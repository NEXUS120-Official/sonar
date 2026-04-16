// ============================================================
// Predictions — Model Accuracy Tracking
// ============================================================
// Shows the real accuracy of SONAR's prediction engine over time.
// No hand-waving: actual vs. predicted direction for each horizon.
//
// This page is the proof of work for the intelligence layer.
// ============================================================

'use client';

import { useEffect, useState } from 'react';

// ── Types ──────────────────────────────────────────────────────

interface PredictionRun {
  id:               string;
  horizon:          string;
  model_name:       string;
  feature_time:     string;
  prob_up:          number | null;
  prob_down:        number | null;
  confidence:       number | null;
  direction:        number | null;
  actual_direction: number | null;
  correct:          boolean | null;
  evaluated_at:     string | null;
  top_features:     unknown;
}

interface Metrics {
  total_runs:       number;
  evaluated_count:  number;
  pending_count:    number;
  overall_accuracy: number | null;
  by_horizon: Record<string, { total: number; correct: number; accuracy: number | null }>;
}

interface IntelPredictions {
  ok:      boolean;
  metrics: Metrics;
  runs:    PredictionRun[];
}

interface SolPrediction {
  ok:          boolean;
  direction:   string;
  probability: number;
  confidence:  string;
}

// ── Helpers ────────────────────────────────────────────────────

function dirColor(d: number | string | null): string {
  if (d === 1  || d === 'bullish') return '#00E5A0';
  if (d === -1 || d === 'bearish') return '#FF4D6A';
  return '#FFB800';
}

function dirLabel(d: number | null): string {
  if (d === 1)  return '↑ UP';
  if (d === -1) return '↓ DOWN';
  if (d === 0)  return '→ FLAT';
  return '—';
}

function fmtPct(v: number | null): string {
  if (v == null) return '—';
  return `${v.toFixed(1)}%`;
}

function fmtConf(v: number | null): string {
  if (v == null) return '—';
  if (v >= 75) return 'HIGH';
  if (v >= 50) return 'MED';
  return 'LOW';
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ago`;
  if (h > 0)   return `${h}h ${m}m ago`;
  return `${m}m ago`;
}

// ── Component ──────────────────────────────────────────────────

export default function PredictionsPage() {
  const [data, setData]       = useState<IntelPredictions | null>(null);
  const [live, setLive]       = useState<SolPrediction | null>(null);
  const [horizon, setHorizon] = useState('all');
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    const hParam = horizon === 'all' ? '' : `&horizon=${horizon}`;
    const [histRes, liveRes] = await Promise.all([
      fetch(`/api/intel/predictions?limit=100${hParam}&evaluated=all`).then(r => r.json() as Promise<IntelPredictions>).catch(() => null),
      fetch('/api/predict/sol').then(r => r.json() as Promise<SolPrediction>).catch(() => null),
    ]);
    setData(histRes);
    setLive(liveRes?.ok ? liveRes : null);
    setLastUpdated(new Date());
    setLoading(false);
  }

  useEffect(() => { void load(); }, [horizon]);

  const metrics = data?.metrics;
  const runs    = data?.runs ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            Prediction Engine
          </h1>
          <p className="text-sm mt-1" style={{ color: '#8888AA' }}>
            Real accuracy tracking — every prediction verified against on-chain price data
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
              updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{ borderColor: '#2A2A3A', color: loading ? '#4b4b60' : '#8888AA' }}
          >
            {loading ? 'loading…' : 'refresh'}
          </button>
        </div>
      </div>

      {/* Live current prediction */}
      {live && (
        <div className="rounded-xl border p-5" style={{
          background: '#111118',
          borderColor: live.direction === 'bullish' ? '#00E5A040'
                     : live.direction === 'bearish' ? '#FF4D6A40'
                     : '#FFB80040',
        }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Current SOL Prediction
              </p>
              <div className="flex items-center gap-4">
                <span className="text-3xl font-bold" style={{ color: dirColor(live.direction), fontFamily: 'var(--font-heading)' }}>
                  {live.direction === 'bullish' ? '↑' : live.direction === 'bearish' ? '↓' : '→'} {live.direction.toUpperCase()}
                </span>
                <span className="text-2xl font-bold" style={{ color: dirColor(live.direction), fontFamily: 'var(--font-mono)' }}>
                  {(live.probability * 100).toFixed(0)}%
                </span>
              </div>
            </div>
            <div className="text-right">
              <p className="text-xs" style={{ color: '#8888AA' }}>Confidence</p>
              <p className="text-lg font-bold" style={{ fontFamily: 'var(--font-mono)', color: '#F0F0F8' }}>
                {live.confidence.toUpperCase()}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Accuracy metrics */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Total Predictions', value: String(metrics.total_runs), sub: `${metrics.evaluated_count} evaluated` },
            { label: 'Overall Accuracy', value: fmtPct(metrics.overall_accuracy), sub: `${metrics.evaluated_count} samples`, highlight: metrics.overall_accuracy != null && metrics.overall_accuracy >= 60 },
            { label: '4h Accuracy', value: fmtPct(metrics.by_horizon['4h']?.accuracy ?? null), sub: `${metrics.by_horizon['4h']?.total ?? 0} samples`, highlight: (metrics.by_horizon['4h']?.accuracy ?? 0) >= 60 },
            { label: '24h Accuracy', value: fmtPct(metrics.by_horizon['24h']?.accuracy ?? null), sub: `${metrics.by_horizon['24h']?.total ?? 0} samples`, highlight: (metrics.by_horizon['24h']?.accuracy ?? 0) >= 60 },
          ].map(s => (
            <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
              <p className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
              <p className="text-2xl font-bold mt-1" style={{
                fontFamily: 'var(--font-mono)',
                color: s.highlight ? '#00E5A0' : '#F0F0F8',
              }}>{s.value}</p>
              <p className="text-xs mt-0.5" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>{s.sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* Horizon filter */}
      <div className="flex gap-2">
        {['all', '4h', '24h', '72h'].map(h => (
          <button
            key={h}
            onClick={() => setHorizon(h)}
            className="text-xs px-3 py-1.5 rounded-lg border transition-colors"
            style={{
              borderColor: horizon === h ? '#7B61FF' : '#2A2A3A',
              color:       horizon === h ? '#7B61FF' : '#8888AA',
              background:  horizon === h ? '#7B61FF15' : 'transparent',
            }}
          >
            {h === 'all' ? 'All horizons' : h}
          </button>
        ))}
      </div>

      {/* Prediction history table */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-3 border-b text-xs font-semibold" style={{
          borderColor: '#2A2A3A',
          fontFamily: 'var(--font-mono)',
          color: '#8888AA',
          display: 'grid',
          gridTemplateColumns: '80px 100px 80px 80px 80px 80px 80px 1fr',
          gap: '8px',
        }}>
          <span>HORIZON</span>
          <span>FEATURE TIME</span>
          <span className="text-right">PROB UP</span>
          <span className="text-right">PROB DN</span>
          <span className="text-right">CONF</span>
          <span className="text-right">PREDICTED</span>
          <span className="text-right">ACTUAL</span>
          <span className="text-right">RESULT</span>
        </div>

        {loading && (
          <div className="text-center py-8 text-xs" style={{ color: '#8888AA' }}>loading…</div>
        )}

        {!loading && runs.length === 0 && (
          <div className="text-center py-8 text-xs" style={{ color: '#8888AA' }}>
            No predictions yet — run <span style={{ color: '#7B61FF', fontFamily: 'var(--font-mono)' }}>/api/cron/build-prediction-features</span> to generate the first batch
          </div>
        )}

        {runs.map(r => (
          <div key={r.id} className="px-5 py-2.5 border-b text-xs" style={{
            borderColor: '#2A2A3A',
            display: 'grid',
            gridTemplateColumns: '80px 100px 80px 80px 80px 80px 80px 1fr',
            gap: '8px',
            alignItems: 'center',
          }}>
            <span className="rounded px-1.5 py-0.5 text-center font-semibold" style={{
              background: r.horizon === '4h' ? '#7B61FF20' : r.horizon === '24h' ? '#00E5A020' : '#FFB80020',
              color:      r.horizon === '4h' ? '#7B61FF'   : r.horizon === '24h' ? '#00E5A0'   : '#FFB800',
              fontFamily: 'var(--font-mono)',
            }}>
              {r.horizon}
            </span>

            <span style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              {timeAgo(r.feature_time)}
            </span>

            <span className="text-right" style={{ color: '#00E5A0', fontFamily: 'var(--font-mono)' }}>
              {r.prob_up != null ? `${(r.prob_up * 100).toFixed(0)}%` : '—'}
            </span>

            <span className="text-right" style={{ color: '#FF4D6A', fontFamily: 'var(--font-mono)' }}>
              {r.prob_down != null ? `${(r.prob_down * 100).toFixed(0)}%` : '—'}
            </span>

            <span className="text-right" style={{ color: '#F0F0F8', fontFamily: 'var(--font-mono)' }}>
              {fmtConf(r.confidence)}
            </span>

            <span className="text-right font-semibold" style={{
              color: dirColor(r.direction),
              fontFamily: 'var(--font-mono)',
            }}>
              {dirLabel(r.direction)}
            </span>

            <span className="text-right font-semibold" style={{
              color: r.actual_direction != null ? dirColor(r.actual_direction) : '#4b4b60',
              fontFamily: 'var(--font-mono)',
            }}>
              {r.actual_direction != null ? dirLabel(r.actual_direction) : '…'}
            </span>

            <span className="text-right font-bold" style={{
              fontFamily: 'var(--font-mono)',
              color: r.correct === true  ? '#00E5A0'
                   : r.correct === false ? '#FF4D6A'
                   : '#4b4b60',
            }}>
              {r.correct === true ? '✓ HIT' : r.correct === false ? '✗ MISS' : r.evaluated_at ? '—' : 'PENDING'}
            </span>
          </div>
        ))}
      </div>

      {/* Explanation */}
      <div className="rounded-xl border p-5 text-xs space-y-2" style={{ background: '#0D0D16', borderColor: '#2A2A3A', color: '#8888AA' }}>
        <p className="font-semibold" style={{ color: '#F0F0F8' }}>How predictions are evaluated</p>
        <p>• Every hour, <span style={{ color: '#7B61FF', fontFamily: 'var(--font-mono)' }}>build-prediction-features</span> reads flow_snapshots and bias_index_history, writes a feature vector to <span style={{ fontFamily: 'var(--font-mono)' }}>prediction_features</span>, and runs the prediction model</p>
        <p>• The model outputs probability_up, probability_down, and direction for 4h / 24h / 72h horizons</p>
        <p>• <span style={{ color: '#7B61FF', fontFamily: 'var(--font-mono)' }}>evaluate-predictions</span> runs at :30 each hour. When a horizon elapses, it fetches SOL price from Binance at feature_time and feature_time+horizon, computes pct_change and actual_direction, then marks the prediction as HIT or MISS</p>
        <p>• <span style={{ color: '#F0F0F8' }}>No lookahead bias</span>: predictions are locked at feature_time and never updated after the model runs</p>
      </div>
    </div>
  );
}
