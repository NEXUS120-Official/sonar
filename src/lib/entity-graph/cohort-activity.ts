// ============================================================
// SONAR — Cohort Activity Reader
// ============================================================
// Aggregates movement data by behavioral cluster membership for
// a given time window. Used by the weekly report, feature builder
// (via process-flows), and any future cohort-aware surface.
//
// Only includes clusters that are:
//   - is_active = true  (not archived)
//   - methodology = 'behavior_v1'  (current methodology)
//
// Two DB reads (cluster members + movements via whale_id FK),
// all aggregation in JS. Returns one entry per active cluster.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import { METHODOLOGY_VERSION }    from './clustering';

type Db = ReturnType<typeof createAdminClient>;

// ── Types ─────────────────────────────────────────────────────

export interface CohortActivityEntry {
  cluster_type:            string;
  cluster_name:            string | null;
  active_wallets:          number;   // unique addresses with ≥1 movement in window
  total_movements:         number;
  exchange_deposit_usd:    number;
  exchange_withdrawal_usd: number;
  net_exchange_flow_usd:   number;   // withdrawal - deposit; positive = accumulation
  stake_usd:               number;
  defi_deposit_usd:        number;
  dominant_action:         string;   // 'accumulating' | 'distributing' | 'staking' | 'defi' | 'mixed'
}

// ── getCohortActivity ─────────────────────────────────────────

/**
 * Returns per-cluster activity aggregates for a time window.
 *
 * Filters to active behavior_v1 clusters only.
 * Returns [] if no clusters exist or no movements matched.
 * Errors are surfaced via rejection — callers should .catch(() => []).
 */
export async function getCohortActivity(
  db:   Db,
  opts: { windowHours?: number } = {},
): Promise<CohortActivityEntry[]> {
  const windowHours = opts.windowHours ?? 168;
  const cutoff      = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // ── 1. Load cluster members with cluster metadata ─────────
  const { data: memberRows, error: memberErr } = await dba
    .from('wallet_cluster_members')
    .select('address, wallet_clusters ( cluster_type, cluster_name, is_active, methodology )');

  if (memberErr) throw new Error(`cluster member load: ${memberErr.message}`);

  type MemberRow = {
    address:         string;
    wallet_clusters: {
      cluster_type: string;
      cluster_name: string | null;
      is_active:    boolean;
      methodology:  string | null;
    } | null;
  };

  // Filter: only active behavior_v1 clusters
  const validMembers = ((memberRows ?? []) as MemberRow[]).filter(
    r => r.wallet_clusters?.is_active === true &&
         r.wallet_clusters?.methodology === METHODOLOGY_VERSION,
  );

  if (validMembers.length === 0) return [];

  // Build address → cluster map
  const addrToCluster = new Map<string, { cluster_type: string; cluster_name: string | null }>();
  for (const m of validMembers) {
    addrToCluster.set(m.address, {
      cluster_type: m.wallet_clusters!.cluster_type,
      cluster_name: m.wallet_clusters!.cluster_name ?? null,
    });
  }

  // ── 2. Resolve cluster addresses to whale IDs ─────────────
  // Movements are indexed by whale_id FK — faster and more reliable
  // than querying by address strings.
  const allAddrs = [...addrToCluster.keys()];
  const { data: whaleRows } = await db
    .from('whales')
    .select('id, address')
    .in('address', allAddrs);

  type WhaleRef = { id: string; address: string };
  const whalePairs = (whaleRows ?? []) as WhaleRef[];
  if (whalePairs.length === 0) return [];

  const whaleIdToAddr = new Map(whalePairs.map(w => [w.id, w.address]));
  const whaleIds      = whalePairs.map(w => w.id);

  // ── 3. Load movements for these whales in the window ──────
  const { data: movRows, error: movErr } = await dba
    .from('movements')
    .select('whale_id, flow_type, amount_usd')
    .in('whale_id', whaleIds)
    .gte('block_time', cutoff)
    .limit(100_000);

  if (movErr) throw new Error(`cohort movements load: ${movErr.message}`);

  // ── 4. Aggregate per cluster ───────────────────────────────
  type ClusterAgg = {
    cluster_name:            string | null;
    active_wallets:          Set<string>;
    total_movements:         number;
    exchange_deposit_usd:    number;
    exchange_withdrawal_usd: number;
    stake_usd:               number;
    defi_deposit_usd:        number;
  };

  const byCluster = new Map<string, ClusterAgg>();

  // Initialise entries for every cluster with members (even if no activity)
  const clustersByType = new Map<string, string | null>(); // type → name
  for (const info of addrToCluster.values()) {
    if (!clustersByType.has(info.cluster_type)) {
      clustersByType.set(info.cluster_type, info.cluster_name);
    }
  }
  for (const [ct, cn] of clustersByType) {
    byCluster.set(ct, {
      cluster_name:            cn,
      active_wallets:          new Set(),
      total_movements:         0,
      exchange_deposit_usd:    0,
      exchange_withdrawal_usd: 0,
      stake_usd:               0,
      defi_deposit_usd:        0,
    });
  }

  for (const mov of (movRows ?? []) as Array<{
    whale_id: string; flow_type: string; amount_usd: number | null;
  }>) {
    const addr       = whaleIdToAddr.get(mov.whale_id);
    if (!addr) continue;
    const clusterInfo = addrToCluster.get(addr);
    if (!clusterInfo) continue;

    const agg = byCluster.get(clusterInfo.cluster_type);
    if (!agg) continue;

    const usd = mov.amount_usd ?? 0;
    agg.active_wallets.add(addr);
    agg.total_movements++;

    switch (mov.flow_type) {
      case 'exchange_deposit':    agg.exchange_deposit_usd    += usd; break;
      case 'exchange_withdrawal': agg.exchange_withdrawal_usd += usd; break;
      case 'stake':               agg.stake_usd               += usd; break;
      case 'defi_deposit':        agg.defi_deposit_usd        += usd; break;
    }
  }

  // ── 5. Build output entries ────────────────────────────────
  return [...byCluster.entries()]
    .map(([cluster_type, agg]) => {
      const net_exchange_flow_usd = Math.round(agg.exchange_withdrawal_usd - agg.exchange_deposit_usd);
      return {
        cluster_type,
        cluster_name:            agg.cluster_name,
        active_wallets:          agg.active_wallets.size,
        total_movements:         agg.total_movements,
        exchange_deposit_usd:    Math.round(agg.exchange_deposit_usd),
        exchange_withdrawal_usd: Math.round(agg.exchange_withdrawal_usd),
        net_exchange_flow_usd,
        stake_usd:               Math.round(agg.stake_usd),
        defi_deposit_usd:        Math.round(agg.defi_deposit_usd),
        dominant_action:         dominantAction(
          net_exchange_flow_usd,
          agg.stake_usd,
          agg.defi_deposit_usd,
        ),
      } satisfies CohortActivityEntry;
    })
    .filter(e => e.active_wallets > 0)  // omit clusters with no activity in window
    .sort((a, b) => b.active_wallets - a.active_wallets);
}

// ── Helpers ───────────────────────────────────────────────────

function dominantAction(
  netExchangeFlow: number,
  stakeUsd:        number,
  defiDepositUsd:  number,
): string {
  const candidates: Array<[string, number]> = [
    ['accumulating', netExchangeFlow > 0 ? netExchangeFlow  : 0],
    ['distributing', netExchangeFlow < 0 ? -netExchangeFlow : 0],
    ['staking',      stakeUsd],
    ['defi',         defiDepositUsd],
  ];
  const best = candidates.reduce((a, b) => (b[1] > a[1] ? b : a), ['mixed', 0]);
  return best[1] > 0 ? best[0] : 'mixed';
}
