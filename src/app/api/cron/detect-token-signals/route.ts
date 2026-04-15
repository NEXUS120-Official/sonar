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
} from '@/lib/flow-engine/confluence';
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

// ── In-memory cooldown: 60 min per token ──────────────────────

const _lastFired = new Map<string, number>();
const COOLDOWN_MS = 60 * 60_000;

function onCooldown(key: string): boolean {
  const last = _lastFired.get(key) ?? 0;
  return Date.now() - last < COOLDOWN_MS;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs = Date.now();
  const db      = createAdminClient();
  const since   = new Date(Date.now() - 35 * 60_000).toISOString(); // 35min lookback

  // ── 1. Load recent token_movements ───────────────────────────
  const { data: movRaw } = await (db as any)
    .from('token_movements')
    .select('whale_id, token_mint, token_symbol, action, amount_usd, is_new_token, block_time')
    .gte('block_time', since)
    .not('whale_id', 'is', null)
    .in('action', ['buy', 'sell']);

  const movements = (movRaw ?? []) as Pick<
    TokenMovementRow,
    'whale_id' | 'token_mint' | 'token_symbol' | 'action' | 'amount_usd' | 'is_new_token' | 'block_time'
  >[];

  if (movements.length === 0) {
    return NextResponse.json({ ok: true, signals: 0, duration_ms: Date.now() - startMs });
  }

  // ── 2. Load smart_money_flag for whale IDs seen ────────────────
  const whaleIds = [...new Set(movements.map(m => m.whale_id).filter(Boolean) as string[])];

  const { data: whaleRaw } = await db
    .from('whales')
    .select('id, smart_money_flag')
    .in('id', whaleIds);

  const smartMoneySet = new Set(
    ((whaleRaw ?? []) as Pick<WhaleRow, 'id' | 'smart_money_flag'>[])
      .filter(w => w.smart_money_flag)
      .map(w => w.id),
  );

  // ── 3. Run confluence detection ───────────────────────────────
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

  // ── 4. Fire alerts for new signals (not on cooldown) ─────────
  const freeChannel    = process.env.TELEGRAM_CHANNEL_ID ?? '';
  const premiumChannel = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';

  let fired = 0;

  for (const sig of signals) {
    const cooldownKey = sig.token_mint;
    if (onCooldown(cooldownKey)) continue;

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
