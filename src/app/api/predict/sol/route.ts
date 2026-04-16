// ============================================================
// SONAR — GET /api/predict/sol
// ============================================================
// Bayesian SOL directional prediction.
//
// Signal stack (priority order):
//   1. Bias Index (exchange + staking + stablecoin + DeFi)
//   2. Smart money ratio (confirmation weighting)
//   3. Signal confluence (directional alignment count)
//   4. Entity score (smart whale hit rate)
//   5. Token accumulation (bullish if smart money buying)
//   6. Historical accuracy (calibration factor)
//
// Output:
//   direction:      'bullish' | 'bearish' | 'neutral'
//   probability:    0.0–1.0 (P(move in direction) at 1h)
//   confidence:     'high' | 'medium' | 'low' | 'insufficient_data'
//   bias_score:     -100..+100
//   signals:        array of contributing signals with weights
//   next_update:    ISO timestamp
// ============================================================

import { NextResponse }            from 'next/server';
import { createAdminClient }       from '@/lib/supabase/server';
import { computeDirectionalConfluence } from '@/lib/signal-engine';
import type { BiasIndexHistoryRow, FlowSnapshotRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Types ─────────────────────────────────────────────────────

interface PredictionSignal {
  name:        string;
  direction:   'bullish' | 'bearish' | 'neutral';
  strength:    number;   // 0-100
  weight:      number;   // 0-1, contribution to final score
  description: string;
}

interface SolPrediction {
  ok:           boolean;
  direction:    'bullish' | 'bearish' | 'neutral';
  probability:  number;   // P(price moves ≥0.5% in direction at 1h)
  confidence:   'high' | 'medium' | 'low' | 'insufficient_data';
  bias_score:   number;
  signals:      PredictionSignal[];
  smart_money_ratio: number;
  confluence:   { aligned: number; amplifier: number };
  data_age_min: number;   // how many minutes since last bias update
  next_update:  string;   // ISO — when cron will refresh
  computed_at:  string;
}

// ── In-process cache (2 min) ──────────────────────────────────

let _cache: { result: SolPrediction; expires_at: number } | null = null;
const CACHE_TTL = 2 * 60_000;

// ── Helpers ───────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function biasToProb(biasScore: number, amplifier: number): number {
  // Convert -100..+100 bias score to a directional probability.
  // Baseline (score=0) = 0.50 (coin flip).
  // At score=±100: P ≈ 0.78 (calibrated against historical accuracy).
  // Logistic: P = 1 / (1 + exp(-k * score))  with k chosen so P(100) ≈ 0.78
  const k   = 0.011;
  const raw = 1 / (1 + Math.exp(-k * biasScore));
  // Amplifier compresses/expands distance from 0.5
  const amplified = 0.5 + (raw - 0.5) * amplifier;
  return clamp(amplified, 0.30, 0.90);
}

// ── Main computation ──────────────────────────────────────────

async function computePrediction(): Promise<SolPrediction> {
  const db  = createAdminClient();
  const now = new Date();

  // ── 1. Latest Bias Index (4h window) ─────────────────────────
  const { data: biasRaw } = await (db as any)
    .from('bias_index_history')
    .select('score, bias, confidence, components, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const biasRow = biasRaw as Pick<BiasIndexHistoryRow, 'score' | 'bias' | 'confidence' | 'components' | 'created_at'> | null;

  if (!biasRow) {
    return {
      ok:           true,
      direction:    'neutral',
      probability:  0.50,
      confidence:   'insufficient_data',
      bias_score:   0,
      signals:      [],
      smart_money_ratio: 0.5,
      confluence:   { aligned: 0, amplifier: 1.0 },
      data_age_min: 999,
      next_update:  new Date(now.getTime() + 5 * 60_000).toISOString(),
      computed_at:  now.toISOString(),
    };
  }

  const biasScore   = biasRow.score;
  const components  = (biasRow.components ?? {}) as Record<string, { score: number; raw_usd: number; interpretation: string }>;
  const dataAgeMin  = Math.round((now.getTime() - new Date(biasRow.created_at).getTime()) / 60_000);

  // ── 2. Latest 4h flow snapshot for confluence ────────────────
  const { data: snapRaw } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 4)
    .order('snapshot_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  const snap = snapRaw as FlowSnapshotRow | null;

  // ── 3. Compute directional confluence ────────────────────────
  const confluenceResult = computeDirectionalConfluence({
    exchange_score:   components.exchange?.score   ?? 0,
    staking_score:    components.staking?.score    ?? 0,
    stablecoin_score: components.stablecoin?.score ?? 0,
    defi_score:       components.defi?.score       ?? 0,
  });

  // ── 4. Smart money ratio ─────────────────────────────────────
  const smComp      = (biasRow.components as any)?.smart_money;
  const smRatio     = typeof smComp?.ratio === 'number' ? smComp.ratio : 0.5;

  // ── 5. Recent smart money accuracy (from whale stats) ────────
  const { data: smWhales } = await (db as any)
    .from('whales')
    .select('hit_rate_30d, signal_count_30d')
    .eq('smart_money_flag', true)
    .eq('is_active', true)
    .gte('signal_count_30d', 5);

  const smRows = (smWhales ?? []) as { hit_rate_30d: number | null; signal_count_30d: number | null }[];
  const avgSmHitRate = smRows.length > 0
    ? smRows.reduce((s, r) => s + (r.hit_rate_30d ?? 0.5), 0) / smRows.length
    : 0.5;

  // ── 6. Token accumulation bias (last 30 min) ──────────────────
  const since30m = new Date(now.getTime() - 30 * 60_000).toISOString();
  const { data: tokAccRaw } = await (db as any)
    .from('alerts')
    .select('severity, data, created_at')
    .eq('alert_type', 'token_accumulation')
    .gte('created_at', since30m)
    .order('created_at', { ascending: false })
    .limit(5);

  const tokAccAlerts = (tokAccRaw ?? []) as { severity: string; data: any; created_at: string }[];
  const smTokenBuys  = tokAccAlerts.filter(a => (a.data?.smart_money_count ?? 0) > 0).length;
  const tokenBias    = smTokenBuys > 0 ? Math.min(20, smTokenBuys * 5) : 0; // 0–20 bonus to bullish

  // ── 7. Assemble signals ──────────────────────────────────────
  const signals: PredictionSignal[] = [];

  // Exchange flow
  const exchScore  = components.exchange?.score ?? 0;
  const exchDir    = exchScore > 5 ? 'bullish' : exchScore < -5 ? 'bearish' : 'neutral';
  signals.push({
    name:        'Exchange Net Flow',
    direction:   exchDir,
    strength:    Math.abs(exchScore) * 2.5,
    weight:      0.35,
    description: components.exchange?.interpretation ?? 'balanced',
  });

  // Staking flow
  const stakeScore = components.staking?.score ?? 0;
  const stakeDir   = stakeScore > 3 ? 'bullish' : stakeScore < -3 ? 'bearish' : 'neutral';
  signals.push({
    name:        'Staking Flow',
    direction:   stakeDir,
    strength:    Math.abs(stakeScore) * 5,
    weight:      0.20,
    description: components.staking?.interpretation ?? 'flat',
  });

  // DeFi activity
  const defiScore  = components.defi?.score ?? 0;
  const defiDir    = defiScore > 3 ? 'bullish' : defiScore < -3 ? 'bearish' : 'neutral';
  signals.push({
    name:        'DeFi Capital Flow',
    direction:   defiDir,
    strength:    Math.abs(defiScore) * 5,
    weight:      0.15,
    description: components.defi?.interpretation ?? 'flat',
  });

  // Smart money confirmation
  const smStrength = Math.abs(smRatio - 0.5) * 200; // 0–100
  const smDir      = smRatio >= 0.5 ? 'bullish' : 'bearish';
  signals.push({
    name:        'Smart Money Concentration',
    direction:   smDir,
    strength:    Math.round(smStrength),
    weight:      0.15,
    description: smComp?.interpretation ?? 'neutral smart money presence',
  });

  // Historical accuracy
  const accStrength = Math.min(100, avgSmHitRate * 100);
  signals.push({
    name:        'Entity Track Record (Smart Money)',
    direction:   avgSmHitRate > 0.5 ? 'bullish' : 'neutral',
    strength:    Math.round(accStrength),
    weight:      0.10,
    description: smRows.length > 0
      ? `Avg hit rate: ${(avgSmHitRate * 100).toFixed(1)}% across ${smRows.length} smart wallets`
      : 'Insufficient data — tracking in progress',
  });

  // Token accumulation
  if (tokAccAlerts.length > 0) {
    signals.push({
      name:        'Token Accumulation Signal',
      direction:   'bullish',
      strength:    Math.min(100, tokenBias * 5),
      weight:      0.05,
      description: `${tokAccAlerts.length} token accumulation cluster${tokAccAlerts.length > 1 ? 's' : ''} in last 30m`,
    });
  }

  // ── 8. Final probability ──────────────────────────────────────
  // Weighted directional score: bullish signals sum positive, bearish negative
  let weightedScore = 0;
  for (const sig of signals) {
    const dir = sig.direction === 'bullish' ? 1 : sig.direction === 'bearish' ? -1 : 0;
    weightedScore += dir * sig.strength * sig.weight;
  }

  // Combine with Bias Index (primary) + weighted signal score (secondary)
  const blended     = biasScore * 0.7 + weightedScore * 0.3;
  const probability = biasToProb(blended, confluenceResult.amplifier);

  // Direction from blended score
  const direction: SolPrediction['direction'] =
    blended > 8  ? 'bullish' :
    blended < -8 ? 'bearish' : 'neutral';

  // Confidence tiers
  const hasEnoughData     = dataAgeMin < 10 && (snap?.unique_whales_active ?? 0) >= 5;
  const signalAgreement   = confluenceResult.aligned_signals;
  const confidence: SolPrediction['confidence'] =
    !hasEnoughData                                          ? 'insufficient_data' :
    signalAgreement >= 3 && Math.abs(biasScore) >= 20      ? 'high' :
    signalAgreement >= 2 || Math.abs(biasScore) >= 10      ? 'medium' : 'low';

  return {
    ok:           true,
    direction,
    probability:  Math.round(probability * 1000) / 1000,
    confidence,
    bias_score:   biasScore,
    signals:      signals.map(s => ({ ...s, strength: Math.round(clamp(s.strength, 0, 100)) })),
    smart_money_ratio: smRatio,
    confluence:   { aligned: confluenceResult.aligned_signals, amplifier: confluenceResult.amplifier },
    data_age_min: dataAgeMin,
    next_update:  new Date(now.getTime() + 5 * 60_000).toISOString(),
    computed_at:  now.toISOString(),
  };
}

// ── GET handler ───────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    if (_cache && _cache.expires_at > Date.now()) {
      return NextResponse.json({ ..._cache.result, cached: true });
    }
    const result = await computePrediction();
    _cache = { result, expires_at: Date.now() + CACHE_TTL };
    return NextResponse.json({ ...result, cached: false });
  } catch (err) {
    console.error('[api/predict/sol]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
