// ============================================================
// SONAR — Evaluate Predictions Cron
// POST /api/cron/evaluate-predictions  (every hour)
// ============================================================
// Closes the prediction feedback loop:
//
// 1. Find prediction_runs where horizon has elapsed and
//    actual_direction is still NULL (not yet evaluated).
// 2. Fetch SOL price at feature_time and at feature_time+horizon
//    from Binance OHLCV (1m candles).
// 3. Compute:
//    - price_at_start, price_at_end, pct_change, direction
// 4. Write to prediction_targets (upsert).
// 5. Update prediction_runs.actual_direction + correct + evaluated_at.
//
// This enables real accuracy tracking over time — no hand-waving.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Constants ─────────────────────────────────────────────────

// How much extra time before we consider a horizon "ready to evaluate"
// (give Binance candles time to settle)
const EVAL_BUFFER_MS   = 30 * 60_000; // 30 min grace

const HORIZON_MAP: Record<string, number> = {
  '4h':  4  * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '72h': 72 * 60 * 60_000,
};

const BATCH_SIZE = 20; // max prediction_runs evaluated per cron run

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-cron-secret') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

// ── Binance price fetcher ─────────────────────────────────────

async function getSolPriceAt(targetMs: number): Promise<number | null> {
  // Fetch 1m candle that contains targetMs, take close price
  const startMs = targetMs - 60_000;
  const endMs   = targetMs + 60_000;

  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=SOLUSDT&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=3`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const candles = (await res.json()) as unknown[][];
    if (!candles || candles.length === 0) return null;
    // Each candle: [openTime, open, high, low, close, ...]
    // Find the candle closest to targetMs
    let best: [number, number] | null = null;
    for (const c of candles) {
      const openTime = Number(c[0]);
      const close    = parseFloat(String(c[4]));
      if (!best || Math.abs(openTime - targetMs) < Math.abs(best[0] - targetMs)) {
        best = [openTime, close];
      }
    }
    return best ? best[1] : null;
  } catch {
    return null;
  }
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs = Date.now();
  const db      = createAdminClient();
  const dbAny   = db as any;

  // ── 1. Find prediction_runs ready to evaluate ─────────────
  // A run is ready when: now >= feature_time + horizon_ms + EVAL_BUFFER_MS
  // We check the earliest horizon (4h) as the cutoff for simplicity;
  // for 24h/72h the same logic applies.
  const cutoff4h  = new Date(Date.now() - HORIZON_MAP['4h']  - EVAL_BUFFER_MS).toISOString();
  const cutoff24h = new Date(Date.now() - HORIZON_MAP['24h'] - EVAL_BUFFER_MS).toISOString();
  const cutoff72h = new Date(Date.now() - HORIZON_MAP['72h'] - EVAL_BUFFER_MS).toISOString();

  // Fetch unevaluated runs across all horizons
  const { data: runsRaw } = await dbAny
    .from('prediction_runs')
    .select('id, model_name, horizon, feature_time, prob_up, prob_down, direction')
    .is('evaluated_at', null)
    .or(
      `and(horizon.eq.4h,feature_time.lte.${cutoff4h}),` +
      `and(horizon.eq.24h,feature_time.lte.${cutoff24h}),` +
      `and(horizon.eq.72h,feature_time.lte.${cutoff72h})`,
    )
    .order('feature_time', { ascending: true })
    .limit(BATCH_SIZE);

  const runs = (runsRaw ?? []) as Array<{
    id: string;
    model_name: string;
    horizon: string;
    feature_time: string;
    prob_up: number | null;
    prob_down: number | null;
    direction: number | null;
  }>;

  if (runs.length === 0) {
    return NextResponse.json({
      ok: true, evaluated: 0, duration_ms: Date.now() - startMs, message: 'no_pending_runs',
    });
  }

  // ── 2. Evaluate each run ───────────────────────────────────

  let evaluated = 0;
  let failed    = 0;

  for (const run of runs) {
    const horizonMs = HORIZON_MAP[run.horizon];
    if (!horizonMs) { failed++; continue; }

    const featureMs = new Date(run.feature_time).getTime();
    const endMs     = featureMs + horizonMs;

    // Fetch price at start and end
    const [priceStart, priceEnd] = await Promise.all([
      getSolPriceAt(featureMs),
      getSolPriceAt(endMs),
    ]);

    if (!priceStart || !priceEnd) { failed++; continue; }

    const pct_change = (priceEnd - priceStart) / priceStart;
    const direction  = pct_change > 0.005 ? 1 : pct_change < -0.005 ? -1 : 0;

    // Write prediction_targets (upsert — feature_time + horizon is unique)
    await dbAny
      .from('prediction_targets')
      .upsert({
        feature_time:   run.feature_time,
        horizon:        run.horizon,
        price_at_start: priceStart,
        price_at_end:   priceEnd,
        pct_change,
        direction,
        realized_at:    new Date(endMs).toISOString(),
      }, { onConflict: 'feature_time,horizon', ignoreDuplicates: false });

    // Update prediction_runs
    const predicted  = run.direction ?? (run.prob_up != null && run.prob_down != null
      ? (run.prob_up > run.prob_down ? 1 : run.prob_up < run.prob_down ? -1 : 0)
      : null);
    const correct = predicted !== null ? predicted === direction : null;

    await dbAny
      .from('prediction_runs')
      .update({
        actual_direction: direction,
        correct,
        evaluated_at: new Date().toISOString(),
      })
      .eq('id', run.id);

    evaluated++;

    // Small delay to avoid Binance rate limits
    await new Promise(r => setTimeout(r, 250));
  }

  return NextResponse.json({
    ok:          true,
    evaluated,
    failed,
    total_found: runs.length,
    duration_ms: Date.now() - startMs,
  });
}

export const GET = POST;
