// ============================================================
// SONAR v2.0 — GET /api/signal/accuracy
// ============================================================
// Computes live signal accuracy statistics from historical
// alerts vs Binance SOLUSDT price movement.
//
// Logic:
//   1. Pull last 30 days of alerts
//   2. For each alert, fetch the Binance SOLUSDT 5m candle at
//      alert time + forward windows (5, 15, 60, 240 min)
//   3. Hit rate = did price move in predicted direction?
//   4. Cache result 30 min (in-process; resets on restart)
//
// Response:
//   { points: AccuracyPoint[], data_window_days, total_alerts_analyzed }
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { AlertRow, AlertType } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ─────────────────────────────────────────────────────

interface AccuracyPoint {
  alert_type:       string;
  window_minutes:   number;
  n_signals:        number;
  hit_rate:         number;   // 0.0–1.0
  mean_return_pct:  number;
  ci_low:           number;   // 95% confidence interval lower bound
  ci_high:          number;   // 95% confidence interval upper bound
  is_robust:        boolean;  // true if n_signals >= 50
  computed_at:      string;   // ISO timestamp
}

interface AccuracyResult {
  points:                  AccuracyPoint[];
  data_window_days:        number;
  total_alerts_analyzed:   number;
}

// ── In-process cache ──────────────────────────────────────────

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

let _cache: { result: AccuracyResult; expires_at: number } | null = null;

// ── Binance OHLCV fetcher ─────────────────────────────────────

interface Candle {
  open_time: number;
  open:      number;
  close:     number;
}

async function fetchBinanceCandles(
  startMs:  number,
  endMs:    number,
  interval: string,
  limit:    number,
): Promise<Candle[]> {
  const url =
    `https://api.binance.com/api/v3/klines` +
    `?symbol=SOLUSDT&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${limit}`;

  const res = await fetch(url, { next: { revalidate: 0 } });
  if (!res.ok) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[][] = await res.json();
  return raw.map((r) => ({
    open_time: r[0] as number,
    open:      parseFloat(r[1]),
    close:     parseFloat(r[4]),
  }));
}

/** Find the candle whose open_time is closest to but <= targetMs. */
function findCandleAt(candles: Candle[], targetMs: number): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.open_time <= targetMs) {
      if (!best || c.open_time > best.open_time) best = c;
    }
  }
  return best;
}

// ── Direction predictor ───────────────────────────────────────

/**
 * Returns expected price direction for an alert type.
 * 'up'  = bullish (price should rise)
 * 'down'= bearish (price should fall)
 * null  = direction ambiguous / not predictive
 */
function predictedDirection(alertType: string): 'up' | 'down' | null {
  switch (alertType as AlertType) {
    case 'accumulation_wave':  return 'up';
    case 'distribution_wave':  return 'down';
    case 'exchange_spike':     return 'down'; // inflow spike = bearish
    case 'staking_shift':      return 'up';   // staking = conviction bullish
    case 'flow_reversal':      return null;   // direction depends on data field
    case 'defi_rotation':      return 'up';
    case 'stablecoin_flow':    return 'up';   // dry powder deployment
    case 'whale_large_move':   return null;   // need more context
    case 'weekly_report':      return null;
    default:                   return null;
  }
}

// ── Wilson confidence interval ────────────────────────────────

function wilsonCI(hits: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z  = 1.96; // 95% CI
  const p  = hits / n;
  const d  = 1 + (z * z) / n;
  const a  = p + (z * z) / (2 * n);
  const b  = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    low:  Math.max(0, (a - b) / d),
    high: Math.min(1, (a + b) / d),
  };
}

// ── Core computation ──────────────────────────────────────────

const FORWARD_WINDOWS_MIN = [5, 15, 60, 240] as const;
const DATA_WINDOW_DAYS    = 30;
const ROBUST_N            = 50;

async function computeAccuracy(): Promise<AccuracyResult> {
  const db        = createAdminClient();
  const since     = new Date(Date.now() - DATA_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: alertsRaw, error } = await db
    .from('alerts')
    .select('id, alert_type, severity, data, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error || !alertsRaw) {
    return { points: [], data_window_days: DATA_WINDOW_DAYS, total_alerts_analyzed: 0 };
  }

  const alerts = alertsRaw as Pick<AlertRow, 'id' | 'alert_type' | 'severity' | 'data' | 'created_at'>[];

  // Filter to alerts with a predictable direction
  const actionable = alerts.filter((a) => predictedDirection(a.alert_type) !== null);

  if (actionable.length === 0) {
    return { points: [], data_window_days: DATA_WINDOW_DAYS, total_alerts_analyzed: 0 };
  }

  // Determine overall time range needed
  const firstMs = new Date(actionable[0].created_at).getTime();
  const lastMs  = new Date(actionable[actionable.length - 1].created_at).getTime();
  const spanMs  = lastMs - firstMs + (240 * 60 * 1000); // extra for forward window

  // Fetch enough 5m candles to cover the whole range (max 1000 per request)
  // We may need multiple requests for 30d of 5m candles (30*24*12 = 8640 candles)
  // Fetch in chunks of 1000 candles
  const allCandles: Candle[] = [];
  let chunkStart = firstMs;
  while (chunkStart < firstMs + spanMs) {
    const chunkEnd = Math.min(chunkStart + 1000 * 5 * 60 * 1000, firstMs + spanMs);
    const chunk    = await fetchBinanceCandles(chunkStart, chunkEnd, '5m', 1000);
    allCandles.push(...chunk);
    if (chunk.length < 1000) break;
    chunkStart = chunk[chunk.length - 1].open_time + 5 * 60 * 1000;
  }

  if (allCandles.length === 0) {
    // Can't compute without price data — return empty
    return { points: [], data_window_days: DATA_WINDOW_DAYS, total_alerts_analyzed: alerts.length };
  }

  // ── Score each alert × window combination ─────────────────

  // Map: alertType → windowMin → [hits, total, returns]
  type WindowAcc = { hits: number; total: number; returns: number[] };
  const acc = new Map<string, Map<number, WindowAcc>>();

  for (const alert of actionable) {
    const dir = predictedDirection(alert.alert_type);
    if (!dir) continue;

    const alertMs   = new Date(alert.created_at).getTime();
    const entryC    = findCandleAt(allCandles, alertMs);
    if (!entryC) continue;
    const entryPrice = entryC.close;

    if (!acc.has(alert.alert_type)) {
      acc.set(alert.alert_type, new Map());
    }
    const typeAcc = acc.get(alert.alert_type)!;

    for (const win of FORWARD_WINDOWS_MIN) {
      const targetMs = alertMs + win * 60 * 1000;
      const exitC    = findCandleAt(allCandles, targetMs);
      if (!exitC || exitC.open_time <= entryC.open_time) continue;

      const returnPct = ((exitC.close - entryPrice) / entryPrice) * 100;
      const hit       = dir === 'up' ? exitC.close > entryPrice : exitC.close < entryPrice;

      if (!typeAcc.has(win)) {
        typeAcc.set(win, { hits: 0, total: 0, returns: [] });
      }
      const wa = typeAcc.get(win)!;
      wa.total++;
      if (hit) wa.hits++;
      wa.returns.push(dir === 'up' ? returnPct : -returnPct);
    }
  }

  // ── Build AccuracyPoint array ──────────────────────────────

  const computedAt = new Date().toISOString();
  const points: AccuracyPoint[] = [];

  for (const [alertType, winMap] of acc.entries()) {
    for (const [win, wa] of winMap.entries()) {
      if (wa.total === 0) continue;

      const hitRate        = wa.hits / wa.total;
      const meanReturn     = wa.returns.reduce((s, r) => s + r, 0) / wa.returns.length;
      const { low, high }  = wilsonCI(wa.hits, wa.total);

      points.push({
        alert_type:      alertType,
        window_minutes:  win,
        n_signals:       wa.total,
        hit_rate:        Math.round(hitRate * 1000) / 1000,
        mean_return_pct: Math.round(meanReturn * 100) / 100,
        ci_low:          Math.round(low * 1000) / 1000,
        ci_high:         Math.round(high * 1000) / 1000,
        is_robust:       wa.total >= ROBUST_N,
        computed_at:     computedAt,
      });
    }
  }

  return {
    points,
    data_window_days:      DATA_WINDOW_DAYS,
    total_alerts_analyzed: alerts.length,
  };
}

// ── GET handler ───────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    const now = Date.now();

    // Return cached result if still valid
    if (_cache && _cache.expires_at > now) {
      return NextResponse.json({ ok: true, cached: true, ..._cache.result });
    }

    const result = await computeAccuracy();
    _cache = { result, expires_at: now + CACHE_TTL_MS };

    return NextResponse.json({ ok: true, cached: false, ...result });
  } catch (err) {
    console.error('[api/signal/accuracy]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
