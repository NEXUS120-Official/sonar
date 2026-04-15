// ============================================================
// LP Monitor — Whale liquidity add/remove events (live)
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { ProGate }           from '@/components/ProGate';
import type { TokenMovementRow, WhaleRow } from '@/lib/supabase/types';

// ── Helpers ───────────────────────────────────────────────────

function fmtUsd(v: number | null) {
  if (!v) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function timeAgo(iso: string): string {
  const diffS = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffS < 60)    return `${diffS}s ago`;
  if (diffS < 3600)  return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

// ── Data ──────────────────────────────────────────────────────

async function getData() {
  const db    = createAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [movRes, whaleRes] = await Promise.all([
    (db as any)
      .from('token_movements')
      .select('id, whale_id, signature, block_time, token_mint, token_symbol, action, amount_usd, amount_token, protocol, pool_address')
      .gte('block_time', since)
      .in('action', ['add_liquidity', 'remove_liquidity'])
      .order('block_time', { ascending: false })
      .limit(200),

    db.from('whales')
      .select('id, address, label, smart_money_flag, reputation_score')
      .eq('is_active', true),
  ]);

  const events = (movRes.data ?? []) as Pick<
    TokenMovementRow,
    'id' | 'whale_id' | 'signature' | 'block_time' | 'token_mint' | 'token_symbol' |
    'action' | 'amount_usd' | 'amount_token' | 'protocol' | 'pool_address'
  >[];

  const whales = (whaleRes.data ?? []) as Pick<
    WhaleRow, 'id' | 'address' | 'label' | 'smart_money_flag' | 'reputation_score'
  >[];
  const whaleById = new Map(whales.map(w => [w.id, w]));

  const addEvents    = events.filter(e => e.action === 'add_liquidity');
  const removeEvents = events.filter(e => e.action === 'remove_liquidity');
  const totalVol     = events.reduce((s, e) => s + (e.amount_usd ?? 0), 0);

  // Detect potential rug signals: remove_liquidity by non-smart-money whale, large size
  const rugSignals = removeEvents.filter(e => {
    const whale = e.whale_id ? whaleById.get(e.whale_id) : null;
    return (e.amount_usd ?? 0) >= 10_000 && !whale?.smart_money_flag;
  });

  return { events, addEvents, removeEvents, totalVol, rugSignals, whaleById };
}

// ── Page ──────────────────────────────────────────────────────

export default async function LpMonitorPage() {
  const { events, addEvents, removeEvents, totalVol, rugSignals, whaleById } = await getData();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          LP Monitor
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#8888AA' }}>
          Whale liquidity add / remove events · last 24h · {events.length} events
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'LP Events (24h)',      value: String(events.length) },
          { label: 'Liquidity Added',      value: String(addEvents.length) },
          { label: 'Liquidity Removed',    value: String(removeEvents.length) },
          { label: 'Total LP Value',       value: fmtUsd(totalVol) },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Signal cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border p-5" style={{
          background: '#111118',
          borderColor: rugSignals.length > 0 ? '#FF4D6A60' : '#2A2A3A',
        }}>
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: '#FF4D6A' }}>⚠</span>
            <p className="text-sm font-semibold" style={{ color: '#FF4D6A' }}>
              Rug Risk Signals
            </p>
            {rugSignals.length > 0 && (
              <span className="ml-auto text-xs font-bold px-2 py-0.5 rounded"
                style={{ background: '#FF4D6A20', color: '#FF4D6A', border: '1px solid #FF4D6A40', fontFamily: 'var(--font-mono)' }}>
                {rugSignals.length} flagged
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>
            Large LP removals (&gt;$10k) by non-smart-money wallets. Potential exit or rug-pull precursor.
          </p>
          {rugSignals.length > 0 && (
            <div className="mt-3 space-y-1">
              {rugSignals.slice(0, 3).map(e => {
                const whale = e.whale_id ? whaleById.get(e.whale_id) : null;
                return (
                  <div key={e.id} className="flex items-center justify-between text-xs py-1.5 border-t" style={{ borderColor: '#FF4D6A20' }}>
                    <span style={{ color: '#F0F0F8' }}>{e.token_symbol ?? shortAddr(e.token_mint)}</span>
                    <span style={{ color: '#FF4D6A', fontFamily: 'var(--font-mono)' }}>{fmtUsd(e.amount_usd)}</span>
                    <span style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {whale?.label ?? (whale?.address ? shortAddr(whale.address) : '—')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border p-5" style={{ background: '#111118', borderColor: '#00E5A040' }}>
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: '#00E5A0' }}>◈</span>
            <p className="text-sm font-semibold" style={{ color: '#00E5A0' }}>Market Construction</p>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>
            Whale LP additions signal market confidence. New liquidity → deeper books, tighter spreads.
          </p>
          {addEvents.length > 0 && (
            <p className="mt-3 text-xs" style={{ color: '#00E5A0', fontFamily: 'var(--font-mono)' }}>
              {addEvents.length} add events · {fmtUsd(addEvents.reduce((s, e) => s + (e.amount_usd ?? 0), 0))} added
            </p>
          )}
        </div>
      </div>

      {/* Event feed — Pro gated */}
      <ProGate featureName="LP Monitor" ctaLabel="Unlock LP Monitor">
      {events.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#111118', borderColor: '#2A2A3A', color: '#8888AA' }}>
          <p className="text-base font-semibold">No LP events yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            LP data populates as whales interact with Raydium, Orca, Meteora and other DEXs via ADD_LIQUIDITY / WITHDRAW_LIQUIDITY webhooks.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>LP Event Feed</h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>last 24h · newest first</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Event', 'Token', 'Amount', 'Protocol', 'Whale', 'Time'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 100).map((e, i) => {
                  const whale   = e.whale_id ? whaleById.get(e.whale_id) : null;
                  const isAdd   = e.action === 'add_liquidity';
                  return (
                    <tr key={e.id} style={{ borderBottom: i < events.length - 1 ? '1px solid #1e1e2e' : 'none' }}>
                      <td className="px-5 py-2.5">
                        <span style={{
                          display: 'inline-block', fontSize: 10, fontWeight: 700,
                          padding: '2px 8px', borderRadius: 4,
                          background: isAdd ? '#00E5A010' : '#FF4D6A10',
                          color:      isAdd ? '#00E5A0'   : '#FF4D6A',
                          border:     `1px solid ${isAdd ? '#00E5A030' : '#FF4D6A30'}`,
                          fontFamily: 'var(--font-mono)',
                        }}>
                          {isAdd ? 'ADD' : 'REMOVE'}
                        </span>
                      </td>
                      <td className="px-5 py-2.5 font-medium">
                        {e.token_symbol ?? shortAddr(e.token_mint)}
                      </td>
                      <td className="px-5 py-2.5" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8', fontSize: '0.82rem' }}>
                        {fmtUsd(e.amount_usd)}
                      </td>
                      <td className="px-5 py-2.5 text-xs" style={{ color: '#8888AA' }}>
                        {e.protocol ?? '—'}
                      </td>
                      <td className="px-5 py-2.5 text-xs" style={{
                        color: whale?.smart_money_flag ? '#FFB800' : '#8888AA',
                        fontFamily: 'var(--font-mono)',
                      }}>
                        {whale?.smart_money_flag ? '⭐ ' : ''}{whale?.label ?? (whale?.address ? shortAddr(whale.address) : '—')}
                      </td>
                      <td className="px-5 py-2.5 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                        {timeAgo(e.block_time)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </ProGate>
    </div>
  );
}
