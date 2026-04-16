// ============================================================
// SONAR — Feature Builder
// ============================================================
// Derives prediction_features rows from a 4h flow snapshot,
// the prior snapshot (for reversal detection), and the raw
// movements in that window (for per-exchange breakdown).
//
// Called from the process-flows cron after snapshot + bias
// index writes, so all derived data is consistent.
//
// One row per (feature_time, horizon) — same feature vector
// written for '4h', '24h', '72h' horizons so the prediction
// engine can train separate models per lookforward period.
//
// Upsert on (feature_time, horizon): idempotent, a cron re-run
// simply refreshes the features for the same snapshot time.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { SnapshotInsert }    from '@/lib/signal-engine';
import type { FlowSnapshotRow, MovementRow } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

type Db = ReturnType<typeof createAdminClient>;

export interface FeatureBuilderContext {
  snapshot:       SnapshotInsert;           // 4h snapshot just written
  baseline:       FlowSnapshotRow | null;   // prior 4h snapshot (reversal detection)
  movements4h:    MovementRow[];            // movements in the 4h window
  biasScore:      number;                   // -100..+100 from calculateBiasIndex
  biasLabel:      string;                   // 'bullish' | 'bearish' | 'neutral' | ...
  biasConfidence: number;                   // 0-100
}

export interface FeatureBuildReceipt {
  written:      number;
  feature_time: string;
  horizons:     string[];
}

// ── Helpers ───────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Group movements by exchange, summing inflow and outflow separately. */
function computeExchangeFlowByExchange(
  movements: MovementRow[],
): Record<string, { in_usd: number; out_usd: number; net_usd: number }> {
  const result: Record<string, { in_usd: number; out_usd: number; net_usd: number }> = {};

  for (const m of movements) {
    if (!m.exchange) continue;
    const ex  = m.exchange;
    const amt = m.amount_usd ?? 0;
    if (!result[ex]) result[ex] = { in_usd: 0, out_usd: 0, net_usd: 0 };

    if (m.flow_type === 'exchange_deposit')    result[ex].in_usd  += amt;
    if (m.flow_type === 'exchange_withdrawal') result[ex].out_usd += amt;
  }

  for (const ex of Object.keys(result)) {
    // net = withdrawals - deposits:  positive = net outflow from exchanges = bullish
    result[ex].net_usd = result[ex].out_usd - result[ex].in_usd;
  }

  return result;
}

/**
 * True if market_bias direction flipped between prior and current snapshot.
 * Neutral→anything or anything→neutral is NOT considered a reversal.
 */
function detectFlowReversal(
  current: SnapshotInsert,
  prior:   FlowSnapshotRow | null,
): boolean {
  if (!prior) return false;
  const bullish = (b: string | null | undefined) => b === 'bullish';
  const bearish = (b: string | null | undefined) => b === 'bearish';
  return (
    (bullish(current.market_bias) && bearish(prior.market_bias)) ||
    (bearish(current.market_bias) && bullish(prior.market_bias))
  );
}

// ── Main export ───────────────────────────────────────────────

const PREDICTION_HORIZONS = ['4h', '24h', '72h'] as const;

export async function buildPredictionFeatures(
  ctx: FeatureBuilderContext,
  db:  Db,
): Promise<FeatureBuildReceipt> {
  const { snapshot, baseline, movements4h, biasScore, biasLabel, biasConfidence } = ctx;

  // ── Derived scores ────────────────────────────────────────

  // defi_rotation_score: how much of total inflow went to DeFi  (-1..+1)
  const totalInflow      = snapshot.sol_exchange_inflow_usd + snapshot.defi_deposit_usd;
  const defiRotationScore = clamp(
    totalInflow > 0 ? snapshot.net_defi_flow_usd / (totalInflow + 1) : 0,
    -1, 1,
  );

  // large_wallet_concentration: avg large moves per active whale  (0..10)
  const largeWalletConcentration = clamp(
    snapshot.unique_whales_active > 0
      ? snapshot.large_movements_count / snapshot.unique_whales_active
      : 0,
    0, 10,
  );

  // cluster_activity_score: normalised large-move count  (0..1)
  const clusterActivityScore = clamp(snapshot.large_movements_count / 50, 0, 1);

  // smart_money_net_bias: bias score normalised to -1..+1
  const smartMoneyNetBias = clamp(biasScore / 100, -1, 1);

  // stablecoin_dex_intensity: share of inflows going to DeFi rather than exchanges  (0..1)
  const stablecoinDexIntensity = clamp(
    snapshot.defi_deposit_usd / (snapshot.defi_deposit_usd + snapshot.sol_exchange_inflow_usd + 1),
    0, 1,
  );

  // ── Extended features (features_json) ────────────────────

  const exchangeFlowByExchange = computeExchangeFlowByExchange(movements4h);
  const flowReversalFlag       = detectFlowReversal(snapshot, baseline);

  const featuresJson = {
    exchange_flow_by_exchange:  exchangeFlowByExchange,
    stablecoin_dex_intensity:   stablecoinDexIntensity,
    net_defi_flow_usd:          snapshot.net_defi_flow_usd,
    bias_label:                 biasLabel,
    flow_reversal_flag:         flowReversalFlag,
    unique_whales_active:       snapshot.unique_whales_active,
    large_movements_count:      snapshot.large_movements_count,
    net_usdc_flow_usd:          snapshot.net_usdc_flow_usd,
    sol_exchange_inflow_usd:    snapshot.sol_exchange_inflow_usd,
    sol_exchange_outflow_usd:   snapshot.sol_exchange_outflow_usd,
    defi_deposit_usd:           snapshot.defi_deposit_usd,
    defi_withdrawal_usd:        snapshot.defi_withdrawal_usd,
  };

  // ── Build rows (one per horizon) ──────────────────────────

  const rows = PREDICTION_HORIZONS.map(horizon => ({
    feature_time:               snapshot.snapshot_time,
    horizon,
    exchange_net_flow_usd:      snapshot.sol_net_exchange_flow_usd,
    staking_net_flow_usd:       snapshot.net_staking_flow_usd,
    staking_velocity:           snapshot.staking_velocity_pct ?? 0,
    stablecoin_deploy_usd:      snapshot.net_usdc_flow_usd,
    defi_rotation_score:        defiRotationScore,
    large_wallet_concentration: largeWalletConcentration,
    cluster_activity_score:     clusterActivityScore,
    smart_money_net_bias:       smartMoneyNetBias,
    bias_score:                 biasScore,
    bias_confidence:            biasConfidence,
    features_json:              featuresJson,
  }));

  // Upsert: re-running the cron refreshes the same (feature_time, horizon) row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('prediction_features')
    .upsert(rows, { onConflict: 'feature_time,horizon', ignoreDuplicates: false })
    .select('id');

  if (error) {
    throw new Error(`prediction_features upsert failed: ${error.message}`);
  }

  return {
    written:      data?.length ?? 0,
    feature_time: snapshot.snapshot_time,
    horizons:     [...PREDICTION_HORIZONS],
  };
}
