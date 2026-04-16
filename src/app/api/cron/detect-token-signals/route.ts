// ============================================================
// SONAR — Detect Token Signals Cron
// GET/POST /api/cron/detect-token-signals   (every 2 min)
// ============================================================
// Scans recent token_movements for whale accumulation clusters.
// When 2+ tracked whales buy the same token in a 30-min window:
//   - Generates a token_accumulation alert
//   - Sends immediately to Telegram (free: significant+major)
//   - Cooldown: 60 min per token to prevent spam
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';
import { sendMessage }                    from '@/lib/telegram/bot';
import {
  detectTokenAccumulation,
  formatTokenAccumulationAlert,
} from '@/lib/signal-engine';
import type { TokenMovementRow, WhaleRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-cron-secret') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

// ── Cooldown helpers ───────────────────────────────────────────
// Primary: DB check (survives cold starts).
// Secondary: in-memory cache (avoids redundant DB calls within same invocation).

const COOLDOWN_MS    = 60 * 60_000;       // token_accumulation: 60 min
const SM_COOLDOWN_MS_INNER = 4 * 60 * 60_000; // smart_money_token_buy: 4 h

// In-memory layer (best-effort — resets on cold start, DB is authoritative)
const _lastFired = new Map<string, number>();

function inMemoryCooldown(key: string, windowMs: number): boolean {
  const last = _lastFired.get(key) ?? 0;
  return Date.now() - last < windowMs;
}

// Returns a Set of keys that are still on cooldown according to the DB.
// key format for token_accumulation:  token_mint
// key format for smart_money_token_buy: `sm:${whale_id}:${token_mint}`
async function dbCooldownSet(
  db: ReturnType<typeof createAdminClient>,
  alertType: string,
  windowMs: number,
): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - windowMs).toISOString();
  const { data } = await (db as any)
    .from('alerts')
    .select('data')
    .eq('alert_type', alertType)
    .gte('created_at', cutoff);

  const result = new Set<string>();
  for (const row of (data ?? []) as { data: Record<string, unknown> }[]) {
    if (alertType === 'token_accumulation') {
      const mint = row.data?.token_mint as string | undefined;
      if (mint) result.add(mint);
    } else if (alertType === 'smart_money_token_buy') {
      const whale = row.data?.whale_id as string | undefined;
      const mint  = row.data?.token_mint as string | undefined;
      if (whale && mint) result.add(`sm:${whale}:${mint}`);
    }
  }
  return result;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs = Date.now();
  const db      = createAdminClient();
  const since   = new Date(Date.now() - 35 * 60_000).toISOString(); // 35min lookback

  // Pre-fetch DB cooldown sets once per run (avoids per-token DB calls)
  const [accCooldownDb, smCooldownDb] = await Promise.all([
    dbCooldownSet(db, 'token_accumulation',    COOLDOWN_MS),
    dbCooldownSet(db, 'smart_money_token_buy', SM_COOLDOWN_MS_INNER),
  ]);

  // ── 1. Load recent token_movements ───────────────────────────
  const { data: movRaw } = await (db as any)
    .from('token_movements')
    .select('whale_id, token_mint, token_symbol, action, amount_usd, is_new_token, block_time, protocol')
    .gte('block_time', since)
    .not('whale_id', 'is', null)
    .in('action', ['buy', 'sell']);

  const movements = (movRaw ?? []) as Pick<
    TokenMovementRow,
    'whale_id' | 'token_mint' | 'token_symbol' | 'action' | 'amount_usd' | 'is_new_token' | 'block_time' | 'protocol'
  >[];

  if (movements.length === 0) {
    return NextResponse.json({ ok: true, signals: 0, duration_ms: Date.now() - startMs });
  }

  // ── 2. Load whale metadata for IDs seen ───────────────────────
  const whaleIds = [...new Set(movements.map(m => m.whale_id).filter(Boolean) as string[])];

  const { data: whaleRaw } = await db
    .from('whales')
    .select('id, label, address, smart_money_flag, reputation_score')
    .in('id', whaleIds);

  type WhaleMeta = Pick<WhaleRow, 'id' | 'label' | 'address' | 'smart_money_flag' | 'reputation_score'>;
  const whaleMetaMap = new Map<string, WhaleMeta>(
    ((whaleRaw ?? []) as WhaleMeta[]).map(w => [w.id, w]),
  );

  const smartMoneySet = new Set(
    ((whaleRaw ?? []) as WhaleMeta[])
      .filter(w => w.smart_money_flag)
      .map(w => w.id),
  );

  // ── Channel refs (used by both smart_money_token_buy and token_accumulation) ─
  const freeChannel    = process.env.TELEGRAM_CHANNEL_ID ?? '';
  const premiumChannel = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';
  let fired = 0;

  // ── 3. Smart money individual buy alerts ─────────────────────
  // Fires smart_money_token_buy when a tracked smart-money whale buys
  // a token with amount >= $2k (cooldown: 4h per whale+token combo).
  const SM_BUY_THRESHOLD_USD = 2_000;
  const smCooldownKey        = (wId: string, mint: string) => `sm:${wId}:${mint}`;

  function fmtUsd(v: number): string {
    return v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M`
         : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K`
         : `$${v.toFixed(0)}`;
  }

  // Deduplicate by whale+token, keep largest buy
  const smBuyMap = new Map<string, typeof movements[0]>();
  for (const m of movements) {
    if (!m.whale_id || !smartMoneySet.has(m.whale_id)) continue;
    if (m.action !== 'buy') continue;
    if ((m.amount_usd ?? 0) < SM_BUY_THRESHOLD_USD) continue;
    const key = `${m.whale_id}:${m.token_mint}`;
    const existing = smBuyMap.get(key);
    if (!existing || (m.amount_usd ?? 0) > (existing.amount_usd ?? 0)) {
      smBuyMap.set(key, m);
    }
  }

  for (const [, m] of smBuyMap) {
    const cdKey = smCooldownKey(m.whale_id!, m.token_mint);

    // DB-authoritative cooldown (cold-start safe) + in-memory fast path
    if (smCooldownDb.has(cdKey) || inMemoryCooldown(cdKey, SM_COOLDOWN_MS_INNER)) continue;

    const whale      = whaleMetaMap.get(m.whale_id!);
    const whaleLabel = whale?.label ?? (whale?.address ? `${whale.address.slice(0, 6)}…` : 'Whale');
    const token      = m.token_symbol ?? m.token_mint.slice(0, 8);
    const amtUsd     = m.amount_usd ?? 0;
    const repScore   = whale?.reputation_score ?? 0.5;

    const severity   = amtUsd >= 50_000 ? 'major'
                     : amtUsd >= 5_000  ? 'significant'
                     : 'notable' as const;

    const title = `Smart Money: ${whaleLabel} → ${token} (${fmtUsd(amtUsd)})`;
    const body  = [
      `Token:      ${token}`,
      `Amount:     ${fmtUsd(amtUsd)}`,
      `Whale:      ${whaleLabel}`,
      `Track rec:  ${(repScore * 100).toFixed(0)}/100`,
      `Protocol:   ${m.protocol ?? '—'}`,
    ].join('\n');

    const { data: smInserted, error: smErr } = await (db as any)
      .from('alerts')
      .insert({
        alert_type:            'smart_money_token_buy',
        severity,
        title,
        body,
        ai_analysis:           null,
        data: {
          token_mint:       m.token_mint,
          token_symbol:     m.token_symbol,
          amount_usd:       amtUsd,
          whale_id:         m.whale_id,
          whale_label:      whaleLabel,
          reputation_score: repScore,
          protocol:         m.protocol,
        },
        movement_ids:          null,
        sent_telegram_free:    false,
        sent_telegram_premium: false,
        sent_at:               null,
      })
      .select('id')
      .single();

    if (smErr || !smInserted) continue;

    const smText   = `🧠 *${title}*\n\n${body}`;
    const sendFree = freeChannel && ['significant', 'major'].includes(severity);

    const [smFreeOk, smPremOk] = await Promise.all([
      sendFree
        ? sendMessage({ chatId: freeChannel, text: smText }).then(r => r.ok).catch(() => false)
        : Promise.resolve(false),
      premiumChannel
        ? sendMessage({ chatId: premiumChannel, text: smText }).then(r => r.ok).catch(() => false)
        : Promise.resolve(false),
    ]);

    await (db as any).from('alerts').update({
      sent_telegram_free:    smFreeOk,
      sent_telegram_premium: smPremOk,
      sent_at:               new Date().toISOString(),
    }).eq('id', (smInserted as any).id);

    _lastFired.set(cdKey, Date.now());
    fired++;
  }

  // ── 4. Run token accumulation confluence detection ────────────
  const enriched = movements.map(m => ({
    whale_id:    m.whale_id,
    token_mint:  m.token_mint,
    token_symbol: m.token_symbol,
    action:      m.action as 'buy' | 'sell',
    amount_usd:  m.amount_usd,
    is_pump_fun: m.token_mint.endsWith('pump'),
    block_time:  m.block_time,
    smart_money: m.whale_id ? smartMoneySet.has(m.whale_id) : false,
  }));

  const signals = detectTokenAccumulation(enriched, 30, 2);

  if (signals.length === 0) {
    return NextResponse.json({ ok: true, signals: 0, duration_ms: Date.now() - startMs });
  }

  // ── 5. Fire token_accumulation alerts ────────────────────────
  for (const sig of signals) {
    const cooldownKey = sig.token_mint;
    // DB-authoritative cooldown (cold-start safe) + in-memory fast path
    if (accCooldownDb.has(cooldownKey) || inMemoryCooldown(cooldownKey, COOLDOWN_MS)) continue;

    const { title, body } = formatTokenAccumulationAlert(sig);

    // Insert alert to DB
    const { data: inserted, error: insertErr } = await (db as any)
      .from('alerts')
      .insert({
        alert_type:            'token_accumulation',
        severity:              sig.severity,
        title,
        body,
        ai_analysis:           null,
        data: {
          token_mint:        sig.token_mint,
          token_symbol:      sig.token_symbol,
          unique_whales:     sig.unique_whales,
          smart_money_count: sig.smart_money_count,
          total_usd:         sig.total_usd,
          confluence_score:  sig.confluence_score,
          is_pump_fun:       sig.is_pump_fun,
          whale_addresses:   sig.whale_addresses,
        },
        movement_ids:          null,
        sent_telegram_free:    false,
        sent_telegram_premium: false,
        sent_at:               null,
      })
      .select('id')
      .single();

    if (insertErr || !inserted) continue;

    // Telegram delivery
    const sendFree = freeChannel && ['significant', 'major'].includes(sig.severity);
    const text = `🐳 *${title}*\n\n${body}`;

    const [freeOk, premOk] = await Promise.all([
      sendFree ? sendMessage({ chatId: freeChannel, text }).then(r => r.ok).catch(() => false) : Promise.resolve(false),
      premiumChannel ? sendMessage({ chatId: premiumChannel, text }).then(r => r.ok).catch(() => false) : Promise.resolve(false),
    ]);

    await (db as any).from('alerts').update({
      sent_telegram_free:    freeOk,
      sent_telegram_premium: premOk,
      sent_at:               new Date().toISOString(),
    }).eq('id', (inserted as any).id);

    _lastFired.set(cooldownKey, Date.now());
    fired++;
  }

  return NextResponse.json({
    ok:           true,
    movements:    movements.length,
    signals:      signals.length,
    alerts_fired: fired,
    duration_ms:  Date.now() - startMs,
  });
}

export const GET = POST;
