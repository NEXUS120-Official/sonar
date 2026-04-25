// ============================================================
// SONAR — SovereignPersistenceManager v1
// ============================================================
// Buffered / batch-oriented persistence helper for canonical
// joined intelligence objects.
// ============================================================

import { createHash } from 'crypto';
import type { createAdminClient } from '@/lib/supabase/server';
import type { SovereignJoinedMovement } from '@/lib/sovereign/sovereign-flow-joiner';

type Db = ReturnType<typeof createAdminClient>;

export interface PersistableJoinedIntelligenceRecord {
  record_id: string;
  tx_signature: string;
  asset_key: string | null;
  flow_type: string | null;
  token_symbol: string | null;
  token_program_type: string | null;
  valuation_status: string;
  valuation_confidence: string;
  privacy_signal: boolean;
  source_exchange: string | null;
  exchange_lineage_band: string;
  exchange_lineage_confidence: number;
  cluster_id: string | null;
  cluster_confidence: number | null;
  attribution_confidence: number;
  linkage_reason: string;
  evidence_bundle: string[];
  methodology_version: string;
}

export function buildJoinedIntelligenceRecordId(
  joined: SovereignJoinedMovement,
): string {
  return createHash('sha256')
    .update([
      joined.signature,
      joined.asset_key ?? '',
      joined.flow_type ?? '',
      joined.methodology_version,
    ].join('|'))
    .digest('hex');
}

export function toPersistableJoinedIntelligenceRecord(
  joined: SovereignJoinedMovement,
): PersistableJoinedIntelligenceRecord {
  return {
    record_id: buildJoinedIntelligenceRecordId(joined),
    tx_signature: joined.signature,
    asset_key: joined.asset_key,
    flow_type: joined.flow_type,
    token_symbol: joined.token_context.token_symbol,
    token_program_type: joined.token_context.token_program_type,
    valuation_status: joined.valuation_context.valuation_status,
    valuation_confidence: joined.valuation_context.effective_confidence,
    privacy_signal: joined.privacy_context.privacy_signal,
    source_exchange: joined.exchange_lineage_context.source_exchange,
    exchange_lineage_band: joined.exchange_lineage_context.lineage_band,
    exchange_lineage_confidence: joined.exchange_lineage_context.lineage_confidence,
    cluster_id: joined.cluster_context.cluster_id,
    cluster_confidence: joined.cluster_context.cluster_confidence,
    attribution_confidence: joined.attribution_confidence,
    linkage_reason: joined.linkage_reason,
    evidence_bundle: joined.evidence_bundle,
    methodology_version: joined.methodology_version,
  };
}

export async function persistJoinedIntelligenceBatch(
  db: Db,
  joinedRows: ReadonlyArray<SovereignJoinedMovement>,
): Promise<{
  attempted: number;
  persisted: number;
}> {
  if (joinedRows.length === 0) {
    return { attempted: 0, persisted: 0 };
  }

  const records = joinedRows.map(toPersistableJoinedIntelligenceRecord);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('joined_intelligence_records')
    .upsert(records as any, { onConflict: 'record_id' })
    .select('record_id');

  if (error) throw error;

  return {
    attempted: records.length,
    persisted: (data ?? []).length,
  };
}
