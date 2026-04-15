'use client';
// ============================================================
// WeeklyReport — 7-day summary card (Innovation 5)
// ============================================================

interface WeeklyBiasPoint {
  score: number;
  bias:  string;
  created_at: string;
}

interface WeeklyFlowSummary {
  net_exchange_usd:  number;
  net_staking_usd:   number;
  net_stablecoin_usd: number;
  net_defi_usd:      number;
  total_movements:   number;
  unique_whales:     number;
}

interface WeeklyReportProps {
  biasHistory:    WeeklyBiasPoint[];   // last 7d from bias_index_history
  flowSummary:    WeeklyFlowSummary;   // aggregated 168h snapshot
  dominantBias:   string | null;
  avgScore:       number | null;
  highScore:      number | null;
  lowScore:       number | null;
  weekLabel?:     string;
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000)     return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)         return `$${Math.round(abs / 1_000)}K`;
  return `$${Math.round(abs)}`;
}

function biasColor(bias: string | null): string {
  if (!bias) return '#6b6b80';
  if (bias.includes('bullish')) return '#00e599';
  if (bias.includes('bearish')) return '#ff4757';
  return '#ffd60a';
}

function biasLabel(bias: string | null): string {
  switch (bias) {
    case 'extreme_bullish': return 'Extreme Bullish';
    case 'bullish':         return 'Bullish';
    case 'neutral':         return 'Neutral';
    case 'bearish':         return 'Bearish';
    case 'extreme_bearish': return 'Extreme Bearish';
    default:                return '—';
  }
}

function MiniSparkline({ data }: { data: WeeklyBiasPoint[] }) {
  if (data.length < 2) return null;
  const W = 300, H = 48;
  const pad = { l: 4, r: 4, t: 4, b: 4 };
  const iW = W - pad.l - pad.r;
  const iH = H - pad.t - pad.b;
  const toY = (s: number) => pad.t + ((100 - s) / 200) * iH;
  const toX = (i: number) => pad.l + (i / (data.length - 1)) * iW;
  const pts  = data.map((d, i) => `${toX(i)},${toY(d.score)}`).join(' L ');
  const last = data[data.length - 1];
  const color = last.score >= 20 ? '#00e599' : last.score <= -20 ? '#ff4757' : '#ffd60a';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H}>
      <line x1={pad.l} x2={pad.l + iW} y1={toY(0)} y2={toY(0)} stroke="#2a2a3a" strokeWidth={1} />
      <path d={`M ${pts}`} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={toX(data.length - 1)} cy={toY(last.score)} r={3} fill={color} />
    </svg>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ flex: 1, minWidth: 120, padding: '12px 14px', background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 10 }}>
      <p style={{ fontSize: 10, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
        {label}
      </p>
      <p style={{ fontSize: 20, fontWeight: 800, color: color ?? '#e0e0f0', fontFamily: 'var(--font-heading)', margin: '4px 0 2px' }}>
        {value}
      </p>
      {sub && (
        <p style={{ fontSize: 10, color: '#4b4b60', margin: 0, fontFamily: 'var(--font-mono)' }}>{sub}</p>
      )}
    </div>
  );
}

function FlowRow({ label, value }: { label: string; value: number }) {
  const color = value > 0 ? '#00e599' : value < 0 ? '#ff4757' : '#6b6b80';
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
      <span style={{ fontSize: 12, color: '#9b9bb0', fontFamily: 'var(--font-mono)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
        {value >= 0 ? '+' : ''}{fmtUsd(value)}
      </span>
    </div>
  );
}

export function WeeklyReport({
  biasHistory,
  flowSummary,
  dominantBias,
  avgScore,
  highScore,
  lowScore,
  weekLabel,
}: WeeklyReportProps) {
  const domColor = biasColor(dominantBias);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <p style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
            Weekly Report
          </p>
          <p style={{ fontSize: 13, color: '#4b4b60', fontFamily: 'var(--font-mono)', margin: '2px 0 0' }}>
            {weekLabel ?? 'Last 7 days'}
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: domColor, textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-heading)' }}>
            {biasLabel(dominantBias)}
          </span>
          <p style={{ fontSize: 10, color: '#4b4b60', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>dominant bias</p>
        </div>
      </div>

      {/* Sparkline */}
      {biasHistory.length >= 2 && (
        <div style={{ padding: '8px 0' }}>
          <MiniSparkline data={biasHistory} />
        </div>
      )}

      {/* Score stats */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <StatCard
          label="Avg Score"
          value={avgScore !== null ? `${avgScore > 0 ? '+' : ''}${avgScore.toFixed(0)}` : '—'}
          color={avgScore !== null ? biasColor(avgScore >= 20 ? 'bullish' : avgScore <= -20 ? 'bearish' : 'neutral') : undefined}
        />
        <StatCard
          label="Peak"
          value={highScore !== null ? `+${highScore}` : '—'}
          color="#00e599"
        />
        <StatCard
          label="Trough"
          value={lowScore !== null ? `${lowScore}` : '—'}
          color="#ff4757"
        />
        <StatCard
          label="Whales Active"
          value={flowSummary.unique_whales.toString()}
          sub={`${flowSummary.total_movements} movements`}
        />
      </div>

      {/* 7d Flow breakdown */}
      <div>
        <p style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
          7d Net Flows
        </p>
        <FlowRow label="Exchange"   value={flowSummary.net_exchange_usd} />
        <FlowRow label="Staking"    value={flowSummary.net_staking_usd} />
        <FlowRow label="Stablecoin" value={flowSummary.net_stablecoin_usd} />
        <FlowRow label="DeFi"       value={flowSummary.net_defi_usd} />
      </div>

    </div>
  );
}
