'use client';
// ============================================================
// BiasChart — SVG line chart for Bias Index history
// No external dependencies — pure SVG + CSS
// ============================================================

interface DataPoint {
  score:      number;
  created_at: string;
}

interface BiasChartProps {
  data:   DataPoint[];
  height?: number;
}

const W = 600;

function biasStroke(score: number): string {
  if (score >= 20)  return '#00e599';
  if (score <= -20) return '#ff4757';
  return '#ffd60a';
}

export function BiasChart({ data, height = 120 }: BiasChartProps) {
  if (!data || data.length < 2) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4b4b60', fontSize: 12 }}>
        Not enough history yet
      </div>
    );
  }

  const pad   = { top: 12, right: 8, bottom: 24, left: 32 };
  const innerW = W - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  // Map score -100..+100 → y
  const toY = (s: number) => pad.top + ((100 - s) / 200) * innerH;
  const toX = (i: number) => pad.left + (i / (data.length - 1)) * innerW;

  // Build path
  const pts  = data.map((d, i) => `${toX(i)},${toY(d.score)}`);
  const path = `M ${pts.join(' L ')}`;

  // Fill area under/above zero
  const zeroY = toY(0);

  // X axis labels: first, mid, last
  const labelIdxs = [0, Math.floor(data.length / 2), data.length - 1];

  function fmtTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      width="100%"
      height={height}
      style={{ overflow: 'visible' }}
    >
      {/* Background zones */}
      {/* Green zone: above zero */}
      <rect
        x={pad.left} y={pad.top}
        width={innerW} height={zeroY - pad.top}
        fill="#00e599" opacity={0.04}
      />
      {/* Red zone: below zero */}
      <rect
        x={pad.left} y={zeroY}
        width={innerW} height={innerH - (zeroY - pad.top)}
        fill="#ff4757" opacity={0.04}
      />

      {/* Horizontal grid lines */}
      {[-60, -20, 0, 20, 60].map(s => (
        <g key={s}>
          <line
            x1={pad.left} x2={pad.left + innerW}
            y1={toY(s)} y2={toY(s)}
            stroke={s === 0 ? '#3a3a50' : '#1e1e2e'}
            strokeWidth={s === 0 ? 1.5 : 1}
            strokeDasharray={s === 0 ? 'none' : '4 4'}
          />
          <text
            x={pad.left - 5} y={toY(s) + 4}
            textAnchor="end"
            fill="#4b4b60"
            fontSize={9}
            fontFamily="var(--font-mono)"
          >
            {s > 0 ? `+${s}` : s}
          </text>
        </g>
      ))}

      {/* Line — colored by final score */}
      <path
        d={path}
        fill="none"
        stroke={biasStroke(data[data.length - 1].score)}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Dot at current value */}
      <circle
        cx={toX(data.length - 1)}
        cy={toY(data[data.length - 1].score)}
        r={4}
        fill={biasStroke(data[data.length - 1].score)}
      />

      {/* X axis time labels */}
      {labelIdxs.map(i => (
        <text
          key={i}
          x={toX(i)}
          y={pad.top + innerH + 16}
          textAnchor="middle"
          fill="#4b4b60"
          fontSize={9}
          fontFamily="var(--font-mono)"
        >
          {fmtTime(data[i].created_at)}
        </text>
      ))}
    </svg>
  );
}
