// ============================================================
// DEX Intelligence — Whale volume aggregated by protocol (live)
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import type { TokenMovementRow } from '@/lib/supabase/types';

// ── Helpers ───────────────────────────────────────────────────

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function timeAgo(iso: string): string {
  const diffS = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffS < 60)    return `${diffS}s ago`;
  if (diffS < 3600)  return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

// Canonical DEX display config
const DEX_DISPLAY: Record<string, { label: string; icon: string; color: string }> = {
  raydium_v4:      { label: 'Raydium',  icon: '⬡', color: '#7B61FF' },
  raydium_camm:    { label: 'Raydium',  icon: '⬡', color: '#7B61FF' },
  raydium_clmm:    { label: 'Raydium',  icon: '⬡', color: '#7B61FF' },
  orca_whirlpool:  { label: 'Orca',     icon: '◎', color: '#00D4FF' },
  orca:            { label: 'Orca',     icon: '◎', color: '#00D4FF' },
  meteora_dlmm:    { label: 'Meteora',  icon: '◈', color: '#00E5A0' },
  meteora:         { label: 'Meteora',  icon: '◈', color: '#00E5A0' },
  phoenix:         { label: 'Phoenix',  icon: '◬', color: '#FFB800' },
  jupiter:         { label: 'Jupiter',  icon: '◉', color: '#F0F0F8' },
  pumpfun:         { label: 'Pump.fun', icon: '◐', color: '#FF4D6A' },
};

// Canonical DEX order for display (group Raydium variants together)
const DEX_GROUP_ORDER = ['raydium', 'orca', 'meteora', 'phoenix', 'jupiter', 'pumpfun', 'other'];

// ── Data ──────────────────────────────────────────────────────

async function getData() {
  const db      = createAdminClient();
  const since24 = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const since48 = new Date(Date.now() - 48 * 3_600_000).toISOString();

  const [cur, prev] = await Promise.all([
    (db as any)
      .from('token_movements')
      .select('whale_id, action, amount_usd, protocol, block_time, token_mint, token_symbol')
      .gte('block_time', since24)
      .in('action', ['buy', 'sell'])
      .not('protocol', 'is', null),
    (db as any)
      .from('token_movements')
      .select('amount_usd, protocol')
      .gte('block_time', since48)
      .lt('block_time', since24)
      .in('action', ['buy', 'sell'])
      .not('protocol', 'is', null),
  ]);

  type TM = Pick<TokenMovementRow, 'whale_id' | 'action' | 'amount_usd' | 'protocol' | 'block_time' | 'token_mint' | 'token_symbol'>;
  const current  = (cur.data ?? [])  as TM[];
  const previous = (prev.data ?? []) as Pick<TokenMovementRow, 'amount_usd' | 'protocol'>[];

  // Aggregate current window by protocol group
  type DexStats = {
    group:      string;
    protocols:  Set<string>;
    volume:     number;
    buys:       number;
    sells:      number;
    whales:     Set<string>;
    lastActive: string;
    topToken:   string | null;
    tokenVol:   Map<string, number>;
  };

  const dexMap = new Map<string, DexStats>();

  const groupOf = (protocol: string): string => {
    const p = (protocol ?? '').toLowerCase();
    if (p.startsWith('raydium')) return 'raydium';
    if (p.startsWith('orca'))    return 'orca';
    if (p.startsWith('meteora')) return 'meteora';
    if (p === 'phoenix')         return 'phoenix';
    if (p === 'jupiter')         return 'jupiter';
    if (p === 'pumpfun')         return 'pumpfun';
    return 'other';
  };

  for (const m of current) {
    const grp = groupOf(m.protocol ?? '');
    if (!dexMap.has(grp)) {
      dexMap.set(grp, {
        group: grp, protocols: new Set(), volume: 0,
        buys: 0, sells: 0, whales: new Set(),
        lastActive: m.block_time, topToken: null, tokenVol: new Map(),
      });
    }
    const d = dexMap.get(grp)!;
    d.protocols.add(m.protocol ?? '');
    d.volume += m.amount_usd ?? 0;
    if (m.action === 'buy')  d.buys++;
    if (m.action === 'sell') d.sells++;
    if (m.whale_id) d.whales.add(m.whale_id);
    if (m.block_time > d.lastActive) d.lastActive = m.block_time;
    if (m.token_mint) {
      const v = (d.tokenVol.get(m.token_mint) ?? 0) + (m.amount_usd ?? 0);
      d.tokenVol.set(m.token_mint, v);
    }
  }

  // Compute top token per DEX
  for (const d of dexMap.values()) {
    let topMint = null as string | null;
    let topVol  = 0;
    for (const [mint, vol] of d.tokenVol) {
      if (vol > topVol) { topVol = vol; topMint = mint; }
    }
    // Resolve symbol from current movements
    if (topMint) {
      const found = current.find(m => m.token_mint === topMint && m.token_symbol);
      d.topToken = found?.token_symbol ?? topMint.slice(0, 8);
    }
  }

  // Previous window volume by group
  const prevVol = new Map<string, number>();
  for (const m of previous) {
    const grp = groupOf(m.protocol ?? '');
    prevVol.set(grp, (prevVol.get(grp) ?? 0) + (m.amount_usd ?? 0));
  }

  // Sort by volume desc, following DEX_GROUP_ORDER preference
  const sortedDexes = [...dexMap.values()].sort((a, b) => b.volume - a.volume);

  const totalVol     = sortedDexes.reduce((s, d) => s + d.volume, 0);
  const totalWhales  = new Set(current.map(m => m.whale_id).filter(Boolean)).size;
  const totalEvents  = current.length;
  const mostActive   = sortedDexes[0];

  return { sortedDexes, prevVol, totalVol, totalWhales, totalEvents, mostActive };
}

// ── Page ──────────────────────────────────────────────────────

export default async function DexIntelligencePage() {
  const { sortedDexes, prevVol, totalVol, totalWhales, totalEvents, mostActive } = await getData();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          DEX Intelligence
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#8888AA' }}>
          Whale volume by protocol · last 24h · {totalEvents} transactions
        </p>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Total DEX Volume (24h)', value: fmtUsd(totalVol) },
          { label: 'Active Protocols',        value: String(sortedDexes.length) },
          { label: 'Most Active DEX',         value: mostActive
            ? (DEX_DISPLAY[mostActive.protocols.values().next().value ?? '']?.label ?? mostActive.group)
            : '—' },
          { label: 'Unique Whales',           value: String(totalWhales) },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* DEX breakdown */}
      {sortedDexes.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#111118', borderColor: '#2A2A3A', color: '#8888AA' }}>
          <p className="text-base font-semibold">No DEX data yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            DEX activity populates as whales trade through Raydium, Orca, Meteora and other protocols via the Helius webhook stream.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              DEX Activity Breakdown
            </h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>24h window</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Protocol', 'Volume', 'Txns', 'Buys', 'Sells', 'Whales', 'Top Token', 'vs Prior 24h', 'Last Active'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedDexes.map((d, i) => {
                  const display  = DEX_DISPLAY[d.protocols.values().next().value ?? '']
                                ?? { label: d.group.charAt(0).toUpperCase() + d.group.slice(1), icon: '◻', color: '#8888AA' };
                  const prior    = prevVol.get(d.group) ?? 0;
                  const changePct = prior > 0 ? ((d.volume - prior) / prior) * 100 : null;
                  const share     = totalVol > 0 ? (d.volume / totalVol) * 100 : 0;

                  return (
                    <tr key={d.group} style={{ borderBottom: i < sortedDexes.length - 1 ? '1px solid #1e1e2e' : 'none' }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <span style={{ color: display.color, fontSize: 16 }}>{display.icon}</span>
                          <div>
                            <p className="font-medium" style={{ color: '#F0F0F8' }}>{display.label}</p>
                            <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: '#2A2A3A', width: 64 }}>
                              <div className="h-full rounded-full" style={{ width: `${share}%`, background: display.color + '80' }} />
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 font-semibold" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8' }}>
                        {fmtUsd(d.volume)}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
                        {d.buys + d.sells}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#00E5A0' }}>
                        {d.buys}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#FF4D6A' }}>
                        {d.sells}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
                        {d.whales.size}
                      </td>
                      <td className="px-5 py-3 text-xs" style={{ color: '#00D4FF', fontFamily: 'var(--font-mono)' }}>
                        {d.topToken ?? '—'}
                      </td>
                      <td className="px-5 py-3">
                        {changePct === null ? (
                          <span style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)', fontSize: 12 }}>—</span>
                        ) : (
                          <span style={{
                            fontFamily: 'var(--font-mono)', fontSize: 12,
                            color: changePct > 0 ? '#00E5A0' : '#FF4D6A',
                          }}>
                            {changePct > 0 ? '↑' : '↓'}{Math.abs(changePct).toFixed(0)}%
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                        {timeAgo(d.lastActive)}
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
