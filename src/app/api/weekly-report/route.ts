// ============================================================
// SONAR v2.0 — GET /api/weekly-report (Innovation 5)
// ============================================================
// Returns a 7-day summary:
//  - bias_history: hourly bias_index_history points (downsampled to 4h)
//  - flow_summary: from the most recent 168h snapshot
//  - dominant_bias, avg_score, high_score, low_score
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const db    = createAdminClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [biasRes, snapshotRes] = await Promise.all([
      db
        .from('bias_index_history')
        .select('score, bias, created_at')
        .gte('created_at', since)
        .order('created_at', { ascending: true }),

      db
        .from('flow_snapshots')
        .select(
          'sol_net_exchange_flow_usd, net_staking_flow_usd, net_usdc_flow_usd, net_defi_flow_usd, large_movements_count, unique_whales_active, created_at'
        )
        .eq('window_hours', 168)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (biasRes.error) {
      return NextResponse.json({ ok: false, error: biasRes.error.message }, { status: 500 });
    }

    // Downsample bias history to 4h buckets for performance
    const rawBias = (biasRes.data ?? []) as any[];
    const buckets = new Map<string, { score: number; bias: string; created_at: string }>();
    for (const p of rawBias) {
      const slot = Math.floor(new Date(p.created_at as string).getTime() / (4 * 3_600_000));
      buckets.set(String(slot), p);
    }
    const biasHistory = Array.from(buckets.values());

    // Compute stats from full hourly set
    const scores = rawBias.map((p: any) => p.score as number);
    const avgScore  = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
    const highScore = scores.length ? Math.max(...scores) : null;
    const lowScore  = scores.length ? Math.min(...scores) : null;

    // Dominant bias: mode of bias labels
    const biasCounts: Record<string, number> = {};
    for (const p of rawBias) biasCounts[p.bias as string] = (biasCounts[p.bias] ?? 0) + 1;
    const dominantBias = Object.keys(biasCounts).sort((a, b) => biasCounts[b] - biasCounts[a])[0] ?? null;

    // Flow summary from 168h snapshot
    const snap = snapshotRes.data as any;
    const flowSummary = {
      net_exchange_usd:   snap ? -(snap.sol_net_exchange_flow_usd ?? 0) : 0, // flip: outflow = positive (accumulation)
      net_staking_usd:    snap?.net_staking_flow_usd    ?? 0,
      net_stablecoin_usd: snap?.net_usdc_flow_usd       ?? 0,
      net_defi_usd:       snap?.net_defi_flow_usd       ?? 0,
      total_movements:    snap?.large_movements_count   ?? 0,
      unique_whales:      snap?.unique_whales_active    ?? 0,
    };

    // Week label
    const now   = new Date();
    const start = new Date(Date.now() - 7 * 24 * 3_600_000);
    const fmt   = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const weekLabel = `${fmt(start)} – ${fmt(now)}`;

    return NextResponse.json({
      ok:           true,
      bias_history: biasHistory,
      flow_summary: flowSummary,
      dominant_bias: dominantBias,
      avg_score:    avgScore,
      high_score:   highScore,
      low_score:    lowScore,
      week_label:   weekLabel,
    });
  } catch (err) {
    console.error('[api/weekly-report]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
