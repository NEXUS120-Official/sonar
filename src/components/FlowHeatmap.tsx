'use client';
// ============================================================
// FlowHeatmap — 7×24 exchange flow grid (Innovation 6)
// ============================================================

interface HeatmapCell {
  day:   number;  // 0=Mon … 6=Sun
  hour:  number;  // 0-23
  value: number;  // avg net_exchange_flow_usd in that hour bucket
  count: number;
}

interface FlowHeatmapProps {
  cells: HeatmapCell[];
  min:   number;
  max:   number;
}

const DAY_LABELS  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOUR_LABELS = Array.from({ length: 24 }, (_, i) =>
  i === 0 ? '12am' : i === 12 ? '12pm' : i < 12 ? `${i}am` : `${i - 12}pm`
);

function cellColor(value: number, min: number, max: number): string {
  if (value === 0 && min === 0 && max === 0) return '#1e1e2e';
  if (value >= 0) {
    // Bullish: transparent → green
    const t = max > 0 ? Math.min(value / max, 1) : 0;
    const g = Math.round(229 * t);
    const a = Math.max(0.08, t * 0.85);
    return `rgba(0,${g},${Math.round(153 * t)},${a.toFixed(2)})`;
  } else {
    // Bearish: transparent → red
    const t = min < 0 ? Math.min(Math.abs(value) / Math.abs(min), 1) : 0;
    const a = Math.max(0.08, t * 0.85);
    return `rgba(255,${Math.round(71 * (1 - t))},${Math.round(87 * (1 - t))},${a.toFixed(2)})`;
  }
}

function fmtCell(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${v > 0 ? '+' : '-'}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${v > 0 ? '+' : '-'}$${Math.round(abs / 1_000)}K`;
  return `${v > 0 ? '+' : '-'}$${Math.round(abs)}`;
}

export function FlowHeatmap({ cells, min, max }: FlowHeatmapProps) {
  if (!cells || cells.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: '#4b4b60', fontSize: 13 }}>
        Not enough 1h snapshot data yet (need ~7 days).
      </div>
    );
  }

  // Build lookup: day×hour → value
  const lookup = new Map<string, number>();
  for (const c of cells) lookup.set(`${c.day}:${c.hour}`, c.value);

  const CELL_W = 28;
  const CELL_H = 22;
  const DAY_LABEL_W = 32;
  const HOUR_LABEL_H = 18;
  const totalW = DAY_LABEL_W + 24 * CELL_W;
  const totalH = HOUR_LABEL_H + 7 * CELL_H;

  return (
    <div style={{ overflowX: 'auto' }}>
      {/* Legend */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 10, color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>Exchange flow intensity</span>
        <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
          <div style={{ width: 40, height: 8, background: 'linear-gradient(to right, rgba(255,71,87,0.7), #1e1e2e, rgba(0,229,153,0.7))', borderRadius: 2 }} />
          <span style={{ fontSize: 9, color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>bearish ← → bullish</span>
        </div>
      </div>

      <svg viewBox={`0 0 ${totalW} ${totalH}`} width="100%" style={{ minWidth: totalW }}>
        {/* Hour labels */}
        {HOUR_LABELS.map((lbl, h) => (
          (h % 3 === 0) && (
            <text
              key={h}
              x={DAY_LABEL_W + h * CELL_W + CELL_W / 2}
              y={HOUR_LABEL_H - 3}
              textAnchor="middle"
              fill="#4b4b60"
              fontSize={7}
              fontFamily="var(--font-mono)"
            >
              {lbl}
            </text>
          )
        ))}

        {/* Day labels + cells */}
        {DAY_LABELS.map((day, d) => (
          <g key={d}>
            <text
              x={DAY_LABEL_W - 4}
              y={HOUR_LABEL_H + d * CELL_H + CELL_H / 2 + 3}
              textAnchor="end"
              fill="#6b6b80"
              fontSize={8}
              fontFamily="var(--font-mono)"
            >
              {day}
            </text>
            {Array.from({ length: 24 }, (_, h) => {
              const val = lookup.get(`${d}:${h}`) ?? 0;
              const bg  = cellColor(val, min, max);
              return (
                <g key={h}>
                  <rect
                    x={DAY_LABEL_W + h * CELL_W + 1}
                    y={HOUR_LABEL_H + d * CELL_H + 1}
                    width={CELL_W - 2}
                    height={CELL_H - 2}
                    fill={bg}
                    rx={2}
                  >
                    <title>{`${day} ${HOUR_LABELS[h]}: ${fmtCell(val)}`}</title>
                  </rect>
                </g>
              );
            })}
          </g>
        ))}
      </svg>
    </div>
  );
}
