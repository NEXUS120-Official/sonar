'use client';
// ============================================================
// ExchangeFlowBreakdown — per-exchange bar chart + table
// ============================================================

interface ExchangeItem {
  exchange:       string;
  inflow_usd:     number;
  outflow_usd:    number;
  net_usd:        number;
  interpretation: string;
  trend?: {
    net_change_pct: number | null;
  };
}

interface ExchangeFlowBreakdownProps {
  items:        ExchangeItem[];
  window_hours?: number;
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${Math.round(abs / 1_000)}K`;
  return `$${Math.round(abs)}`;
}

function netColor(net: number): string {
  if (net >  50_000) return '#00e599';
  if (net < -50_000) return '#ff4757';
  return '#6b6b80';
}

function interpBadge(interp: string): { text: string; color: string; bg: string } {
  if (interp.includes('accumulation')) return { text: 'Accumulation', color: '#00e599', bg: '#00e59918' };
  if (interp.includes('distribution')) return { text: 'Distribution', color: '#ff4757', bg: '#ff475718' };
  return { text: 'Balanced', color: '#6b6b80', bg: '#6b6b8018' };
}

function ExchangeBar({ item, maxVol }: { item: ExchangeItem; maxVol: number }) {
  const inflowPct  = maxVol > 0 ? (item.inflow_usd  / maxVol) * 100 : 0;
  const outflowPct = maxVol > 0 ? (item.outflow_usd / maxVol) * 100 : 0;
  const badge      = interpBadge(item.interpretation);
  const netCol     = netColor(item.net_usd);
  const trend      = item.trend?.net_change_pct;
  const isSpike    = trend !== null && trend !== undefined && Math.abs(trend) > 200;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 0', borderBottom: '1px solid #1e1e2e' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--font-heading)', fontSize: 13, fontWeight: 600, color: '#e0e0f0', textTransform: 'capitalize' }}>
            {item.exchange}
          </span>
          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, color: badge.color, background: badge.bg }}>
            {badge.text}
          </span>
          {isSpike && (
            <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, color: '#ffd60a', background: '#ffd60a18' }}>
              ⚡ Spike
            </span>
          )}
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: netCol, fontFamily: 'var(--font-mono)' }}>
          {item.net_usd >= 0 ? '+' : ''}{fmtUsd(item.net_usd)}
          {trend !== null && trend !== undefined && (
            <span style={{ fontSize: 10, color: '#6b6b80', marginLeft: 6 }}>
              {trend > 0 ? '↑' : '↓'}{Math.abs(trend)}% vs prior
            </span>
          )}
        </span>
      </div>

      {/* Dual bar */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#6b6b80', width: 40, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>out</span>
          <div style={{ flex: 1, height: 6, background: '#1e1e2e', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${outflowPct}%`, height: '100%', background: '#00e599', borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 10, color: '#9b9bb0', width: 60, fontFamily: 'var(--font-mono)' }}>{fmtUsd(item.outflow_usd)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 10, color: '#6b6b80', width: 40, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>in</span>
          <div style={{ flex: 1, height: 6, background: '#1e1e2e', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${inflowPct}%`, height: '100%', background: '#ff4757', borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: 10, color: '#9b9bb0', width: 60, fontFamily: 'var(--font-mono)' }}>{fmtUsd(item.inflow_usd)}</span>
        </div>
      </div>
    </div>
  );
}

export function ExchangeFlowBreakdown({ items, window_hours = 24 }: ExchangeFlowBreakdownProps) {
  if (!items || items.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#4b4b60', fontSize: 13 }}>
        No exchange flow data in this window.
      </div>
    );
  }

  const maxVol = Math.max(...items.map(i => Math.max(i.inflow_usd, i.outflow_usd)));
  const totalNet = items.reduce((s, i) => s + i.net_usd, 0);
  const netCol   = netColor(totalNet);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {window_hours}h exchange breakdown
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: netCol, fontFamily: 'var(--font-mono)' }}>
          Net: {totalNet >= 0 ? '+' : ''}{fmtUsd(totalNet)}
        </span>
      </div>

      {/* Bars */}
      {items.map(item => (
        <ExchangeBar key={item.exchange} item={item} maxVol={maxVol} />
      ))}
    </div>
  );
}
