// ============================================================
// SONAR v2.0 — Resolve Outcomes Cron
// POST /api/cron/resolve-outcomes
// ============================================================
// Runs every 15 minutes (see vercel.json).
//
// Logic:
//   1. Fetch unresolved whale_signal_outcomes where signal_time
//      is older than 4 hours (all windows have had time to elapse)
//   2. For each outcome, fetch Binance SOLUSDT 1m candles for
//      the required forward windows (5m, 15m, 1h, 4h)
//   3. Fill price fields, compute returns, set hit booleans
//   4. Mark resolved = true
//   5. Trigger reputation recomputation for affected whales
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { updateReputationsForWhales } from '@/lib/scoring/whale-reputation';
import type { WhaleSignalOutcomeRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Constants ─────────────────────────────────────────────────

const BATCH_SIZE        = 50;   // max outcomes to resolve per run
const RESOLVE_AFTER_MS  = 4 * 60 * 60 * 1000; // 4h — all windows reachable

// Forward window definitions (minutes → field names)
const WINDOWS = [
  { minutes: 5,    priceField: 'price_5m',  returnField: 'return_5m',  hitField: 'hit_5m'  },
  { minutes: 15,   priceField: 'price_15m', returnField: 'return_15m', hitField: 'hit_15m' },
  { minutes: 60,   priceField: 'price_1h',  returnField: 'return_1h',  hitField: 'hit_1h'  },
  { minutes: 240,  priceField: 'price_4h',  returnField: 'return_4h',  hitField: 'hit_4h'  },
] as const;

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/resolve-outcomes][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'CRON_SECRET not set — unauthenticated (dev mode)');
    return true;
  }
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Binance klines fetcher ────────────────────────────────────

interface Candle {
  open_time: number;
  close:     number;
}

async function fetchBinanceCandles(
  startMs:  number,
  endMs:    number,
  interval: string,
  limit:    number,
): Promise<Candle[]> {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=SOLUSDT&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${limit}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      log('warn', `Binance returned HTTP ${res.status}`);
      return [];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: any[][] = await res.json();
    return raw.map((r) => ({
      open_time: r[0] as number,
      close:     parseFloat(r[4]),
    }));
  } catch (err) {
    log('warn', 'Binance fetch failed', err);
    return [];
  }
}

/** Find the candle whose open_time is closest to but >= targetMs. */
function findCandleAt(candles: Candle[], targetMs: number): Candle | null {
  // Find the candle that started just at or after targetMs
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.open_time <= targetMs) {
      if (!best || c.open_time > best.open_time) best = c;
    }
  }
  return best;
}

// ── Resolution logic ──────────────────────────────────────────

interface WindowResult {
  price:   number | null;
  ret:     number | null;
  hit:     boolean | null;
}

async function resolveOutcome(
  outcome: WhaleSignalOutcomeRow,
): Promise<Record<string, number | boolean | null>> {
  const signalMs     = new Date(outcome.signal_time).getTime();
  const priceAtSig   = outcome.price_at_signal;

  if (!priceAtSig || priceAtSig <= 0) {
    // Cannot compute returns without entry price — mark resolved to avoid retry loops
    return { resolved: true };
  }

  const maxForwardMs = 240 * 60 * 1000 + 5 * 60 * 1000; // 4h + 5m buffer
  const startMs      = signalMs;
  const endMs        = signalMs + maxForwardMs;

  // Fetch 1m candles covering all windows in one request (max ~250 candles = ~4h15m)
  const candles = await fetchBinanceCandles(startMs, endMs, '1m', 260);

  if (candles.length === 0) {
    log('warn', `No Binance candles for outcome ${outcome.id}, will retry next run`);
    return {}; // Don't resolve yet — will be retried
  }

  const updates: Record<string, number | boolean | null> = { resolved: true };

  const isBullish = outcome.signal_direction === 'bullish';
  const isBearish = outcome.signal_direction === 'bearish';

  for (const win of WINDOWS) {
    const targetMs = signalMs + win.minutes * 60 * 1000;
    const candle   = findCandleAt(candles, targetMs);

    if (!candle) {
      // Window not yet reached — set null, don't block resolve
      updates[win.priceField]  = null;
      updates[win.returnField] = null;
      updates[win.hitField]    = null;
      continue;
    }

    const price  = candle.close;
    const ret    = (price - priceAtSig) / priceAtSig;

    let hit: boolean | null = null;
    if (isBullish) hit = price > priceAtSig;
    else if (isBearish) hit = price < priceAtSig;
    // neutral: hit stays null

    updates[win.priceField]  = price;
    updates[win.returnField] = ret;
    updates[win.hitField]    = hit;
  }

  return updates;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startMs = Date.now();

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();

  // ── 1. Fetch unresolved outcomes older than 4h ─────────────
  const cutoff = new Date(Date.now() - RESOLVE_AFTER_MS).toISOString();

  const { data: rawOutcomes, error: fetchErr } = await (db as any)
    .from('whale_signal_outcomes')
    .select('*')
    .eq('resolved', false)
    .lt('signal_time', cutoff)
    .order('signal_time', { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchErr) {
    log('error', 'Failed to fetch unresolved outcomes', fetchErr.message);
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
  }

  const outcomes = (rawOutcomes ?? []) as WhaleSignalOutcomeRow[];
  log('info', `Found ${outcomes.length} unresolved outcome(s) to resolve`);

  if (outcomes.length === 0) {
    return NextResponse.json({
      ok: true,
      resolved: 0,
      skipped: 0,
      duration_ms: Date.now() - startMs,
    });
  }

  // ── 2. Resolve each outcome ────────────────────────────────
  let resolvedCount  = 0;
  let skippedCount   = 0;
  const affectedWhaleIds = new Set<string>();

  for (const outcome of outcomes) {
    try {
      const updates = await resolveOutcome(outcome);

      if (Object.keys(updates).length === 0) {
        // Not yet resolvable (no candle data) — skip
        skippedCount++;
        continue;
      }

      const { error: updateErr } = await (db as any)
        .from('whale_signal_outcomes')
        .update(updates)
        .eq('id', outcome.id);

      if (updateErr) {
        log('error', `Failed to update outcome ${outcome.id}`, updateErr.message);
        skippedCount++;
      } else {
        resolvedCount++;
        affectedWhaleIds.add(outcome.whale_id);
      }
    } catch (err) {
      log('error', `Exception resolving outcome ${outcome.id}`, err);
      skippedCount++;
    }
  }

  log('info', `Resolved ${resolvedCount}, skipped ${skippedCount}`);

  // ── 3. Recompute reputations for affected whales ───────────
  let reputationResult = { updated: 0, smart_money_count: 0 };
  if (affectedWhaleIds.size > 0) {
    try {
      reputationResult = await updateReputationsForWhales(
        [...affectedWhaleIds],
        db,
      );
      log('info', `Updated reputations for ${reputationResult.updated} whales, ${reputationResult.smart_money_count} smart money`);
    } catch (err) {
      log('error', 'Failed to update reputations', err);
    }
  }

  return NextResponse.json({
    ok:                    true,
    outcomes_found:        outcomes.length,
    resolved:              resolvedCount,
    skipped:               skippedCount,
    reputations_updated:   reputationResult.updated,
    smart_money_count:     reputationResult.smart_money_count,
    duration_ms:           Date.now() - startMs,
  });
}

export const GET = POST;
