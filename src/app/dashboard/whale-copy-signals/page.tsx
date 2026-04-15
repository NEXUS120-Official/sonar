// ============================================================
// Whale Copy Signals — Smart money token buys with confidence (live)
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
  if (diffS < 60)    return `${diffS}s ago`;
  if (diffS < 3600)  return `${Math.floor(diffS / 60)}m ago`;
  if (diffS < 86400) return `${Math.floor(diffS / 3600)}h ago`;
  return `${Math.floor(diffS / 86400)}d ago`;
}

/** Freshness decay: 1.0 if <1h, linear decay to 0.1 at 24h */
function freshnessFactor(iso: string): number {
  const ageMs  = Date.now() - new Date(iso).getTime();
  const ageH   = ageMs / 3_600_000;
  if (ageH < 1) return 1.0;
  return Math.max(0.1, 1.0 - (ageH - 1) / (23));
}

/** Confidence = reputation_score × freshness × size_multiplier (capped at 100) */
function computeConfidence(
  reputationScore: number,
  amountUsd: number,
  blockTime: string,
): number {
  const freshness      = freshnessFactor(blockTime);
  // Size multiplier: 1.0 at $1k, 1.5 at $10k, 2.0 at $100k+
  const sizeMultiplier = Math.min(2.0, 1.0 + Math.log10(Math.max(1, amountUsd / 1_000)) * 0.35);
  const raw            = reputationScore * freshness * sizeMultiplier * 100;
  return Math.min(100, Math.round(raw));
}

// ── Data ──────────────────────────────────────────────────────

async function getData() {
  const db    = createAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  // Only smart money whales
  const { data: smWhaleRaw } = await (db as any)
    .from('whales')
    .select('id, address, label, smart_money_flag, reputation_score, hit_rate_30d, signal_count_30d')
    .eq('smart_money_flag', true)
    .eq('is_active', true);

  type WhaleMeta = Pick<WhaleRow, 'id' | 'address' | 'label' | 'smart_money_flag' | 'reputation_score' | 'hit_rate_30d' | 'signal_count_30d'>;
  const smartWhales = (smWhaleRaw ?? []) as WhaleMeta[];
  const whaleIds    = smartWhales.map(w => w.id);
  const whaleById   = new Map(smartWhales.map(w => [w.id, w]));

  if (whaleIds.length === 0) {
    return { signals: [], smartWhaleCount: 0, totalSignals: 0 };
  }

  // Get their recent buys
  const { data: movRaw } = await (db as any)
    .from('token_movements')
    .select('id, whale_id, token_mint, token_symbol, token_name, action, amount_usd, price_per_token, protocol, block_time, is_new_token')
    .gte('block_time', since)
    .in('whale_id', whaleIds)
    .eq('action', 'buy')
    .order('block_time', { ascending: false })
    .limit(300);

  type TM = Pick<TokenMovementRow,
    'id' | 'whale_id' | 'token_mint' | 'token_symbol' | 'token_name' |
    'action' | 'amount_usd' | 'price_per_token' | 'protocol' | 'block_time' | 'is_new_token'
  >;
  const movements = (movRaw ?? []) as TM[];

  // Build signals: deduplicate by whale+token, keep highest confidence
  type Signal = {
    id:           string;
    whaleLabel:   string;
    whaleAddr:    string;
    reputation:   number;
    hitRate:      number;
    signalCount:  number;
    token:        string;
    tokenName:    string | null;
    tokenMint:    string;
    amountUsd:    number;
    price:        number | null;
    protocol:     string | null;
    blockTime:    string;
    confidence:   number;
    freshness:    number;
    isNew:        boolean;
  };

  const signalMap = new Map<string, Signal>();

  for (const m of movements) {
    if (!m.whale_id) continue;
    const whale = whaleById.get(m.whale_id);
    if (!whale) continue;

    const repScore  = whale.reputation_score ?? 0.5;
    const amtUsd    = m.amount_usd ?? 0;
    const confidence = computeConfidence(repScore, amtUsd, m.block_time);
    const freshness  = freshnessFactor(m.block_time);

    const key = `${m.whale_id}:${m.token_mint}`;
    const existing = signalMap.get(key);
    if (!existing || confidence > existing.confidence) {
      signalMap.set(key, {
        id:          m.id,
        whaleLabel:  whale.label ?? shortAddr(whale.address),
        whaleAddr:   whale.address,
        reputation:  Math.round(repScore * 100),
        hitRate:     Math.round((whale.hit_rate_30d ?? 0.5) * 100),
        signalCount: whale.signal_count_30d ?? 0,
        token:       m.token_symbol ?? m.token_mint.slice(0, 8),
        tokenName:   m.token_name,
        tokenMint:   m.token_mint,
        amountUsd:   amtUsd,
        price:       m.price_per_token,
        protocol:    m.protocol,
        blockTime:   m.block_time,
        confidence,
        freshness:   Math.round(freshness * 100),
        isNew:       m.is_new_token,
      });
    }
  }

  const signals = Array.from(signalMap.values())
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 50);

  return { signals, smartWhaleCount: smartWhales.length, totalSignals: movements.length };
}

// ── Confidence bar color ───────────────────────────────────────

function confColor(c: number): string {
  if (c >= 70) return '#00E5A0';
  if (c >= 45) return '#FFB800';
  return '#FF4D6A';
}

// ── Page ──────────────────────────────────────────────────────

export default async function WhaleCopySignalsPage() {
  const { signals, smartWhaleCount, totalSignals } = await getData();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Whale Copy Signals
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#8888AA' }}>
          Smart money buys ranked by confidence · {smartWhaleCount} smart whales tracked · last 24h
        </p>
      </div>

      {/* How it works */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { step: '01', title: 'Smart money buys', desc: 'Buy detected via Helius webhook for a whale with smart_money_flag (hit rate ≥62% over 30d).', color: '#7B61FF' },
          { step: '02', title: 'Confidence scored', desc: 'Confidence = reputation × freshness × size. Decays linearly from 1h to 24h.', color: '#00D4FF' },
          { step: '03', title: 'Ranked by alpha',   desc: 'Highest confidence signals at top. Reputation tracks real 30-day price outcomes.', color: '#00E5A0' },
        ].map(s => (
          <div key={s.step} className="rounded-xl border p-5" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs font-bold mb-2" style={{ color: s.color, fontFamily: 'var(--font-mono)' }}>STEP {s.step}</p>
            <p className="font-semibold text-sm mb-1" style={{ fontFamily: 'var(--font-heading)' }}>{s.title}</p>
            <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>{s.desc}</p>
          </div>
        ))}
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Smart Whales Tracked', value: String(smartWhaleCount) },
          { label: 'Buy Signals (24h)',    value: String(totalSignals) },
          { label: 'Active Signals',       value: String(signals.length) },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Signal feed */}
      {signals.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#111118', borderColor: '#2A2A3A', color: '#8888AA' }}>
          <p className="text-base font-semibold">No smart money signals yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            Signals appear here once tracked smart-money wallets (hit rate ≥62%) execute token buys via the Helius webhook stream.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
          <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Live Signal Feed</h2>
            <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              ranked by confidence · decays over 24h
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  {['Confidence', 'Whale', 'Token', 'Amount', 'Protocol', 'Hit Rate', 'Freshness', 'Time'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-medium"
                      style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={s.id} style={{ borderBottom: i < signals.length - 1 ? '1px solid #1e1e2e' : 'none' }}>
                    {/* Confidence */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold" style={{ color: confColor(s.confidence), fontFamily: 'var(--font-mono)', minWidth: 32 }}>
                          {s.confidence}
                        </span>
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#2A2A3A', width: 48 }}>
                          <div className="h-full rounded-full"
                            style={{ width: `${s.confidence}%`, background: confColor(s.confidence) }} />
                        </div>
                      </div>
                    </td>
                    {/* Whale */}
                    <td className="px-5 py-3">
                      <div>
                        <p className="font-medium text-xs" style={{ color: '#FFB800' }}>⭐ {s.whaleLabel}</p>
                        <p className="text-xs mt-0.5" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                          rep {s.reputation}/100
                        </p>
                      </div>
                    </td>
                    {/* Token */}
                    <td className="px-5 py-3">
                      <div>
                        <p className="font-semibold" style={{ color: '#00D4FF' }}>
                          {s.token}
                          {s.isNew && (
                            <span className="ml-1.5 text-xs px-1 py-0.5 rounded font-bold"
                              style={{ background: '#00D4FF15', color: '#00D4FF', border: '1px solid #00D4FF30' }}>
                              NEW
                            </span>
                          )}
                        </p>
                        {s.tokenName && s.tokenName !== s.token && (
                          <p className="text-xs mt-0.5" style={{ color: '#8888AA' }}>{s.tokenName}</p>
                        )}
                      </div>
                    </td>
                    {/* Amount */}
                    <td className="px-5 py-3 font-semibold" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8' }}>
                      {fmtUsd(s.amountUsd)}
                    </td>
                    {/* Protocol */}
                    <td className="px-5 py-3 text-xs" style={{ color: '#8888AA' }}>
                      {s.protocol ?? '—'}
                    </td>
                    {/* Hit rate */}
                    <td className="px-5 py-3">
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 12,
                        color: s.hitRate >= 62 ? '#00E5A0' : s.hitRate >= 50 ? '#FFB800' : '#FF4D6A',
                      }}>
                        {s.hitRate}%
                      </span>
                    </td>
                    {/* Freshness */}
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#2A2A3A', width: 36 }}>
                          <div className="h-full rounded-full"
                            style={{ width: `${s.freshness}%`, background: s.freshness > 66 ? '#00E5A0' : s.freshness > 33 ? '#FFB800' : '#FF4D6A' }} />
                        </div>
                        <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                          {s.freshness}%
                        </span>
                      </div>
                    </td>
                    {/* Time */}
                    <td className="px-5 py-3 text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                      {timeAgo(s.blockTime)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
