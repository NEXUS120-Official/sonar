'use client';
// ============================================================
// TokenPredictionCard — Client component
// Fetches /api/predict/token/[mint] and renders a prediction
// widget for the given token mint.
// ============================================================

import { useEffect, useState } from 'react';

interface TokenPrediction {
  ok:          boolean;
  mint:        string;
  direction:   'bullish' | 'bearish' | 'neutral';
  probability: number;
  confidence:  string;
  signals:     Array<{ name: string; direction: string; weight: number; value?: number }>;
  whale_activity: {
    total_events:  number;
    unique_whales: number;
    total_usd:     number;
    buy_usd:       number;
    sell_usd:      number;
  };
  computed_at: string;
}

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

interface Props {
  mint:   string;
  symbol: string | null;
}

export default function TokenPredictionCard({ mint, symbol }: Props) {
  const [data, setData]     = useState<TokenPrediction | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetch(`/api/predict/token/${mint}`)
      .then(r => r.json())
      .then((d: TokenPrediction) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [mint]);

  const dirColor = (d: string) =>
    d === 'bullish' ? '#00E5A0' : d === 'bearish' ? '#FF4D6A' : '#FFB800';

  const dirEmoji = (d: string) =>
    d === 'bullish' ? '↑' : d === 'bearish' ? '↓' : '→';

  return (
    <div className="rounded-xl border p-5 space-y-4" style={{ background: '#111118', borderColor: '#7B61FF40' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span style={{ color: '#7B61FF', fontSize: 14 }}>🧠</span>
          <p className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
            Token Prediction
          </p>
        </div>
        <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
          {symbol ?? mint.slice(0, 8)}
        </span>
      </div>

      {loading && (
        <div className="text-xs text-center py-4" style={{ color: '#8888AA' }}>computing…</div>
      )}

      {!loading && !data && (
        <div className="text-xs text-center py-4" style={{ color: '#FF4D6A' }}>failed to load</div>
      )}

      {!loading && data && (
        <>
          {/* Direction + probability */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold" style={{ color: dirColor(data.direction), fontFamily: 'var(--font-heading)' }}>
                {dirEmoji(data.direction)} {data.direction.toUpperCase()}
              </p>
              <p className="text-xs mt-0.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                confidence: {data.confidence}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-mono)', color: dirColor(data.direction) }}>
                {(data.probability * 100).toFixed(0)}%
              </p>
              <p className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>probability</p>
            </div>
          </div>

          {/* Probability bar */}
          <div className="h-2 rounded-full overflow-hidden" style={{ background: '#2A2A3A' }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${data.probability * 100}%`, background: dirColor(data.direction) }} />
          </div>

          {/* Whale activity */}
          <div className="grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'Whales',   value: String(data.whale_activity.unique_whales) },
              { label: 'Buy vol',  value: fmtUsd(data.whale_activity.buy_usd) },
              { label: 'Sell vol', value: fmtUsd(data.whale_activity.sell_usd) },
            ].map(s => (
              <div key={s.label} className="rounded-lg p-2" style={{ background: '#0D0D16' }}>
                <p className="text-xs font-semibold" style={{ color: '#F0F0F8', fontFamily: 'var(--font-mono)' }}>{s.value}</p>
                <p style={{ color: '#8888AA', fontSize: 10, fontFamily: 'var(--font-mono)' }}>{s.label}</p>
              </div>
            ))}
          </div>

          {/* Signals */}
          {data.signals.length > 0 && (
            <div className="space-y-1.5">
              {data.signals.slice(0, 4).map((sig, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span style={{ color: '#8888AA' }}>{sig.name}</span>
                  <span style={{ color: dirColor(sig.direction), fontFamily: 'var(--font-mono)' }}>
                    {sig.direction === 'bullish' ? '+' : sig.direction === 'bearish' ? '−' : ''}
                    {(sig.weight * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            4h lookback · {new Date(data.computed_at).toLocaleTimeString()}
          </p>
        </>
      )}
    </div>
  );
}
