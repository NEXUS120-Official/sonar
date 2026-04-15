'use client';
// ============================================================
// WWWDWidget — "What Would Whales Do?" (Innovation 8)
// Pro-tier signal widget
// ============================================================

type WWWDSignal = 'accumulate' | 'distribute' | 'hold' | 'rotate_to_defi' | 'reduce_defi';
type ConfidenceTier = 'high' | 'medium' | 'low';

interface WWWDWidgetProps {
  signal:     WWWDSignal;
  confidence: ConfidenceTier;
  score:      number;
  bias:       string;
  headline:   string;
  rationale:  string[];
  cohort_distribution?: Record<string, number>;
  generated_at?: string;
}

const SIGNAL_META: Record<WWWDSignal, {
  label:  string;
  icon:   string;
  color:  string;
  bg:     string;
  border: string;
}> = {
  accumulate:     { label: 'ACCUMULATE',     icon: '🟢', color: '#00e599', bg: '#00e59910', border: '#00e59940' },
  distribute:     { label: 'DISTRIBUTE',     icon: '🔴', color: '#ff4757', bg: '#ff475710', border: '#ff475740' },
  hold:           { label: 'HOLD',           icon: '⏸️', color: '#ffd60a', bg: '#ffd60a10', border: '#ffd60a40' },
  rotate_to_defi: { label: 'ROTATE → DeFi', icon: '⚡', color: '#7b68ee', bg: '#7b68ee10', border: '#7b68ee40' },
  reduce_defi:    { label: 'REDUCE DeFi',   icon: '⬇️', color: '#ff8c42', bg: '#ff8c4210', border: '#ff8c4240' },
};

const CONFIDENCE_META: Record<ConfidenceTier, { label: string; color: string }> = {
  high:   { label: 'High Confidence',   color: '#00e599' },
  medium: { label: 'Medium Confidence', color: '#ffd60a' },
  low:    { label: 'Low Confidence',    color: '#6b6b80' },
};

function biasHuman(bias: string): string {
  switch (bias) {
    case 'extreme_bullish': return 'Extreme Bullish';
    case 'bullish':         return 'Bullish';
    case 'neutral':         return 'Neutral';
    case 'bearish':         return 'Bearish';
    case 'extreme_bearish': return 'Extreme Bearish';
    default:                return bias;
  }
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function WWWDWidget({
  signal,
  confidence,
  score,
  bias,
  headline,
  rationale,
  cohort_distribution,
  generated_at,
}: WWWDWidgetProps) {
  const meta    = SIGNAL_META[signal];
  const confMeta = CONFIDENCE_META[confidence];

  const totalWhales = cohort_distribution
    ? Object.values(cohort_distribution).reduce((s, n) => s + n, 0)
    : 0;

  return (
    <div style={{
      background:   meta.bg,
      border:       `1px solid ${meta.border}`,
      borderRadius: 14,
      padding:      20,
      display:      'flex',
      flexDirection: 'column',
      gap:          14,
    }}>
      {/* Top: label + confidence */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 22 }}>{meta.icon}</span>
          <span style={{
            fontSize:      18,
            fontWeight:    900,
            color:         meta.color,
            fontFamily:    'var(--font-heading)',
            letterSpacing: '0.06em',
          }}>
            {meta.label}
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span style={{ fontSize: 10, color: confMeta.color, fontFamily: 'var(--font-mono)' }}>
            ● {confMeta.label}
          </span>
          <p style={{ fontSize: 10, color: '#4b4b60', margin: '2px 0 0', fontFamily: 'var(--font-mono)' }}>
            Score {score > 0 ? '+' : ''}{score} · {biasHuman(bias)}
          </p>
        </div>
      </div>

      {/* Headline */}
      <p style={{
        fontSize:   14,
        fontWeight: 600,
        color:      '#e0e0f0',
        margin:     0,
        lineHeight: 1.4,
      }}>
        {headline}
      </p>

      {/* Rationale bullets */}
      <ul style={{ margin: 0, padding: '0 0 0 16px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rationale.map((r, i) => (
          <li key={i} style={{ fontSize: 12, color: '#9b9bb0', fontFamily: 'var(--font-mono)', lineHeight: 1.4 }}>
            {r}
          </li>
        ))}
      </ul>

      {/* Cohort distribution pills */}
      {cohort_distribution && totalWhales > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {Object.entries(cohort_distribution)
            .sort((a, b) => b[1] - a[1])
            .map(([cohort, count]) => (
              <span key={cohort} style={{
                fontSize:     10,
                padding:      '2px 8px',
                borderRadius: 4,
                background:   '#1e1e2e',
                color:        '#9b9bb0',
                fontFamily:   'var(--font-mono)',
              }}>
                {cohort}: {count}
              </span>
            ))
          }
        </div>
      )}

      {/* Footer */}
      {generated_at && (
        <p style={{ fontSize: 10, color: '#4b4b60', margin: 0, fontFamily: 'var(--font-mono)' }}>
          Generated {fmtTime(generated_at)} · SONAR Smart Money Intelligence
        </p>
      )}
    </div>
  );
}
