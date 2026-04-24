// ============================================================
// SONAR — SovereignFlowJoiner v1
// ============================================================
// Canonical intelligence joiner.
// Pure / near-pure enrichment layer that composes existing
// sovereign context into one auditable intelligence object.
// ============================================================

import { scoreExchangeLineage } from '@/lib/sovereign/sovereign-exchange-lineage-doctrine';

export interface SovereignJoinableMovement {
  signature: string;
  flow_type?: string | null;
  token_mint?: string | null;
  token_symbol?: string | null;
  token_program_type?: string | null;
  amount_usd?: number | null;
  source_exchange?: string | null;
  privacy_signal?: boolean;
  token_risk_flags?: string[] | null;
}

export interface SovereignFlowJoinContext {
  valuation?: {
    valuation_status: string;
    effective_confidence: string;
    value_usd: number | null;
  };
  exchange_lineage?: {
    confidence_score: number;
    evidence_count: number;
    source_exchange: string | null;
  };
  cluster?: {
    cluster_id: string | null;
    cluster_confidence: number | null;
  };
}

export interface SovereignJoinedMovement {
  signature: string;
  asset_key: string | null;
  flow_type: string | null;

  token_context: {
    token_mint: string | null;
    token_symbol: string | null;
    token_program_type: string | null;
    token_risk_flags: string[];
  };

  valuation_context: {
    valuation_status: string;
    effective_confidence: string;
    value_usd: number | null;
  };

  privacy_context: {
    privacy_signal: boolean;
  };

  exchange_lineage_context: {
    source_exchange: string | null;
    lineage_confidence: number;
    lineage_band: string;
    lineage_reason: string;
  };

  cluster_context: {
    cluster_id: string | null;
    cluster_confidence: number | null;
  };

  attribution_confidence: number;
  linkage_reason: string;
  evidence_bundle: string[];
  methodology_version: string;
}

function confidenceToScore(conf: string): number {
  if (conf === 'high') return 85;
  if (conf === 'medium') return 60;
  if (conf === 'low') return 35;
  return 10;
}

export function joinSovereignMovement(
  movement: SovereignJoinableMovement,
  ctx: SovereignFlowJoinContext,
): SovereignJoinedMovement {
  const asset_key = movement.token_symbol ?? movement.token_mint ?? null;

  const valuation = ctx.valuation ?? {
    valuation_status: 'unknown',
    effective_confidence: 'unknown',
    value_usd: movement.amount_usd ?? null,
  };

  const lineage = scoreExchangeLineage({
    source_exchange: ctx.exchange_lineage?.source_exchange ?? movement.source_exchange ?? null,
    confidence_score: ctx.exchange_lineage?.confidence_score ?? confidenceToScore(valuation.effective_confidence),
    evidence_count: ctx.exchange_lineage?.evidence_count ?? 1,
    valuation_status: valuation.valuation_status,
    privacy_signal_seen: movement.privacy_signal ?? false,
    downstream_evidence_count: ctx.exchange_lineage?.evidence_count ?? 1,
    hop_count: (ctx.exchange_lineage?.source_exchange ?? movement.source_exchange) ? 1 : null,
  });

  const evidence_bundle: string[] = [];
  if (movement.token_symbol) evidence_bundle.push('token_symbol_present');
  if (movement.token_program_type) evidence_bundle.push('token_program_context_present');
  if (valuation.valuation_status !== 'unknown') evidence_bundle.push('valuation_context_present');
  if (movement.privacy_signal) evidence_bundle.push('privacy_signal_present');
  if ((ctx.exchange_lineage?.source_exchange ?? movement.source_exchange)) evidence_bundle.push('exchange_origin_present');
  if (ctx.cluster?.cluster_id) evidence_bundle.push('cluster_context_present');
  if ((movement.token_risk_flags ?? []).length > 0) evidence_bundle.push('token_risk_flags_present');

  let attribution_confidence = Math.round(
    (
      lineage.lineage_confidence +
      confidenceToScore(valuation.effective_confidence) +
      ((ctx.cluster?.cluster_confidence ?? 0))
    ) / 3
  );

  if (movement.privacy_signal) attribution_confidence += 5;
  attribution_confidence = Math.max(0, Math.min(100, attribution_confidence));

  const linkage_reason_parts = [
    lineage.lineage_reason,
    valuation.valuation_status !== 'unknown' ? `valuation=${valuation.valuation_status}` : null,
    movement.privacy_signal ? 'privacy-adjacent signal seen' : null,
    ctx.cluster?.cluster_id ? `cluster=${ctx.cluster.cluster_id}` : null,
  ].filter(Boolean) as string[];

  return {
    signature: movement.signature,
    asset_key,
    flow_type: movement.flow_type ?? null,

    token_context: {
      token_mint: movement.token_mint ?? null,
      token_symbol: movement.token_symbol ?? null,
      token_program_type: movement.token_program_type ?? null,
      token_risk_flags: movement.token_risk_flags ?? [],
    },

    valuation_context: {
      valuation_status: valuation.valuation_status,
      effective_confidence: valuation.effective_confidence,
      value_usd: valuation.value_usd,
    },

    privacy_context: {
      privacy_signal: movement.privacy_signal ?? false,
    },

    exchange_lineage_context: {
      source_exchange: ctx.exchange_lineage?.source_exchange ?? movement.source_exchange ?? null,
      lineage_confidence: lineage.lineage_confidence,
      lineage_band: lineage.lineage_band,
      lineage_reason: lineage.lineage_reason,
    },

    cluster_context: {
      cluster_id: ctx.cluster?.cluster_id ?? null,
      cluster_confidence: ctx.cluster?.cluster_confidence ?? null,
    },

    attribution_confidence,
    linkage_reason: linkage_reason_parts.join(' | '),
    evidence_bundle,
    methodology_version: 'sovereign_flow_joiner_v1',
  };
}
