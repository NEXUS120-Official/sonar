// ============================================================
// SONAR Intel API — Bias Index
// GET /api/intel/bias
// ============================================================
// Returns the current Bias Index: direction, score, confidence,
// components breakdown (exchange, staking, DeFi, stablecoin),
// and a 24-hour historical series.
//
// This is the core of SONAR's intelligence layer.
// Protected by CRON_SECRET or public if not set.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Simple auth — same pattern as crons
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

  const db = createAdminClient();

  // ── 1. Latest bias index row ───────────────────────────────
  const { data: latestRaw } = await (db as any)
    .from('bias_index_history')
    .select('*')
    .order('computed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!latestRaw) {
    return NextResponse.json({ ok: false, error: 'no_data' }, { status: 503 });
  }

  const latest = latestRaw as Record<string, unknown>;

  // ── 2. 24h history (one row per hour) ─────────────────────
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: historyRaw } = await (db as any)
    .from('bias_index_history')
    .select('computed_at, bias_score, market_bias, confidence_score')
    .gte('computed_at', since24h)
    .order('computed_at', { ascending: true })
    .limit(288); // 24h × 12 per hour max

  const history = (historyRaw ?? []) as Array<{
    computed_at: string;
    bias_score: number;
    market_bias: string;
    confidence_score: number;
  }>;

  // ── 3. Latest flow snapshot for component breakdown ────────
  const { data: snapshotRaw } = await db
    .from('flow_snapshots')
    .select('*')
    .order('snapshot_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  const snap = snapshotRaw as Record<string, number | string | null> | null;

  // ── 4. Build component breakdown ──────────────────────────
  const components = snap ? {
    exchange: {
      label:     'Exchange Flow',
      weight:    0.35,
      net_usd:   Number(snap.sol_net_exchange_flow_usd ?? 0),
      direction: Number(snap.sol_net_exchange_flow_usd ?? 0) < 0 ? 'bullish' : 'bearish',
    },
    staking: {
      label:     'Staking Flow',
      weight:    0.20,
      net_usd:   Number(snap.net_staking_flow_usd ?? 0),
      direction: Number(snap.net_staking_flow_usd ?? 0) > 0 ? 'bullish' : 'bearish',
    },
    defi: {
      label:     'DeFi Rotation',
      weight:    0.15,
      net_usd:   Number(snap.net_defi_flow_usd ?? 0),
      direction: Number(snap.net_defi_flow_usd ?? 0) > 0 ? 'bullish' : 'bearish',
    },
    stablecoin: {
      label:     'Stablecoin Deploy',
      weight:    0.10,
      net_usd:   Number(snap.net_usdc_flow_usd ?? 0),
      direction: Number(snap.net_usdc_flow_usd ?? 0) > 0 ? 'bullish' : 'bearish',
    },
  } : null;

  const data_age_min = snap
    ? Math.round((Date.now() - new Date(snap.snapshot_time as string).getTime()) / 60_000)
    : null;

  return NextResponse.json({
    ok:            true,
    bias: {
      direction:    latest.market_bias,
      score:        latest.bias_score,
      confidence:   latest.confidence_score ?? latest.confidence,
      computed_at:  latest.computed_at,
      data_age_min,
    },
    components,
    history: history.map(h => ({
      t:         h.computed_at,
      score:     h.bias_score,
      direction: h.market_bias,
      confidence: h.confidence_score,
    })),
  });
}
