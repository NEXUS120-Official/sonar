// ============================================================
// Pump.fun Radar — Whale activity on pump.fun tokens (live)
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
  const db     = createAdminClient();
  const since1h = new Date(Date.now() -  1 * 3_600_000).toISOString();
  const since24 = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [movRes, whaleRes] = await Promise.all([
    (db as any)
      .from('token_movements')
      .select('id, whale_id, signature, block_time, token_mint, token_symbol, token_name, action, amount_usd, amount_token, price_per_token, is_new_token')
      .gte('block_time', since24)
      .eq('protocol', 'pumpfun')
      .in('action', ['buy', 'sell'])
      .order('block_time', { ascending: false })
      .limit(500),

    db.from('whales')
      .select('id, address, label, smart_money_flag, reputation_score')
      .eq('is_active', true),
  ]);

  type TM = Pick<TokenMovementRow,
    'id' | 'whale_id' | 'signature' | 'block_time' | 'token_mint' | 'token_symbol' | 'token_name' |
    'action' | 'amount_usd' | 'amount_token' | 'price_per_token' | 'is_new_token'
  >;

  const movements = (movRes.data ?? []) as TM[];
  const whales    = (whaleRes.data ?? []) as Pick<WhaleRow, 'id' | 'address' | 'label' | 'smart_money_flag' | 'reputation_score'>[];
  const whaleById = new Map(whales.map(w => [w.id, w]));

  // Aggregate by token
  type TokenEntry = {
    mint:       string;
    symbol:     string | null;
    name:       string | null;
    whaleBuys:  number;
    whaleSells: number;
    volume:     number;
    whales:     Set<string>;
    smartMoney: number;
    latest:     string;
    lastPrice:  number | null;
    isNew:      boolean;
  };

  const tokenMap = new Map<string, TokenEntry>();

  for (const m of movements) {
    if (!tokenMap.has(m.token_mint)) {
      tokenMap.set(m.token_mint, {
        mint: m.token_mint, symbol: m.token_symbol, name: m.token_name,
        whaleBuys: 0, whaleSells: 0, volume: 0,
        whales: new Set(), smartMoney: 0,
        latest: m.block_time, lastPrice: null, isNew: m.is_new_token,
      });
    }
    const t = tokenMap.get(m.token_mint)!;
    if (m.action === 'buy')  t.whaleBuys++;
    if (m.action === 'sell') t.whaleSells++;
    t.volume += m.amount_usd ?? 0;
    if (m.whale_id) {
      t.whales.add(m.whale_id);
      const whale = whaleById.get(m.whale_id);
      if (whale?.smart_money_flag) t.smartMoney++;
    }
    if (m.block_time > t.latest) t.latest = m.block_time;
    if (m.price_per_token && !t.lastPrice) t.lastPrice = m.price_per_token;
  }

  const tokens = Array.from(tokenMap.values())
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 50);

  // 1h stats
  const since1hCutoff = since1h;
  const buys1h     = movements.filter(m => m.action === 'buy'  && m.block_time >= since1hCutoff).length;
  const largestBuy = movements.filter(m => m.action === 'buy').reduce((mx, m) => Math.max(mx, m.amount_usd ?? 0), 0);
  const uniqueWhalesSpotted = new Set(movements.map(m => m.whale_id).filter(Boolean)).size;

  return { tokens, movements, whaleById, buys1h, largestBuy, uniqueWhalesSpotted };
}

// ── Page ──────────────────────────────────────────────────────

export default async function PumpfunRadarPage() {
  const { tokens, movements, whaleById, buys1h, largestBuy, uniqueWhalesSpotted } = await getData();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            Pump.fun Radar
          </h1>
          <span className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
            style={{ background: '#FF4D6A20', color: '#FF4D6A', border: '1px solid #FF4D6A40', fontFamily: 'var(--font-mono)' }}>
            Live
          </span>
        </div>
        <p className="text-sm" style={{ color: '#8888AA' }}>
          Whale buys on pump.fun · last 24h · {movements.length} transactions tracked
        </p>
      </div>

      {/* Alert banner */}
      <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
        style={{ background: '#FF4D6A08', borderColor: '#FF4D6A30', color: '#FF4D6A' }}>
        <span>◎</span>
        <span>Monitoring pump.fun (6EF8rr…) for tracked whale wallet interactions via Helius webhook.</span>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Tokens on Radar',       value: String(tokens.length) },
          { label: 'Whale Buys (1h)',         value: String(buys1h) },
          { label: 'Largest Single Buy',      value: fmtUsd(largestBuy) },
          { label: 'Unique Whales Spotted',   value: String(uniqueWhalesSpotted) },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Token table + feed — Pro gated */}
      <ProGate featureName="Pump.fun Radar" ctaLabel="Unlock Pump.fun Radar">
      {tokens.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#111118', borderColor: '#2A2A3A', color: '#8888AA' }}>
          <p className="text-base font-semibold">No pump.fun activity yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            Whale pump.fun buys appear here as tracked wallets interact with the pump.fun program.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Top Pump.fun Tokens by Whale Volume
            </h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              {tokens.length} tokens · 24h
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Token', 'Volume', 'Buys', 'Sells', 'Whales', 'Smart $', 'Last Price', 'Last Activity'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokens.map((t, i) => {
                  const bias = t.whaleBuys / Math.max(1, t.whaleBuys + t.whaleSells);
                  return (
                    <tr key={t.mint} style={{ borderBottom: i < tokens.length - 1 ? '1px solid #1e1e2e' : 'none' }}>
                      <td className="px-5 py-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="font-medium" style={{ color: '#F0F0F8' }}>
                              {t.symbol ?? shortAddr(t.mint)}
                            </p>
                            {t.isNew && (
                              <span className="text-xs px-1.5 py-0.5 rounded font-bold"
                                style={{ background: '#00D4FF15', color: '#00D4FF', border: '1px solid #00D4FF30' }}>
                                NEW
                              </span>
                            )}
                            {t.smartMoney > 0 && (
                              <span style={{ color: '#FFB800', fontSize: 12 }}>⭐</span>
                            )}
                          </div>
                          {t.name && t.name !== t.symbol && (
                            <p className="text-xs mt-0.5" style={{ color: '#8888AA' }}>{t.name}</p>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3 font-semibold" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8' }}>
                        {fmtUsd(t.volume)}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#00E5A0' }}>
                        {t.whaleBuys}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#FF4D6A' }}>
                        {t.whaleSells}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>{t.whales.size}</span>
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#2A2A3A', width: 40 }}>
                            <div className="h-full rounded-full"
                              style={{ width: `${bias * 100}%`, background: bias > 0.6 ? '#00E5A0' : bias < 0.4 ? '#FF4D6A' : '#FFB800' }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-center" style={{ color: t.smartMoney > 0 ? '#FFB800' : '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                        {t.smartMoney > 0 ? `⭐ ${t.smartMoney}` : '—'}
                      </td>
                      <td className="px-5 py-3 text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                        {t.lastPrice ? `$${t.lastPrice < 0.0001 ? t.lastPrice.toExponential(2) : t.lastPrice.toFixed(6)}` : '—'}
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

      {/* Recent moves feed */}
      {movements.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Recent Whale Moves
            </h2>
          </div>
          <div className="divide-y" style={{ borderColor: '#1e1e2e' }}>
            {movements.slice(0, 20).map(m => {
              const whale = m.whale_id ? whaleById.get(m.whale_id) : null;
              const isBuy = m.action === 'buy';
              return (
                <div key={m.id} className="px-5 py-3 flex items-center gap-4 text-sm">
                  <span style={{
                    display: 'inline-block', fontSize: 10, fontWeight: 700,
                    padding: '2px 7px', borderRadius: 4, minWidth: 36, textAlign: 'center',
                    background: isBuy ? '#00E5A010' : '#FF4D6A10',
                    color:      isBuy ? '#00E5A0'   : '#FF4D6A',
                    border:     `1px solid ${isBuy ? '#00E5A030' : '#FF4D6A30'}`,
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {isBuy ? 'BUY' : 'SELL'}
                  </span>
                  <span className="font-medium flex-1">
                    {m.token_symbol ?? shortAddr(m.token_mint)}
                    {m.is_new_token && <span className="ml-2 text-xs" style={{ color: '#00D4FF' }}>●NEW</span>}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8', fontSize: '0.82rem' }}>
                    {fmtUsd(m.amount_usd)}
                  </span>
                  <span className="text-xs" style={{
                    color: whale?.smart_money_flag ? '#FFB800' : '#8888AA',
                    fontFamily: 'var(--font-mono)', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {whale?.smart_money_flag ? '⭐ ' : ''}{whale?.label ?? (whale?.address ? shortAddr(whale.address) : '—')}
                  </span>
                  <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)', minWidth: 52 }}>
                    {timeAgo(m.block_time)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      </ProGate>
    </div>
  );
}
