// ============================================================
// Whale List Page
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import type { WhaleRow, MovementRow } from '@/lib/supabase/types';

function fmtUsd(v: number | null) {
  if (!v) return '—';
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

const METHOD_LABELS: Record<string, string> = {
  manual:              'Manual',
  exchange_withdrawal: 'Exchange Withdrawal',
  gmgn_feed:           'GMGN Feed',
  balance_scan:        'Balance Scan',
};

async function getData() {
  const db = createAdminClient();

  const { data: whalesRaw } = await db
    .from('whales')
    .select('id, address, label, sol_balance, usdc_balance, total_value_usd, whale_type, discovery_method, balance_updated_at, is_active')
    .order('total_value_usd', { ascending: false, nullsFirst: false })
    .limit(200);

  const whales = (whalesRaw ?? []) as Pick<
    WhaleRow,
    'id' | 'address' | 'label' | 'sol_balance' | 'usdc_balance' | 'total_value_usd' |
    'whale_type' | 'discovery_method' | 'balance_updated_at' | 'is_active'
  >[];

  const ids = whales.map(w => w.id);
  const { data: movsRaw } = ids.length > 0
    ? await db.from('movements').select('whale_id, flow_type, amount_usd, block_time').in('whale_id', ids).order('block_time', { ascending: false }).limit(ids.length * 3)
    : { data: [] };

  const lastMov = new Map<string, { flow_type: string; amount_usd: number | null; block_time: string }>();
  for (const m of ((movsRaw ?? []) as Pick<MovementRow, 'whale_id' | 'flow_type' | 'amount_usd' | 'block_time'>[])) {
    if (m.whale_id && !lastMov.has(m.whale_id)) {
      lastMov.set(m.whale_id, { flow_type: m.flow_type, amount_usd: m.amount_usd, block_time: m.block_time });
    }
  }

  return { whales, lastMov };
}

export default async function WhalesPage() {
  const { whales, lastMov } = await getData();
  const active   = whales.filter(w => w.is_active);
  const inactive = whales.filter(w => !w.is_active);

  return (
    <div className="p-8 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>Whale Tracker</h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
          {active.length} active whale{active.length !== 1 ? 's' : ''} · {whales.length} total
        </p>
      </div>

      {whales.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
          <p className="text-base font-semibold">No whales tracked yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>Run the discover-whales cron or seed known addresses.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Header */}
          <div
            className="grid gap-3 px-4 py-2 text-xs uppercase tracking-widest"
            style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', color: '#4b4b60', fontFamily: 'var(--font-mono)' }}
          >
            <span>Address</span>
            <span className="text-right">SOL</span>
            <span className="text-right">USDC</span>
            <span className="text-right">Total</span>
            <span>Discovery</span>
            <span>Last Move</span>
          </div>

          {whales.map(w => {
            const mov = lastMov.get(w.id);
            return (
              <div
                key={w.id}
                className="grid gap-3 px-4 py-3 rounded-lg border items-center text-sm"
                style={{
                  gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr',
                  background: '#12121a',
                  borderColor: w.is_active ? '#1e1e2e' : '#15151f',
                  opacity: w.is_active ? 1 : 0.5,
                }}
              >
                <div className="flex flex-col gap-0.5">
                  <a
                    href={`https://solscan.io/account/${w.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-70 transition-opacity"
                    style={{ color: '#00b8ff', fontFamily: 'var(--font-mono)', fontSize: '0.8rem' }}
                  >
                    {shortAddr(w.address)}
                  </a>
                  {w.label && <span className="text-xs" style={{ color: '#6b6b80' }}>{w.label}</span>}
                </div>
                <span className="text-right" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef' }}>
                  {w.sol_balance ? w.sol_balance.toFixed(0) : '—'}
                </span>
                <span className="text-right" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef' }}>
                  {fmtUsd(w.usdc_balance)}
                </span>
                <span
                  className="text-right font-semibold"
                  style={{ fontFamily: 'var(--font-mono)', color: w.is_active ? '#00e599' : '#6b6b80' }}
                >
                  {fmtUsd(w.total_value_usd)}
                </span>
                <span className="text-xs" style={{ color: '#6b6b80' }}>
                  {METHOD_LABELS[w.discovery_method ?? ''] ?? w.discovery_method ?? '—'}
                </span>
                <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                  {mov ? (
                    <span title={mov.flow_type}>
                      {new Date(mov.block_time).toLocaleDateString()}
                    </span>
                  ) : '—'}
                </span>
              </div>
            );
          })}

          {inactive.length > 0 && (
            <p className="text-xs mt-2" style={{ color: '#4b4b60' }}>
              {inactive.length} inactive wallet{inactive.length !== 1 ? 's' : ''} (below $500K threshold) shown greyed out.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
