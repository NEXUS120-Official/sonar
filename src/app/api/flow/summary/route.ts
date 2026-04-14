// ============================================================
// SONAR v2.0 — GET /api/flow/summary
// ============================================================
// Returns the latest 24h flow snapshot with bias score,
// market direction, and aggregated flow metrics.
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { FlowSnapshotRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/summary] ${msg}`, ctx ?? '');
}

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    // Latest snapshot for each window: 1h, 4h, 24h
    const { data: snapshotsRaw, error } = await db
      .from('flow_snapshots')
      .select('*')
      .in('window_hours', [1, 4, 24])
      .order('snapshot_time', { ascending: false })
      .limit(30); // grab enough to cover all windows

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const snapshots = (snapshotsRaw ?? []) as FlowSnapshotRow[];

    // Pick latest snapshot per window
    const byWindow = new Map<number, FlowSnapshotRow>();
    for (const s of snapshots) {
      if (!byWindow.has(s.window_hours)) {
        byWindow.set(s.window_hours, s);
      }
    }

    const s24 = byWindow.get(24) ?? null;
    const s4  = byWindow.get(4)  ?? null;
    const s1  = byWindow.get(1)  ?? null;

    return NextResponse.json({
      ok:           true,
      snapshot_time: s24?.snapshot_time ?? null,
      bias: {
        score:  s24?.bias_score ?? null,
        label:  s24?.market_bias ?? null,
      },
      windows: {
        '1h': s1  ? formatWindow(s1)  : null,
        '4h': s4  ? formatWindow(s4)  : null,
        '24h': s24 ? formatWindow(s24) : null,
      },
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

function formatWindow(s: FlowSnapshotRow) {
  return {
    window_hours:             s.window_hours,
    bias_score:               s.bias_score,
    market_bias:              s.market_bias,
    exchange: {
      inflow_usd:             s.sol_exchange_inflow_usd,
      outflow_usd:            s.sol_exchange_outflow_usd,
      net_usd:                s.sol_net_exchange_flow_usd,
    },
    staking: {
      staked_usd:             s.sol_staked_usd,
      unstaked_usd:           s.sol_unstaked_usd,
      net_usd:                s.net_staking_flow_usd,
    },
    defi: {
      deposit_usd:            s.defi_deposit_usd,
      withdrawal_usd:         s.defi_withdrawal_usd,
      net_usd:                s.net_defi_flow_usd,
    },
    usdc: {
      inflow_usd:             s.usdc_inflow_usd,
      outflow_usd:            s.usdc_outflow_usd,
      net_usd:                s.net_usdc_flow_usd,
    },
    counts: {
      large_movements:        s.large_movements_count,
      unique_whales_active:   s.unique_whales_active,
    },
  };
}
