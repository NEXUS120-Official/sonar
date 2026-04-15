// ============================================================
// Staking Flow Page — with StakingVelocity
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { SummaryCard } from '@/components/SummaryCard';
import { MovementRow } from '@/components/MovementRow';
import { StakingVelocity } from '@/components/StakingVelocity';
import type { MovementRow as MovRow } from '@/lib/supabase/types';

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function velocityInterp(pct: number | null): string | null {
  if (pct === null) return null;
  if (pct > 200)   return 'surge';
  if (pct > 50)    return 'strongly accelerating';
  if (pct > 10)    return 'accelerating';
  if (pct > -10)   return 'stable';
  if (pct > -50)   return 'decelerating';
  if (pct > -200)  return 'strongly decelerating';
  return 'collapse';
}

async function getData() {
  const db     = createAdminClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [movRes, snapRes] = await Promise.all([
    db.from('movements')
      .select('id, flow_type, flow_direction, from_label, to_label, from_address, to_address, protocol, amount_usd, token, block_time')
      .in('flow_type', ['stake', 'unstake'])
      .gte('block_time', cutoff)
      .order('block_time', { ascending: false })
      .limit(500),

    // Last two 4h snapshots for velocity
    db.from('flow_snapshots')
      .select('net_staking_flow_usd, staking_velocity_pct, created_at')
      .eq('window_hours', 4)
      .order('created_at', { ascending: false })
      .limit(2),
  ]);

  const movements = (movRes.data ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'flow_direction' | 'from_label' | 'to_label' |
    'from_address' | 'to_address' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
  >[];

  const map = new Map<string, { staked: number; unstaked: number; count: number }>();
  for (const m of movements) {
    const key = m.protocol ?? 'unknown';
    const e = map.get(key) ?? { staked: 0, unstaked: 0, count: 0 };
    if (m.flow_type === 'stake')   e.staked   += m.amount_usd ?? 0;
    if (m.flow_type === 'unstake') e.unstaked += m.amount_usd ?? 0;
    e.count++;
    map.set(key, e);
  }

  const byProtocol = Array.from(map.entries())
    .map(([protocol, v]) => ({
      protocol,
      staked_usd:  v.staked,
      unstaked_usd: v.unstaked,
      net_usd:     v.staked - v.unstaked,
    }))
    .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

  const totalStaked   = movements.filter(m => m.flow_type === 'stake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
  const totalUnstaked = movements.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

  // Velocity from latest 4h snapshot
  const snaps = (snapRes.data ?? []) as any[];
  const latestSnap = snaps[0] ?? null;
  const velPct: number | null = latestSnap?.staking_velocity_pct ?? null;

  return { movements, byProtocol, totalStaked, totalUnstaked, velPct };
}

export default async function StakingFlowPage() {
  const { movements, byProtocol, totalStaked, totalUnstaked, velPct } = await getData();
  const net = totalStaked - totalUnstaked;

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Staking Flow
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
          24-hour liquid staking activity
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard title="Total Staked"   value={fmtUsd(totalStaked)}   accent="blue"   sub="SOL staked to protocols" />
        <SummaryCard title="Total Unstaked" value={fmtUsd(totalUnstaked)} accent="yellow" sub="SOL unstaked / withdrawn" />
        <SummaryCard
          title="Net Staking"
          value={(net >= 0 ? '+' : '') + fmtUsd(Math.abs(net))}
          accent={net >= 0 ? 'blue' : 'yellow'}
          sub={net >= 0 ? 'Net staking (risk-on)' : 'Net unstaking (risk-off)'}
        />
      </div>

      {/* Staking Velocity widget */}
      <div
        className="rounded-xl border p-5"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
          Staking Velocity
        </p>
        <StakingVelocity
          totalStaked={totalStaked}
          totalUnstaked={totalUnstaked}
          netUsd={net}
          velocityPct={velPct}
          velocityInterp={velocityInterp(velPct)}
          byProtocol={byProtocol}
          windowHours={24}
        />
      </div>

      {/* Movement list */}
      <div>
        <h2 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--font-heading)' }}>
          Recent Events
        </h2>
        {movements.length === 0 ? (
          <div className="rounded-xl border p-8 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
            <p className="text-sm">No staking movements in the last 24 hours.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {movements.slice(0, 20).map(m => (
              <MovementRow key={m.id} m={{ ...m, from: m.from_address, to: m.to_address }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
