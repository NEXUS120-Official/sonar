// ============================================================
// Price Prediction — SONAR Intelligence Layer
// ============================================================

'use client';

import { useEffect, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────

interface PredictionSignal {
  name:        string;
  direction:   'bullish' | 'bearish' | 'neutral';
  strength:    number;
  weight:      number;
  description: string;
}

interface SolPrediction {
  ok:                boolean;
  direction:         'bullish' | 'bearish' | 'neutral';
  probability:       number;
  confidence:        'high' | 'medium' | 'low' | 'insufficient_data';
  bias_score:        number;
  signals:           PredictionSignal[];
  smart_money_ratio: number;
  confluence:        { aligned: number; amplifier: number };
  data_age_min:      number;
  next_update:       string;
  computed_at:       string;
  cached:            boolean;
}

interface AccuracyPoint {
  alert_type:      string;
  window_minutes:  number;
  n_signals:       number;
  hit_rate:        number;
  mean_return_pct: number;
  ci_low:          number;
  ci_high:         number;
  is_robust:       boolean;
}

interface AccuracyResponse {
  ok:                    boolean;
  points:                AccuracyPoint[];
  data_window_days:      number;
  total_alerts_analyzed: number;
}

// ── Helpers ───────────────────────────────────────────────────

function directionColor(d: string) {
  return d === 'bullish' ? '#00E5A0' : d === 'bearish' ? '#FF4D6A' : '#8888AA';
}

function directionLabel(d: string) {
  return d === 'bullish' ? 'BULLISH' : d === 'bearish' ? 'BEARISH' : 'NEUTRAL';
}

function confidenceColor(c: string) {
  return c === 'high' ? '#00E5A0' : c === 'medium' ? '#FFB800' : c === 'low' ? '#FF4D6A' : '#8888AA';
}

function fmtAlertType(t: string) {
  return t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const WINDOWS = [5, 15, 60, 240] as const;
const WINDOW_LABELS: Record<number, string> = { 5: '5m', 15: '15m', 60: '1h', 240: '4h' };

// ── Page ──────────────────────────────────────────────────────

export default function PricePredictionPage() {
  const [pred,    setPred]    = useState<SolPrediction | null>(null);
  const [acc,     setAcc]     = useState<AccuracyResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/predict/sol').then((r) => r.json()),
      fetch('/api/signal/accuracy').then((r) => r.json()),
    ]).then(([predData, accData]) => {
      setPred(predData as SolPrediction);
      setAcc(accData as AccuracyResponse);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Auto-refresh prediction every 30s
  useEffect(() => {
    const interval = setInterval(() => {
      fetch('/api/predict/sol')
        .then((r) => r.json())
        .then((data) => setPred(data as SolPrediction))
        .catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const direction = pred?.direction ?? 'neutral';
  const dirColor  = directionColor(direction);

  // Build accuracy lookup
  const pointMap = new Map<string, Map<number, AccuracyPoint>>();
  for (const p of acc?.points ?? []) {
    if (!pointMap.has(p.alert_type)) pointMap.set(p.alert_type, new Map());
    pointMap.get(p.alert_type)!.set(p.window_minutes, p);
  }
  const alertTypes = [...pointMap.keys()].sort();

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Price Prediction
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#8888AA' }}>
          Bayesian directional model · SOL/USD · updates every 5 min
        </p>
      </div>

      {/* ── MAIN PREDICTION CARD ─────────────────────────────── */}
      <div
        className="rounded-2xl border p-6 lg:p-8"
        style={{
          background:  '#0D0D15',
          borderColor: loading ? '#2A2A3A' : dirColor + '40',
          boxShadow:   loading ? 'none' : `0 0 40px ${dirColor}10`,
        }}
      >
        {loading ? (
          <div className="text-center py-8 text-sm" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Computing prediction…
          </div>
        ) : pred ? (
          <div className="flex flex-col lg:flex-row gap-8 items-start">

            {/* Direction + probability */}
            <div className="flex-1">
              <p className="text-xs uppercase tracking-widest mb-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                SOL Directional Bias · 1h Window
              </p>

              <div className="flex items-center gap-4 mb-4">
                <span
                  className="text-5xl lg:text-6xl font-black"
                  style={{ fontFamily: 'var(--font-heading)', color: dirColor }}
                >
                  {directionLabel(direction)}
                </span>
              </div>

              {/* Probability bar */}
              <div className="mb-4">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Probability</span>
                  <span className="text-sm font-bold" style={{ color: dirColor, fontFamily: 'var(--font-mono)' }}>
                    {(pred.probability * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ background: '#1A1A24' }}>
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width:      `${pred.probability * 100}%`,
                      background: `linear-gradient(90deg, ${dirColor}80, ${dirColor})`,
                    }}
                  />
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-xs" style={{ color: '#FF4D6A', fontFamily: 'var(--font-mono)' }}>Bearish 0%</span>
                  <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Neutral 50%</span>
                  <span className="text-xs" style={{ color: '#00E5A0', fontFamily: 'var(--font-mono)' }}>Bullish 100%</span>
                </div>
              </div>

              {/* Meta badges */}
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className="text-xs px-2.5 py-1 rounded-full font-bold"
                  style={{
                    background: confidenceColor(pred.confidence) + '15',
                    color:      confidenceColor(pred.confidence),
                    border:     `1px solid ${confidenceColor(pred.confidence)}30`,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {pred.confidence === 'insufficient_data' ? 'Building Data' : pred.confidence.toUpperCase()} CONFIDENCE
                </span>
                <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  Bias: {pred.bias_score > 0 ? '+' : ''}{pred.bias_score}
                </span>
                <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {pred.confluence.aligned}/4 signals aligned
                </span>
                <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                  {pred.data_age_min < 2 ? 'live' : `${pred.data_age_min}m ago`}
                </span>
              </div>
            </div>

            {/* Signal breakdown sidebar */}
            <div className="w-full lg:w-80 flex flex-col gap-2">
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                Signal Breakdown
              </p>
              {pred.signals.map((sig, i) => {
                const sc = directionColor(sig.direction);
                return (
                  <div key={i} className="rounded-lg px-3 py-2.5" style={{ background: '#12121a' }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium" style={{ color: '#D0D0E8' }}>{sig.name}</span>
                      <span className="text-xs font-bold" style={{ color: sc, fontFamily: 'var(--font-mono)' }}>
                        {sig.direction === 'bullish' ? '▲' : sig.direction === 'bearish' ? '▼' : '—'} {sig.strength}
                      </span>
                    </div>
                    <div className="h-1 rounded-full overflow-hidden mb-1" style={{ background: '#2A2A3A' }}>
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${sig.strength}%`, background: sc }}
                      />
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: '#6b6b80' }}>{sig.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-center text-sm" style={{ color: '#FF4D6A' }}>Failed to load prediction</p>
        )}
      </div>

      {/* Stats strip */}
      {pred && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Bias Score',        value: `${pred.bias_score > 0 ? '+' : ''}${pred.bias_score}`,  color: dirColor },
            { label: 'Smart Money Ratio', value: `${(pred.smart_money_ratio * 100).toFixed(0)}%`,          color: '#FFB800' },
            { label: 'Confluence',        value: `${pred.confluence.aligned}/4 signals`,                   color: '#7B61FF' },
            { label: 'Amplifier',         value: `×${pred.confluence.amplifier.toFixed(2)}`,              color: '#00D4FF' },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
              <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
              <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: s.color }}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Signal accuracy table */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <div>
            <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>
              Signal Accuracy — Live
            </h2>
            {acc && (
              <p className="text-xs mt-0.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                {acc.total_alerts_analyzed} alerts · last {acc.data_window_days}d · vs Binance SOLUSDT
              </p>
            )}
          </div>
          <div className="hidden lg:flex items-center gap-3 text-xs" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
            <span style={{ color: '#00E5A0' }}>■ &gt;55%</span>
            <span style={{ color: '#FFB800' }}>■ 50–55%</span>
            <span style={{ color: '#FF4D6A' }}>■ &lt;50%</span>
          </div>
        </div>

        {loading && (
          <div className="px-5 py-8 text-center text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Loading accuracy data…
          </div>
        )}

        {!loading && alertTypes.length === 0 && (
          <div className="px-5 py-8 text-center text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            No accuracy data yet — signals accumulating. Check back in 24–48h.
          </div>
        )}

        {!loading && alertTypes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Alert Type</th>
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Signals</th>
                  {WINDOWS.map((w) => (
                    <th key={w} className="px-5 py-3 text-center text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                      {WINDOW_LABELS[w]}
                    </th>
                  ))}
                  <th className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Avg Return 1h</th>
                </tr>
              </thead>
              <tbody>
                {alertTypes.map((alertType, i) => {
                  const winMap    = pointMap.get(alertType)!;
                  const anyPoint  = [...winMap.values()][0];
                  const nSignals  = anyPoint?.n_signals ?? 0;
                  const isRobust  = anyPoint?.is_robust ?? false;
                  const oneHourPt = winMap.get(60);
                  return (
                    <tr key={alertType} style={{ borderBottom: i < alertTypes.length - 1 ? '1px solid #2A2A3A' : 'none' }}>
                      <td className="px-5 py-3 font-medium" style={{ color: '#F0F0F8' }}>{fmtAlertType(alertType)}</td>
                      <td className="px-5 py-3" style={{ fontFamily: 'var(--font-mono)', color: '#8888AA' }}>
                        {nSignals}
                        {!isRobust && (
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded font-bold"
                            style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40' }}>
                            Training
                          </span>
                        )}
                      </td>
                      {WINDOWS.map((w) => {
                        const pt = winMap.get(w);
                        if (!pt) return <td key={w} className="px-5 py-3 text-center" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>—</td>;
                        const color = !pt.is_robust ? '#8888AA' : pt.hit_rate > 0.55 ? '#00E5A0' : pt.hit_rate >= 0.50 ? '#FFB800' : '#FF4D6A';
                        return (
                          <td key={w} className="px-5 py-3 text-center" style={{ fontFamily: 'var(--font-mono)' }}>
                            <span style={{ color, fontWeight: 600 }}>{(pt.hit_rate * 100).toFixed(1)}%</span>
                            <span className="ml-1 text-xs" style={{ color: '#4b4b60' }}>
                              [{(pt.ci_low * 100).toFixed(0)}–{(pt.ci_high * 100).toFixed(0)}%]
                            </span>
                          </td>
                        );
                      })}
                      <td className="px-5 py-3" style={{
                        fontFamily: 'var(--font-mono)',
                        color: oneHourPt ? (oneHourPt.mean_return_pct >= 0 ? '#00E5A0' : '#FF4D6A') : '#8888AA',
                      }}>
                        {oneHourPt ? `${oneHourPt.mean_return_pct >= 0 ? '+' : ''}${oneHourPt.mean_return_pct.toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Methodology */}
      <div className="rounded-xl border p-5" style={{ background: '#0D0D15', borderColor: '#2A2A3A' }}>
        <p className="text-xs font-bold uppercase tracking-widest mb-2" style={{ color: '#7B61FF', fontFamily: 'var(--font-mono)' }}>
          Model Methodology
        </p>
        <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>
          6-layer Bayesian stack: exchange net flow (35%) · staking conviction (20%) · DeFi deployment (15%) · smart money concentration (15%) · entity track record (10%) · token accumulation clusters (5%).
          Directional probability uses a logistic function calibrated against 30d Binance SOLUSDT candles.
          Confluence amplifier (×1.0–2.0) scales signal strength when multiple components agree.
        </p>
        <p className="text-xs mt-2" style={{ color: '#4b4b60' }}>Not financial advice. Model accuracy improves as signal history accumulates.</p>
      </div>

    </div>
  );
}
