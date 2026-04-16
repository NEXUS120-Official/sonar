// ============================================================
// SONAR — Build Prediction Features Cron
// POST /api/cron/build-prediction-features
// ============================================================
// Runs every hour. Reads recent flow_snapshots and bias_index_history,
// computes normalized feature vectors, and writes rows to prediction_features
// for each horizon: 4h, 24h, 72h.
//
// Feature derivation:
//   exchange_net_flow_usd  ← sol_net_exchange_flow_usd  (negative = accumulation)
//   staking_net_flow_usd   ← net_staking_flow_usd       (positive = bullish)
//   staking_velocity       ← Δnet_staking / Δt (SOL/h) — acceleration
//   stablecoin_deploy_usd  ← net_usdc_flow_usd          (positive = deploying capital)
//   defi_rotation_score    ← net_defi_flow_usd normalized to [-1, 1]
//   large_wallet_concentration ← large_movements_count / unique_whales_active
//   smart_money_net_bias   ← bias_score / 100 from bias_index_history
//   bias_score             ← from latest bias_index_history row
//   bias_confidence        ← from latest bias_index_history row
//
// Horizons map to window_hours:
//   4h  → window_hours = 4
//   24h → window_hours = 24
//   72h → aggregate of 3 × 24h snapshots (last 72 h)
//
// Idempotent: uses unique index on (feature_time, horizon); conflicting rows
// are updated (upsert). Runs de-dup: skips if a row already exists for
// the truncated hour × horizon.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

// ── Config ────────────────────────────────────────────────────

const NORMALIZATION_CAP_USD = 100_000_000; // $100M — cap for [-1,1] normalization

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

interface FlowSnapshotRow {
  id:                      string;
  snapshot_time:           string;
  window_hours:            number;
  sol_exchange_inflow_usd:  number;
  sol_exchange_outflow_usd: number;
  sol_net_exchange_flow_usd: number;
  sol_staked_usd:           number;
  sol_unstaked_usd:         number;
  net_staking_flow_usd:     number;
  usdc_inflow_usd:          number;
  usdc_outflow_usd:         number;
  net_usdc_flow_usd:        number;
  defi_deposit_usd:         number;
  defi_withdrawal_usd:      number;
  net_defi_flow_usd:        number;
  large_movements_count:    number;
  unique_whales_active:     number;
  bias_score:               number | null;
}

interface BiasHistoryRow {
  score:      number;
  confidence: number;
  created_at: string;
}

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
  features_json:              Record<string, number>;
}

// ── Math helpers ──────────────────────────────────────────────

function normalize(value: number, cap: number): number {
  return Math.max(-1, Math.min(1, value / cap));
}

function safeDiv(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

// ── Feature computation ───────────────────────────────────────

function computeFeatures(
  snapshot: FlowSnapshotRow,
  prevSnapshot: FlowSnapshotRow | null,
  latestBias: BiasHistoryRow | null,
): FeatureVector {
  // Staking velocity: Δnet_staking / Δt (hours)
  let stakingVelocity = 0;
  if (prevSnapshot) {
    const dtHours =
      (new Date(snapshot.snapshot_time).getTime() -
       new Date(prevSnapshot.snapshot_time).getTime()) /
      3_600_000;
    if (dtHours > 0) {
      const deltaStaking =
        (snapshot.net_staking_flow_usd ?? 0) -
        (prevSnapshot.net_staking_flow_usd ?? 0);
      stakingVelocity = safeDiv(deltaStaking, dtHours);
    }
  }

  // DeFi rotation: net_defi_flow normalized
  const defiRotationScore = normalize(
    snapshot.net_defi_flow_usd ?? 0,
    NORMALIZATION_CAP_USD,
  );

  // Whale concentration: large movements per active whale
  const largeWalletConcentration = safeDiv(
    snapshot.large_movements_count ?? 0,
    snapshot.unique_whales_active ?? 1,
  );

  const biasScore      = latestBias?.score      ?? snapshot.bias_score ?? 0;
  const biasConfidence = latestBias?.confidence ?? 50;
  const smartMoneyBias = biasScore / 100; // [-1, 1]

  return {
    exchange_net_flow_usd:      snapshot.sol_net_exchange_flow_usd ?? 0,
    staking_net_flow_usd:       snapshot.net_staking_flow_usd ?? 0,
    staking_velocity:           stakingVelocity,
    stablecoin_deploy_usd:      snapshot.net_usdc_flow_usd ?? 0,
    defi_rotation_score:        defiRotationScore,
    large_wallet_concentration: largeWalletConcentration,
    smart_money_net_bias:       smartMoneyBias,
    bias_score:                 biasScore,
    bias_confidence:            biasConfidence,
    features_json: {
      sol_inflow_usd:      snapshot.sol_exchange_inflow_usd ?? 0,
      sol_outflow_usd:     snapshot.sol_exchange_outflow_usd ?? 0,
      sol_staked_usd:      snapshot.sol_staked_usd ?? 0,
      sol_unstaked_usd:    snapshot.sol_unstaked_usd ?? 0,
      usdc_inflow_usd:     snapshot.usdc_inflow_usd ?? 0,
      usdc_outflow_usd:    snapshot.usdc_outflow_usd ?? 0,
      defi_deposit_usd:    snapshot.defi_deposit_usd ?? 0,
      defi_withdrawal_usd: snapshot.defi_withdrawal_usd ?? 0,
      large_movements_count:  snapshot.large_movements_count ?? 0,
      unique_whales_active:   snapshot.unique_whales_active ?? 0,
    },
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

interface PredictionOutput {
  prob_up:      number;   // [0, 1]
  prob_down:    number;   // [0, 1]
  prob_flat:    number;   // [0, 1]
  direction:    number;   // +1 | 0 | -1
  confidence:   number;   // 0–100
  top_features: Record<string, number>;
}

function runModel(f: FeatureVector): PredictionOutput {
  const CAP    = 100_000_000; // $100M normalisation cap
  const K      = 0.011;       // logistic steepness

  // Normalise each component to [-1, +1]
  const exchNorm  = Math.max(-1, Math.min(1, -f.exchange_net_flow_usd / CAP));  // negative = bullish
  const stakeNorm = Math.max(-1, Math.min(1, f.staking_net_flow_usd   / CAP));  // unstaking = bullish
  const smNorm    = f.smart_money_net_bias;                                      // already [-1, 1]
  const stabNorm  = Math.max(-1, Math.min(1, f.stablecoin_deploy_usd  / CAP));
  const defiNorm  = f.defi_rotation_score;                                       // already [-1, 1]
  const concNorm  = Math.max(-1, Math.min(1, f.large_wallet_concentration / 10));

  // Weighted blend
  const rawScore =
    exchNorm  * 0.35 +
    stakeNorm * 0.20 +
    smNorm    * 0.15 +
    stabNorm  * 0.10 +
    defiNorm  * 0.10 +
    concNorm  * 0.10;

  // Scale to [-100, +100]
  const score   = rawScore * 100;
  const prob_up = 1 / (1 + Math.exp(-K * score));

  // Clamp to avoid extreme certainty
  const prob_up_clamped   = Math.max(0.30, Math.min(0.85, prob_up));
  const prob_down_clamped = Math.max(0.10, Math.min(0.55, 1 - prob_up_clamped));
  const prob_flat         = Math.max(0, 1 - prob_up_clamped - prob_down_clamped);

  const direction =
    prob_up_clamped > 0.55 ? 1  :
    prob_down_clamped > 0.45 ? -1 : 0;

  // How many components agree with the predicted direction
  const components = [exchNorm, stakeNorm, smNorm, stabNorm, defiNorm, concNorm];
  const aligned = components.filter(c =>
    direction === 1  ? c > 0.05  :
    direction === -1 ? c < -0.05 :
    Math.abs(c) < 0.05,
  ).length;
  const confidence = Math.min(100, Math.round(40 + aligned * 10));

  const top_features: Record<string, number> = {
    exchange_flow:    Math.round(exchNorm  * 100) / 100,
    staking_flow:     Math.round(stakeNorm * 100) / 100,
    smart_money:      Math.round(smNorm    * 100) / 100,
    stablecoin_deploy: Math.round(stabNorm * 100) / 100,
    defi_rotation:    Math.round(defiNorm  * 100) / 100,
    whale_concentration: Math.round(concNorm * 100) / 100,
    raw_score:        Math.round(score * 10) / 10,
  };

  return {
    prob_up:   Math.round(prob_up_clamped * 10000) / 10000,
    prob_down: Math.round(prob_down_clamped * 10000) / 10000,
    prob_flat: Math.round(prob_flat * 10000) / 10000,
    direction,
    confidence,
    top_features,
  };
}

// ── 72h aggregate: sum 3 × 24h snapshots ─────────────────────

function aggregate72h(snapshots24h: FlowSnapshotRow[]): FlowSnapshotRow {
  const base: FlowSnapshotRow = {
    ...snapshots24h[0],
    window_hours: 72,
    sol_exchange_inflow_usd:  0,
    sol_exchange_outflow_usd: 0,
    sol_net_exchange_flow_usd: 0,
    sol_staked_usd:           0,
    sol_unstaked_usd:         0,
    net_staking_flow_usd:     0,
    usdc_inflow_usd:          0,
    usdc_outflow_usd:         0,
    net_usdc_flow_usd:        0,
    defi_deposit_usd:         0,
    defi_withdrawal_usd:      0,
    net_defi_flow_usd:        0,
    large_movements_count:    0,
    unique_whales_active:     0,
    bias_score:               null,
  };

  for (const s of snapshots24h) {
    base.sol_exchange_inflow_usd   += s.sol_exchange_inflow_usd ?? 0;
    base.sol_exchange_outflow_usd  += s.sol_exchange_outflow_usd ?? 0;
    base.sol_net_exchange_flow_usd += s.sol_net_exchange_flow_usd ?? 0;
    base.sol_staked_usd            += s.sol_staked_usd ?? 0;
    base.sol_unstaked_usd          += s.sol_unstaked_usd ?? 0;
    base.net_staking_flow_usd      += s.net_staking_flow_usd ?? 0;
    base.usdc_inflow_usd           += s.usdc_inflow_usd ?? 0;
    base.usdc_outflow_usd          += s.usdc_outflow_usd ?? 0;
    base.net_usdc_flow_usd         += s.net_usdc_flow_usd ?? 0;
    base.defi_deposit_usd          += s.defi_deposit_usd ?? 0;
    base.defi_withdrawal_usd       += s.defi_withdrawal_usd ?? 0;
    base.net_defi_flow_usd         += s.net_defi_flow_usd ?? 0;
    base.large_movements_count     += s.large_movements_count ?? 0;
    // unique_whales: take max (avoid double-counting)
    base.unique_whales_active = Math.max(
      base.unique_whales_active,
      s.unique_whales_active ?? 0,
    );
  }

  return base;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startMs = Date.now();

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db    = createAdminClient();
  const dbAny = db as any;

  log('info', 'Starting feature store build');

  // ── 1. Fetch latest bias from bias_index_history ─────────────
  let latestBias: BiasHistoryRow | null = null;
  try {
    const { data: biasData } = await dbAny
      .from('bias_index_history')
      .select('score, confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    latestBias = biasData ?? null;
  } catch (err) {
    log('warn', 'Could not fetch bias_index_history — proceeding without bias', err);
  }

  // ── 2. Fetch recent flow_snapshots (4h window, last 2 rows) ──
  // We need 2 rows to compute staking_velocity (current vs prev).
  const { data: snaps4hRaw, error: snaps4hErr } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 4)
    .order('snapshot_time', { ascending: false })
    .limit(2);

  if (snaps4hErr) {
    log('error', 'Failed to fetch 4h snapshots', snaps4hErr.message);
    return NextResponse.json({ ok: false, error: snaps4hErr.message }, { status: 500 });
  }

  const snaps4h = (snaps4hRaw ?? []) as FlowSnapshotRow[];

  // ── 3. Fetch recent flow_snapshots (24h window, last 4 rows) ─
  const { data: snaps24hRaw, error: snaps24hErr } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 24)
    .order('snapshot_time', { ascending: false })
    .limit(4);  // need 3 for 72h aggregate + 1 prev for velocity

  if (snaps24hErr) {
    log('error', 'Failed to fetch 24h snapshots', snaps24hErr.message);
    return NextResponse.json({ ok: false, error: snaps24hErr.message }, { status: 500 });
  }

  const snaps24h = (snaps24hRaw ?? []) as FlowSnapshotRow[];

  if (snaps4h.length === 0 && snaps24h.length === 0) {
    log('info', 'No flow snapshots available — skipping');
    return NextResponse.json({ ok: true, message: 'no_data', inserted: 0, duration_ms: Date.now() - startMs });
  }

  // ── 4. Compute and upsert features for each horizon ──────────

  const featureTime = new Date();
  // Truncate to the current hour for idempotency
  featureTime.setMinutes(0, 0, 0);

  let inserted = 0;
  let runs_inserted = 0;
  const errors: string[] = [];

  // ── Helper: upsert features + run model + write prediction_run ─
  async function processHorizon(
    horizon: string,
    snap: FlowSnapshotRow,
    prev: FlowSnapshotRow | null,
  ): Promise<void> {
    const features = computeFeatures(snap, prev, latestBias);

    const { error: upsertErr } = await dbAny
      .from('prediction_features')
      .upsert({
        feature_time:               featureTime.toISOString(),
        horizon,
        exchange_net_flow_usd:      features.exchange_net_flow_usd,
        staking_net_flow_usd:       features.staking_net_flow_usd,
        staking_velocity:           features.staking_velocity,
        stablecoin_deploy_usd:      features.stablecoin_deploy_usd,
        defi_rotation_score:        features.defi_rotation_score,
        large_wallet_concentration: features.large_wallet_concentration,
        cluster_activity_score:     null,
        smart_money_net_bias:       features.smart_money_net_bias,
        bias_score:                 features.bias_score,
        bias_confidence:            features.bias_confidence,
        features_json:              features.features_json,
      }, { onConflict: 'feature_time,horizon', ignoreDuplicates: false });

    if (upsertErr) {
      errors.push(`${horizon} features upsert failed: ${upsertErr.message}`);
      log('error', `${horizon} features upsert failed`, upsertErr.message);
      return;
    }

    inserted++;

    // Run logistic model
    const pred = runModel(features);
    log('info', `${horizon}: score=${pred.top_features.raw_score} dir=${pred.direction} p_up=${pred.prob_up} conf=${pred.confidence}`);

    // Write prediction_run (ignore duplicate for same feature_time+horizon+model)
    const { error: runErr } = await dbAny
      .from('prediction_runs')
      .insert({
        model_name:   MODEL_VERSION,
        model_version: '1.0.0',
        horizon,
        feature_time: featureTime.toISOString(),
        prob_up:      pred.prob_up,
        prob_down:    pred.prob_down,
        prob_flat:    pred.prob_flat,
        direction:    pred.direction,
        confidence:   pred.confidence,
        top_features: pred.top_features,
        predictions:  { ...pred, features: features.features_json },
        // evaluated fields filled later by evaluate-predictions cron
        actual_direction: null,
        correct:          null,
        evaluated_at:     null,
      });

    if (runErr) {
      // Duplicate (same hour already ran) is fine — ignore
      if (!runErr.message.includes('duplicate') && !runErr.message.includes('unique')) {
        errors.push(`${horizon} prediction_run insert failed: ${runErr.message}`);
        log('warn', `${horizon} prediction_run insert failed`, runErr.message);
      }
    } else {
      runs_inserted++;
    }
  }

  // ── 4a. 4h horizon ───────────────────────────────────────────
  if (snaps4h.length > 0) {
    await processHorizon('4h', snaps4h[0], snaps4h[1] ?? null);
  }

  // ── 4b. 24h horizon ──────────────────────────────────────────
  if (snaps24h.length > 0) {
    await processHorizon('24h', snaps24h[0], snaps24h[1] ?? null);
  }

  // ── 4c. 72h horizon (aggregate 3 × 24h) ─────────────────────
  if (snaps24h.length >= 3) {
    const snap72h  = aggregate72h(snaps24h.slice(0, 3));
    const prev72h  = snaps24h.length >= 4 ? aggregate72h(snaps24h.slice(1, 4)) : null;
    await processHorizon('72h', snap72h, prev72h);
  } else {
    log('info', `72h skipped — only ${snaps24h.length} 24h snapshots available (need ≥3)`);
  }

  const duration = Date.now() - startMs;
  log('info', `Done — inserted/updated=${inserted} errors=${errors.length} duration=${duration}ms`);

  return NextResponse.json({
    ok:            errors.length === 0,
    feature_time:  featureTime.toISOString(),
    features_inserted: inserted,
    runs_inserted,
    errors:        errors.slice(0, 5),
    duration_ms:   duration,
  });
}

export const GET = POST;
