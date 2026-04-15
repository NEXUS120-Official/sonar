'use client';
// ============================================================
// BiasGauge — SONAR Bias Index™ display
// Semicircular gauge + 4 component mini-bars
// ============================================================

interface ComponentBar {
  label:          string;
  score:          number;  // -max..+max
  maxScore:       number;
  interpretation: string;
  emoji:          string;
}

interface BiasGaugeProps {
  score:      number | null;
  bias:       string | null;
  confidence: number | null;
  components?: {
    exchange?:   { score: number; interpretation: string };
    staking?:    { score: number; interpretation: string };
    stablecoin?: { score: number; interpretation: string };
    defi?:       { score: number; interpretation: string };
  } | null;
  size?: number;
}

function biasColor(bias: string | null, score: number | null): string {
  if (!bias || score === null) return '#6b6b80';
  if (bias.includes('bullish')) return '#00e599';
  if (bias.includes('bearish')) return '#ff4757';
  return '#ffd60a';
}

function biasHuman(bias: string | null): string {
  switch (bias) {
    case 'extreme_bullish': return 'Extreme Bullish';
    case 'bullish':         return 'Bullish';
    case 'neutral':         return 'Neutral';
    case 'bearish':         return 'Bearish';
    case 'extreme_bearish': return 'Extreme Bearish';
    default:                return 'No data';
  }
}

function Gauge({ score, bias, size = 200 }: { score: number; bias: string | null; size?: number }) {
  const cx = size / 2;
  const cy = size / 2 + 10;
  const r  = size * 0.38;
  const sw = size * 0.072;
  const color = biasColor(bias, score);

  const ratio      = (score + 100) / 200;
  const startAngle = Math.PI;
  const needleAng  = startAngle - ratio * Math.PI;

  function polar(ang: number, rad: number) {
    return { x: cx + rad * Math.cos(ang), y: cy + rad * Math.sin(ang) };
  }
  function arc(from: number, to: number, rad: number) {
    const s = polar(from, rad), e = polar(to, rad);
    const large = Math.abs(from - to) > Math.PI ? 1 : 0;
    const sweep = to < from ? 0 : 1;
    return `M ${s.x} ${s.y} A ${rad} ${rad} 0 ${large} ${sweep} ${e.x} ${e.y}`;
  }

  const tip  = polar(needleAng, r * 0.82);
  const b1   = polar(needleAng + Math.PI / 2, sw * 0.25);
  const b2   = polar(needleAng - Math.PI / 2, sw * 0.25);
  const disp = score > 0 ? `+${score}` : `${score}`;

  return (
    <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`}>
      <path d={arc(Math.PI, 0, r)} fill="none" stroke="#1e1e2e" strokeWidth={sw} strokeLinecap="round" />
      <path d={arc(Math.PI, needleAng, r)} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" opacity={0.85} />
      <text x={cx - r - sw * 0.6} y={cy + 4} fill="#ff4757" fontSize={size * 0.06} textAnchor="end" fontFamily="var(--font-mono)">−</text>
      <text x={cx + r + sw * 0.6} y={cy + 4} fill="#00e599" fontSize={size * 0.06} textAnchor="start" fontFamily="var(--font-mono)">+</text>
      <polygon points={`${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`} fill={color} />
      <circle cx={cx} cy={cy} r={sw * 0.35} fill="#12121a" stroke="#1e1e2e" strokeWidth={2} />
      <text x={cx} y={cy - r * 0.3} textAnchor="middle" fill={color} fontSize={size * 0.15} fontWeight="700" fontFamily="var(--font-heading)">{disp}</text>
    </svg>
  );
}

function MiniBar({ label, score, maxScore, interpretation, emoji }: ComponentBar) {
  const pct    = Math.min(Math.abs(score) / maxScore, 1) * 100;
  const color  = score > 0 ? '#00e599' : score < 0 ? '#ff4757' : '#3a3a50';
  const sigStr = score > 0 ? `+${score}` : `${score}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: '#9b9bb0', fontFamily: 'var(--font-mono)' }}>
          {emoji} {label}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color, fontFamily: 'var(--font-mono)' }}>
          {sigStr}
        </span>
      </div>
      <div style={{ height: 4, background: '#1e1e2e', borderRadius: 2, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            borderRadius: 2,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      <span style={{ fontSize: 10, color: '#6b6b80' }}>{interpretation}</span>
    </div>
  );
}

export function BiasGauge({
  score,
  bias,
  confidence,
  components,
  size = 200,
}: BiasGaugeProps) {
  const s     = score ?? 0;
  const color = biasColor(bias, score);

  const bars: ComponentBar[] = [
    {
      label:          'Exchange',
      emoji:          '🏦',
      score:          components?.exchange?.score   ?? 0,
      maxScore:       40,
      interpretation: components?.exchange?.interpretation ?? '—',
    },
    {
      label:          'Staking',
      emoji:          '🔒',
      score:          components?.staking?.score    ?? 0,
      maxScore:       20,
      interpretation: components?.staking?.interpretation ?? '—',
    },
    {
      label:          'Stablecoin',
      emoji:          '💵',
      score:          components?.stablecoin?.score ?? 0,
      maxScore:       20,
      interpretation: components?.stablecoin?.interpretation ?? '—',
    },
    {
      label:          'DeFi',
      emoji:          '⚡',
      score:          components?.defi?.score       ?? 0,
      maxScore:       20,
      interpretation: components?.defi?.interpretation ?? '—',
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      {/* Gauge */}
      {score !== null ? (
        <Gauge score={s} bias={bias} size={size} />
      ) : (
        <div style={{ width: size, height: size * 0.62, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#4b4b60', fontSize: 13 }}>
          No data
        </div>
      )}

      {/* Label + confidence */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-heading)' }}>
          {biasHuman(bias)}
        </span>
        {confidence !== null && (
          <span style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            {confidence}% confidence
          </span>
        )}
      </div>

      {/* 4 component mini-bars */}
      {components && (
        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 4px 0' }}>
          {bars.map(b => <MiniBar key={b.label} {...b} />)}
        </div>
      )}
    </div>
  );
}
