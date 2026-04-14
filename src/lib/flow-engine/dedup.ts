// ============================================================
// SONAR v2.0 — Alert Deduplication / Cooldown Guard
// ============================================================
// isSuppressed() returns true when an alert should NOT fire
// because it is still within its cooldown window AND the key
// signal metric has not changed enough to warrant a refire.
//
// Rules:
//   1. No prior alert for this type → always fire (not suppressed).
//   2. Prior alert exists but cooldown has expired → fire.
//   3. Within cooldown + metric changed >= ALERT_MIN_CHANGE_PCT → fire.
//   4. Within cooldown + metric changed < ALERT_MIN_CHANGE_PCT → suppress.
//
// Key metric per alert type (must match detector data fields):
//   exchange_spike    → current_volume_usd  (inflow + outflow)
//   accumulation_wave → net_outflow_usd     (-sol_net_exchange_flow_usd)
//   distribution_wave → net_inflow_usd      (sol_net_exchange_flow_usd)
//   staking_shift     → net_staking_usd     (abs(net_staking_flow_usd))
// ============================================================

import { ALERT_COOLDOWNS_MS, ALERT_MIN_CHANGE_PCT } from '@/lib/utils/constants';
import type { AlertRow, AlertType }                  from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

/** Most-recent fired alert per AlertType, loaded by the process-flows cron. */
export type RecentAlertMap = Partial<Record<AlertType, AlertRow>>;

// ── Internal helpers ──────────────────────────────────────────

/**
 * Extract the key signal metric from a previously stored alert's data JSON.
 * Returns null when the field is absent or not a number.
 */
function getLastMetricValue(alert: AlertRow): number | null {
  const data = alert.data as Record<string, unknown> | null;
  if (!data) return null;

  switch (alert.alert_type) {
    case 'exchange_spike': {
      const v = data['current_volume_usd'];
      return typeof v === 'number' ? v : null;
    }
    case 'accumulation_wave': {
      const v = data['net_outflow_usd'];
      return typeof v === 'number' ? v : null;
    }
    case 'distribution_wave': {
      const v = data['net_inflow_usd'];
      return typeof v === 'number' ? v : null;
    }
    case 'staking_shift': {
      const v = data['net_staking_usd'];
      return typeof v === 'number' ? Math.abs(v) : null;
    }
    case 'flow_reversal': {
      const v = data['magnitude_usd'];
      return typeof v === 'number' ? v : null;
    }
    default:
      return null;
  }
}

// ── Main export ───────────────────────────────────────────────

/**
 * Decide whether a new alert of `alertType` should be suppressed.
 *
 * @param alertType          - The type of alert being considered.
 * @param lastAlert          - Most recent fired alert of this type, or null.
 * @param currentSignalValue - The key metric value from the current snapshot.
 * @returns true  → suppress (do NOT insert a new alert row)
 *          false → allow (insert as normal)
 */
export function isSuppressed(
  alertType:          AlertType,
  lastAlert:          AlertRow | null,
  currentSignalValue: number,
): boolean {
  // No history → always fire
  if (!lastAlert) return false;

  const cooldownMs = ALERT_COOLDOWNS_MS[alertType as string];
  // Type has no cooldown configured → always fire
  if (cooldownMs === undefined) return false;

  const lastFiredMs = new Date(lastAlert.created_at).getTime();
  const elapsedMs   = Date.now() - lastFiredMs;

  // Cooldown has expired → fire
  if (elapsedMs >= cooldownMs) return false;

  // Within cooldown — check whether the metric moved enough
  const lastValue = getLastMetricValue(lastAlert);

  // Can't retrieve last value (old schema or null data) → suppress to be safe
  if (lastValue === null) return true;

  // Avoid divide-by-zero: if last value was zero, allow fire
  if (lastValue === 0) return false;

  const changePct = Math.abs(currentSignalValue - lastValue) / Math.abs(lastValue);
  return changePct < ALERT_MIN_CHANGE_PCT;
}

/**
 * Derive the current signal value for a given alert type from FlowMetrics fields.
 * Exported so detectors and tests share the same formula.
 */
export function signalValueFor(
  alertType: AlertType,
  metrics: {
    sol_exchange_inflow_usd:  number;
    sol_exchange_outflow_usd: number;
    sol_net_exchange_flow_usd: number;
    net_staking_flow_usd:     number;
  },
): number {
  switch (alertType) {
    case 'exchange_spike':
      return metrics.sol_exchange_inflow_usd + metrics.sol_exchange_outflow_usd;
    case 'accumulation_wave':
      return -metrics.sol_net_exchange_flow_usd;   // positive = net outflow
    case 'distribution_wave':
      return metrics.sol_net_exchange_flow_usd;    // positive = net inflow
    case 'staking_shift':
      return Math.abs(metrics.net_staking_flow_usd);
    case 'flow_reversal':
      // magnitude = absolute current net exchange flow (size of the new direction)
      return Math.abs(metrics.sol_net_exchange_flow_usd);
    default:
      return 0;
  }
}
