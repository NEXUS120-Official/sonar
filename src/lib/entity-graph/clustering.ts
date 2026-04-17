// ============================================================
// SONAR — Behavioral Clustering (behavior_v1)
// ============================================================
// Conservative, deterministic first-pass clustering.
// One wallet → one primary cluster. No ML. No fuzzy scoring.
//
// Methodology version: behavior_v1
// Data sources:
//   movements table — last windowDays days, joined via whale_id FK
//   whales table    — balance state (total_value_usd, staked balances)
//
// Cluster types (priority order — first match wins):
//   1. inactive_large_holder — large balance, minimal activity
//   2. staker                — consistent staking behavior
//   3. accumulator           — predominantly withdrawing from exchanges
//   4. distributor           — predominantly depositing to exchanges
//   5. defi_rotator          — active DeFi cycling (both sides)
//   6. exchange_heavy        — high exchange volume, no directional bias
//
// Idempotency:
//   wallet_clusters: SELECT-or-INSERT by (cluster_type, methodology)
//   wallet_cluster_members: DELETE cluster members → re-INSERT fresh set
//   Safe to rerun at any time. Prior assignments are fully replaced.
//
// Per-member supporting metrics gap:
//   wallet_cluster_members has no metadata JSONB column.
//   Only weight NUMERIC(8,4) is available per member — used here
//   as a 0.0–1.0 normalized strength score.
//   To persist full supporting metrics (flow counts, staked_total,
//   total_value_usd per member), a migration adding metadata JSONB
//   to wallet_cluster_members is required. Not done in this block.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

// ── Constants ─────────────────────────────────────────────────

export const METHODOLOGY_VERSION = 'behavior_v1';

const DEFAULT_WINDOW_DAYS = 90;

// Exact rule descriptions stored in wallet_clusters.metadata.
// These are the authoritative human-readable rule specifications.
const CLUSTER_RULES: Record<ClusterType, string> = {
  inactive_large_holder:
    'total_value_usd >= 500_000 AND total_movements_in_window <= 3',
  staker:
    'stake_count >= 3 AND (stake_count >= exchange_total OR staked_total_sol >= 50)',
  accumulator:
    'exchange_withdrawal >= 5 AND exchange_withdrawal >= exchange_deposit * 2',
  distributor:
    'exchange_deposit >= 5 AND exchange_deposit >= exchange_withdrawal * 2',
  defi_rotator:
    'defi_deposit + defi_withdrawal >= 8 AND defi_deposit >= 3 AND defi_withdrawal >= 3',
  exchange_heavy:
    'exchange_deposit + exchange_withdrawal >= 10 (residual: not accumulator/distributor)',
};

const CLUSTER_LABELS: Record<ClusterType, string> = {
  inactive_large_holder: 'Inactive Large Holders',
  staker:                'Stakers',
  accumulator:           'Accumulators',
  distributor:           'Distributors',
  defi_rotator:          'DeFi Rotators',
  exchange_heavy:        'Exchange Heavy',
};

// ── Types ─────────────────────────────────────────────────────

export type ClusterType =
  | 'inactive_large_holder'
  | 'staker'
  | 'accumulator'
  | 'distributor'
  | 'defi_rotator'
  | 'exchange_heavy';

// Priority order — first match wins. Export for use in reports/tests.
export const CLUSTER_PRIORITY: readonly ClusterType[] = [
  'inactive_large_holder',
  'staker',
  'accumulator',
  'distributor',
  'defi_rotator',
  'exchange_heavy',
] as const;

export interface WalletFlowCounts {
  exchange_deposit:    number;
  exchange_withdrawal: number;
  stake:               number;
  unstake:             number;
  defi_deposit:        number;
  defi_withdrawal:     number;
  total:               number;
  total_volume_usd:    number; // sum of amount_usd across all movements in window
}

export interface WalletBalanceState {
  total_value_usd: number | null;
  staked_total:    number; // staked_sol + staked_msol + staked_jitosol (SOL units)
}

export interface ClusterAssignment {
  type:   ClusterType;
  weight: number; // 0.0–1.0 normalized strength score
}

export interface BuildClustersResult {
  wallets_evaluated: number;
  assigned:          number;
  unassigned:        number;
  by_cluster:        Record<ClusterType, number>;
  errors:            string[];
}

// ── Pure assignment function ──────────────────────────────────

/**
 * Assign a wallet to a cluster type based on flow counts + balance state.
 *
 * Pure function — no DB, fully unit-testable.
 * Priority: inactive_large_holder > staker > accumulator >
 *           distributor > defi_rotator > exchange_heavy.
 * Returns null if no rule fires.
 *
 * Weight (0.0–1.0) reflects signal strength within the cluster type:
 *   inactive_large_holder — normalized by $1M
 *   staker                — max of stake_count/20 and staked_total/500
 *   accumulator           — withdrawal / (withdrawal + deposit + 1)
 *   distributor           — deposit / (deposit + withdrawal + 1)
 *   defi_rotator          — defi_total / 20
 *   exchange_heavy        — exchange_total / 30
 */
export function assignClusterType(
  counts:  WalletFlowCounts,
  balance: WalletBalanceState,
): ClusterAssignment | null {
  const {
    exchange_deposit:    dep,
    exchange_withdrawal: wd,
    stake,
    defi_deposit:        dDep,
    defi_withdrawal:     dWd,
    total,
  } = counts;

  const exchangeTotal = dep + wd;
  const defiTotal     = dDep + dWd;
  const { total_value_usd, staked_total } = balance;

  // 1. inactive_large_holder
  if ((total_value_usd ?? 0) >= 500_000 && total <= 3) {
    return {
      type:   'inactive_large_holder',
      weight: clamp((total_value_usd ?? 0) / 1_000_000, 0.1, 1.0),
    };
  }

  // 2. staker — balance confirmation prevents false positives from
  // wallets that staked once and then became exchange-heavy
  if (stake >= 3 && (stake >= exchangeTotal || staked_total >= 50)) {
    return {
      type:   'staker',
      weight: clamp(Math.max(stake / 20, staked_total / 500), 0.1, 1.0),
    };
  }

  // 3. accumulator
  if (wd >= 5 && wd >= dep * 2) {
    return {
      type:   'accumulator',
      weight: clamp(wd / (wd + dep + 1), 0.1, 1.0),
    };
  }

  // 4. distributor
  if (dep >= 5 && dep >= wd * 2) {
    return {
      type:   'distributor',
      weight: clamp(dep / (dep + wd + 1), 0.1, 1.0),
    };
  }

  // 5. defi_rotator — both-sides check ensures rotation, not one-direction flow
  if (defiTotal >= 8 && dDep >= 3 && dWd >= 3) {
    return {
      type:   'defi_rotator',
      weight: clamp(defiTotal / 20, 0.1, 1.0),
    };
  }

  // 6. exchange_heavy
  if (exchangeTotal >= 10) {
    return {
      type:   'exchange_heavy',
      weight: clamp(exchangeTotal / 30, 0.1, 1.0),
    };
  }

  return null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Main: buildBehaviorClusters ───────────────────────────────

/**
 * Build behavior_v1 clusters from existing movement + whale data.
 *
 * Two DB reads (whales + movements), all assignment logic in JS,
 * then upsert writes. No per-wallet DB round trips.
 *
 * Not concurrency-safe: two simultaneous runs will produce
 * interleaved DELETE+INSERT. Schedule as a single-instance cron.
 */
export async function buildBehaviorClusters(
  db:   Db,
  opts: { windowDays?: number } = {},
): Promise<BuildClustersResult> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const cutoff     = new Date(Date.now() - windowDays * 24 * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba        = db as any;
  const errors: string[] = [];

  // ── 1. Load active whales + balance data ──────────────────
  const { data: whaleRows, error: whaleErr } = await db
    .from('whales')
    .select('id, address, total_value_usd, staked_sol, staked_msol, staked_jitosol')
    .eq('is_active', true)
    .limit(2000);

  if (whaleErr || !whaleRows?.length) {
    return {
      wallets_evaluated: 0, assigned: 0, unassigned: 0,
      by_cluster: zeroByClusters(),
      errors: [whaleErr?.message ?? 'no active whales found'],
    };
  }

  type LoadedWhale = {
    id:              string;
    address:         string;
    total_value_usd: number | null;
    staked_sol:      number | null;
    staked_msol:     number | null;
    staked_jitosol:  number | null;
  };

  const whales = whaleRows as LoadedWhale[];

  const whaleIdToAddr = new Map(whales.map(w => [w.id, w.address]));
  const addrToBalance = new Map<string, WalletBalanceState>(
    whales.map(w => [w.address, {
      total_value_usd: w.total_value_usd ?? null,
      staked_total:    (w.staked_sol ?? 0) + (w.staked_msol ?? 0) + (w.staked_jitosol ?? 0),
    }]),
  );

  // ── 2. Load movements for these whales via whale_id FK ────
  // Using whale_id FK (not address) avoids from/to ambiguity —
  // the normalizer already tagged which whale each movement belongs to.
  const whaleIds = whales.map(w => w.id);

  const { data: movRows, error: movErr } = await dba
    .from('movements')
    .select('whale_id, flow_type, amount_usd')
    .in('whale_id', whaleIds)
    .gte('block_time', cutoff)
    .limit(100_000);

  if (movErr) errors.push(`movements query: ${movErr.message}`);

  // ── 3. Aggregate flow counts + volume per whale ───────────
  const flowByAddr = new Map<string, WalletFlowCounts>();

  // Ensure every whale gets an entry (for inactive_large_holder detection)
  for (const w of whales) {
    flowByAddr.set(w.address, {
      exchange_deposit: 0, exchange_withdrawal: 0,
      stake: 0, unstake: 0,
      defi_deposit: 0, defi_withdrawal: 0,
      total: 0, total_volume_usd: 0,
    });
  }

  for (const mov of (movRows ?? []) as Array<{
    whale_id: string; flow_type: string; amount_usd: number | null;
  }>) {
    const addr = whaleIdToAddr.get(mov.whale_id);
    if (!addr) continue;

    const c = flowByAddr.get(addr)!;
    c.total++;
    c.total_volume_usd += mov.amount_usd ?? 0;

    switch (mov.flow_type) {
      case 'exchange_deposit':    c.exchange_deposit++;    break;
      case 'exchange_withdrawal': c.exchange_withdrawal++; break;
      case 'stake':               c.stake++;               break;
      case 'unstake':             c.unstake++;             break;
      case 'defi_deposit':        c.defi_deposit++;        break;
      case 'defi_withdrawal':     c.defi_withdrawal++;     break;
    }
  }

  // ── 4. Assign cluster types ───────────────────────────────
  const assignments = new Map<ClusterType, Array<{ address: string; weight: number; avg_trade_usd: number | null }>>();
  for (const t of CLUSTER_PRIORITY) assignments.set(t, []);

  let assigned   = 0;
  let unassigned = 0;

  for (const [addr, counts] of flowByAddr) {
    const balance = addrToBalance.get(addr) ?? { total_value_usd: null, staked_total: 0 };
    const result  = assignClusterType(counts, balance);

    if (result) {
      const avg_trade_usd = counts.total > 0
        ? Math.round(counts.total_volume_usd / counts.total)
        : null;
      assignments.get(result.type)!.push({
        address:       addr,
        weight:        result.weight,
        avg_trade_usd,
      });
      assigned++;
    } else {
      unassigned++;
    }
  }

  // ── 5–7. Persist clusters + members ───────────────────────
  const byClusters = zeroByClusters();

  for (const clusterType of CLUSTER_PRIORITY) {
    const members = assignments.get(clusterType) ?? [];
    byClusters[clusterType] = members.length;
    if (members.length === 0) continue;

    try {
      // 5a. Get or create wallet_clusters row
      const { data: existing } = await dba
        .from('wallet_clusters')
        .select('id')
        .eq('cluster_type', clusterType)
        .eq('methodology', METHODOLOGY_VERSION)
        .maybeSingle();

      let clusterId: string;

      if (existing?.id) {
        clusterId = existing.id as string;
      } else {
        const { data: inserted, error: insertErr } = await dba
          .from('wallet_clusters')
          .insert({
            cluster_type: clusterType,
            cluster_name: CLUSTER_LABELS[clusterType],
            methodology:  METHODOLOGY_VERSION,
            is_active:    true,
            metadata: buildClusterMetadata(clusterType, windowDays),
          })
          .select('id')
          .single();

        if (insertErr || !inserted?.id) {
          errors.push(`create cluster ${clusterType}: ${insertErr?.message ?? 'no id'}`);
          continue;
        }
        clusterId = inserted.id as string;
      }

      // 5b. Delete stale members (full replacement — stale assignments must not persist)
      await dba.from('wallet_cluster_members').delete().eq('cluster_id', clusterId);

      // 5c. Insert fresh members in batches
      const BATCH = 500;
      const memberRows = members.map(m => ({
        cluster_id: clusterId,
        address:    m.address,
        weight:     round4(m.weight),
      }));

      for (let i = 0; i < memberRows.length; i += BATCH) {
        const { error: memberErr } = await dba
          .from('wallet_cluster_members')
          .insert(memberRows.slice(i, i + BATCH));
        if (memberErr) {
          errors.push(`member insert ${clusterType} batch ${i}: ${memberErr.message}`);
        }
      }

      // 5d. Update cluster-level stats
      const clusterAvgUsd = computeClusterAvgTradeUsd(members);
      await dba.from('wallet_clusters').update({
        member_count:  members.length,
        last_computed: new Date().toISOString(),
        avg_trade_usd: clusterAvgUsd,
        metadata:      buildClusterMetadata(clusterType, windowDays),
      }).eq('id', clusterId);

    } catch (err) {
      errors.push(`cluster ${clusterType}: ${String(err)}`);
    }
  }

  return {
    wallets_evaluated: flowByAddr.size,
    assigned,
    unassigned,
    by_cluster: byClusters,
    errors:     errors.slice(0, 30),
  };
}

// ── Helpers ───────────────────────────────────────────────────

function zeroByClusters(): Record<ClusterType, number> {
  return {
    inactive_large_holder: 0,
    staker:                0,
    accumulator:           0,
    distributor:           0,
    defi_rotator:          0,
    exchange_heavy:        0,
  };
}

function buildClusterMetadata(type: ClusterType, windowDays: number) {
  return {
    methodology_version: METHODOLOGY_VERSION,
    window_days:         windowDays,
    priority_rank:       CLUSTER_PRIORITY.indexOf(type) + 1,
    rule:                CLUSTER_RULES[type],
    last_run_at:         new Date().toISOString(),
  };
}

function computeClusterAvgTradeUsd(
  members: Array<{ avg_trade_usd: number | null }>,
): number | null {
  const valid = members.map(m => m.avg_trade_usd).filter((v): v is number => v !== null && v > 0);
  if (valid.length === 0) return null;
  return Math.round(valid.reduce((s, v) => s + v, 0) / valid.length);
}

function round4(v: number): number {
  return Math.round(v * 10_000) / 10_000;
}
