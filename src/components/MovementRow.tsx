// ============================================================
// MovementRow — single movement list entry
// ============================================================

const FLOW_LABELS: Record<string, { label: string; color: string }> = {
  exchange_deposit:    { label: 'Deposit →Exchange', color: '#ff4757' },
  exchange_withdrawal: { label: 'Withdrawal ←Exchange', color: '#00e599' },
  stake:               { label: 'Stake',             color: '#00b8ff' },
  unstake:             { label: 'Unstake',            color: '#ffd60a' },
  defi_deposit:        { label: 'DeFi Deposit',      color: '#00b8ff' },
  defi_withdrawal:     { label: 'DeFi Withdraw',     color: '#ffd60a' },
  whale_transfer:      { label: 'Whale Transfer',    color: '#6b6b80' },
  bridge_in:           { label: 'Bridge In',         color: '#00e599' },
  bridge_out:          { label: 'Bridge Out',        color: '#ff4757' },
  unknown:             { label: 'Unknown',           color: '#6b6b80' },
};

function fmtUsd(v: number | null) {
  if (!v) return '—';
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtTime(ts: string) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

interface Movement {
  id:         string;
  flow_type:  string;
  amount_usd: number | null;
  from_label?: string | null;
  to_label?:   string | null;
  from?:       string;
  to?:         string;
  exchange?:   string | null;
  protocol?:   string | null;
  token:       string;
  block_time:  string;
}

export function MovementRow({ m }: { m: Movement }) {
  const ft  = FLOW_LABELS[m.flow_type] ?? { label: m.flow_type, color: '#6b6b80' };
  const src = m.from_label ?? m.from ?? '—';
  const dst = m.to_label   ?? m.to   ?? '—';
  const ctx = m.exchange ?? m.protocol ?? '';
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-lg border text-sm"
      style={{ background: '#12121a', borderColor: '#1e1e2e' }}
    >
      <span
        className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded"
        style={{ color: ft.color, background: ft.color + '18', fontFamily: 'var(--font-mono)', minWidth: '6rem', textAlign: 'center' }}
      >
        {ft.label}
      </span>
      <span className="font-bold text-base shrink-0" style={{ color: ft.color, fontFamily: 'var(--font-mono)' }}>
        {fmtUsd(m.amount_usd)}
      </span>
      <span className="truncate flex-1" style={{ color: '#6b6b80', fontSize: '0.72rem', fontFamily: 'var(--font-mono)' }}>
        {src.length > 20 ? src.slice(0,10)+'…'+src.slice(-6) : src}
        {' → '}
        {dst.length > 20 ? dst.slice(0,10)+'…'+dst.slice(-6) : dst}
        {ctx && <span style={{ color: '#4b4b60' }}> · {ctx}</span>}
      </span>
      <span className="shrink-0 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
        {fmtTime(m.block_time)}
      </span>
    </div>
  );
}
