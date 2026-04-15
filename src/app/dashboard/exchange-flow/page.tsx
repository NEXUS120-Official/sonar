// ============================================================
// Exchange Flow Page — with ExchangeFlowBreakdown
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { SummaryCard } from '@/components/SummaryCard';
import { MovementRow } from '@/components/MovementRow';
import { ExchangeFlowBreakdown } from '@/components/ExchangeFlowBreakdown';
import type { MovementRow as MovRow } from '@/lib/supabase/types';

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function exchangeInterp(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000)   return 'balanced flow';
  if (net > 0) {
    if (abs < 250_000)  return 'mild accumulation';
    if (abs < 1_000_000) return 'moderate accumulation';
    return 'strong accumulation';
  }
  if (abs < 250_000)  return 'mild distribution';
  if (abs < 1_000_000) return 'moderate distribution';
  return 'strong distribution';
}

async function getData() {
  const db     = createAdminClient();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const prior  = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const [currentRes, priorRes] = await Promise.all([
    db.from('movements')
      .select('id, flow_type, flow_direction, from_label, to_label, from_address, to_address, exchange, amount_usd, token, block_time')
      .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
      .gte('block_time', cutoff)
      .order('block_time', { ascending: false })
      .limit(500),

    db.from('movements')
      .select('exchange, flow_type, amount_usd')
      .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
      .gte('block_time', prior)
      .lt('block_time', cutoff),
  ]);

  const movements = (currentRes.data ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'flow_direction' | 'from_label' | 'to_label' |
    'from_address' | 'to_address' | 'exchange' | 'amount_usd' | 'token' | 'block_time'
  >[];

  // Current window per-exchange
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

  // Prior window per-exchange (for trend)
  const priorMap = new Map<string, number>(); // exchange → prior net
  for (const m of (priorRes.data ?? []) as any[]) {
    const key = (m.exchange as string) ?? 'unknown';
    const usd = (m.amount_usd as number) ?? 0;
    const sign = m.flow_type === 'exchange_withdrawal' ? 1 : -1;
    priorMap.set(key, (priorMap.get(key) ?? 0) + sign * usd);
  }

  const byExchange = Array.from(map.entries())
    .map(([exchange, v]) => {
      const net     = v.outflow - v.inflow; // positive = accumulation
      const priorNet = priorMap.get(exchange) ?? 0;
      const netChangePct = priorNet !== 0
        ? Math.round(((net - priorNet) / Math.abs(priorNet)) * 100)
        : null;
      return {
        exchange,
        inflow_usd:     v.inflow,
        outflow_usd:    v.outflow,
        net_usd:        net,
        interpretation: exchangeInterp(net),
        trend:          { net_change_pct: netChangePct },
      };
    })
    .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

  const totalIn  = movements.filter(m => m.flow_type === 'exchange_deposit').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
  const totalOut = movements.filter(m => m.flow_type === 'exchange_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

  return { movements, byExchange, totalIn, totalOut };
}

export default async function ExchangeFlowPage() {
  const { movements, byExchange, totalIn, totalOut } = await getData();
  const net = totalOut - totalIn;

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Exchange Flow
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
          24-hour SOL exchange deposits &amp; withdrawals
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard title="Total Inflow"  value={fmtUsd(totalIn)}  accent="red"   sub="Deposits → exchanges" />
        <SummaryCard title="Total Outflow" value={fmtUsd(totalOut)} accent="green" sub="Withdrawals ← exchanges" />
        <SummaryCard
          title="Net Flow"
          value={(net >= 0 ? '+' : '') + fmtUsd(Math.abs(net))}
          accent={net > 0 ? 'green' : 'red'}
          sub={net > 0 ? 'Accumulation signal' : 'Sell pressure signal'}
        />
      </div>

      {/* Exchange breakdown */}
      {byExchange.length > 0 && (
        <div
          className="rounded-xl border p-5"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <ExchangeFlowBreakdown items={byExchange} window_hours={24} />
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
