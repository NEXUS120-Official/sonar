#!/usr/bin/env tsx
// ============================================================
// SONAR v2.0 — Signal Quality Continuous Validation Pipeline
// ============================================================
// Statistically validates SONAR signal directionality for SOL
// price prediction, with alert/snapshot deduplication, true
// independent signal counts, and run-over-run comparison.
//
// Changes vs v1 (single-study mode):
//   - Alert deduplication: consecutive firings within the
//     per-type cooldown window are collapsed to 1 event.
//   - Snapshot deduplication: only direction-change events
//     (market_bias flip) are treated as new signals.
//   - 95% confidence intervals on all hit rates.
//   - Required-N advisory: N=385 for 95% CI ±5%.
//   - Confirmation count stratification (cc >= 2 filter).
//   - Comparison with most-recent prior artifact.
//   - Script version tag in artifact for schema tracking.
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json \
//     --env-file=.env.local \
//     scripts/validate-signal-quality.ts
//
// Output:
//   artifacts/signal-quality-{date}.json
//   (overwrites if run multiple times on the same date)
// ============================================================

import { createClient }          from '@supabase/supabase-js';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { resolve }               from 'path';
import { loadEnv }               from './lib/load-env';
import type { Database, FlowSnapshotRow, AlertRow, AlertType } from '../src/lib/supabase/types';

loadEnv();

// ── Config ────────────────────────────────────────────────────

const SCRIPT_VERSION   = '2.0';
const BIAS_THRESHOLDS  = [20, 40, 60] as const;
const FORWARD_WINDOWS  = [5, 15, 60, 240, 1440, 10080] as const; // minutes
const CANDLE_MS        = 5 * 60 * 1000;
const BINANCE_LIMIT    = 1000;

/** Minimum N of independent signals for 95% CI ±5% */
const REQUIRED_N_FOR_ROBUST_CI = 385;

/**
 * Per-alert-type cooldown windows (ms) for deduplication.
 * Matches ALERT_COOLDOWNS_MS in constants.ts — kept local to avoid
 * importing application code into the analysis script.
 */
const ALERT_COOLDOWNS_MS: Record<string, number> = {
  accumulation_wave: 2 * 60 * 60 * 1000,
  distribution_wave: 2 * 60 * 60 * 1000,
  exchange_spike:    4 * 60 * 60 * 1000,
  staking_shift:     4 * 60 * 60 * 1000,
  flow_reversal:     4 * 60 * 60 * 1000,
};
const DEFAULT_ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // fallback for unknown types
const ALERT_MIN_CHANGE_PCT      = 0.20;                // 20% metric change allows refire

// ── Supabase ──────────────────────────────────────────────────

const db = createClient<Database>(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Types ─────────────────────────────────────────────────────

interface Candle {
  open_time: number;
  open: number; high: number; low: number; close: number;
}

interface SignalPoint {
  ts:           number;
  source:       'snapshot' | 'alert';
  signal_type:  string;
  bias_score:   number | null;
  conf_count:   number | null;    // confirmation_count from snapshot (or related snapshot)
  raw:          FlowSnapshotRow | AlertRow;
}

interface ForwardReturn {
  window_min:  number;
  return_pct:  number;
  entry_price: number;
  exit_price:  number;
}

interface ScoredSignal extends SignalPoint {
  entry_price:   number;
  forward:       ForwardReturn[];
  predicted_dir: 'bullish' | 'bearish' | 'neutral';
}

interface WindowStats {
  window_min:      number;
  n:               number;
  hit_rate_pct:    number;
  ci95_lo:         number;
  ci95_hi:         number;
  mean_return_pct: number;
  med_return_pct:  number;
  mfe_pct:         number;
  mae_pct:         number;
  tp: number; fp: number;
}

interface ThresholdStats {
  threshold:  number;
  n_signals:  number;
  n_neutral:  number;
  per_window: WindowStats[];
}

interface AlertTypeStats {
  alert_type:      string;
  n_raw:           number;
  n_deduped:       number;
  mean_bias:       number;
  dominant_bias:   string;
  hit_rate_1h_pct: number;
  hit_rate_4h_pct: number;
  mean_ret_1h_pct: number;
  mean_ret_4h_pct: number;
}

interface FlowReversalStats {
  n_reversals:     number;
  hit_rate_1h_pct: number;
  hit_rate_4h_pct: number;
  mean_ret_1h_pct: number;
  mean_ret_4h_pct: number;
}

interface ConfirmationStratStats {
  filter:          string;
  n:               number;
  hit_rate_4h_pct: number;
  ci95_lo:         number;
  ci95_hi:         number;
}

interface ComparisonDelta {
  previous_run_at:    string;
  previous_n_deduped: number;
  previous_hit_rate:  number;
  current_n_deduped:  number;
  current_hit_rate:   number;
  delta_n:            number;
  delta_hit_rate:     number;
  trend:              'improving' | 'declining' | 'stable' | 'inconclusive';
}

// ── Binance price fetcher ─────────────────────────────────────

async function fetchKlines(startMs: number, endMs: number): Promise<Map<number, Candle>> {
  const priceMap = new Map<number, Candle>();
  let cursor = startMs;
  let calls   = 0;

  process.stdout.write('  Fetching SOL/USDT candles from Binance');

  while (cursor < endMs) {
    const url =
      `https://api.binance.com/api/v3/klines` +
      `?symbol=SOLUSDT&interval=5m` +
      `&startTime=${cursor}&endTime=${endMs}&limit=${BINANCE_LIMIT}`;

    let batch: unknown[][] = [];
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      batch = (await res.json()) as unknown[][];
    } catch {
      await sleep(2000);
      const res2 = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res2.ok) throw new Error(`Binance API ${res2.status}: ${await res2.text()}`);
      batch = (await res2.json()) as unknown[][];
    }

    if (!batch.length) break;
    for (const k of batch) priceMap.set(Number(k[0]), {
      open_time: Number(k[0]), open: Number(k[1]), high: Number(k[2]),
      low: Number(k[3]), close: Number(k[4]),
    });
    cursor = Number(batch[batch.length - 1][0]) + CANDLE_MS;

    calls++;
    process.stdout.write('.');
    if (calls % 30 === 0) await sleep(3000); else await sleep(200);
  }

  console.log(` done (${priceMap.size} candles, ${calls} calls)`);
  return priceMap;
}

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function floorTo5m(ms: number): number {
  return Math.floor(ms / CANDLE_MS) * CANDLE_MS;
}

function getPrice(priceMap: Map<number, Candle>, ms: number): number | null {
  const key = floorTo5m(ms);
  for (let d = 0; d <= 2; d++) {
    const c = priceMap.get(key + d * CANDLE_MS) ?? priceMap.get(key - d * CANDLE_MS);
    if (c) return c.close;
  }
  return null;
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/**
 * Wilson score 95% confidence interval for a proportion.
 * Returns [lo, hi] as percentages (0–100).
 */
function wilsonCI95(successes: number, n: number): [number, number] {
  if (n === 0) return [0, 100];
  const z    = 1.96;
  const p    = successes / n;
  const denom = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, (center - margin) * 100), Math.min(100, (center + margin) * 100)];
}

function pct2(n: number): string { return n.toFixed(2) + '%'; }
function padR(s: string, n: number): string { return s.padEnd(n); }
function padL(s: string, n: number): string { return s.padStart(n); }

function predictedDir(biasScore: number | null, threshold: number): 'bullish' | 'bearish' | 'neutral' {
  if (biasScore === null) return 'neutral';
  if (biasScore >= threshold)  return 'bullish';
  if (biasScore <= -threshold) return 'bearish';
  return 'neutral';
}

// ── Deduplication ─────────────────────────────────────────────

/**
 * Deduplicate 4h snapshots: keep only direction-change events.
 * Consecutive snapshots with the same market_bias are collapsed —
 * only the FIRST in each consecutive same-bias run is retained.
 *
 * This converts "288 snapshots/day" into "N direction changes/day"
 * — the true independent signal count.
 */
function deduplicateSnapshots(snapshots: FlowSnapshotRow[]): FlowSnapshotRow[] {
  const sorted = [...snapshots].sort(
    (a, b) => new Date(a.snapshot_time).getTime() - new Date(b.snapshot_time).getTime(),
  );

  const deduped: FlowSnapshotRow[] = [];
  let lastBias: string | null = null;

  for (const snap of sorted) {
    const bias = snap.market_bias ?? 'neutral';
    if (bias !== lastBias) {
      deduped.push(snap);
      lastBias = bias;
    }
  }

  return deduped;
}

/**
 * Extract the key signal metric stored in an alert's data JSON.
 * Used for the 20% min-change check during deduplication.
 */
function alertSignalValue(alert: AlertRow): number | null {
  const data = alert.data as Record<string, unknown> | null;
  if (!data) return null;
  switch (alert.alert_type) {
    case 'exchange_spike':    return typeof data['current_volume_usd'] === 'number' ? data['current_volume_usd'] : null;
    case 'accumulation_wave': return typeof data['net_outflow_usd']    === 'number' ? data['net_outflow_usd']    : null;
    case 'distribution_wave': return typeof data['net_inflow_usd']     === 'number' ? data['net_inflow_usd']     : null;
    case 'staking_shift':     return typeof data['net_staking_usd']    === 'number' ? Math.abs(data['net_staking_usd'] as number) : null;
    case 'flow_reversal':     return typeof data['magnitude_usd']      === 'number' ? data['magnitude_usd']      : null;
    default:                  return null;
  }
}

/**
 * Deduplicate alerts: for each alert_type, consecutive firings within
 * the cooldown window that don't show ≥20% metric change are collapsed.
 *
 * Returns both the deduped list AND a per-type raw/deduped count map.
 */
function deduplicateAlerts(alerts: AlertRow[]): {
  deduped: AlertRow[];
  counts: Map<string, { raw: number; deduped: number }>;
} {
  const byType = new Map<AlertType, AlertRow[]>();
  for (const a of alerts) {
    const list = byType.get(a.alert_type) ?? [];
    list.push(a);
    byType.set(a.alert_type, list);
  }

  const deduped: AlertRow[] = [];
  const counts  = new Map<string, { raw: number; deduped: number }>();

  for (const [type, group] of byType.entries()) {
    const sorted = [...group].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );

    const cooldownMs = ALERT_COOLDOWNS_MS[type as string] ?? DEFAULT_ALERT_COOLDOWN_MS;
    const typeDeduped: AlertRow[] = [];
    let lastFiredMs = 0;
    let lastValue: number | null = null;

    for (const a of sorted) {
      const ts      = new Date(a.created_at).getTime();
      const elapsed = ts - lastFiredMs;
      const curVal  = alertSignalValue(a);

      // Cooldown expired → always keep
      if (elapsed >= cooldownMs) {
        typeDeduped.push(a);
        lastFiredMs = ts;
        lastValue   = curVal;
        continue;
      }

      // Within cooldown — check metric change
      if (lastValue !== null && curVal !== null && Math.abs(lastValue) > 0) {
        const changePct = Math.abs(curVal - lastValue) / Math.abs(lastValue);
        if (changePct >= ALERT_MIN_CHANGE_PCT) {
          // Large enough change — treat as new independent event
          typeDeduped.push(a);
          lastFiredMs = ts;
          lastValue   = curVal;
        }
        // else: suppress (within cooldown, small change)
      }
      // lastValue null or lastValue == 0 → suppress within cooldown
    }

    deduped.push(...typeDeduped);
    counts.set(type, { raw: sorted.length, deduped: typeDeduped.length });
  }

  // Sort by created_at
  deduped.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return { deduped, counts };
}

// ── Stats functions ───────────────────────────────────────────

function computeWindowStats(
  signals:   ScoredSignal[],
  windowMin: number,
  threshold: number,
): WindowStats {
  const eligible = signals.filter((s) => {
    const d  = predictedDir(s.bias_score, threshold);
    if (d === 'neutral') return false;
    return !!s.forward.find((f) => f.window_min === windowMin);
  });

  if (!eligible.length) {
    return { window_min: windowMin, n: 0, hit_rate_pct: 0,
      ci95_lo: 0, ci95_hi: 0, mean_return_pct: 0, med_return_pct: 0,
      mfe_pct: 0, mae_pct: 0, tp: 0, fp: 0 };
  }

  let tp = 0, fp = 0;
  const returns: number[] = [];
  const mfes:    number[] = [];
  const maes:    number[] = [];

  for (const s of eligible) {
    const dir = predictedDir(s.bias_score, threshold);
    const fw  = s.forward.find((f) => f.window_min === windowMin)!;
    const ret = fw.return_pct;
    returns.push(ret);

    const actualUp = ret > 0;
    const hit = (dir === 'bullish' && actualUp) || (dir === 'bearish' && !actualUp);
    if (hit) tp++; else fp++;

    if (dir === 'bullish') {
      mfes.push(Math.max(0,  ret));
      maes.push(Math.max(0, -ret));
    } else {
      mfes.push(Math.max(0, -ret));
      maes.push(Math.max(0,  ret));
    }
  }

  const n = eligible.length;
  const [ci95_lo, ci95_hi] = wilsonCI95(tp, n);

  return {
    window_min: windowMin, n,
    hit_rate_pct:    (tp / n) * 100,
    ci95_lo, ci95_hi,
    mean_return_pct: mean(returns),
    med_return_pct:  median(returns),
    mfe_pct:         mean(mfes),
    mae_pct:         mean(maes),
    tp, fp,
  };
}

function computeAlertTypeStats(
  signals:   ScoredSignal[],
  dedupCounts: Map<string, { raw: number; deduped: number }>,
  threshold: number,
): AlertTypeStats[] {
  const alertSignals = signals.filter((s) => s.source === 'alert');
  const groups = new Map<string, ScoredSignal[]>();
  for (const s of alertSignals) {
    const g = groups.get(s.signal_type) ?? [];
    g.push(s);
    groups.set(s.signal_type, g);
  }

  return Array.from(groups.entries()).map(([type, group]) => {
    const biasScores = group.map((s) => s.bias_score).filter((b): b is number => b !== null);
    const meanBias   = mean(biasScores);
    const s1h = computeWindowStats(group, 60,  threshold);
    const s4h = computeWindowStats(group, 240, threshold);
    const dc  = dedupCounts.get(type) ?? { raw: group.length, deduped: group.length };

    return {
      alert_type:      type,
      n_raw:           dc.raw,
      n_deduped:       dc.deduped,
      mean_bias:       meanBias,
      dominant_bias:   meanBias > 10 ? 'bullish' : meanBias < -10 ? 'bearish' : 'neutral',
      hit_rate_1h_pct: s1h.hit_rate_pct,
      hit_rate_4h_pct: s4h.hit_rate_pct,
      mean_ret_1h_pct: s1h.mean_return_pct,
      mean_ret_4h_pct: s4h.mean_return_pct,
    };
  });
}

function computeFlowReversalStats(
  snapshots4h: FlowSnapshotRow[],
  priceMap: Map<number, Candle>,
): FlowReversalStats {
  const sorted = [...snapshots4h].sort(
    (a, b) => new Date(a.snapshot_time).getTime() - new Date(b.snapshot_time).getTime(),
  );

  interface Rev {
    ts: number; new_dir: 'bullish' | 'bearish';
    entry_price: number; ret_1h: number | null; ret_4h: number | null;
  }

  const reversals: Rev[] = [];
  const now = Date.now();

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], curr = sorted[i];
    const pb = prev.market_bias, cb = curr.market_bias;
    if (
      (pb === 'bullish' && cb === 'bearish') ||
      (pb === 'bearish' && cb === 'bullish')
    ) {
      const ts    = new Date(curr.snapshot_time).getTime();
      const entry = getPrice(priceMap, ts);
      if (!entry) continue;

      const e1h = ts + 60 * 60 * 1000;
      const e4h = ts + 4  * 60 * 60 * 1000;

      reversals.push({
        ts, new_dir: cb as 'bullish' | 'bearish', entry_price: entry,
        ret_1h: e1h <= now && getPrice(priceMap, e1h)
          ? ((getPrice(priceMap, e1h)! / entry) - 1) * 100 : null,
        ret_4h: e4h <= now && getPrice(priceMap, e4h)
          ? ((getPrice(priceMap, e4h)! / entry) - 1) * 100 : null,
      });
    }
  }

  const r1h = reversals.filter((r) => r.ret_1h !== null);
  const r4h = reversals.filter((r) => r.ret_4h !== null);

  function hitRate(pts: Rev[], f: 'ret_1h' | 'ret_4h'): number {
    if (!pts.length) return 0;
    return pts.filter((r) => {
      const ret = r[f]!;
      return (r.new_dir === 'bullish' && ret > 0) || (r.new_dir === 'bearish' && ret < 0);
    }).length / pts.length * 100;
  }

  return {
    n_reversals:     reversals.length,
    hit_rate_1h_pct: hitRate(r1h, 'ret_1h'),
    hit_rate_4h_pct: hitRate(r4h, 'ret_4h'),
    mean_ret_1h_pct: mean(r1h.map((r) => r.ret_1h!)),
    mean_ret_4h_pct: mean(r4h.map((r) => r.ret_4h!)),
  };
}

function computeConfirmationStrat(
  scored:    ScoredSignal[],
  threshold: number,
): ConfirmationStratStats[] {
  const filters: Array<{ label: string; fn: (s: ScoredSignal) => boolean }> = [
    { label: 'all',    fn: () => true },
    { label: 'cc >= 1', fn: (s) => (s.conf_count ?? 0) >= 1 },
    { label: 'cc >= 2', fn: (s) => (s.conf_count ?? 0) >= 2 },
    { label: 'cc == 3', fn: (s) => (s.conf_count ?? 0) === 3 },
  ];

  return filters.map(({ label, fn }) => {
    const subset = scored.filter(fn);
    const stats  = computeWindowStats(subset, 240, threshold);
    return {
      filter:          label,
      n:               stats.n,
      hit_rate_4h_pct: stats.hit_rate_pct,
      ci95_lo:         stats.ci95_lo,
      ci95_hi:         stats.ci95_hi,
    };
  });
}

// ── Comparison with previous artifact ────────────────────────

function loadPreviousArtifact(artifactsDir: string, currentDateStr: string): Record<string, unknown> | null {
  try {
    const files = readdirSync(artifactsDir)
      .filter((f) => f.startsWith('signal-quality-') && f.endsWith('.json') && !f.includes(currentDateStr))
      .sort()
      .reverse(); // newest first

    if (!files.length) return null;
    const raw = readFileSync(resolve(artifactsDir, files[0]), 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildComparison(
  prev:    Record<string, unknown> | null,
  current: { n_deduped: number; hit_rate: number },
): ComparisonDelta | null {
  if (!prev) return null;

  try {
    const prevDs = prev['dataset'] as Record<string, unknown>;
    const prevN  = Number(prevDs['n_scored_deduped'] ?? 0);
    const prevTR = (prev['threshold_results'] as ThresholdStats[] | undefined)?.find((t) => t.threshold === 40);
    const prevHR = prevTR?.per_window?.find((w) => w.window_min === 240)?.hit_rate_pct ?? 0;

    const dHR = current.hit_rate - prevHR;
    const trend: ComparisonDelta['trend'] =
      current.n_deduped < 10 || prevN < 10 ? 'inconclusive' :
      dHR >  2 ? 'improving'  :
      dHR < -2 ? 'declining'  :
      'stable';

    return {
      previous_run_at:    String(prev['run_at'] ?? ''),
      previous_n_deduped: prevN,
      previous_hit_rate:  prevHR,
      current_n_deduped:  current.n_deduped,
      current_hit_rate:   current.hit_rate,
      delta_n:            current.n_deduped - prevN,
      delta_hit_rate:     dHR,
      trend,
    };
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  SONAR Signal Quality Validation Pipeline  v${SCRIPT_VERSION}`);
  console.log(`  Run date: ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════\n');

  // ── 1. Load data ──────────────────────────────────────────

  console.log('1. Loading data from Supabase...');

  const { data: snapshots, error: snapErr } = await db
    .from('flow_snapshots')
    .select('*')
    .order('snapshot_time', { ascending: true });

  if (snapErr) throw new Error(`flow_snapshots: ${snapErr.message}`);
  if (!snapshots?.length) {
    console.log('  No flow_snapshots — nothing to validate.');
    process.exit(0);
  }

  const { data: alertsRaw, error: alertErr } = await db
    .from('alerts')
    .select('*')
    .order('created_at', { ascending: true });

  if (alertErr) throw new Error(`alerts: ${alertErr.message}`);

  const snapshots4h_all = snapshots.filter((s) => s.window_hours === 4) as FlowSnapshotRow[];
  const allAlerts       = (alertsRaw ?? []) as AlertRow[];

  // Deduplication
  const snapshots4h_deduped           = deduplicateSnapshots(snapshots4h_all);
  const { deduped: alerts_deduped, counts: alertDedupCounts } = deduplicateAlerts(allAlerts);

  console.log(`  Snapshots 4h:  ${snapshots4h_all.length} raw  →  ${snapshots4h_deduped.length} deduped (direction-change events)`);
  console.log(`  Alerts:        ${allAlerts.length} raw  →  ${alerts_deduped.length} deduped (cooldown + 20% change)`);
  for (const [type, cnt] of alertDedupCounts.entries()) {
    if (cnt.raw !== cnt.deduped) {
      console.log(`    ${type}: ${cnt.raw} raw → ${cnt.deduped} deduped  (${cnt.raw - cnt.deduped} suppressed)`);
    }
  }

  const dedupFactor = allAlerts.length > 0
    ? (allAlerts.length / Math.max(1, alerts_deduped.length)).toFixed(1)
    : '1.0';

  // ── 2. Price data ─────────────────────────────────────────

  console.log('\n2. Fetching SOL/USDT price data from Binance...');

  const allTs = [
    ...snapshots4h_deduped.map((s) => new Date(s.snapshot_time).getTime()),
    ...alerts_deduped.map((a) => new Date(a.created_at).getTime()),
  ];

  if (!allTs.length) {
    console.log('  No signal points to score.');
    process.exit(0);
  }

  const now    = Date.now();
  const minTs  = Math.min(...allTs);
  const maxFwd = Math.min(now, Math.max(...allTs) + 10080 * 60 * 1000);

  console.log(`  Date range: ${new Date(minTs).toISOString()} → ${new Date(maxFwd).toISOString()}`);

  const priceMap = await fetchKlines(floorTo5m(minTs), maxFwd + CANDLE_MS);

  if (!priceMap.size) {
    console.log('  Could not fetch price data — aborting.');
    process.exit(1);
  }

  // ── 3. Build signal points (from deduped sets) ────────────

  console.log('\n3. Building signal points (deduped)...');

  const signalPoints: SignalPoint[] = [];

  // Deduped 4h snapshots → direction-change events
  for (const s of snapshots4h_deduped) {
    signalPoints.push({
      ts:          new Date(s.snapshot_time).getTime(),
      source:      'snapshot',
      signal_type: `snapshot_${s.market_bias ?? 'unknown'}`,
      bias_score:  s.bias_score,
      conf_count:  s.confirmation_count ?? null,
      raw:         s,
    });
  }

  // Deduped alerts → cross-reference with nearest 4h snapshot
  for (const a of alerts_deduped) {
    const ts = new Date(a.created_at).getTime();
    const nearestSnap = snapshots4h_all
      .filter((s) => new Date(s.snapshot_time).getTime() <= ts)
      .at(-1);

    signalPoints.push({
      ts,
      source:      'alert',
      signal_type: a.alert_type,
      bias_score:  nearestSnap?.bias_score ?? null,
      conf_count:  nearestSnap?.confirmation_count ?? null,
      raw:         a,
    });
  }

  console.log(`  ${signalPoints.length} signal points  (${snapshots4h_deduped.length} snapshots + ${alerts_deduped.length} alerts)`);

  // ── 4. Score against forward prices ──────────────────────

  console.log('\n4. Scoring signals against forward prices...');

  const scored: ScoredSignal[] = [];
  let skipped = 0;

  for (const sp of signalPoints) {
    const entryPrice = getPrice(priceMap, sp.ts);
    if (!entryPrice) { skipped++; continue; }

    const forward: ForwardReturn[] = [];
    for (const winMin of FORWARD_WINDOWS) {
      const exitTs = sp.ts + winMin * 60 * 1000;
      if (exitTs > now) continue;
      const exitPrice = getPrice(priceMap, exitTs);
      if (!exitPrice) continue;
      forward.push({
        window_min:  winMin,
        return_pct:  ((exitPrice / entryPrice) - 1) * 100,
        entry_price: entryPrice,
        exit_price:  exitPrice,
      });
    }

    if (!forward.length) { skipped++; continue; }

    scored.push({
      ...sp,
      entry_price:   entryPrice,
      forward,
      predicted_dir: predictedDir(sp.bias_score, BIAS_THRESHOLDS[0]),
    });
  }

  console.log(`  Scored: ${scored.length}  |  Skipped (no price data): ${skipped}`);

  // ── 5. Per-threshold stats ────────────────────────────────

  console.log('\n5. Computing stats...');

  const thresholdResults: ThresholdStats[] = [];
  for (const threshold of BIAS_THRESHOLDS) {
    const nonNeutral = scored.filter((s) => predictedDir(s.bias_score, threshold) !== 'neutral');
    const perWindow  = FORWARD_WINDOWS.map((wm) => computeWindowStats(scored, wm, threshold));
    thresholdResults.push({
      threshold,
      n_signals: nonNeutral.length,
      n_neutral: scored.length - nonNeutral.length,
      per_window: perWindow,
    });
  }

  const alertTypeResults       = computeAlertTypeStats(scored, alertDedupCounts, BIAS_THRESHOLDS[0]);
  const reversalStats          = computeFlowReversalStats(snapshots4h_all, priceMap);
  const confirmationStrat      = computeConfirmationStrat(scored, 20);

  // ── 6. Print results ──────────────────────────────────────

  const winLabel = (m: number) => m < 60 ? `${m}m` : m < 1440 ? `${m/60}h` : `${m/1440}d`;

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESULTS: Bias Score Threshold Analysis  (DEDUPED)');
  console.log('══════════════════════════════════════════════════════════');

  for (const tr of thresholdResults) {
    console.log(`\n  Threshold ±${tr.threshold}  →  ${tr.n_signals} directional signals  (${tr.n_neutral} neutral)`);
    console.log(
      '  ' + padR('Window', 8) + padL('N', 6) + padL('Hit%', 8) +
      padL('CI95', 14) + padL('MeanRet', 10) + padL('MedRet', 10) + padL('MFE', 8) + padL('MAE', 8),
    );
    console.log('  ' + '─'.repeat(72));

    for (const w of tr.per_window) {
      if (!w.n) continue;
      console.log(
        '  ' +
        padR(winLabel(w.window_min), 8) +
        padL(String(w.n), 6) +
        padL(pct2(w.hit_rate_pct), 8) +
        padL(`[${w.ci95_lo.toFixed(1)},${w.ci95_hi.toFixed(1)}]`, 14) +
        padL(pct2(w.mean_return_pct), 10) +
        padL(pct2(w.med_return_pct), 10) +
        padL(pct2(w.mfe_pct), 8) +
        padL(pct2(w.mae_pct), 8),
      );
    }
  }

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESULTS: Per Alert-Type  (threshold ±20, after dedup)');
  console.log('══════════════════════════════════════════════════════════');

  if (!alertTypeResults.length) {
    console.log('  No alerts in dataset.');
  } else {
    console.log(
      '  ' + padR('Alert Type', 22) +
      padL('Raw', 6) + padL('Dedup', 7) + padL('Bias', 7) + padL('Dom', 9) +
      padL('Hit1h%', 8) + padL('Hit4h%', 8),
    );
    console.log('  ' + '─'.repeat(73));
    for (const at of alertTypeResults.sort((a, b) => b.n_deduped - a.n_deduped)) {
      console.log(
        '  ' + padR(at.alert_type, 22) +
        padL(String(at.n_raw), 6) + padL(String(at.n_deduped), 7) +
        padL(at.mean_bias.toFixed(1), 7) + padL(at.dominant_bias, 9) +
        padL(at.hit_rate_1h_pct > 0 ? pct2(at.hit_rate_1h_pct) : 'n/a', 8) +
        padL(at.hit_rate_4h_pct > 0 ? pct2(at.hit_rate_4h_pct) : 'n/a', 8),
      );
    }
  }

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESULTS: Confirmation Count Stratification  (threshold ±20, 4h)');
  console.log('══════════════════════════════════════════════════════════');
  console.log(
    '  ' + padR('Filter', 12) + padL('N', 6) + padL('Hit4h%', 8) + padL('CI95', 16),
  );
  console.log('  ' + '─'.repeat(44));
  for (const cs of confirmationStrat) {
    if (!cs.n) continue;
    console.log(
      '  ' + padR(cs.filter, 12) + padL(String(cs.n), 6) +
      padL(pct2(cs.hit_rate_4h_pct), 8) +
      padL(`[${cs.ci95_lo.toFixed(1)},${cs.ci95_hi.toFixed(1)}]`, 16),
    );
  }

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  RESULTS: Flow Reversal Signals');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Reversals detected:  ${reversalStats.n_reversals}`);
  if (reversalStats.n_reversals > 0) {
    console.log(`  1h hit rate:         ${pct2(reversalStats.hit_rate_1h_pct)}`);
    console.log(`  4h hit rate:         ${pct2(reversalStats.hit_rate_4h_pct)}`);
    console.log(`  1h mean return:      ${pct2(reversalStats.mean_ret_1h_pct)}`);
    console.log(`  4h mean return:      ${pct2(reversalStats.mean_ret_4h_pct)}`);
  }

  // ── 7. Verdict ────────────────────────────────────────────

  const best = thresholdResults.find((t) => t.threshold === 40)?.per_window.find((w) => w.window_min === 240);

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  FINAL VERDICT: Predictive Edge Assessment');
  console.log('══════════════════════════════════════════════════════════');

  let verdict: string;
  let explanation: string;

  if (!best || best.n < 5) {
    verdict = 'INSUFFICIENT DATA';
    explanation = `Only ${best?.n ?? 0} scored signals at ±40/4h after deduplication. ` +
      `Need ≥5 for any verdict, ≥${REQUIRED_N_FOR_ROBUST_CI} for 95% CI ±5%. ` +
      'Continue running the engine and re-validate when more data accumulates.';
  } else {
    const hr = best.hit_rate_pct;
    if (hr >= 65) {
      verdict = 'STRONG PREDICTIVE EDGE';
      explanation = `Hit rate ${pct2(hr)} at ±40/4h is well above baseline. ` +
        `CI95: [${best.ci95_lo.toFixed(1)},${best.ci95_hi.toFixed(1)}]. ` +
        'Statistically meaningful directional edge — suitable for position sizing research.';
    } else if (hr >= 58) {
      verdict = 'MODERATE PREDICTIVE EDGE';
      explanation = `Hit rate ${pct2(hr)} at ±40/4h is meaningfully above 50%. ` +
        `CI95: [${best.ci95_lo.toFixed(1)},${best.ci95_hi.toFixed(1)}]. ` +
        'Useful as one input in a multi-signal framework.';
    } else if (hr >= 52) {
      verdict = 'WEAK PREDICTIVE EDGE';
      explanation = `Hit rate ${pct2(hr)} at ±40/4h is marginally above random. ` +
        `CI95: [${best.ci95_lo.toFixed(1)},${best.ci95_hi.toFixed(1)}]. ` +
        `With N=${best.n} the CI is wide. Need ~${REQUIRED_N_FOR_ROBUST_CI} independent events for confidence.`;
    } else {
      verdict = 'NO PREDICTIVE EDGE DETECTED';
      explanation = `Hit rate ${pct2(hr)} at ±40/4h is at or below the 50% chance baseline. ` +
        `CI95: [${best.ci95_lo.toFixed(1)},${best.ci95_hi.toFixed(1)}]. ` +
        'On-chain flow data, as currently measured, does not predict SOL direction at this window.';
    }
  }

  console.log(`\n  Verdict:       ${verdict}`);
  console.log(`\n  ${explanation}`);

  if (best && best.n >= 5) {
    console.log(`\n  Key metrics (±40, 4h, deduped N=${best.n}):`);
    console.log(`    Hit rate:     ${pct2(best.hit_rate_pct)}  CI95: [${best.ci95_lo.toFixed(1)},${best.ci95_hi.toFixed(1)}]`);
    console.log(`    Mean return:  ${pct2(best.mean_return_pct)}`);
    console.log(`    MFE/MAE:      ${pct2(best.mfe_pct)} / ${pct2(best.mae_pct)}`);
  }

  const oldestTs = scored[0]?.ts ?? 0;
  const newestTs = scored.at(-1)?.ts ?? 0;
  const spanDays = scored.length > 1 ? Math.round((newestTs - oldestTs) / 86400000) : 0;
  const oldestStr = oldestTs ? new Date(oldestTs).toISOString().split('T')[0] : 'n/a';
  const newestStr = newestTs ? new Date(newestTs).toISOString().split('T')[0] : 'n/a';

  // ── 8. Dataset summary ────────────────────────────────────

  console.log('\n');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  Dataset Summary');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  4h snapshots raw:    ${snapshots4h_all.length}  →  ${snapshots4h_deduped.length} deduped`);
  console.log(`  Alerts raw:          ${allAlerts.length}  →  ${alerts_deduped.length} deduped  (${dedupFactor}× collapse)`);
  console.log(`  Total scored:        ${scored.length}  (skipped: ${skipped})`);
  console.log(`  Date range:          ${oldestStr} → ${newestStr}  (${spanDays} days)`);
  console.log(`  Price candles:       ${priceMap.size}`);

  const minRecommended = 90;
  if (spanDays < minRecommended) {
    const estDaysToRobust = best
      ? Math.ceil((REQUIRED_N_FOR_ROBUST_CI / Math.max(1, scored.length)) * spanDays)
      : 0;
    console.log(`\n  Statistical power: LOW (${spanDays}d data, need ≥${minRecommended}d)`);
    if (estDaysToRobust > 0) {
      console.log(`  Est. days to N=${REQUIRED_N_FOR_ROBUST_CI}: ~${estDaysToRobust} days at current signal rate`);
    }
  } else {
    console.log(`\n  Statistical power: ADEQUATE (${spanDays}d data)`);
  }

  // ── 9. Artifacts ──────────────────────────────────────────

  const artifactsDir = resolve(process.cwd(), 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const dateStr    = new Date().toISOString().split('T')[0];
  const outputPath = resolve(artifactsDir, `signal-quality-${dateStr}.json`);

  // Load previous run for comparison
  const prevArtifact = loadPreviousArtifact(artifactsDir, dateStr);
  const comparison   = buildComparison(prevArtifact, {
    n_deduped: scored.length,
    hit_rate:  best?.hit_rate_pct ?? 0,
  });

  if (comparison) {
    console.log('\n');
    console.log('══════════════════════════════════════════════════════════');
    console.log('  Comparison vs Previous Run');
    console.log('══════════════════════════════════════════════════════════');
    console.log(`  Previous run:     ${comparison.previous_run_at}`);
    console.log(`  N deduped:        ${comparison.previous_n_deduped} → ${comparison.current_n_deduped}  (Δ${comparison.delta_n >= 0 ? '+' : ''}${comparison.delta_n})`);
    console.log(`  Hit rate ±40/4h:  ${pct2(comparison.previous_hit_rate)} → ${pct2(comparison.current_hit_rate)}  (Δ${comparison.delta_hit_rate >= 0 ? '+' : ''}${comparison.delta_hit_rate.toFixed(2)}pp)`);
    console.log(`  Trend:            ${comparison.trend.toUpperCase()}`);
  }

  const output = {
    run_at:         new Date().toISOString(),
    script_version: SCRIPT_VERSION,
    dedup_config: {
      alert_cooldowns_ms:   ALERT_COOLDOWNS_MS,
      alert_min_change_pct: ALERT_MIN_CHANGE_PCT,
      snapshot_dedup:       'direction_change',
      confirmation_min_usd: 50_000,
    },
    dataset: {
      n_snapshots_4h_raw:    snapshots4h_all.length,
      n_snapshots_4h_deduped: snapshots4h_deduped.length,
      n_alerts_raw:          allAlerts.length,
      n_alerts_deduped:      alerts_deduped.length,
      n_scored_raw:          signalPoints.length,
      n_scored_deduped:      scored.length,
      dedup_factor:          parseFloat(dedupFactor),
      span_days:             spanDays,
      oldest_signal:         oldestStr,
      newest_signal:         newestStr,
    },
    threshold_results:     thresholdResults,
    alert_type_results:    alertTypeResults,
    flow_reversal_stats:   reversalStats,
    confirmation_strat:    confirmationStrat,
    verdict,
    verdict_explanation:   explanation,
    comparison:            comparison ?? null,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n  Artifact saved: ${outputPath}`);
  console.log('\n══════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\nFATAL ERROR:', err);
  process.exit(1);
});
