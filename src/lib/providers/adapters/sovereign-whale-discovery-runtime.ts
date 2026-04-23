// ============================================================
// SONAR — Sovereign Whale Discovery Runtime
// ============================================================
// Provider-agnostic whale candidate discovery.
// Uses persisted movements + known exchange lineage + optional
// sovereign account-state snapshots.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

export interface SovereignWhaleCandidate {
  address: string;
  discovery_method: 'exchange_withdrawal_sovereign' | 'account_state_sovereign';
  source_exchange: string | null;
  triggering_signature: string | null;
  first_seen_at: string;
  evidence_count: number;
  estimated_balance_usd: number | null;
  confidence_score: number;
  linkage_reason: string;
  methodology_version: string;
}

function safeNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function discoverWhaleCandidatesFromExchangeWithdrawals(
  db: Db,
  minMovementUsd: number = 100_000,
): Promise<SovereignWhaleCandidate[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('movements')
    .select('signature, from_address, to_address, amount_usd, exchange, block_time, flow_type')
    .eq('flow_type', 'exchange_withdrawal')
    .gte('amount_usd', minMovementUsd)
    .order('block_time', { ascending: false })
    .limit(500);

  if (error) throw error;

  const byAddress = new Map<string, SovereignWhaleCandidate>();

  for (const row of (data ?? []) as Array<{
    signature: string;
    from_address: string;
    to_address: string;
    amount_usd: number | null;
    exchange: string | null;
    block_time: string;
    flow_type: string;
  }>) {
    const addr = row.to_address;
    if (!addr) continue;

    const prev = byAddress.get(addr);
    const usd = row.amount_usd ?? 0;

    if (prev) {
      prev.evidence_count += 1;
      prev.estimated_balance_usd = Math.max(prev.estimated_balance_usd ?? 0, usd);
      prev.confidence_score = Math.min(95, prev.confidence_score + 5);
    } else {
      byAddress.set(addr, {
        address: addr,
        discovery_method: 'exchange_withdrawal_sovereign',
        source_exchange: row.exchange,
        triggering_signature: row.signature,
        first_seen_at: row.block_time,
        evidence_count: 1,
        estimated_balance_usd: usd,
        confidence_score: usd >= 500_000 ? 80 : usd >= 250_000 ? 72 : 65,
        linkage_reason: 'large exchange withdrawal into candidate wallet',
        methodology_version: 'sovereign_whale_discovery_v1',
      });
    }
  }

  return [...byAddress.values()]
    .sort((a, b) =>
      (b.confidence_score - a.confidence_score) ||
      ((b.estimated_balance_usd ?? 0) - (a.estimated_balance_usd ?? 0))
    );
}

export async function discoverWhaleCandidatesFromAccountState(
  db: Db,
  minEstimatedUsd: number = 500_000,
): Promise<SovereignWhaleCandidate[]> {
  // Reads archived sovereign account-state rows from raw_transactions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_account_state')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) throw error;

  const latestByAddress = new Map<string, SovereignWhaleCandidate>();

  for (const row of (data ?? []) as Array<{ raw_json: Record<string, unknown> | null; created_at: string }>) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;

    const address = typeof raw['address'] === 'string' ? raw['address'] : null;
    if (!address) continue;
    if (latestByAddress.has(address)) continue;

    const totalValueUsd = safeNum(raw['total_value_usd']);
    const totalValueUsdSafe = totalValueUsd ?? 0;
    const nativeSol = safeNum(raw['native_sol_balance']) ?? 0;

    if (totalValueUsdSafe < minEstimatedUsd) continue;

    latestByAddress.set(address, {
      address,
      discovery_method: 'account_state_sovereign',
      source_exchange: null,
      triggering_signature: null,
      first_seen_at: row.created_at,
      evidence_count: 1,
      estimated_balance_usd: totalValueUsd,
      confidence_score: totalValueUsdSafe >= 1_000_000 ? 88 : 78,
      linkage_reason: nativeSol > 0
        ? 'archived sovereign account state exceeds whale threshold'
        : 'archived sovereign account state indicates large multi-asset wallet',
      methodology_version: 'sovereign_whale_discovery_v1',
    });
  }

  return [...latestByAddress.values()]
    .sort((a, b) =>
      ((b.estimated_balance_usd ?? 0) - (a.estimated_balance_usd ?? 0)) ||
      (b.confidence_score - a.confidence_score)
    );
}

export async function mergeSovereignWhaleCandidates(
  db: Db,
): Promise<SovereignWhaleCandidate[]> {
  const [exchangeCandidates, accountCandidates] = await Promise.all([
    discoverWhaleCandidatesFromExchangeWithdrawals(db),
    discoverWhaleCandidatesFromAccountState(db),
  ]);

  const merged = new Map<string, SovereignWhaleCandidate>();

  for (const c of [...exchangeCandidates, ...accountCandidates]) {
    const prev = merged.get(c.address);
    if (!prev) {
      merged.set(c.address, { ...c });
      continue;
    }

    merged.set(c.address, {
      ...prev,
      discovery_method:
        prev.discovery_method === 'exchange_withdrawal_sovereign'
          ? prev.discovery_method
          : c.discovery_method,
      source_exchange: prev.source_exchange ?? c.source_exchange,
      triggering_signature: prev.triggering_signature ?? c.triggering_signature,
      first_seen_at: prev.first_seen_at < c.first_seen_at ? prev.first_seen_at : c.first_seen_at,
      evidence_count: prev.evidence_count + c.evidence_count,
      estimated_balance_usd: Math.max(prev.estimated_balance_usd ?? 0, c.estimated_balance_usd ?? 0),
      confidence_score: Math.min(95, Math.max(prev.confidence_score, c.confidence_score) + 3),
      linkage_reason: prev.linkage_reason === c.linkage_reason
        ? prev.linkage_reason
        : `${prev.linkage_reason}; ${c.linkage_reason}`,
      methodology_version: 'sovereign_whale_discovery_v1',
    });
  }

  return [...merged.values()]
    .sort((a, b) =>
      (b.confidence_score - a.confidence_score) ||
      ((b.estimated_balance_usd ?? 0) - (a.estimated_balance_usd ?? 0))
    );
}
