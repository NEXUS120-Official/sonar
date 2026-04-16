// ============================================================
// SONAR — Build Prediction Features Cron
// POST /api/cron/build-prediction-features
// ============================================================
// Runs every hour.
//
// Responsibility: MODEL RUNNER only.
//   1. Read the latest prediction_features rows per horizon
//      (written every 5 min by process-flows → feature-builder)
//   2. Run logistic_v1 model on those features
//   3. Write prediction_runs rows
//
// This cron no longer computes or writes prediction_features.
// src/lib/feature-builder/index.ts is the single canonical writer.
//
// Idempotent on prediction_runs: duplicate insert (same
// feature_time + horizon + model) is silently ignored.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/build-prediction-features][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn') console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Types ─────────────────────────────────────────────────────

interface StoredFeatures {
  feature_time:               string;
  horizon:                    string;
  exchange_net_flow_usd:      number | null;
  staking_net_flow_usd:       number | null;
  staking_velocity:           number | null;
  stablecoin_deploy_usd:      number | null;
  defi_rotation_score:        number | null;
  large_wallet_concentration: number | null;
  smart_money_net_bias:       number | null;
  bias_score:                 number | null;
  bias_confidence:            number | null;
  features_json:              Record<string, unknown> | null;
}

// Internal vector shape required by runModel()
interface FeatureVector {
  exchange_net_flow_usd:      number;
  staking_net_flow_usd:       number;
  staking_velocity:           number;
  stablecoin_deploy_usd:      number;
  defi_rotation_score:        number;
  large_wallet_concentration: number;
  smart_money_net_bias:       number;
  bias_score:                 number;
  bias_confidence:            number;
  features_json:              Record<string, unknown>;
}

function storedToVector(f: StoredFeatures): FeatureVector {
  return {
    exchange_net_flow_usd:      f.exchange_net_flow_usd      ?? 0,
    staking_net_flow_usd:       f.staking_net_flow_usd       ?? 0,
    staking_velocity:           f.staking_velocity           ?? 0,
    stablecoin_deploy_usd:      f.stablecoin_deploy_usd      ?? 0,
    defi_rotation_score:        f.defi_rotation_score        ?? 0,
    large_wallet_concentration: f.large_wallet_concentration ?? 0,
    smart_money_net_bias:       f.smart_money_net_bias       ?? 0,
    bias_score:                 f.bias_score                 ?? 0,
    bias_confidence:            f.bias_confidence            ?? 50,
    features_json:              f.features_json              ?? {},
  };
}

// ── Logistic prediction model (v1) ───────────────────────────
//
// Weights derived from signal importance in the Bias Index:
//   exchange flow  35% — primary signal (negative = bullish, accumulation)
//   staking        20% — defensive/offensive positioning
//   smart money    15% — track record weighted
//   stablecoin     10% — capital deployment readiness
//   DeFi rotation  10% — risk-on indicator
//   concentration  10% — whale coordination signal
//
// Score range: [-100, +100], positive = bullish.
// P_up = 1 / (1 + exp(-k × score)), k = 0.011.

const MODEL_VERSION = 'logistic_v1';
const MODEL_SEM_VER = '1.0.0';

interface PredictionOutput {
  prob_up:      number;
  prob_down:    number;
  prob_flat:    number;
  direction:    number;    // +1 | 0 | -1
  confidence:   number;    // 0–100
  top_features: Record<string, number>;
}

function runModel(f: FeatureVector): PredictionOutput {
  const CAP = 100_000_000; // $100M normalisation cap
  const K   = 0.011;       // logistic steepness

  const exchNorm  = Math.max(-1, Math.min(1, -f.exchange_net_flow_usd / CAP)); // negative = bullish
  const stakeNorm = Math.max(-1, Math.min(1,  f.staking_net_flow_usd  / CAP)); // unstaking = bullish
  const smNorm    = f.smart_money_net_bias;                                     // already [-1, 1]
  const stabNorm  = Math.max(-1, Math.min(1,  f.stablecoin_deploy_usd / CAP));
  const defiNorm  = f.defi_rotation_score;                                      // already [-1, 1]
  const concNorm  = Math.max(-1, Math.min(1,  f.large_wallet_concentration / 10));

  const rawScore =
    exchNorm  * 0.35 +
    stakeNorm * 0.20 +
    smNorm    * 0.15 +
    stabNorm  * 0.10 +
    defiNorm  * 0.10 +
    concNorm  * 0.10;

  const score   = rawScore * 100;
  const prob_up = 1 / (1 + Math.exp(-K * score));

  const prob_up_clamped   = Math.max(0.30, Math.min(0.85, prob_up));
  const prob_down_clamped = Math.max(0.10, Math.min(0.55, 1 - prob_up_clamped));
  const prob_flat         = Math.max(0, 1 - prob_up_clamped - prob_down_clamped);

  const direction =
    prob_up_clamped   > 0.55 ?  1 :
    prob_down_clamped > 0.45 ? -1 : 0;

  const components = [exchNorm, stakeNorm, smNorm, stabNorm, defiNorm, concNorm];
  const aligned    = components.filter(c =>
    direction ===  1 ? c >  0.05 :
    direction === -1 ? c < -0.05 :
    Math.abs(c) < 0.05,
  ).length;
  const confidence = Math.min(100, Math.round(40 + aligned * 10));

  return {
    prob_up:   Math.round(prob_up_clamped   * 10000) / 10000,
    prob_down: Math.round(prob_down_clamped * 10000) / 10000,
    prob_flat: Math.round(prob_flat         * 10000) / 10000,
    direction,
    confidence,
    top_features: {
      exchange_flow:       Math.round(exchNorm  * 100) / 100,
      staking_flow:        Math.round(stakeNorm * 100) / 100,
      smart_money:         Math.round(smNorm    * 100) / 100,
      stablecoin_deploy:   Math.round(stabNorm  * 100) / 100,
      defi_rotation:       Math.round(defiNorm  * 100) / 100,
      whale_concentration: Math.round(concNorm  * 100) / 100,
      raw_score:           Math.round(score     *   10) /   10,
    },
  };
}

// ── POST handler ──────────────────────────────────────────────

const HORIZONS = ['4h', '24h', '72h'] as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startMs = Date.now();

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  log('info', 'Starting model run');

  let runs_inserted = 0;
  const errors: string[] = [];
  const processed: string[] = [];

  for (const horizon of HORIZONS) {
    // ── 1. Read latest prediction_features row for this horizon ─
    // Written every 5 min by process-flows → feature-builder.
    const { data: featureRow, error: fetchErr } = await db
      .from('prediction_features')
      .select('*')
      .eq('horizon', horizon)
      .order('feature_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchErr) {
      const msg = `${horizon}: failed to read prediction_features — ${fetchErr.message}`;
      log('error', msg);
      errors.push(msg);
      continue;
    }

    if (!featureRow) {
      log('info', `${horizon}: no prediction_features row yet — skipping`);
      continue;
    }

    const stored  = featureRow as StoredFeatures;
    const vector  = storedToVector(stored);

    // ── 2. Run logistic_v1 model ──────────────────────────────
    const pred = runModel(vector);
    log('info', `${horizon}: raw_score=${pred.top_features.raw_score} dir=${pred.direction} p_up=${pred.prob_up} conf=${pred.confidence}`);

    // ── 3. Write prediction_run ───────────────────────────────
    // Uses stored.feature_time so the run is traceable to its features row.
    const { error: runErr } = await db
      .from('prediction_runs')
      .insert({
        model_name:       MODEL_VERSION,
        model_version:    MODEL_SEM_VER,
        horizon,
        feature_time:     stored.feature_time,
        prob_up:          pred.prob_up,
        prob_down:        pred.prob_down,
        prob_flat:        pred.prob_flat,
        direction:        pred.direction,
        confidence:       pred.confidence,
        top_features:     pred.top_features,
        predictions:      { ...pred, features: stored.features_json },
        actual_direction: null,
        correct:          null,
        evaluated_at:     null,
      });

    if (runErr) {
      // Duplicate (same feature_time already processed) — silently skip
      if (runErr.message.includes('duplicate') || runErr.message.includes('unique')) {
        log('info', `${horizon}: prediction_run already exists for feature_time=${stored.feature_time} — skipping`);
      } else {
        const msg = `${horizon}: prediction_run insert failed — ${runErr.message}`;
        errors.push(msg);
        log('warn', msg);
      }
    } else {
      runs_inserted++;
      processed.push(`${horizon}@${stored.feature_time}`);
    }
  }

  const duration = Date.now() - startMs;
  log('info', `Done — runs_inserted=${runs_inserted} errors=${errors.length} duration=${duration}ms`);

  return NextResponse.json({
    ok:            errors.length === 0,
    runs_inserted,
    processed,
    errors:        errors.slice(0, 5),
    duration_ms:   duration,
  });
}

export const GET = POST;
