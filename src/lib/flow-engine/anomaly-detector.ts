// ============================================================
// SONAR v2.0 — Anomaly Detector
// ============================================================
// Compares a current snapshot against a baseline (e.g. 7d average)
// and generates alert payloads when thresholds are crossed.
//
// Alert types:
//   exchange_spike      — exchange volume >> baseline
//   accumulation_wave   — large net exchange outflow
//   distribution_wave   — large net exchange inflow
//   staking_shift       — large net staking change
//
// Keep this simple: threshold-based only, no ML.
// ============================================================

import { FLOW_THRESHOLDS } from '@/lib/utils/constants';
import type { AlertRow, AlertType, AlertSeverity } from '@/lib/supabase/types';
import type { FlowMetrics } from './aggregator';
import { isSuppressed, signalValueFor, type RecentAlertMap } from './dedup';

// ── Types ─────────────────────────────────────────────────────

export type AlertInsert = Omit<AlertRow, 'id' | 'created_at'>;

export interface AnomalyInput {
  current:      FlowMetrics;
  baseline:     FlowMetrics | null;  // null on first run (no history yet)
  windowHours:  number;
  /** Most-recent fired alert per type, used for cooldown + min-change dedup. */
  recentAlerts?: RecentAlertMap;
}

// ── Helpers ───────────────────────────────────────────────────

function severity(usd: number): AlertSeverity {
  if (usd >= 5_000_000) return 'major';
  if (usd >= 1_000_000) return 'significant';
  if (usd >= 500_000)   return 'notable';
  return 'info';
}

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

function baseAlert(type: AlertType): Omit<AlertInsert, 'severity' | 'title' | 'body' | 'data'> {
  return {
    alert_type:           type,
    ai_analysis:          null,
    movement_ids:         null,
    sent_telegram_free:    false,
    sent_telegram_premium: false,
    sent_at:              null,
  };
}

// ── Detectors ─────────────────────────────────────────────────

/**
 * Exchange spike: total exchange volume (in + out) is N× the baseline average.
 * Fires if no baseline is available AND volume exceeds absolute threshold.
 */
function detectExchangeSpike(
  current:   FlowMetrics,
  baseline:  FlowMetrics | null,
  lastAlert: AlertRow | null,
): AlertInsert | null {
  const currentVolume  = current.sol_exchange_inflow_usd + current.sol_exchange_outflow_usd;
  const baselineVolume = baseline
    ? baseline.sol_exchange_inflow_usd + baseline.sol_exchange_outflow_usd
    : null;

  const multiplier = FLOW_THRESHOLDS.alert.exchange_spike_multiplier;

  const isSpike =
    baselineVolume !== null
      ? baselineVolume > 0 && currentVolume >= baselineVolume * multiplier
      : currentVolume >= 2_000_000; // absolute fallback when no baseline

  if (!isSpike) return null;

  if (isSuppressed('exchange_spike', lastAlert, currentVolume)) {
    console.log(`[anomaly] exchange_spike suppressed by cooldown/dedup (volume: ${fmtUsd(currentVolume)})`);
    return null;
  }

  const ratio = baselineVolume ? (currentVolume / baselineVolume).toFixed(1) : 'N/A';

  console.log(
    `[anomaly] exchange_spike detected — volume: ${fmtUsd(currentVolume)}` +
    ` (${ratio}× baseline)`,
  );

  return {
    ...baseAlert('exchange_spike'),
    severity: severity(currentVolume),
    title:    `Exchange volume spike (${ratio}× baseline)`,
    body:
      `Exchange volume hit ${fmtUsd(currentVolume)} — ` +
      `${ratio}× the recent average. ` +
      `Inflow: ${fmtUsd(current.sol_exchange_inflow_usd)} | ` +
      `Outflow: ${fmtUsd(current.sol_exchange_outflow_usd)}.`,
    data: {
      current_volume_usd:  currentVolume,
      baseline_volume_usd: baselineVolume,
      ratio,
    },
  };
}

/**
 * Accumulation wave: net exchange outflow >= threshold (bullish).
 */
function detectAccumulationWave(
  current:   FlowMetrics,
  lastAlert: AlertRow | null,
): AlertInsert | null {
  // Negative net_exchange_flow = more withdrawals than deposits = accumulation
  const netOutflow = -current.sol_net_exchange_flow_usd;
  if (netOutflow < FLOW_THRESHOLDS.alert.accumulation_wave_usd) return null;

  if (isSuppressed('accumulation_wave', lastAlert, netOutflow)) {
    console.log(`[anomaly] accumulation_wave suppressed by cooldown/dedup (outflow: ${fmtUsd(netOutflow)})`);
    return null;
  }

  console.log(`[anomaly] accumulation_wave detected — net outflow: ${fmtUsd(netOutflow)}`);

  return {
    ...baseAlert('accumulation_wave'),
    severity: severity(netOutflow),
    title:    `Accumulation wave — ${fmtUsd(netOutflow)} net exchange outflow`,
    body:
      `Smart money withdrew ${fmtUsd(current.sol_exchange_outflow_usd)} from exchanges ` +
      `vs deposited ${fmtUsd(current.sol_exchange_inflow_usd)} ` +
      `— net outflow of ${fmtUsd(netOutflow)}. ` +
      `This pattern suggests large holders are accumulating off exchange.`,
    data: {
      net_outflow_usd:  netOutflow,
      inflow_usd:       current.sol_exchange_inflow_usd,
      outflow_usd:      current.sol_exchange_outflow_usd,
    },
  };
}

/**
 * Distribution wave: net exchange inflow >= threshold (bearish).
 */
function detectDistributionWave(
  current:   FlowMetrics,
  lastAlert: AlertRow | null,
): AlertInsert | null {
  const netInflow = current.sol_net_exchange_flow_usd;
  if (netInflow < FLOW_THRESHOLDS.alert.distribution_wave_usd) return null;

  if (isSuppressed('distribution_wave', lastAlert, netInflow)) {
    console.log(`[anomaly] distribution_wave suppressed by cooldown/dedup (inflow: ${fmtUsd(netInflow)})`);
    return null;
  }

  console.log(`[anomaly] distribution_wave detected — net inflow: ${fmtUsd(netInflow)}`);

  return {
    ...baseAlert('distribution_wave'),
    severity: severity(netInflow),
    title:    `Distribution wave — ${fmtUsd(netInflow)} net exchange inflow`,
    body:
      `Smart money deposited ${fmtUsd(current.sol_exchange_inflow_usd)} into exchanges ` +
      `vs withdrew ${fmtUsd(current.sol_exchange_outflow_usd)} ` +
      `— net inflow of ${fmtUsd(netInflow)}. ` +
      `This pattern suggests large holders are distributing / preparing to sell.`,
    data: {
      net_inflow_usd:   netInflow,
      inflow_usd:       current.sol_exchange_inflow_usd,
      outflow_usd:      current.sol_exchange_outflow_usd,
    },
  };
}

/**
 * Staking shift: large net staking or unstaking event.
 */
function detectStakingShift(
  current:   FlowMetrics,
  lastAlert: AlertRow | null,
): AlertInsert | null {
  const absNet = Math.abs(current.net_staking_flow_usd);
  if (absNet < FLOW_THRESHOLDS.alert.staking_shift_usd) return null;

  if (isSuppressed('staking_shift', lastAlert, absNet)) {
    console.log(`[anomaly] staking_shift suppressed by cooldown/dedup (absNet: ${fmtUsd(absNet)})`);
    return null;
  }

  const isStaking = current.net_staking_flow_usd > 0;
  console.log(
    `[anomaly] staking_shift detected — net ${isStaking ? 'staked' : 'unstaked'}: ${fmtUsd(absNet)}`,
  );

  return {
    ...baseAlert('staking_shift'),
    severity: severity(absNet),
    title:    `Staking shift — ${fmtUsd(absNet)} net ${isStaking ? 'staked' : 'unstaked'}`,
    body: isStaking
      ? `Large capital moved into staking protocols: ${fmtUsd(current.sol_staked_usd)} staked ` +
        `vs ${fmtUsd(current.sol_unstaked_usd)} unstaked ` +
        `(net: ${fmtUsd(current.net_staking_flow_usd)}). Bullish long-term signal.`
      : `Large capital exiting staking protocols: ${fmtUsd(current.sol_unstaked_usd)} unstaked ` +
        `vs ${fmtUsd(current.sol_staked_usd)} staked ` +
        `(net: ${fmtUsd(current.net_staking_flow_usd)}). Watch for increased sell pressure.`,
    data: {
      net_staking_usd:  current.net_staking_flow_usd,
      staked_usd:       current.sol_staked_usd,
      unstaked_usd:     current.sol_unstaked_usd,
    },
  };
}

// ── Flow reversal ─────────────────────────────────────────────

/**
 * Flow reversal: the dominant direction of 4h exchange net flow has flipped
 * between the prior snapshot and the current snapshot.
 *
 * Conditions:
 *   1. Both current and baseline must have |net_exchange_flow| >= flow_reversal_min_usd
 *   2. Their signs must be opposite (bullish→bearish or bearish→bullish)
 *
 * This is inherently a 2-snapshot detection — the "confirmed flip" that the
 * sprint requires. A single noisy outlier cannot trigger it alone.
 */
function detectFlowReversal(
  current:   FlowMetrics,
  baseline:  FlowMetrics | null,
  lastAlert: AlertRow | null,
): AlertInsert | null {
  if (!baseline) return null;  // No history yet — can't detect a flip

  const minUsd = FLOW_THRESHOLDS.alert.flow_reversal_min_usd;
  const curNet  = current.sol_net_exchange_flow_usd;
  const prevNet = baseline.sol_net_exchange_flow_usd;

  // Both sides must exceed the minimum to confirm a real move
  if (Math.abs(curNet) < minUsd || Math.abs(prevNet) < minUsd) return null;

  // Signs must be opposite
  const flipped = (curNet > 0 && prevNet < 0) || (curNet < 0 && prevNet > 0);
  if (!flipped) return null;

  const magnitudeUsd = Math.abs(curNet);

  if (isSuppressed('flow_reversal', lastAlert, magnitudeUsd)) {
    console.log(`[anomaly] flow_reversal suppressed by cooldown/dedup (magnitude: ${fmtUsd(magnitudeUsd)})`);
    return null;
  }

  const direction = curNet < 0
    ? ('bearish_to_bullish' as const)   // was positive (bearish inflow), now negative (bullish outflow)
    : ('bullish_to_bearish' as const);  // was negative (bullish outflow), now positive (bearish inflow)

  const dirLabel = direction === 'bearish_to_bullish'
    ? 'bearish → bullish'
    : 'bullish → bearish';

  console.log(
    `[anomaly] flow_reversal detected — ${dirLabel}` +
    ` | prev: ${fmtUsd(prevNet)} → cur: ${fmtUsd(curNet)}`,
  );

  return {
    ...baseAlert('flow_reversal'),
    severity: severity(magnitudeUsd),
    title:    `Flow reversal — ${dirLabel} (${fmtUsd(magnitudeUsd)})`,
    body:
      `Exchange net flow has reversed direction. ` +
      `Previous 4h window: ${fmtUsd(prevNet)} net ${prevNet > 0 ? 'inflow (bearish)' : 'outflow (bullish)'}. ` +
      `Current 4h window:  ${fmtUsd(curNet)} net ${curNet  > 0 ? 'inflow (bearish)' : 'outflow (bullish)'}. ` +
      `This directional flip may signal a near-term trend change.`,
    data: {
      previous_net_exchange_usd: prevNet,
      current_net_exchange_usd:  curNet,
      direction,
      magnitude_usd:             magnitudeUsd,
    },
  };
}

// ── Main export ───────────────────────────────────────────────

/**
 * Run all anomaly detectors on the current snapshot vs baseline.
 * Returns alert payloads ready for DB insert.
 * Pass `recentAlerts` (most-recent fired row per type) to enable cooldown/dedup.
 */
export function detectAnomalies(input: AnomalyInput): AlertInsert[] {
  const { current, baseline, recentAlerts = {} } = input;
  const alerts: AlertInsert[] = [];

  const spike = detectExchangeSpike(current, baseline, recentAlerts['exchange_spike'] ?? null);
  if (spike)  alerts.push(spike);

  const accum = detectAccumulationWave(current, recentAlerts['accumulation_wave'] ?? null);
  if (accum)  alerts.push(accum);

  const dist  = detectDistributionWave(current, recentAlerts['distribution_wave'] ?? null);
  if (dist)   alerts.push(dist);

  const stake = detectStakingShift(current, recentAlerts['staking_shift'] ?? null);
  if (stake)  alerts.push(stake);

  const reversal = detectFlowReversal(current, baseline, recentAlerts['flow_reversal'] ?? null);
  if (reversal) alerts.push(reversal);

  console.log(`[anomaly] ${alerts.length} alert(s) generated`);
  return alerts;
}
