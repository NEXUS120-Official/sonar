// ============================================================
// Token Intelligence — Whale token movements from token_movements
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
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
  if (diffS < 60)   return `${diffS}s ago`;
  if (diffS < 3600) return `${Math.floor(diffS / 60)}m ago`;
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
      .select('id, whale_id, signature, block_time, token_mint, token_symbol, token_name, action, amount_token, amount_usd, price_per_token, protocol, is_new_token')
      .gte('block_time', since)
      .order('block_time', { ascending: false })
      .limit(200),

    db.from('whales')
      .select('id, address, label, smart_money_flag, reputation_score')
      .eq('is_active', true),
  ]);

  const movements = (movRes.data ?? []) as Pick<
    TokenMovementRow,
    'id' | 'whale_id' | 'signature' | 'block_time' | 'token_mint' | 'token_symbol' | 'token_name' |
    'action' | 'amount_token' | 'amount_usd' | 'price_per_token' | 'protocol' | 'is_new_token'
  >[];

  const whales = (whaleRes.data ?? []) as Pick<
    WhaleRow, 'id' | 'address' | 'label' | 'smart_money_flag' | 'reputation_score'
  >[];

  const whaleById = new Map(whales.map(w => [w.id, w]));

  // Token aggregation (by mint, last 24h)
  const tokenMap = new Map<string, {
    symbol: string | null;
    name:   string | null;
    mint:   string;
    buys:   number;
    sells:  number;
    vol:    number;
    whales: Set<string>;
    latest: string;
    isNew:  boolean;
  }>();

  for (const m of movements) {
    const key = m.token_mint;
    if (!tokenMap.has(key)) {
      tokenMap.set(key, {
        symbol: m.token_symbol,
        name:   m.token_name,
        mint:   m.token_mint,
        buys:   0,
        sells:  0,
        vol:    0,
        whales: new Set(),
        latest: m.block_time,
        isNew:  m.is_new_token,
      });
    }
    const t = tokenMap.get(key)!;
    if (m.action === 'buy')  t.buys++;
    if (m.action === 'sell') t.sells++;
    t.vol += m.amount_usd ?? 0;
    if (m.whale_id) t.whales.add(m.whale_id);
    if (m.block_time > t.latest) t.latest = m.block_time;
  }

  const tokens = Array.from(tokenMap.values())
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 50);

  // Smart money filter: movements from smart whales only
  const smartMoves = movements.filter(m => {
    if (!m.whale_id) return false;
    return whaleById.get(m.whale_id)?.smart_money_flag === true;
  });

  return { movements, tokens, whaleById, smartMoves };
}

// ── Page ──────────────────────────────────────────────────────

export default async function TokensPage() {
  const { movements, tokens, whaleById, smartMoves } = await getData();

  const totalVol    = movements.reduce((s, m) => s + (m.amount_usd ?? 0), 0);
  const buyCount    = movements.filter(m => m.action === 'buy').length;
  const sellCount   = movements.filter(m => m.action === 'sell').length;
  const newTokens   = tokens.filter(t => t.isNew).length;

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Token Intelligence
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#8888AA' }}>
          Whale token activity · last 24h · {movements.length} events
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Volume (24h)',      value: fmtUsd(totalVol) },
          { label: 'Buy / Sell',        value: `${buyCount} / ${sellCount}` },
          { label: 'Unique Tokens',     value: String(tokens.length) },
          { label: 'New Token Signals', value: String(newTokens) },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Smart money feed */}
      {smartMoves.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#7B61FF40' }}>
          <div className="px-5 py-4 border-b flex items-center gap-2" style={{ borderColor: '#7B61FF30' }}>
            <span style={{ color: '#FFB800' }}>⭐</span>
            <h2 className="text-sm font-semibold" style={{ color: '#F0F0F8', fontFamily: 'var(--font-heading)' }}>
              Smart Money Moves
            </h2>
            <span className="text-xs ml-auto" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              {smartMoves.length} signal{smartMoves.length !== 1 ? 's' : ''} · 24h
            </span>
          </div>
          <div className="divide-y" style={{ borderColor: '#2A2A3A' }}>
            {smartMoves.slice(0, 10).map(m => {
              const whale = m.whale_id ? whaleById.get(m.whale_id) : null;
              const isBuy = m.action === 'buy';
              return (
                <div key={m.id} className="px-5 py-3 flex items-center gap-4 text-sm">
                  {/* Action badge */}
                  <span style={{
                    display:      'inline-block',
                    minWidth:     40,
                    textAlign:    'center',
                    fontSize:     11,
                    fontWeight:   700,
                    padding:      '2px 8px',
                    borderRadius: 4,
                    background:   isBuy ? '#00E5A010' : '#FF4D6A10',
                    color:        isBuy ? '#00E5A0'   : '#FF4D6A',
                    border:       `1px solid ${isBuy ? '#00E5A030' : '#FF4D6A30'}`,
                    fontFamily:   'var(--font-mono)',
                  }}>
                    {m.action.toUpperCase()}
                  </span>

                  {/* Token */}
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold">
                      {m.token_symbol ?? shortAddr(m.token_mint)}
                    </span>
                    {m.is_new_token && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded font-bold"
                        style={{ background: '#00D4FF15', color: '#00D4FF', border: '1px solid #00D4FF30' }}>
                        NEW
                      </span>
                    )}
                    {m.protocol && (
                      <span className="ml-2 text-xs" style={{ color: '#8888AA' }}>{m.protocol}</span>
                    )}
                  </div>

                  {/* Amount */}
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8', fontSize: '0.82rem' }}>
                    {fmtUsd(m.amount_usd)}
                  </span>

                  {/* Whale label */}
                  <span className="text-xs truncate" style={{ color: '#8888AA', maxWidth: 120, fontFamily: 'var(--font-mono)' }}>
                    {whale?.label ?? (whale?.address ? shortAddr(whale.address) : '—')}
                  </span>

                  {/* Time */}
                  <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)', minWidth: 56 }}>
                    {timeAgo(m.block_time)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Token breakdown table */}
      {tokens.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#111118', borderColor: '#2A2A3A', color: '#8888AA' }}>
          <p className="text-base font-semibold">No token movements yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            Token data populates as whales trade via the Helius webhook stream.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Top Tokens by Whale Volume · 24h
            </h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              {tokens.length} tokens
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Token', 'Volume', 'Buys', 'Sells', 'Whales', 'Last Activity'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokens.map((t, i) => {
                  const ratio  = t.buys / Math.max(1, t.buys + t.sells);
                  const biased = t.buys + t.sells >= 2;
                  return (
                    <tr
                      key={t.mint}
                      style={{ borderBottom: i < tokens.length - 1 ? '1px solid #1e1e2e' : 'none' }}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <div>
                            <p className="font-medium" style={{ color: '#F0F0F8' }}>
                              {t.symbol ?? shortAddr(t.mint)}
                              {t.isNew && (
                                <span className="ml-2 text-xs px-1 py-0.5 rounded font-bold"
                                  style={{ background: '#00D4FF15', color: '#00D4FF', border: '1px solid #00D4FF30' }}>
                                  NEW
                                </span>
                              )}
                            </p>
                            {t.name && t.name !== t.symbol && (
                              <p className="text-xs mt-0.5" style={{ color: '#8888AA' }}>{t.name}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-semibold" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8' }}>
                        {fmtUsd(t.vol)}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#00E5A0' }}>
                        {t.buys}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#FF4D6A' }}>
                        {t.sells}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>{t.whales.size}</span>
                          {biased && (
                            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: '#2A2A3A', maxWidth: 48 }}>
                              <div
                                className="h-full rounded-full"
                                style={{ width: `${ratio * 100}%`, background: ratio > 0.6 ? '#00E5A0' : ratio < 0.4 ? '#FF4D6A' : '#FFB800' }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                        {timeAgo(t.latest)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Raw feed */}
      {movements.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Raw Movement Feed
            </h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              last 24h · newest first
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Action', 'Token', 'Amount', 'Protocol', 'Whale', 'Time'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {movements.slice(0, 50).map((m, i) => {
                  const whale = m.whale_id ? whaleById.get(m.whale_id) : null;
                  const isBuy = m.action === 'buy';
                  return (
                    <tr
                      key={m.id}
                      style={{ borderBottom: i < Math.min(50, movements.length) - 1 ? '1px solid #1e1e2e' : 'none' }}
                    >
                      <td className="px-5 py-2">
                        <span style={{
                          display:      'inline-block',
                          fontSize:     10,
                          fontWeight:   700,
                          padding:      '2px 7px',
                          borderRadius: 4,
                          background:   isBuy ? '#00E5A010' : '#FF4D6A10',
                          color:        isBuy ? '#00E5A0'   : '#FF4D6A',
                          border:       `1px solid ${isBuy ? '#00E5A030' : '#FF4D6A30'}`,
                          fontFamily:   'var(--font-mono)',
                        }}>
                          {m.action.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-5 py-2">
                        <span className="font-medium">
                          {m.token_symbol ?? shortAddr(m.token_mint)}
                        </span>
                        {m.is_new_token && (
                          <span className="ml-1 text-xs" style={{ color: '#00D4FF' }}>●</span>
                        )}
                      </td>
                      <td className="px-5 py-2" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8', fontSize: '0.82rem' }}>
                        {fmtUsd(m.amount_usd)}
                      </td>
                      <td className="px-5 py-2 text-xs" style={{ color: '#8888AA' }}>
                        {m.protocol ?? '—'}
                      </td>
                      <td className="px-5 py-2 text-xs" style={{ color: whale?.smart_money_flag ? '#FFB800' : '#8888AA', fontFamily: 'var(--font-mono)' }}>
                        {whale?.smart_money_flag ? '⭐ ' : ''}{whale?.label ?? (whale?.address ? shortAddr(whale.address) : '—')}
                      </td>
                      <td className="px-5 py-2 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                        {timeAgo(m.block_time)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}
