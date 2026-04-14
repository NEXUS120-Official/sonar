// ============================================================
// Staking Flow Page
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { SummaryCard } from '@/components/SummaryCard';
import { MovementRow } from '@/components/MovementRow';
import type { MovementRow as MovRow } from '@/lib/supabase/types';

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

async function getData() {
  const db = createAdminClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: raw } = await db
    .from('movements')
    .select('id, flow_type, from_label, to_label, from_address, to_address, protocol, amount_usd, token, block_time')
    .in('flow_type', ['stake', 'unstake'])
    .gte('block_time', cutoff)
    .order('block_time', { ascending: false })
    .limit(200);

  const movements = (raw ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'from_label' | 'to_label' | 'from_address' | 'to_address' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
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
    .map(([protocol, v]) => ({ protocol, ...v, net: v.staked - v.unstaked }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const totalStaked   = movements.filter(m => m.flow_type === 'stake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
  const totalUnstaked = movements.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

  return { movements, byProtocol, totalStaked, totalUnstaked };
}

export default async function StakingFlowPage() {
  const { movements, byProtocol, totalStaked, totalUnstaked } = await getData();
  const net = totalStaked - totalUnstaked;

  return (
    <div className="p-8 flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>Staking Flow</h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>24-hour liquid staking activity</p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <SummaryCard title="Total Staked"   value={fmtUsd(totalStaked)}   accent="blue"  sub="SOL staked to protocols" />
        <SummaryCard title="Total Unstaked" value={fmtUsd(totalUnstaked)} accent="yellow" sub="SOL unstaked / withdrawn" />
        <SummaryCard
          title="Net Staking"
          value={(net >= 0 ? '+' : '') + fmtUsd(Math.abs(net))}
          accent={net >= 0 ? 'blue' : 'yellow'}
          sub={net >= 0 ? 'Net staking (risk-on)' : 'Net unstaking (risk-off)'}
        />
      </div>

      {byProtocol.length > 0 && (
        <div>
          <h2 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--font-heading)' }}>By Protocol</h2>
          <div className="flex flex-col gap-2">
            {byProtocol.map(({ protocol, staked, unstaked, net: pNet, count }) => (
              <div
                key={protocol}
                className="flex items-center gap-4 px-5 py-3 rounded-lg border"
                style={{ background: '#12121a', borderColor: '#1e1e2e' }}
              >
                <span className="font-semibold w-28 capitalize" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef' }}>
                  {protocol}
                </span>
                <span className="text-sm w-24" style={{ color: '#00b8ff', fontFamily: 'var(--font-mono)' }}>↑ {fmtUsd(staked)}</span>
                <span className="text-sm w-24" style={{ color: '#ffd60a', fontFamily: 'var(--font-mono)' }}>↓ {fmtUsd(unstaked)}</span>
                <span className="text-sm font-bold w-24" style={{ color: pNet >= 0 ? '#00b8ff' : '#ffd60a', fontFamily: 'var(--font-mono)' }}>
                  {pNet >= 0 ? '+' : ''}{fmtUsd(Math.abs(pNet))}
                </span>
                <span className="text-xs ml-auto" style={{ color: '#4b4b60' }}>{count} txns</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--font-heading)' }}>Recent Events</h2>
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
