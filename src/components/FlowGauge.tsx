// ============================================================
// FlowGauge — SVG bias gauge (-100 bearish → +100 bullish)
// ============================================================

interface FlowGaugeProps {
  score:  number | null;  // -100 to +100
  label:  string | null;  // 'bullish' | 'bearish' | 'neutral'
  size?:  number;
}

export function FlowGauge({ score, label, size = 220 }: FlowGaugeProps) {
  const cx    = size / 2;
  const cy    = size / 2 + 10; // slightly lower for semicircle
  const r     = size * 0.38;
  const strokeW = size * 0.072;

  // Arc from 180° to 0° (left to right across bottom)
  const startAngle = Math.PI;    // left
  const endAngle   = 0;          // right
  const totalArc   = Math.PI;    // 180°

  // Clamp and normalize score
  const s         = Math.max(-100, Math.min(100, score ?? 0));
  const ratio     = (s + 100) / 200; // 0 = fully bearish, 1 = fully bullish
  const fillAngle = startAngle - ratio * totalArc; // from left toward right

  function polar(angle: number, radius: number) {
    return {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  }

  function arcPath(from: number, to: number, rad: number) {
    const s = polar(from, rad);
    const e = polar(to, rad);
    const large = Math.abs(from - to) > Math.PI ? 1 : 0;
    const sweep = to < from ? 0 : 1;
    return `M ${s.x} ${s.y} A ${rad} ${rad} 0 ${large} ${sweep} ${e.x} ${e.y}`;
  }

  // Needle tip
  const needleAngle = startAngle - ratio * totalArc;
  const needleTip   = polar(needleAngle, r * 0.82);
  const needleBase1 = polar(needleAngle + Math.PI / 2, strokeW * 0.25);
  const needleBase2 = polar(needleAngle - Math.PI / 2, strokeW * 0.25);

  const biasColor = label === 'bullish' ? '#00e599'
                  : label === 'bearish' ? '#ff4757'
                  : '#ffd60a';

  const displayScore = score === null ? '—' : (s > 0 ? `+${s}` : `${s}`);

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        width={size}
        height={size * 0.62}
        viewBox={`0 0 ${size} ${size * 0.62}`}
        role="img"
        aria-label={`Bias gauge: ${displayScore}`}
      >
        {/* Track */}
        <path
          d={arcPath(Math.PI, 0, r)}
          fill="none"
          stroke="#1e1e2e"
          strokeWidth={strokeW}
          strokeLinecap="round"
        />

        {/* Fill arc */}
        {score !== null && (
          <path
            d={arcPath(Math.PI, needleAngle, r)}
            fill="none"
            stroke={biasColor}
            strokeWidth={strokeW}
            strokeLinecap="round"
            opacity={0.85}
          />
        )}

        {/* Zone labels */}
        <text x={cx - r - strokeW * 0.6} y={cy + 4} fill="#ff4757" fontSize={size * 0.06} textAnchor="end" fontFamily="var(--font-mono)">−</text>
        <text x={cx + r + strokeW * 0.6} y={cy + 4} fill="#00e599" fontSize={size * 0.06} textAnchor="start" fontFamily="var(--font-mono)">+</text>

        {/* Needle */}
        {score !== null && (
          <polygon
            points={`${needleTip.x},${needleTip.y} ${needleBase1.x},${needleBase1.y} ${needleBase2.x},${needleBase2.y}`}
            fill={biasColor}
          />
        )}

        {/* Center dot */}
        <circle cx={cx} cy={cy} r={strokeW * 0.35} fill="#12121a" stroke="#1e1e2e" strokeWidth={2} />

        {/* Score */}
        <text
          x={cx}
          y={cy - r * 0.3}
          textAnchor="middle"
          fill={biasColor}
          fontSize={size * 0.15}
          fontWeight="700"
          fontFamily="var(--font-heading)"
        >
          {displayScore}
        </text>
      </svg>

      <div className="flex items-center gap-2">
        <span
          className="text-sm font-semibold uppercase tracking-widest"
          style={{ color: biasColor, fontFamily: 'var(--font-heading)' }}
        >
          {label ?? 'no data'}
        </span>
      </div>
    </div>
  );
}
