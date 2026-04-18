// ============================================================
// SONAR — Cohort Attribution
// ============================================================
// Derives CohortContext for a single alert from the movements
// that were active during the alert window.
//
// Counting rules (strictly enforced):
//   - Only addresses present in clusterMemberMap are counted.
//     Exchange/protocol counterparties are never in this map —
//     only behavior_v1 whale cluster members are.
//   - A single wallet address is counted at most once per
//     cluster_type per evaluation, regardless of how many
//     movements it appears in.
//   - Both from_address and to_address are checked; the map
//     filter implicitly excludes all non-member addresses.
// ============================================================

import type { AlertType, FlowType, MovementRow } from '@/lib/supabase/types';

// ── Cluster type → human-readable label ──────────────────────

const CLUSTER_LABELS: Record<string, string> = {
  accumulator:           'Accumulators',
  distributor:           'Distributors',
  staker:                'Stakers',
  exchange_heavy:        'Exchange-Heavy Wallets',
  defi_rotator:          'DeFi Rotators',
  inactive_large_holder: 'Inactive Large Holders',
};

// ── Relevant flow types per alert type ───────────────────────

// Maps each detector's trigger condition to the flow_type values
// causally responsible for the alert firing. Used for both
// movement filtering and audit logging in cohort_context.
const RELEVANT_FLOW_TYPES_BY_ALERT: Partial<Record<AlertType, FlowType[]>> = {
  exchange_spike:    ['exchange_deposit', 'exchange_withdrawal'],
  accumulation_wave: ['exchange_withdrawal'],
  distribution_wave: ['exchange_deposit'],
  staking_shift:     ['stake', 'unstake'],
  flow_reversal:     ['exchange_deposit', 'exchange_withdrawal'],
};

// ── Types ─────────────────────────────────────────────────────

export interface CohortContext {
  /**
   * Explicit marker — only cluster-member wallet addresses are counted.
   * Exchange/protocol counterparties are never members of behavior_v1
   * clusters and therefore never appear in clusterMemberMap.
   */
  cluster_member_only:          true;
  /** Flow types included in this attribution — present for audit/debug. */
  relevant_flow_types:          string[];
  /** Unique cluster-member wallet count per cluster_type. */
  per_cluster:                  Record<string, number>;
  dominant_cluster_type:        string | null;
  /** Human-readable label for dominant_cluster_type (no remapping needed). */
  dominant_cluster_label:       string | null;
  dominant_unique_wallets:      number;
  /** Unique wallet addresses across all clusters (a wallet in N clusters counts once). */
  total_unique_cluster_wallets: number;
}

// ── buildCohortContext ────────────────────────────────────────

/**
 * Pure function. Returns CohortContext or null.
 *
 * Null is returned when:
 *   - clusterMemberMap is absent or empty
 *   - alert type has no defined relevant flow types
 *   - no cluster-member addresses appear in the relevant movements
 */
export function buildCohortContext(
  movements:        MovementRow[],
  clusterMemberMap: Map<string, string>,  // address → cluster_type (behavior_v1 members only)
  alertType:        AlertType,
): CohortContext | null {
  if (!clusterMemberMap || clusterMemberMap.size === 0) return null;

  const relevantTypes = RELEVANT_FLOW_TYPES_BY_ALERT[alertType];
  if (!relevantTypes || relevantTypes.length === 0) return null;

  const relevantSet = new Set(relevantTypes);

  // Per-cluster sets of unique wallet addresses.
  // Using Set<string> ensures no double-counting within this evaluation,
  // even when the same wallet appears in multiple movements.
  const uniqueByCluster = new Map<string, Set<string>>();

  for (const mov of movements) {
    if (!relevantSet.has(mov.flow_type)) continue;

    // Check both sides of the movement. Exchange/protocol addresses will never
    // be present in clusterMemberMap, so the cluster lookup serves as the filter.
    for (const addr of [mov.from_address, mov.to_address]) {
      const clusterType = clusterMemberMap.get(addr);
      if (!clusterType) continue;

      let s = uniqueByCluster.get(clusterType);
      if (!s) { s = new Set<string>(); uniqueByCluster.set(clusterType, s); }
      s.add(addr);
    }
  }

  if (uniqueByCluster.size === 0) return null;

  const perCluster: Record<string, number> = {};
  let dominantType:  string | null = null;
  let dominantCount  = 0;

  // Global set for total_unique_cluster_wallets —
  // a wallet in N clusters must be counted exactly once in the total.
  const globalUnique = new Set<string>();

  for (const [ct, addrs] of uniqueByCluster) {
    perCluster[ct] = addrs.size;
    for (const a of addrs) globalUnique.add(a);
    if (addrs.size > dominantCount) {
      dominantCount = addrs.size;
      dominantType  = ct;
    }
  }

  return {
    cluster_member_only:          true,
    relevant_flow_types:          relevantTypes,
    per_cluster:                  perCluster,
    dominant_cluster_type:        dominantType,
    dominant_cluster_label:       dominantType
      ? (CLUSTER_LABELS[dominantType] ?? dominantType)
      : null,
    dominant_unique_wallets:      dominantCount,
    total_unique_cluster_wallets: globalUnique.size,
  };
}
