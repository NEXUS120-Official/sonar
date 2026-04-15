// ============================================================
// Price Prediction — Intelligence layer combining on-chain signals
// Accuracy section is live; prediction engine is in training
// ============================================================

'use client';

import { useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────

interface AccuracyPoint {
  alert_type:      string;
  window_minutes:  number;
  n_signals:       number;
  hit_rate:        number;
  mean_return_pct: number;
  ci_low:          number;
  ci_high:         number;
  is_robust:       boolean;
  computed_at:     string;
}

interface AccuracyResponse {
  ok:                    boolean;
  cached:                boolean;
  points:                AccuracyPoint[];
  data_window_days:      number;
  total_alerts_analyzed: number;
}

// ── Helpers ───────────────────────────────────────────────────

function hitRateColor(hitRate: number, isRobust: boolean): string {
  if (!isRobust) return '#8888AA';
  if (hitRate > 0.55) return '#00E5A0';
  if (hitRate >= 0.50) return '#FFB800';
  return '#FF4D4D';
}

function formatAlertType(t: string): string {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const WINDOWS = [5, 15, 60, 240] as const;
const WINDOW_LABELS: Record<number, string> = { 5: '5m', 15: '15m', 60: '1h', 240: '4h' };

// ── Component ─────────────────────────────────────────────────

export default function PricePredictionPage() {
  const [accuracy, setAccuracy] = useState<AccuracyResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/signal/accuracy')
      .then((r) => r.json())
      .then((data: AccuracyResponse) => {
        setAccuracy(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(String(err));
        setLoading(false);
      });
  }, []);

  const SIGNAL_INPUTS = [
    { label: 'Exchange Net Flow (24h)',   status: 'active',  weight: '—' },
    { label: 'Staking Velocity',          status: 'active',  weight: '—' },
    { label: 'Whale Buy/Sell Ratio',      status: 'active',  weight: '—' },
    { label: 'DEX Liquidity Delta',       status: 'active',  weight: '—' },
    { label: 'Pump.fun Whale Activity',   status: 'active',  weight: '—' },
    { label: 'LP Construction Signal',    status: 'pending', weight: '—' },
  ];

  // Build lookup: alertType → windowMin → AccuracyPoint
  const pointMap = new Map<string, Map<number, AccuracyPoint>>();
  for (const p of accuracy?.points ?? []) {
    if (!pointMap.has(p.alert_type)) pointMap.set(p.alert_type, new Map());
    pointMap.get(p.alert_type)!.set(p.window_minutes, p);
  }
  const alertTypes = [...pointMap.keys()].sort();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Price Prediction
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40', fontFamily: 'var(--font-mono)' }}
            >
              Model Training
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            The SONAR intelligence layer — combining on-chain signals into a directional bias with confidence score, timeframe, and supporting signal breakdown.
          </p>
        </div>
      </div>

      {/* Current prediction card */}
      <div
        className="rounded-xl border p-6"
        style={{ background: '#111118', borderColor: '#2A2A3A' }}
      >
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              Current Directional Bias
            </p>
            <div className="flex items-center gap-4">
              <span className="text-5xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#7B61FF' }}>—</span>
              <div>
                <p className="text-sm font-medium mb-0.5">Awaiting signal calibration</p>
                <p className="text-xs" style={{ color: '#8888AA' }}>Confidence: — · Timeframe: —</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 text-right">
            <p className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Model Accuracy (30d)</p>
            <p className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#F0F0F8' }}>—</p>
            <p className="text-xs" style={{ color: '#8888AA' }}>Baseline: —</p>
          </div>
        </div>
      </div>

      {/* Signal inputs */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Signal Inputs</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Signal', 'Status', 'Model Weight', 'Current Reading'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SIGNAL_INPUTS.map((s, i) => (
              <tr
                key={s.label}
                style={{ borderBottom: i < SIGNAL_INPUTS.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-3 font-medium" style={{ color: '#F0F0F8' }}>{s.label}</td>
                <td className="px-5 py-3">
                  <span
                    className="text-xs px-2 py-0.5 rounded font-bold"
                    style={{
                      background: s.status === 'active' ? '#00E5A010' : '#FFB80010',
                      color:      s.status === 'active' ? '#00E5A0'   : '#FFB800',
                      border:     `1px solid ${s.status === 'active' ? '#00E5A030' : '#FFB80030'}`,
                    }}
                  >
                    {s.status === 'active' ? 'ACTIVE' : 'PENDING'}
                  </span>
                </td>
                <td className="px-5 py-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.weight}</td>
                <td className="px-5 py-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Live Accuracy Section */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Signal Accuracy — Live
            </h2>
            {accuracy && (
              <p className="text-xs mt-0.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                {accuracy.total_alerts_analyzed} alerts · last {accuracy.data_window_days}d · price data: Binance SOLUSDT
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
            <span style={{ color: '#00E5A0' }}>&#9632; &gt;55% hit rate</span>
            <span style={{ color: '#FFB800' }}>&#9632; 50–55%</span>
            <span style={{ color: '#FF4D4D' }}>&#9632; &lt;50%</span>
            <span>&#9632; Training (&lt;50 signals)</span>
          </div>
        </div>

        {loading && (
          <div className="px-5 py-8 text-center text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Loading accuracy data…
          </div>
        )}

        {!loading && error && (
          <div className="px-5 py-8 text-center text-xs" style={{ color: '#FF4D4D', fontFamily: 'var(--font-mono)' }}>
            Error loading accuracy: {error}
          </div>
        )}

        {!loading && !error && alertTypes.length === 0 && (
          <div className="px-5 py-8 text-center text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            No accuracy data yet — signals accumulating
          </div>
        )}

        {!loading && !error && alertTypes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                    Alert Type
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                    Signals
                  </th>
                  {WINDOWS.map((w) => (
                    <th key={w} className="px-5 py-3 text-center text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      Hit Rate {WINDOW_LABELS[w]}
                    </th>
                  ))}
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                    Avg Return (1h)
                  </th>
                </tr>
              </thead>
              <tbody>
                {alertTypes.map((alertType, i) => {
                  const winMap    = pointMap.get(alertType)!;
                  const anyPoint  = winMap.values().next().value as AccuracyPoint | undefined;
                  const nSignals  = anyPoint?.n_signals ?? 0;
                  const isRobust  = anyPoint?.is_robust ?? false;
                  const oneHourPt = winMap.get(60);

                  return (
                    <tr
                      key={alertType}
                      style={{ borderBottom: i < alertTypes.length - 1 ? '1px solid #2A2A3A' : 'none' }}
                    >
                      <td className="px-5 py-3 font-medium" style={{ color: '#F0F0F8' }}>
                        {formatAlertType(alertType)}
                      </td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
                        {nSignals}
                        {!isRobust && (
                          <span
                            className="ml-2 text-xs px-1.5 py-0.5 rounded font-bold"
                            style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40' }}
                          >
                            Training
                          </span>
                        )}
                      </td>
                      {WINDOWS.map((w) => {
                        const pt = winMap.get(w);
                        if (!pt) {
                          return (
                            <td key={w} className="px-5 py-3 text-center" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                              —
                            </td>
                          );
                        }
                        const color = hitRateColor(pt.hit_rate, pt.is_robust);
                        return (
                          <td key={w} className="px-5 py-3 text-center" style={{ fontFamily: 'var(--font-mono)' }}>
                            <span style={{ color, fontWeight: 600 }}>
                              {(pt.hit_rate * 100).toFixed(1)}%
                            </span>
                            <span className="ml-1 text-xs" style={{ color: '#8888AA' }}>
                              [{(pt.ci_low * 100).toFixed(0)}–{(pt.ci_high * 100).toFixed(0)}%]
                            </span>
                          </td>
                        );
                      })}
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: oneHourPt ? (oneHourPt.mean_return_pct >= 0 ? '#00E5A0' : '#FF4D4D') : '#8888AA' }}>
                        {oneHourPt
                          ? `${oneHourPt.mean_return_pct >= 0 ? '+' : ''}${oneHourPt.mean_return_pct.toFixed(2)}%`
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
