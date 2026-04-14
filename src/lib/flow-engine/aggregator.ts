// ============================================================
// SONAR v2.0 — Flow Aggregator
// ============================================================
// Reads movements from the DB for a given time window and
// produces a FlowSnapshot with net flow metrics and bias score.
//
// Windows: 1h, 4h, 24h, 168h (7d)
// Called by the process-flows cron every 5 minutes.
// ============================================================

import { BIAS_WEIGHTS, CONFIRMATION_MIN_USD, FLOW_THRESHOLDS, SNAPSHOT_WINDOWS } from '@/lib/utils/constants';
import { clamp } from '@/lib/utils/format';
import type { MovementRow, FlowSnapshotRow, MarketBias } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

export type SnapshotWindow = (typeof SNAPSHOT_WINDOWS)[number]; // 1 | 4 | 24 | 168

export interface FlowMetrics {
  sol_exchange_inflow_usd:  number;
  sol_exchange_outflow_usd: number;
  sol_net_exchange_flow_usd: number;

  sol_staked_usd:       number;
  sol_unstaked_usd:     number;
  net_staking_flow_usd: number;

  usdc_inflow_usd:    number;
  usdc_outflow_usd:   number;
  net_usdc_flow_usd:  number;

  defi_deposit_usd:    number;
  defi_withdrawal_usd: number;
  net_defi_flow_usd:   number;

  large_movements_count: number;
  unique_whales_active:  number;

  bias_score:  number;           // -100 to +100
  market_bias: MarketBias;

  /** 0–3: how many of exchange/staking/usdc sub-signals agree with market_bias. */
  confirmation_count:   number;
  /**
   * Rate of change in net_staking_flow_usd vs a prior snapshot.
   * Null until provided externally (computed in process-flows cron).
   */
  staking_velocity_pct: number | null;
}

export type SnapshotInsert = Omit<FlowSnapshotRow, 'id' | 'created_at'>;

// ── Aggregation ───────────────────────────────────────────────

/**
 * Aggregate a list of movements into flow metrics for a given window.
 * All movements must already be filtered to the correct time window
 * by the caller.
 */
export function aggregateMovements(
  movements: MovementRow[],
  windowHours: SnapshotWindow,
  snapshotTime: Date = new Date(),
): SnapshotInsert {
  const log = (msg: string) =>
    console.log(`[aggregator][${windowHours}h] ${msg}`);

  log(`Aggregating ${movements.length} movements`);

  let sol_exchange_inflow_usd  = 0;
  let sol_exchange_outflow_usd = 0;
  let sol_staked_usd           = 0;
  let sol_unstaked_usd         = 0;
  let usdc_inflow_usd          = 0;
  let usdc_outflow_usd         = 0;
  let defi_deposit_usd         = 0;
  let defi_withdrawal_usd      = 0;
  let large_movements_count    = 0;
  const activeWhales           = new Set<string>();

  for (const m of movements) {
    const usd = m.amount_usd ?? 0;
    if (usd <= 0) continue;

    // Track large movements
    if (usd >= FLOW_THRESHOLDS.large_movement_usd) {
      large_movements_count++;
    }

    // Track active whales
    if (m.whale_id) {
      activeWhales.add(m.whale_id);
    }

    switch (m.flow_type) {
      case 'exchange_deposit':
        // SOL going TO exchange = selling pressure (bearish)
        sol_exchange_inflow_usd += usd;
        break;

      case 'exchange_withdrawal':
        // SOL leaving exchange = accumulation (bullish)
        sol_exchange_outflow_usd += usd;
        break;

      case 'stake':
        sol_staked_usd += usd;
        // USDC staking is intentionally NOT added to usdc_inflow_usd here.
        // It is already captured in net_staking_flow_usd; double-counting it
        // in net_usdc_flow_usd would inflate the bias score.
        break;

      case 'unstake':
        sol_unstaked_usd += usd;
        // Same reason — do not add USDC unstake to usdc_outflow_usd.
        break;

      case 'defi_deposit':
        defi_deposit_usd += usd;
        if (m.token === 'USDC' || m.token === 'USDT') {
          usdc_inflow_usd += usd;
        }
        break;

      case 'defi_withdrawal':
        defi_withdrawal_usd += usd;
        if (m.token === 'USDC' || m.token === 'USDT') {
          usdc_outflow_usd += usd;
        }
        break;

      case 'whale_transfer':
      case 'bridge_in':
      case 'bridge_out':
      case 'unknown':
        // Count but don't assign to flow buckets
        break;
    }
  }

  // Net flows: positive = inflow to protocol, negative = outflow
  // Exchange: NEGATIVE net = more withdrawals = accumulation = bullish
  const sol_net_exchange_flow_usd = sol_exchange_inflow_usd - sol_exchange_outflow_usd;
  const net_staking_flow_usd      = sol_staked_usd - sol_unstaked_usd;
  const net_usdc_flow_usd         = usdc_inflow_usd - usdc_outflow_usd;
  const net_defi_flow_usd         = defi_deposit_usd - defi_withdrawal_usd;

  const metrics: FlowMetrics = {
    sol_exchange_inflow_usd,
    sol_exchange_outflow_usd,
    sol_net_exchange_flow_usd,
    sol_staked_usd,
    sol_unstaked_usd,
    net_staking_flow_usd,
    usdc_inflow_usd,
    usdc_outflow_usd,
    net_usdc_flow_usd,
    defi_deposit_usd,
    defi_withdrawal_usd,
    net_defi_flow_usd,
    large_movements_count,
    unique_whales_active:  activeWhales.size,
    bias_score:            0,
    market_bias:           'neutral',
    confirmation_count:    0,
    staking_velocity_pct:  null,
  };

  const { bias_score, market_bias } = calculateBiasScore(metrics);
  metrics.bias_score         = bias_score;
  metrics.market_bias        = market_bias;
  metrics.confirmation_count = calculateConfirmationCount(market_bias, metrics);

  log(
    `Metrics — exchange net: $${sol_net_exchange_flow_usd.toFixed(0)}` +
    ` | staking net: $${net_staking_flow_usd.toFixed(0)}` +
    ` | bias: ${market_bias} (${bias_score > 0 ? '+' : ''}${bias_score})`,
  );

  return {
    snapshot_time:           snapshotTime.toISOString(),
    window_hours:            windowHours,
    sol_exchange_inflow_usd,
    sol_exchange_outflow_usd,
    sol_net_exchange_flow_usd,
    sol_staked_usd,
    sol_unstaked_usd,
    net_staking_flow_usd,
    usdc_inflow_usd,
    usdc_outflow_usd,
    net_usdc_flow_usd,
    defi_deposit_usd,
    defi_withdrawal_usd,
    net_defi_flow_usd,
    large_movements_count,
    unique_whales_active:    activeWhales.size,
    bias_score,
    market_bias,
    confirmation_count:      metrics.confirmation_count,
    staking_velocity_pct:    null, // computed by process-flows cron (requires prior snapshot)
  };
}

// ── Bias score calculation ────────────────────────────────────

/**
 * Log-normalized component scorer.
 *
 * - value ≤ 0:           0 pts (noise / wrong direction)
 * - 0 < value < pivot:   linear ramp from 0 → ptsAtPivot
 * - value == pivot:      ptsAtPivot  (exact calibration point)
 * - value > pivot:       ptsAtPivot × (1 + log₅(value / pivot))
 *                        e.g. 5× pivot → 2× ptsAtPivot, 25× pivot → 3× ptsAtPivot
 *
 * No hard upper cap here — the outer clamp(−100, +100) handles it.
 */
function logPts(value: number, pivot: number, ptsAtPivot: number): number {
  if (value <= 0) return 0;
  if (value < pivot) return ptsAtPivot * (value / pivot);
  return ptsAtPivot * (1 + Math.log(value / pivot) / Math.log(5));
}

/**
 * Compute a continuous bias score from -100 (extreme bearish) to +100 (extreme bullish).
 *
 * Components (all log-normalized, see BIAS_WEIGHTS for calibration points):
 *   Exchange net flow:
 *     - Net outflow (withdrawals > deposits) = bullish (+)
 *     - Net inflow  (deposits > withdrawals) = bearish (−)
 *     - Reference: ±25 pts at $100K, ±50 pts at $500K (5× pivot), ±75 at $2.5M
 *
 *   Staking net:
 *     - Net positive (more staked)   = bullish (+)
 *     - Net negative (more unstaked) = bearish (−)
 *     - Reference: ±15 pts at $100K, ±30 pts at $500K
 *
 *   DeFi stablecoin (USDC/USDT deployment — DeFi only, staking excluded):
 *     - Net inflow  (capital deployed to DeFi) = bullish (+)
 *     - Net outflow (capital withdrawn)        = bearish (−)
 *     - Reference: ±10 pts at $100K, ±20 pts at $500K
 */
export function calculateBiasScore(metrics: Pick<
  FlowMetrics,
  'sol_net_exchange_flow_usd' | 'net_staking_flow_usd' | 'net_usdc_flow_usd'
>): { bias_score: number; market_bias: MarketBias } {
  const { pivot_usd, exchange_pts_at_pivot, staking_pts_at_pivot, usdc_pts_at_pivot } = BIAS_WEIGHTS;

  // Exchange: negative net_exchange_flow = net outflow = accumulation = bullish
  const exchNet  = -metrics.sol_net_exchange_flow_usd; // positive = bullish
  const exchPts  = logPts(Math.abs(exchNet), pivot_usd, exchange_pts_at_pivot);
  const score1   = exchNet >= 0 ? exchPts : -exchPts;

  // Staking: positive = bullish
  const stakePts = logPts(Math.abs(metrics.net_staking_flow_usd), pivot_usd, staking_pts_at_pivot);
  const score2   = metrics.net_staking_flow_usd >= 0 ? stakePts : -stakePts;

  // DeFi stablecoin: positive = bullish (staking USDC excluded — see aggregator)
  const usdcPts  = logPts(Math.abs(metrics.net_usdc_flow_usd), pivot_usd, usdc_pts_at_pivot);
  const score3   = metrics.net_usdc_flow_usd >= 0 ? usdcPts : -usdcPts;

  const bias_score  = clamp(Math.round(score1 + score2 + score3), -100, 100);
  const market_bias: MarketBias =
    bias_score > 20  ? 'bullish' :
    bias_score < -20 ? 'bearish' :
    'neutral';

  return { bias_score, market_bias };
}

// ── Confirmation count ────────────────────────────────────────

/**
 * Count how many of the three sub-signals (exchange, staking, USDC) are
 * individually active AND agree with the computed market_bias direction.
 *
 * Returns 0–3:
 *   3 = all three agree (high conviction)
 *   2 = two agree (moderate conviction)
 *   1 = only one agrees (weak / divergent)
 *   0 = no active sub-signals (or neutral with no signal above noise floor)
 *
 * "Active" = |net flow| > CONFIRMATION_MIN_USD ($50K).
 * For `neutral` bias: counts any active signal regardless of direction.
 */
export function calculateConfirmationCount(
  market_bias: MarketBias,
  metrics: Pick<
    FlowMetrics,
    'sol_net_exchange_flow_usd' | 'net_staking_flow_usd' | 'net_usdc_flow_usd'
  >,
): number {
  const min = CONFIRMATION_MIN_USD;

  // Exchange: negative net_exchange = outflow = bullish; positive = inflow = bearish
  const exchBullish = -metrics.sol_net_exchange_flow_usd > min;
  const exchBearish =  metrics.sol_net_exchange_flow_usd > min;

  // Staking: positive = net staked = bullish; negative = net unstaked = bearish
  const stakeBullish =  metrics.net_staking_flow_usd > min;
  const stakeBearish = -metrics.net_staking_flow_usd > min;

  // DeFi USDC: positive inflow = bullish; negative = bearish
  const usdcBullish =  metrics.net_usdc_flow_usd > min;
  const usdcBearish = -metrics.net_usdc_flow_usd > min;

  if (market_bias === 'bullish') {
    return (exchBullish ? 1 : 0) + (stakeBullish ? 1 : 0) + (usdcBullish ? 1 : 0);
  }
  if (market_bias === 'bearish') {
    return (exchBearish ? 1 : 0) + (stakeBearish ? 1 : 0) + (usdcBearish ? 1 : 0);
  }
  // neutral: count active signals regardless of direction
  return (
    (exchBullish || exchBearish ? 1 : 0) +
    (stakeBullish || stakeBearish ? 1 : 0) +
    (usdcBullish || usdcBearish ? 1 : 0)
  );
}

// ── Staking velocity ─────────────────────────────────────────

/**
 * Rate of change in net staking flow vs the previous snapshot.
 *
 * Formula:  (current - previous) / max(|previous|, FLOOR) × 100
 *
 * Positive = staking is accelerating (more SOL being staked vs prior window).
 * Negative = unstaking is accelerating (net outflow increasing).
 * Capped at ±1000% to prevent extreme outliers from distorting comparisons.
 *
 * Returns null if both values are below a minimum meaningful floor ($10K),
 * indicating there is no staking signal worth measuring.
 */
export function computeStakingVelocity(
  currentNet:  number,
  previousNet: number,
): number | null {
  const FLOOR    = 10_000; // $10K — below this, velocity is noise
  const MAX_PCT  = 1000;

  if (Math.abs(currentNet) < FLOOR && Math.abs(previousNet) < FLOOR) {
    return null; // insufficient signal
  }

  const denom = Math.max(Math.abs(previousNet), FLOOR);
  const raw   = ((currentNet - previousNet) / denom) * 100;
  return Math.max(-MAX_PCT, Math.min(MAX_PCT, raw));
}

// ── Window utilities ──────────────────────────────────────────

/**
 * Returns the cutoff ISO timestamp for a given window in hours.
 * Movements older than this are excluded from the snapshot.
 */
export function windowCutoff(windowHours: number, now: Date = new Date()): string {
  return new Date(now.getTime() - windowHours * 60 * 60 * 1000).toISOString();
}

/**
 * Filter movements to those within the given window.
 */
export function filterToWindow(movements: MovementRow[], windowHours: number): MovementRow[] {
  const cutoff = windowCutoff(windowHours);
  return movements.filter((m) => m.block_time >= cutoff);
}
