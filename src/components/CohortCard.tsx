'use client';
// ============================================================
// CohortCard — Whale Cohort breakdown (Innovation 7)
// ============================================================

type WhaleCohort =
  | 'accumulator'
  | 'distributor'
  | 'staker'
  | 'defi_user'
  | 'opportunist'
  | 'dormant';

interface CohortGroup {
  cohort:           WhaleCohort;
  count:            number;
  pct:              number;
  net_exchange_usd: number;
  net_staking_usd:  number;
}

interface WhaleResult {
  address:         string;
  label?:          string | null;
  cohort:          WhaleCohort;
  cohort_score:    number;
  signals:         string[];
  total_value_usd?: number | null;
  net_exchange_usd: number;
  net_staking_usd:  number;
  net_defi_usd:     number;
  movement_count:   number;
}

interface CohortCardProps {
  groups:    CohortGroup[];
  whales:    WhaleResult[];
  dormant:   number;
  total:     number;
  hours?:    number;
  showWhales?: boolean;
}

const COHORT_META: Record<WhaleCohort, { label: string; emoji: string; color: string; bg: string }> = {
  accumulator: { label: 'Accumulator', emoji: '🟢', color: '#00e599', bg: '#00e59918' },
  distributor: { label: 'Distributor', emoji: '🔴', color: '#ff4757', bg: '#ff475718' },
  staker:      { label: 'Staker',      emoji: '🔒', color: '#7b68ee', bg: '#7b68ee18' },
  defi_user:   { label: 'DeFi User',   emoji: '⚡', color: '#ffd60a', bg: '#ffd60a18' },
  opportunist: { label: 'Opportunist', emoji: '↔️', color: '#9b9bb0', bg: '#9b9bb018' },
  dormant:     { label: 'Dormant',     emoji: '💤', color: '#4b4b60', bg: '#1e1e2e' },
};

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${Math.round(abs / 1_000)}K`;
  return `$${Math.round(abs)}`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function DonutSegment({
  groups, total,
}: { groups: CohortGroup[]; total: number }) {
  const cx = 60, cy = 60, r = 44, sw = 16;
  let cumPct = 0;

  function arc(startPct: number, endPct: number) {
    const s = (startPct / 100) * 2 * Math.PI - Math.PI / 2;
    const e = (endPct   / 100) * 2 * Math.PI - Math.PI / 2;
    const sx = cx + r * Math.cos(s), sy = cy + r * Math.sin(s);
    const ex = cx + r * Math.cos(e), ey = cy + r * Math.sin(e);
    const large = (endPct - startPct) > 50 ? 1 : 0;
    return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey}`;
  }

  const active = groups.filter(g => g.cohort !== 'dormant');

  return (
    <svg width={120} height={120} viewBox="0 0 120 120">
      {active.length === 0 && (
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1e1e2e" strokeWidth={sw} />
      )}
      {active.map(g => {
        const start = cumPct;
        cumPct += g.pct;
        const meta = COHORT_META[g.cohort];
        return (
          <path
            key={g.cohort}
            d={arc(start, cumPct)}
            fill="none"
            stroke={meta.color}
            strokeWidth={sw}
            strokeLinecap="butt"
            opacity={0.85}
          >
            <title>{meta.label}: {g.count} whales ({g.pct}%)</title>
          </path>
        );
      })}
      <text x={cx} y={cy - 6} textAnchor="middle" fill="#e0e0f0" fontSize={18} fontWeight={700} fontFamily="var(--font-heading)">
        {total}
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill="#6b6b80" fontSize={9} fontFamily="var(--font-mono)">
        whales
      </text>
    </svg>
  );
}

export function CohortCard({
  groups,
  whales,
  dormant,
  total,
  hours = 24,
  showWhales = false,
}: CohortCardProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header row: donut + group bars */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <DonutSegment groups={groups} total={total} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{ fontSize: 10, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>
            Cohorts ({hours}h)
          </p>
          {groups.map(g => {
            const meta = COHORT_META[g.cohort];
            return (
              <div key={g.cohort}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                  <span style={{ fontSize: 11, color: meta.color }}>
                    {meta.emoji} {meta.label}
                  </span>
                  <span style={{ fontSize: 11, color: '#9b9bb0', fontFamily: 'var(--font-mono)' }}>
                    {g.count} · {g.pct}%
                  </span>
                </div>
                <div style={{ height: 4, background: '#1e1e2e', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${g.pct}%`, height: '100%', background: meta.color, borderRadius: 2, opacity: 0.8 }} />
                </div>
              </div>
            );
          })}
          {dormant > 0 && (
            <p style={{ fontSize: 10, color: '#4b4b60', margin: '4px 0 0', fontFamily: 'var(--font-mono)' }}>
              + {dormant} dormant
            </p>
          )}
        </div>
      </div>

      {/* Per-whale list (optional) */}
      {showWhales && whales.length > 0 && (
        <div>
          <p style={{ fontSize: 10, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Top Active Whales
          </p>
          {whales.slice(0, 10).map(w => {
            const meta = COHORT_META[w.cohort];
            return (
              <div key={w.address} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid #1e1e2e' }}>
                <div>
                  <span style={{ fontSize: 11, color: '#c0c0d8', fontFamily: 'var(--font-mono)' }}>
                    {w.label ?? shortAddr(w.address)}
                  </span>
                  <p style={{ fontSize: 10, color: '#4b4b60', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
                    {w.signals.slice(0, 1).join(' · ')}
                  </p>
                </div>
                <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, color: meta.color, background: meta.bg, whiteSpace: 'nowrap' }}>
                  {meta.emoji} {meta.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}
