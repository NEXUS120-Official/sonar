// ============================================================
// SONAR v2.0 — GET /api/flow/staking
// ============================================================
// Staking flow breakdown with velocity and trend.
//
// Returns:
//   - per-protocol staked / unstaked / net
//   - staking_velocity from latest 4h snapshot
//   - trend vs prior 24h window
//   - recent staking events
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow, FlowSnapshotRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/staking] ${msg}`, ctx ?? '');
}

const WINDOW_HOURS   = 24;
const TOP_MOVEMENTS  = 20;

// ── Velocity interpretation ───────────────────────────────────

function interpretVelocity(pct: number | null): string | null {
  if (pct === null) return null;
  const abs = Math.abs(pct);
  if (abs < 10) return 'stable';
  if (pct >  200) return 'surge';
  if (pct >   50) return 'strongly accelerating';
  if (pct >   10) return 'accelerating';
  if (pct < -200) return 'collapse';
  if (pct <  -50) return 'strongly decelerating';
  return 'decelerating';
}

function interpretNetFlow(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000) return 'flat';
  if (net > 0) {
    if (abs < 200_000) return 'mild staking inflow';
    if (abs < 1_000_000) return 'moderate staking inflow';
    return 'strong staking inflow';
  } else {
    if (abs < 200_000) return 'mild unstaking';
    if (abs < 1_000_000) return 'moderate unstaking';
    return 'heavy unstaking';
  }
}

type ProtocolBucket = { staked: number; unstaked: number; count: number };

function aggregateByProtocol(
  movements: Pick<MovementRow, 'flow_type' | 'protocol' | 'amount_usd'>[],
): Map<string, ProtocolBucket> {
  const map = new Map<string, ProtocolBucket>();
  for (const m of movements) {
    const key = m.protocol ?? 'unknown';
    const entry = map.get(key) ?? { staked: 0, unstaked: 0, count: 0 };
    const usd = m.amount_usd ?? 0;
    if (m.flow_type === 'stake')   entry.staked   += usd;
    if (m.flow_type === 'unstake') entry.unstaked += usd;
    entry.count++;
    map.set(key, entry);
  }
  return map;
}

// ── Handler ───────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    const db  = createAdminClient();
    const now = Date.now();
    const cutoffCurr = new Date(now - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const cutoffPrev = new Date(now - 2 * WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    // Load 48h of staking movements and latest 4h snapshot in parallel
    const [movResult, snapResult] = await Promise.all([
      db.from('movements')
        .select('id, from_address, to_address, from_label, flow_type, protocol, amount_usd, token, block_time')
        .in('flow_type', ['stake', 'unstake'])
        .gte('block_time', cutoffPrev)
        .order('block_time', { ascending: false })
        .limit(500),
      db.from('flow_snapshots')
        .select('staking_velocity_pct, snapshot_time, net_staking_flow_usd, confirmation_count')
        .eq('window_hours', 4)
        .order('snapshot_time', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (movResult.error) {
      log('DB error', movResult.error.message);
      return NextResponse.json({ ok: false, error: movResult.error.message }, { status: 500 });
    }

    const all = (movResult.data ?? []) as Pick<
      MovementRow,
      'id' | 'from_address' | 'to_address' | 'from_label' |
      'flow_type' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
    >[];

    const currMovements = all.filter(m => m.block_time >= cutoffCurr);
    const prevMovements = all.filter(m => m.block_time < cutoffCurr);

    const snap4h = (snapResult.data ?? null) as Pick<
      FlowSnapshotRow,
      'staking_velocity_pct' | 'snapshot_time' | 'net_staking_flow_usd' | 'confirmation_count'
    > | null;

    // ── Per-protocol breakdown ────────────────────────────────
    const currMap = aggregateByProtocol(currMovements);
    const prevMap = aggregateByProtocol(prevMovements);

    const byProtocol = Array.from(currMap.entries())
      .map(([protocol, v]) => {
        const prev    = prevMap.get(protocol) ?? { staked: 0, unstaked: 0, count: 0 };
        const net     = v.staked - v.unstaked;
        const prevNet = prev.staked - prev.unstaked;
        const netChangePct = prevNet !== 0
          ? Math.round(((net - prevNet) / Math.abs(prevNet)) * 100)
          : null;
        return {
          protocol,
          staked_usd:   v.staked,
          unstaked_usd: v.unstaked,
          net_usd:      net,
          count:        v.count,
          trend: {
            prev_net_usd:   prevNet,
            net_change_pct: netChangePct,
          },
        };
      })
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

    // ── Totals ────────────────────────────────────────────────
    const totalStaked   = currMovements.filter(m => m.flow_type === 'stake')  .reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalUnstaked = currMovements.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalNet      = totalStaked - totalUnstaked;

    const prevStaked    = prevMovements.filter(m => m.flow_type === 'stake')  .reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const prevUnstaked  = prevMovements.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const prevTotalNet  = prevStaked - prevUnstaked;
    const totalNetChangePct = prevTotalNet !== 0
      ? Math.round(((totalNet - prevTotalNet) / Math.abs(prevTotalNet)) * 100)
      : null;

    // ── Velocity (from 4h snapshot) ───────────────────────────
    const velocity_pct            = snap4h?.staking_velocity_pct ?? null;
    const velocity_interpretation = interpretVelocity(velocity_pct);

    log(`${currMovements.length} movements — net $${totalNet.toFixed(0)} — velocity ${velocity_pct?.toFixed(1) ?? 'n/a'}%`);

    return NextResponse.json({
      ok:           true,
      window_hours: WINDOW_HOURS,
      totals: {
        staked_usd:     totalStaked,
        unstaked_usd:   totalUnstaked,
        net_usd:        totalNet,
        count:          currMovements.length,
        prev_net_usd:   prevTotalNet,
        net_change_pct: totalNetChangePct,
        interpretation: interpretNetFlow(totalNet),
      },
      velocity: {
        pct:            velocity_pct,
        interpretation: velocity_interpretation,
        snapshot_time:  snap4h?.snapshot_time ?? null,
      },
      by_protocol:  byProtocol,
      recent:       currMovements.slice(0, TOP_MOVEMENTS).map(m => ({
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
