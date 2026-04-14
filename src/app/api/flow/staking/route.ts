// ============================================================
// SONAR v2.0 — GET /api/flow/staking
// ============================================================
// Returns staking flow breakdown:
//   - net staking flow (last 24h)
//   - breakdown per protocol
//   - recent staking events
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/staking] ${msg}`, ctx ?? '');
}

const WINDOW_HOURS = 24;
const TOP_MOVEMENTS = 20;

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();
    const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: rawMovements, error } = await db
      .from('movements')
      .select('id, from_address, to_address, from_label, to_label, flow_type, protocol, amount_usd, token, block_time')
      .in('flow_type', ['stake', 'unstake'])
      .gte('block_time', cutoff)
      .order('block_time', { ascending: false })
      .limit(500);

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const movements = (rawMovements ?? []) as Pick<
      MovementRow,
      'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' |
      'flow_type' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
    >[];

    // Group by protocol
    const protocolMap = new Map<string, { staked: number; unstaked: number; count: number }>();
    for (const m of movements) {
      const key = m.protocol ?? 'unknown';
      const entry = protocolMap.get(key) ?? { staked: 0, unstaked: 0, count: 0 };
      const usd = m.amount_usd ?? 0;
      if (m.flow_type === 'stake')   entry.staked   += usd;
      if (m.flow_type === 'unstake') entry.unstaked += usd;
      entry.count++;
      protocolMap.set(key, entry);
    }

    const byProtocol = Array.from(protocolMap.entries())
      .map(([protocol, v]) => ({
        protocol,
        staked_usd:   v.staked,
        unstaked_usd: v.unstaked,
        net_usd:      v.staked - v.unstaked,
        count:        v.count,
      }))
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

    const total_staked   = movements.filter(m => m.flow_type === 'stake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const total_unstaked = movements.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

    return NextResponse.json({
      ok:           true,
      window_hours: WINDOW_HOURS,
      totals: {
        staked_usd:   total_staked,
        unstaked_usd: total_unstaked,
        net_usd:      total_staked - total_unstaked,
        count:        movements.length,
      },
      by_protocol:  byProtocol,
      recent:       movements.slice(0, TOP_MOVEMENTS).map(m => ({
        id:         m.id,
        flow_type:  m.flow_type,
        protocol:   m.protocol,
        token:      m.token,
        amount_usd: m.amount_usd,
        from:       m.from_label ?? m.from_address,
        block_time: m.block_time,
      })),
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
