// ============================================================
// SummaryCard — metric display card
// ============================================================

interface SummaryCardProps {
  title:    string;
  value:    string;
  sub?:     string;
  accent?:  'green' | 'red' | 'blue' | 'yellow' | 'muted';
  className?: string;
}

const accentColors: Record<string, string> = {
  green:  '#00e599',
  red:    '#ff4757',
  blue:   '#00b8ff',
  yellow: '#ffd60a',
  muted:  '#6b6b80',
};

export function SummaryCard({ title, value, sub, accent = 'muted', className = '' }: SummaryCardProps) {
  const color = accentColors[accent];
  return (
    <div
      className={`rounded-xl border p-5 flex flex-col gap-1 ${className}`}
      style={{ background: '#12121a', borderColor: '#1e1e2e' }}
    >
      <p className="text-xs uppercase tracking-widest" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
        {title}
      </p>
      <p className="text-2xl font-bold" style={{ color, fontFamily: 'var(--font-heading)' }}>
        {value}
      </p>
      {sub && (
        <p className="text-xs" style={{ color: '#6b6b80' }}>{sub}</p>
      )}
    </div>
  );
}
