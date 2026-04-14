// ============================================================
// Dashboard Overview — FlowGauge + summary cards + movement feed
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { FlowGauge } from '@/components/FlowGauge';
import { SummaryCard } from '@/components/SummaryCard';
import { MovementRow } from '@/components/MovementRow';
import type { FlowSnapshotRow, MovementRow as MovRow } from '@/lib/supabase/types';

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function sign(v: number) { return v > 0 ? '+' : ''; }

async function getData() {
  const db = createAdminClient();

  const [snapRes, movRes] = await Promise.all([
    db.from('flow_snapshots')
      .select('*')
      .eq('window_hours', 24)
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from('movements')
      .select('id, flow_type, flow_direction, from_label, to_label, from_address, to_address, exchange, protocol, amount_usd, token, block_time')
      .order('block_time', { ascending: false })
      .limit(25),
  ]);

  const snap = (snapRes.data as FlowSnapshotRow | null);
  const movements = (movRes.data ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'flow_direction' | 'from_label' | 'to_label' |
    'from_address' | 'to_address' | 'exchange' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
  >[];

  return { snap, movements };
}

export default async function DashboardPage() {
  const { snap, movements } = await getData();

  const netExchange = snap?.sol_net_exchange_flow_usd ?? 0;
  const netStaking  = snap?.net_staking_flow_usd ?? 0;
  const netDefi     = snap?.net_defi_flow_usd ?? 0;

  return (
    <div className="p-8 flex flex-col gap-8">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            Flow Overview
          </h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            24-hour smart money activity · Solana
          </p>
        </div>
        {snap?.snapshot_time && (
          <p className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Last snapshot: {new Date(snap.snapshot_time).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* Gauge + cards row */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        {/* Gauge */}
        <div
          className="lg:col-span-1 flex flex-col items-center justify-center p-6 rounded-xl border"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            Bias Index
          </p>
          <FlowGauge
            score={snap?.bias_score ?? null}
            label={snap?.market_bias ?? null}
            size={180}
          />
        </div>

        {/* Metric cards */}
        <div className="lg:col-span-3 grid grid-cols-2 md:grid-cols-3 gap-4">
          <SummaryCard
            title="Exchange Net Flow"
            value={snap ? `${sign(netExchange)}${fmtUsd(Math.abs(netExchange))}` : '—'}
            sub={netExchange < 0 ? 'Net outflow (accumulation)' : netExchange > 0 ? 'Net inflow (sell pressure)' : 'Balanced'}
            accent={netExchange < 0 ? 'green' : netExchange > 0 ? 'red' : 'muted'}
          />
          <SummaryCard
            title="Staking Net Flow"
            value={snap ? `${sign(netStaking)}${fmtUsd(Math.abs(netStaking))}` : '—'}
            sub={netStaking > 0 ? 'Net staking (bullish)' : 'Net unstaking'}
            accent={netStaking > 0 ? 'blue' : 'yellow'}
          />
          <SummaryCard
            title="DeFi Net Flow"
            value={snap ? `${sign(netDefi)}${fmtUsd(Math.abs(netDefi))}` : '—'}
            sub="Protocol deposits vs. withdrawals"
            accent="blue"
          />
          <SummaryCard
            title="Large Movements"
            value={snap ? String(snap.large_movements_count) : '—'}
            sub="Transactions > $50K"
            accent="yellow"
          />
          <SummaryCard
            title="Active Whales"
            value={snap ? String(snap.unique_whales_active) : '—'}
            sub="Unique wallets in window"
            accent="muted"
          />
          <SummaryCard
            title="Exchange Inflow"
            value={snap ? fmtUsd(snap.sol_exchange_inflow_usd) : '—'}
            sub={snap ? `Outflow: ${fmtUsd(snap.sol_exchange_outflow_usd)}` : ''}
            accent="muted"
          />
        </div>
      </div>

      {/* Movement feed */}
      <div>
        <h2 className="text-base font-semibold mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
          Recent Movements
        </h2>

        {movements.length === 0 ? (
          <div
            className="rounded-xl border p-8 text-center"
            style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}
          >
            <p className="text-sm">No movements recorded yet.</p>
            <p className="text-xs mt-1" style={{ color: '#4b4b60' }}>Movements appear once Helius delivers real webhook events.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {movements.map(m => (
              <MovementRow key={m.id} m={{
                ...m,
                from: m.from_address,
                to:   m.to_address,
              }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
