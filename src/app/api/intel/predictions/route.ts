// ============================================================
// SONAR Intel API — Predictions
// GET /api/intel/predictions?horizon=4h&limit=50
// ============================================================
// Returns prediction history from prediction_runs table.
// Shows model accuracy, calibration, and recent calls.
//
// Query params:
//   horizon   = 4h | 24h | 72h (default all)
//   limit     = max rows (default 50, max 200)
//   evaluated = true | false | all (default all)
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const horizon   = searchParams.get('horizon');
  const limit     = Math.min(200, parseInt(searchParams.get('limit') ?? '50', 10));
  const evaluated = searchParams.get('evaluated');

  const db    = createAdminClient();
  const dbAny = db as any;

  // ── 1. Build query ─────────────────────────────────────────
  let q = dbAny
    .from('prediction_runs')
    .select('*')
    .order('feature_time', { ascending: false })
    .limit(limit);

  if (horizon && ['4h', '24h', '72h'].includes(horizon)) q = q.eq('horizon', horizon);

  if (evaluated === 'true')  q = q.not('evaluated_at', 'is', null);
  if (evaluated === 'false') q = q.is('evaluated_at', null);

  const { data: runsRaw, error } = await q;

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const runs = (runsRaw ?? []) as Array<{
    id: string;
    model_name: string;
    model_version: string;
    horizon: string;
    prob_up: number | null;
    prob_down: number | null;
    prob_flat: number | null;
    confidence: number | null;
    direction: number | null;
    top_features: unknown;
    actual_direction: number | null;
    correct: boolean | null;
    evaluated_at: string | null;
    feature_time: string;
    predictions: unknown;
    created_at: string;
  }>;

  // ── 2. Compute accuracy metrics (evaluated rows only) ──────
  const evaluated_runs = runs.filter(r => r.evaluated_at !== null);
  const correct_count  = evaluated_runs.filter(r => r.correct).length;
  const accuracy = evaluated_runs.length > 0
    ? Math.round((correct_count / evaluated_runs.length) * 1000) / 10
    : null;

  // By horizon
  const byHorizonMap = new Map<string, { total: number; correct: number }>();
  for (const r of evaluated_runs) {
    if (!byHorizonMap.has(r.horizon)) byHorizonMap.set(r.horizon, { total: 0, correct: 0 });
    const h = byHorizonMap.get(r.horizon)!;
    h.total++;
    if (r.correct) h.correct++;
  }
  const by_horizon = Object.fromEntries(
    [...byHorizonMap.entries()].map(([h, v]) => [
      h,
      { total: v.total, correct: v.correct, accuracy: v.total > 0 ? Math.round(v.correct / v.total * 1000) / 10 : null },
    ]),
  );

  return NextResponse.json({
    ok: true,
    metrics: {
      total_runs:      runs.length,
      evaluated_count: evaluated_runs.length,
      pending_count:   runs.length - evaluated_runs.length,
      overall_accuracy: accuracy,
      by_horizon,
    },
    runs: runs.map(r => ({
      id:               r.id,
      horizon:          r.horizon,
      model_name:       r.model_name,
      feature_time:     r.feature_time,
      prob_up:          r.prob_up,
      prob_down:        r.prob_down,
      confidence:       r.confidence,
      direction:        r.direction,
      actual_direction: r.actual_direction,
      correct:          r.correct,
      evaluated_at:     r.evaluated_at,
      top_features:     r.top_features,
    })),
  });
}
