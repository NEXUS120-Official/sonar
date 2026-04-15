// ============================================================
// SONAR v2.0 — GET /api/bias-index
// ============================================================
// Returns current Bias Index computed from the latest 4h snapshot,
// plus last 24h of history (one point per cron run).
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { calculateBiasIndex } from '@/lib/flow-engine/bias-index';
import type { FlowSnapshotRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    const [snapRes, histRes] = await Promise.all([
      db.from('flow_snapshots')
        .select('*')
        .eq('window_hours', 4)
        .order('snapshot_time', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db.from('bias_index_history')
        .select('score, bias, components, confidence, created_at')
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: true }),
    ]);

    const snap = snapRes.data as FlowSnapshotRow | null;

    if (!snap) {
      return NextResponse.json({ ok: false, error: 'No snapshot data yet' }, { status: 404 });
    }

    const current = calculateBiasIndex({
      sol_net_exchange_flow_usd: snap.sol_net_exchange_flow_usd,
      net_staking_flow_usd:      snap.net_staking_flow_usd,
      net_usdc_flow_usd:         snap.net_usdc_flow_usd,
      net_defi_flow_usd:         snap.net_defi_flow_usd,
    });

    const history = (histRes.data ?? []).map((r: any) => ({
      score:      r.score,
      bias:       r.bias,
      confidence: r.confidence,
      created_at: r.created_at,
    }));

    return NextResponse.json({
      ok:           true,
      snapshot_time: snap.snapshot_time,
      window_hours:  4,
      current,
      history_24h:   history,
    });
  } catch (err) {
    console.error('[api/bias-index]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
