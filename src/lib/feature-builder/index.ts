// ============================================================
// SONAR — Feature Builder
// ============================================================
// Derives prediction_features rows from a 4h flow snapshot.
//
// The canonical derivation function is deriveFeatureColumns() —
// a pure function used by both the live path (process-flows cron)
// and the historical backfill cron. Both paths write identical
// column schemas; they differ only in feature quality, which is
// recorded explicitly in features_json.quality metadata.
//
// Live path (process-flows → buildPredictionFeatures):
//   mode = 'live_full'
//   movements provided → exchange_flow_by_exchange populated
//   baseline provided  → flow_reversal_flag accurate
//
// Backfill path (backfill-prediction-features cron):
//   mode = 'historical_snapshot_backfill'
//   movements = [] (not stored historically)
//   baseline from prior row in sorted snapshot list
//
// Upsert on (feature_time, horizon): idempotent, a cron re-run
// simply refreshes the features for the same snapshot time.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { SnapshotInsert }    from '@/lib/signal-engine';
import type { FlowSnapshotRow, MovementRow } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

type Db = ReturnType<typeof createAdminClient>;

export type FeatureSourceMode = 'live_full' | 'historical_snapshot_backfill';

/**
 * Minimal snapshot shape required by deriveFeatureColumns().
 * Satisfied by both SnapshotInsert (live) and FlowSnapshotRow (DB read).
 */
export interface SnapshotLike {
  sol_exchange_inflow_usd:   number;
  sol_exchange_outflow_usd:  number;
  sol_net_exchange_flow_usd: number;
  net_staking_flow_usd:      number;
  staking_velocity_pct:      number | null;
  net_usdc_flow_usd:         number;
  net_defi_flow_usd:         number;
  defi_deposit_usd:          number;
  defi_withdrawal_usd:       number;
  large_movements_count:     number;
  unique_whales_active:      number;
  market_bias:               string | null;
}

export interface DerivedFeatureColumns {
  exchange_net_flow_usd:      number;
  staking_net_flow_usd:       number;
  staking_velocity:           number;
  stablecoin_deploy_usd:      number;
  defi_rotation_score:        number;
  large_wallet_concentration: number;
  cluster_activity_score:     number;
  smart_money_net_bias:       number;
  bias_score:                 number;
  bias_confidence:            number;
  features_json:              Record<string, unknown>;
}

export interface DeriveFeatureOptions {
  mode:                  FeatureSourceMode;
  movements?:            MovementRow[];                    // omit for backfill path
  baseline?:             { market_bias: string | null } | null; // prior snapshot for reversal detection
  // Cohort-aware feature inputs — computed externally and passed in to preserve purity.
  // When provided, cluster_activity_score uses the real net cohort bias signal.
  // When absent (backfill path), falls back to the large_movements_count proxy.
  clusterActivityScore?: number;                           // [-1, +1] net cohort bias
  cohortCounts?:         Record<string, number>;           // cluster_type → unique active wallets
}

export interface FeatureBuilderContext {
  snapshot:         SnapshotInsert;
  baseline:         FlowSnapshotRow | null;
  movements4h:      MovementRow[];
  biasScore:        number;
  biasLabel:        string;
  biasConfidence:   number;
  clusterMemberMap?: Map<string, string>; // address → cluster_type; optional, live path only
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
    // net = withdrawals - deposits: positive = net outflow from exchanges = bullish
    result[ex].net_usd = result[ex].out_usd - result[ex].in_usd;
  }
  return result;
}

function detectFlowReversal(
  current: { market_bias: string | null },
  prior:   { market_bias: string | null } | null,
): boolean {
  if (!prior) return false;
  const bullish = (b: string | null | undefined) => b === 'bullish';
  const bearish = (b: string | null | undefined) => b === 'bearish';
  return (
    (bullish(current.market_bias) && bearish(prior.market_bias)) ||
    (bearish(current.market_bias) && bullish(prior.market_bias))
  );
}

// ── Cohort counts (pure) ──────────────────────────────────────

/**
 * Count unique active wallet addresses per cluster type within a movement set.
 *
 * Checks both from_address and to_address — necessary because the "whale side"
 * varies by flow_type (e.g. exchange_withdrawal: whale receives, is to_address).
 * Pure function — no DB. Called before deriveFeatureColumns in the live path.
 */
export function computeCohortCounts(
  movements:        MovementRow[],
  clusterMemberMap: Map<string, string>, // address → cluster_type
): Record<string, number> {
  const activeByCluster = new Map<string, Set<string>>();

  for (const m of movements) {
    for (const addr of [m.from_address, m.to_address]) {
      const ct = clusterMemberMap.get(addr);
      if (!ct) continue;
      let s = activeByCluster.get(ct);
      if (!s) { s = new Set(); activeByCluster.set(ct, s); }
      s.add(addr);
    }
  }

  const result: Record<string, number> = {};
  for (const [ct, addrs] of activeByCluster) {
    result[ct] = addrs.size;
  }
  return result;
}

// ── Canonical derivation function ─────────────────────────────

/**
 * Pure function: derives all prediction_features columns from a snapshot.
 * Called by both the live path and the historical backfill — single source
 * of truth for feature math. Quality of the result is recorded in
 * features_json so consumers can distinguish live vs. approximated rows.
 */
export function deriveFeatureColumns(
  snapshot:       SnapshotLike,
  biasScore:      number,
  biasLabel:      string,
  biasConfidence: number,
  opts:           DeriveFeatureOptions,
): DerivedFeatureColumns {
  const { mode, movements = [], baseline = null, clusterActivityScore: providedCAS, cohortCounts } = opts;

  // ── Scalar features ────────────────────────────────────────

  const totalInflow        = snapshot.sol_exchange_inflow_usd + snapshot.defi_deposit_usd;
  const defiRotationScore  = clamp(
    totalInflow > 0 ? snapshot.net_defi_flow_usd / (totalInflow + 1) : 0,
    -1, 1,
  );
  const largeWalletConcentration = clamp(
    snapshot.unique_whales_active > 0
      ? snapshot.large_movements_count / snapshot.unique_whales_active
      : 0,
    0, 10,
  );
  // When cluster data is available (live path): real net cohort bias [-1, +1].
  // Positive = accumulators dominating (bullish). Negative = distributors dominating.
  // When absent (backfill path): falls back to large_movements_count proxy [0, 1].
  const clusterActivityScore = providedCAS !== undefined
    ? providedCAS
    : clamp(snapshot.large_movements_count / 50, 0, 1);
  const smartMoneyNetBias    = clamp(biasScore / 100, -1, 1);
  const stablecoinDexIntensity = clamp(
    snapshot.defi_deposit_usd / (snapshot.defi_deposit_usd + snapshot.sol_exchange_inflow_usd + 1),
    0, 1,
  );

  // ── Movement-level features (live path only) ───────────────

  const exchangeFlowByExchange   = computeExchangeFlowByExchange(movements);
  const flowReversalFlag         = detectFlowReversal(snapshot, baseline);
  const movementLevelAvailable   = movements.length > 0;
  const exchangeFlowDetailAvail  = Object.keys(exchangeFlowByExchange).length > 0;

  // ── features_json with explicit quality metadata ───────────

  const features_json: Record<string, unknown> = {
    // ── Quality metadata — always present ──
    feature_source_mode:             mode,
    movement_level_detail_available: movementLevelAvailable,
    exchange_flow_detail_available:  exchangeFlowDetailAvail,
    backfill_approximation:          mode === 'historical_snapshot_backfill',

    // ── Snapshot-level fields — always available ──
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

    // ── Movement-level fields — populated on live_full path only ──
    exchange_flow_by_exchange:  exchangeFlowByExchange,

    // ── Cohort-level fields — populated when clusterMemberMap provided ──
    // null when cluster data unavailable (backfill path or first run before clustering).
    cohort_data_available:              providedCAS !== undefined,
    cohort_accumulator_active:          cohortCounts?.['accumulator']            ?? null,
    cohort_distributor_active:          cohortCounts?.['distributor']            ?? null,
    cohort_staker_active:               cohortCounts?.['staker']                 ?? null,
    cohort_exchange_heavy_active:       cohortCounts?.['exchange_heavy']         ?? null,
    cohort_defi_rotator_active:         cohortCounts?.['defi_rotator']           ?? null,
    cohort_inactive_large_holder_active: cohortCounts?.['inactive_large_holder'] ?? null,
  };

  return {
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
    features_json,
  };
}

// ── Live path: buildPredictionFeatures ────────────────────────

const PREDICTION_HORIZONS = ['4h', '24h', '72h'] as const;

export async function buildPredictionFeatures(
  ctx: FeatureBuilderContext,
  db:  Db,
): Promise<FeatureBuildReceipt> {
  const { snapshot, baseline, movements4h, biasScore, biasLabel, biasConfidence, clusterMemberMap } = ctx;

  // Compute cohort-aware inputs when cluster map is available (live path).
  let clusterActivityScore: number | undefined;
  let cohortCounts: Record<string, number> | undefined;

  if (clusterMemberMap && clusterMemberMap.size > 0) {
    cohortCounts = computeCohortCounts(movements4h, clusterMemberMap);
    const acc = cohortCounts['accumulator'] ?? 0;
    const dis = cohortCounts['distributor'] ?? 0;
    clusterActivityScore = clamp((acc - dis) / (acc + dis + 1), -1, 1);
  }

  const cols = deriveFeatureColumns(snapshot, biasScore, biasLabel, biasConfidence, {
    mode:                 'live_full',
    movements:            movements4h,
    baseline,
    clusterActivityScore,
    cohortCounts,
  });

  const rows = PREDICTION_HORIZONS.map(horizon => ({
    feature_time: snapshot.snapshot_time,
    horizon,
    ...cols,
  }));

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
