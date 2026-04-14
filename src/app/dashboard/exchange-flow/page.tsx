// ============================================================
// Exchange Flow Page
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
    .select('id, flow_type, from_label, to_label, from_address, to_address, exchange, amount_usd, token, block_time')
    .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
    .gte('block_time', cutoff)
    .order('block_time', { ascending: false })
    .limit(200);

  const movements = (raw ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'from_label' | 'to_label' | 'from_address' | 'to_address' | 'exchange' | 'amount_usd' | 'token' | 'block_time'
  >[];

  // Group by exchange
  const map = new Map<string, { inflow: number; outflow: number; count: number }>();
  for (const m of movements) {
    const key = m.exchange ?? 'unknown';
    const e = map.get(key) ?? { inflow: 0, outflow: 0, count: 0 };
    const usd = m.amount_usd ?? 0;
    if (m.flow_type === 'exchange_deposit')    e.inflow  += usd;
    if (m.flow_type === 'exchange_withdrawal') e.outflow += usd;
    e.count++;
    map.set(key, e);
  }

  const byExchange = Array.from(map.entries())
    .map(([exchange, v]) => ({ exchange, ...v, net: v.outflow - v.inflow }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const totalIn  = movements.filter(m => m.flow_type === 'exchange_deposit').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
  const totalOut = movements.filter(m => m.flow_type === 'exchange_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

  return { movements, byExchange, totalIn, totalOut };
}

export default async function ExchangeFlowPage() {
  const { movements, byExchange, totalIn, totalOut } = await getData();
  const net = totalOut - totalIn;

  return (
    <div className="p-8 flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>Exchange Flow</h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>24-hour SOL exchange deposits & withdrawals</p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard title="Total Inflow"  value={fmtUsd(totalIn)}  accent="red"  sub="Deposits → exchanges" />
        <SummaryCard title="Total Outflow" value={fmtUsd(totalOut)} accent="green" sub="Withdrawals ← exchanges" />
        <SummaryCard
          title="Net Flow"
          value={(net >= 0 ? '+' : '') + fmtUsd(Math.abs(net))}
          accent={net < 0 ? 'green' : 'red'}
          sub={net < 0 ? 'Accumulation signal' : 'Sell pressure signal'}
        />
      </div>

      {/* Per-exchange breakdown */}
      {byExchange.length > 0 && (
        <div>
          <h2 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--font-heading)' }}>By Exchange</h2>
          <div className="flex flex-col gap-2">
            {byExchange.map(({ exchange, inflow, outflow, net: exNet, count }) => (
              <div
                key={exchange}
                className="flex items-center gap-4 px-5 py-3 rounded-lg border"
                style={{ background: '#12121a', borderColor: '#1e1e2e' }}
              >
                <span className="font-semibold w-24 capitalize" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef' }}>
                  {exchange}
                </span>
                <span className="text-sm w-20" style={{ color: '#ff4757', fontFamily: 'var(--font-mono)' }}>↑ {fmtUsd(inflow)}</span>
                <span className="text-sm w-20" style={{ color: '#00e599', fontFamily: 'var(--font-mono)' }}>↓ {fmtUsd(outflow)}</span>
                <span className="text-sm font-bold w-24" style={{ color: exNet < 0 ? '#00e599' : '#ff4757', fontFamily: 'var(--font-mono)' }}>
                  {exNet >= 0 ? '+' : ''}{fmtUsd(Math.abs(exNet))}
                </span>
                <span className="text-xs ml-auto" style={{ color: '#4b4b60' }}>{count} txns</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Movement list */}
      <div>
        <h2 className="text-base font-semibold mb-3" style={{ fontFamily: 'var(--font-heading)' }}>
          Recent Movements
        </h2>
        {movements.length === 0 ? (
          <div className="rounded-xl border p-8 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
            <p className="text-sm">No exchange movements in the last 24 hours.</p>
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
