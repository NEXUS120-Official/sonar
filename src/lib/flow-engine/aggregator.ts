// ============================================================
// SONAR v2.0 — Flow Aggregator
// ============================================================
// Reads movements from the DB for a given time window and
// produces a FlowSnapshot with net flow metrics and bias score.
//
// Windows: 1h, 4h, 24h, 168h (7d)
// Called by the process-flows cron every 5 minutes.
// ============================================================

import { BIAS_WEIGHTS, FLOW_THRESHOLDS, SNAPSHOT_WINDOWS } from '@/lib/utils/constants';
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
        // USDC stablecoin moves into staking count as inflow too
        if (m.token === 'USDC' || m.token === 'USDT') {
          usdc_inflow_usd += usd;
        }
        break;

      case 'unstake':
        sol_unstaked_usd += usd;
        if (m.token === 'USDC' || m.token === 'USDT') {
          usdc_outflow_usd += usd;
        }
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
    unique_whales_active: activeWhales.size,
    bias_score: 0,
    market_bias: 'neutral',
  };

  const { bias_score, market_bias } = calculateBiasScore(metrics);
  metrics.bias_score  = bias_score;
  metrics.market_bias = market_bias;

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
  };
}

// ── Bias score calculation ────────────────────────────────────

/**
 * Compute a bias score from -100 (extreme bearish) to +100 (extreme bullish).
 *
 * Components:
 *   Exchange net flow:
 *     - Net outflow (more withdrawals than deposits) = bullish
 *     - Net inflow  (more deposits than withdrawals) = bearish
 *     - Mild threshold  ($100K net): ±25 pts
 *     - Strong threshold ($500K net): ±50 pts (replaces mild)
 *
 *   Staking net:
 *     - Net positive (more staked) = bullish  +15 pts
 *     - Net negative (more unstaked) = bearish -15 pts
 *     - Threshold: $100K
 *
 *   USDC net flow:
 *     - Net inflow to DeFi/staking = bullish  +10 pts
 *     - Net outflow from DeFi = bearish       -10 pts
 *     - Threshold: $100K
 */
export function calculateBiasScore(metrics: Pick<
  FlowMetrics,
  'sol_net_exchange_flow_usd' | 'net_staking_flow_usd' | 'net_usdc_flow_usd'
>): { bias_score: number; market_bias: MarketBias } {
  let score = 0;
  const w   = BIAS_WEIGHTS;

  // Exchange flow component
  // Negative net_exchange_flow = accumulation = bullish (flip sign)
  const exchNet = -metrics.sol_net_exchange_flow_usd; // positive means net outflow (bullish)
  if (Math.abs(exchNet) >= w.exchange_strong_threshold) {
    score += exchNet > 0 ? w.exchange_strong_pts : -w.exchange_strong_pts;
  } else if (Math.abs(exchNet) >= w.exchange_mild_threshold) {
    score += exchNet > 0 ? w.exchange_mild_pts : -w.exchange_mild_pts;
  }

  // Staking component
  if (Math.abs(metrics.net_staking_flow_usd) >= w.staking_threshold) {
    score += metrics.net_staking_flow_usd > 0 ? w.staking_pts : -w.staking_pts;
  }

  // Stablecoin component
  if (Math.abs(metrics.net_usdc_flow_usd) >= w.usdc_threshold) {
    score += metrics.net_usdc_flow_usd > 0 ? w.usdc_pts : -w.usdc_pts;
  }

  const bias_score = clamp(score, -100, 100);

  const market_bias: MarketBias =
    bias_score > 20  ? 'bullish' :
    bias_score < -20 ? 'bearish' :
    'neutral';

  return { bias_score, market_bias };
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
