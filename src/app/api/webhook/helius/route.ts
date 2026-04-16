// ============================================================
// SONAR v2.0 — Helius Webhook Receiver
// POST /api/webhook/helius
// ============================================================
// Receives enhanced transaction payloads from Helius.
// Classifies movements (exchange deposit/withdrawal, stake,
// unstake, DeFi deposit/withdrawal, whale transfer) and
// persists to the movements table.
//
// Security: verifies Authorization header against HELIUS_WEBHOOK_SECRET.
// Always returns 200 — Helius retries on non-200, creating infinite loops.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }               from '@/lib/supabase/server';
import { parseMovement, type HeliusEnhancedTx } from '@/lib/helius/parse-movement';
import { parseTokenMovement, type ParsedTokenMovement } from '@/lib/helius/parse-token-movement';
import { getCachedSolPrice }               from '@/lib/helius/sol-price-cache';
import { resolveTokenMetadataBatch }       from '@/lib/helius/token-metadata';
import { sendMessage }                     from '@/lib/telegram/bot';
import { formatFlowAlert }                 from '@/lib/telegram/formatter';
import type { MovementRow, TokenMovementRow, AlertRow } from '@/lib/supabase/types';

const WEBHOOK_AUTH_HEADER = 'authorization';

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[webhook/helius][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifySecret(header: string | null): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) return false;
  return header === secret;
}

// ── Fetch active whale address set ────────────────────────────

async function fetchWhaleAddressSet(): Promise<Set<string>> {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from('whales')
      .select('address')
      .eq('is_active', true)
      .limit(500);

    if (!data) return new Set();
    return new Set((data as { address: string }[]).map((w) => w.address));
  } catch {
    return new Set();
  }
}

// ── Persist movements ─────────────────────────────────────────

async function persistMovements(
  movements: ReturnType<typeof parseMovement>[],
): Promise<{ inserted: number; skipped: number }> {
  const valid = movements.filter((m): m is NonNullable<typeof m> => m !== null);
  if (valid.length === 0) return { inserted: 0, skipped: 0 };

  const db = createAdminClient();

  // Resolve whale_id for each movement where from/to is a tracked whale
  const whaleAddresses = [...new Set(valid.flatMap((m) => [m.from_address, m.to_address]))];
  const { data: whales } = await db
    .from('whales')
    .select('id, address')
    .in('address', whaleAddresses);

  const whaleMap = new Map<string, string>(
    ((whales ?? []) as { id: string; address: string }[]).map((w) => [w.address, w.id]),
  );

  const rows = valid.map((m) => {
    const whale_id =
      whaleMap.get(m.from_address) ?? whaleMap.get(m.to_address) ?? null;
    return { ...m, whale_id } satisfies Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>;
  });

  // Upsert on signature to handle Helius retries gracefully
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await db
    .from('movements')
    .upsert(rows as any, { onConflict: 'signature', ignoreDuplicates: true })
    .select('id');

  if (error) {
    log('error', 'Failed to upsert movements', error);
    return { inserted: 0, skipped: valid.length };
  }

  return { inserted: (inserted?.length ?? 0), skipped: valid.length - (inserted?.length ?? 0) };
}

// ── Persist token movements ───────────────────────────────────

async function persistTokenMovements(
  tokenMovements: (ParsedTokenMovement | null)[],
  signatureToMovementId: Map<string, string>,
  sigToWhaleId: Map<string, string>,
): Promise<{ inserted: number; skipped: number }> {
  const valid = tokenMovements.filter((m): m is ParsedTokenMovement => m !== null);
  if (valid.length === 0) return { inserted: 0, skipped: 0 };

  const db = createAdminClient();

  // Build a direct whale_address → whale_id map from token movements.
  // This covers SWAP txns that don't create a movements row (and therefore
  // don't appear in sigToWhaleId, which is built from movements.whale_id).
  const tmAddresses = [...new Set(
    valid.map(m => m.whale_address).filter((a): a is string => !!a),
  )];

  const addrToWhaleId = new Map<string, string>(sigToWhaleId); // start with sig-based entries
  if (tmAddresses.length > 0) {
    const { data: tmWhales } = await db
      .from('whales')
      .select('id, address')
      .in('address', tmAddresses);

    for (const w of (tmWhales ?? []) as { id: string; address: string }[]) {
      addrToWhaleId.set(w.address, w.id);
    }
  }

  const rows = valid.map((m) => {
    const movement_id = signatureToMovementId.get(m.signature) ?? null;
    // Prefer sig-based lookup (most specific), fall back to address-based (covers SWAPs)
    const whale_id    = sigToWhaleId.get(m.signature)
      ?? (m.whale_address ? addrToWhaleId.get(m.whale_address) ?? null : null);

    // whale_address is a helper field — strip it from the DB row
    const { whale_address: _wa, ...rest } = m;
    void _wa;
    return {
      ...rest,
      movement_id,
      whale_id,
    } satisfies Omit<TokenMovementRow, 'id' | 'created_at'>;
  });

  // Upsert on signature — same dedup pattern as movements
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await (db as any)
    .from('token_movements')
    .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true })
    .select('id');

  if (error) {
    log('error', 'Failed to upsert token_movements', error);
    return { inserted: 0, skipped: valid.length };
  }

  return { inserted: (inserted?.length ?? 0), skipped: valid.length - (inserted?.length ?? 0) };
}

// ── POST handler ──────────────────────────────────────────────

// ── Hot-path alert: fires immediately for large single moves ──
// Bypasses the 5-min process-flows cron for whale_large_move alerts.
// Runs fire-and-forget so the webhook response stays fast.

const HOT_ALERT_THRESHOLD_USD = 200_000;   // minimum to trigger
const HOT_ALERT_COOLDOWN_MS   = 30 * 60_000; // 30-min per-whale cooldown

// In-memory last-fired map (best-effort in serverless — cron dedup is the safety net)
const _lastHotAlert = new Map<string, number>();

async function fireHotAlerts(
  movements: (ReturnType<typeof parseMovement>)[],
  solPrice:  number,
): Promise<void> {
  const db = createAdminClient();

  const HOT_TYPES = new Set(['exchange_deposit', 'exchange_withdrawal', 'stake', 'unstake', 'defi_deposit', 'defi_withdrawal']);

  const candidates = movements.filter(
    (m): m is NonNullable<typeof m> =>
      m !== null &&
      HOT_TYPES.has(m.flow_type) &&
      (m.amount_usd ?? 0) >= HOT_ALERT_THRESHOLD_USD,
  );

  if (candidates.length === 0) return;

  // Resolve whale_ids for candidates
  const addrs = [...new Set(candidates.flatMap(m => [m.from_address, m.to_address]))];
  const { data: whaleRows } = await db
    .from('whales')
    .select('id, address, label, reputation_score, smart_money_flag')
    .in('address', addrs)
    .eq('is_active', true);

  const whaleByAddr = new Map<string, { id: string; label: string | null; reputation_score: number | null; smart_money_flag: boolean | null }>(
    ((whaleRows ?? []) as any[]).map((w: any) => [w.address, w]),
  );

  const freeChannel    = process.env.TELEGRAM_CHANNEL_ID ?? '';
  const premiumChannel = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';
  if (!freeChannel) return;

  for (const m of candidates) {
    const whale = whaleByAddr.get(m.from_address) ?? whaleByAddr.get(m.to_address);
    const whaleId = whale?.id ?? null;
    const cooldownKey = whaleId ?? m.from_address;

    // Cooldown check — in-memory
    const lastFired = _lastHotAlert.get(cooldownKey) ?? 0;
    if (Date.now() - lastFired < HOT_ALERT_COOLDOWN_MS) continue;

    const amtUsd = m.amount_usd ?? 0;
    const severity =
      amtUsd >= 2_000_000 ? 'major' :
      amtUsd >= 500_000   ? 'significant' :
      amtUsd >= 200_000   ? 'notable' : 'info';

    const dirLabel =
      m.flow_type === 'exchange_withdrawal' ? 'withdrawn from exchange' :
      m.flow_type === 'exchange_deposit'    ? 'deposited to exchange' :
      m.flow_type === 'stake'               ? 'staked' :
      m.flow_type === 'unstake'             ? 'unstaked' :
      m.flow_type === 'defi_deposit'        ? 'moved to DeFi' :
      m.flow_type === 'defi_withdrawal'     ? 'withdrawn from DeFi' : 'moved';

    const fmtUsd = (v: number) =>
      v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` :
      v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` :
      v >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;

    const smartBadge = whale?.smart_money_flag ? ' ⭐ Smart Money' : '';
    const repBadge   = whale?.reputation_score ? ` [rep ${whale.reputation_score}]` : '';

    const title = `Whale ${dirLabel} ${fmtUsd(amtUsd)}${smartBadge}`;
    const body  = [
      whale?.label ? `Wallet: ${whale.label}${repBadge}` : `Address: ${m.from_address.slice(0, 8)}…`,
      `Action: ${dirLabel}`,
      m.exchange ? `Exchange: ${m.exchange}` : m.protocol ? `Protocol: ${m.protocol}` : null,
      `Amount: ${fmtUsd(amtUsd)} SOL @ $${solPrice.toFixed(2)}`,
    ].filter(Boolean).join('\n');

    // Insert alert
    const { data: alertInserted, error: insertErr } = await db
      .from('alerts')
      .insert({
        alert_type:            'whale_large_move',
        severity,
        title,
        body,
        data:                  { amount_usd: amtUsd, flow_type: m.flow_type, exchange: m.exchange, protocol: m.protocol, whale_id: whaleId, smart_money: whale?.smart_money_flag ?? false },
        movement_ids:          null,
        ai_analysis:           null,
        sent_telegram_free:    false,
        sent_telegram_premium: false,
        sent_at:               null,
      } as any)
      .select('id')
      .single();

    if (insertErr || !alertInserted) continue;

    // Build the AlertRow for the formatter
    const alertRow: AlertRow = {
      id:                    (alertInserted as any).id,
      alert_type:            'whale_large_move',
      severity,
      title,
      body,
      data:                  { amount_usd: amtUsd },
      ai_analysis:           null,
      movement_ids:          null,
      sent_telegram_free:    false,
      sent_telegram_premium: false,
      sent_at:               null,
      created_at:            new Date().toISOString(),
    };

    const text = formatFlowAlert(alertRow);

    // Only significant/major go to free; all go to premium
    const sendFree = ['significant', 'major'].includes(severity);
    const [freeOk, premOk] = await Promise.all([
      sendFree ? sendMessage({ chatId: freeChannel, text }).then(r => r.ok).catch(() => false) : Promise.resolve(true),
      premiumChannel ? sendMessage({ chatId: premiumChannel, text }).then(r => r.ok).catch(() => false) : Promise.resolve(false),
    ]);

    await (db as any).from('alerts').update({
      sent_telegram_free:    sendFree ? freeOk : false,
      sent_telegram_premium: premOk,
      sent_at:               new Date().toISOString(),
    }).eq('id', (alertInserted as any).id);

    _lastHotAlert.set(cooldownKey, Date.now());
    log('info', `Hot alert fired: ${title} (free=${sendFree && freeOk}, premium=${premOk})`);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ────────────────────────────────────────────────
  const authHeader = req.headers.get(WEBHOOK_AUTH_HEADER);
  if (!verifySecret(authHeader)) {
    log('warn', 'Invalid webhook secret');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 200 });
  }

  // ── 2. Parse body ──────────────────────────────────────────
  let transactions: unknown[];
  try {
    const body = await req.json() as unknown;
    transactions = Array.isArray(body) ? body : [body];
  } catch (err) {
    log('error', 'Failed to parse webhook body', err);
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 200 });
  }

  if (transactions.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  log('info', `Received ${transactions.length} transaction(s)`);

  // ── 3. Fetch live SOL price + whale addresses in parallel ─
  const [whaleAddresses, solPriceUsd] = await Promise.all([
    fetchWhaleAddressSet(),
    getCachedSolPrice(),
  ]);
  log('info', `SOL price: $${solPriceUsd.toFixed(2)}`);

  // ── 4. Classify each transaction ──────────────────────────
  const txList = transactions as HeliusEnhancedTx[];

  const movements = txList.map((tx) => {
    try {
      return parseMovement(tx, whaleAddresses, solPriceUsd);
    } catch (err) {
      log('warn', `Failed to parse tx ${tx?.signature ?? 'unknown'}`, err);
      return null;
    }
  });

  const tokenMovements = txList.map((tx) => {
    try {
      return parseTokenMovement(tx, whaleAddresses, solPriceUsd);
    } catch (err) {
      log('warn', `Failed to parse token movement for tx ${tx?.signature ?? 'unknown'}`, err);
      return null;
    }
  });

  const classified = movements.filter((m) => m !== null).length;
  const tokenClassified = tokenMovements.filter((m) => m !== null).length;
  log('info', `Classified ${classified}/${transactions.length} movements, ${tokenClassified} token movements`);

  // ── 5. Persist movements ───────────────────────────────────
  const { inserted, skipped } = await persistMovements(movements);
  log('info', `Persisted ${inserted} movements (${skipped} skipped/duplicate)`);

  // ── 5b. Hot-path alerts (fire-and-forget — <5s latency) ───
  // Large individual whale moves bypass the cron chain entirely.
  fireHotAlerts(movements, solPriceUsd).catch((err) =>
    log('warn', 'Hot alert pipeline error', err),
  );

  // ── 6. Persist token movements ─────────────────────────────
  // Build a signature→movement_id map from persisted movements
  let tokenInserted = 0;
  let tokenSkipped  = 0;

  if (tokenClassified > 0) {
    // Fetch movement IDs for the signatures we just upserted
    const sigs = txList
      .map((tx) => tx.signature)
      .filter((s) => !!s);

    const db = createAdminClient();
    const { data: movRows } = await db
      .from('movements')
      .select('id, signature, from_address, to_address, whale_id')
      .in('signature', sigs);

    const sigToMovId    = new Map<string, string>();
    const sigToWhaleId  = new Map<string, string>();

    for (const row of movRows ?? []) {
      const r = row as { id: string; signature: string; whale_id: string | null };
      sigToMovId.set(r.signature, r.id);
      if (r.whale_id) sigToWhaleId.set(r.signature, r.whale_id);
    }

    const result = await persistTokenMovements(tokenMovements, sigToMovId, sigToWhaleId);
    tokenInserted = result.inserted;
    tokenSkipped  = result.skipped;
    log('info', `Persisted ${tokenInserted} token_movements (${tokenSkipped} skipped/duplicate)`);

    // ── 6b. Enrich token_movements with symbol/name (fire-and-forget) ─
    // Collect unique mints from new movements; resolve metadata and back-fill.
    if (tokenInserted > 0) {
      const newMints = [...new Set(
        tokenMovements
          .filter((m): m is ParsedTokenMovement => m !== null)
          .map(m => m.token_mint),
      )];

      resolveTokenMetadataBatch(newMints)
        .then(async (metaMap) => {
          const db2 = createAdminClient();
          for (const [mint, meta] of metaMap) {
            if (!meta.symbol && !meta.name) continue;
            // Update token_movements rows that have null symbol for this mint
            await (db2 as any)
              .from('token_movements')
              .update({ token_symbol: meta.symbol, token_name: meta.name })
              .eq('token_mint', mint)
              .is('token_symbol', null);
          }
        })
        .catch((err) => log('warn', 'Token metadata enrichment failed', err));
    }
  }

  return NextResponse.json({
    ok:              true,
    received:        transactions.length,
    classified,
    inserted,
    skipped,
    token_classified: tokenClassified,
    token_inserted:   tokenInserted,
    token_skipped:    tokenSkipped,
  });
}
