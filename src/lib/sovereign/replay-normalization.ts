import type { MovementRow } from '@/lib/supabase/types';
import type { NormalizationContext, NormalizedOutput } from '@/lib/normalizer';
import type { SovereignIngestEnvelope } from './ingest-envelope';
import { normalizeProviderEnvelopes } from './provider-normalization';

function movementRowToNormalizedOutput(row: MovementRow): NormalizedOutput {
  return {
    signature: row.signature,
    movement: {
      signature:      row.signature,
      from_address:   row.from_address,
      to_address:     row.to_address,
      from_label:     row.from_label,
      to_label:       row.to_label,
      whale_id:       row.whale_id,
      token:          row.token,
      amount_token:   row.amount_token,
      amount_usd:     row.amount_usd,
      flow_type:      row.flow_type,
      flow_direction: row.flow_direction,
      exchange:       row.exchange,
      protocol:       row.protocol,
      block_time:     row.block_time,
    },
    tokenMovement:      null,
    whaleAddressHint:   null,
    skipped:            false,
    tokenDeltaAnalysis: null,
  };
}

export interface ReplayNormalizationResult {
  normalized:        NormalizedOutput[];
  received:          number;
  classified:       number;
  token_classified: number;
  skipped:          number;
  used_provider_path: number;
  used_fallback_path: number;
}

export function normalizeReplayRowsWithFallback(
  rows: ReadonlyArray<MovementRow>,
  envelopes: ReadonlyArray<SovereignIngestEnvelope>,
  ctx: NormalizationContext,
): ReplayNormalizationResult {
  const provider = normalizeProviderEnvelopes(envelopes, ctx);

  const providerBySig = new Map(
    provider.normalized.map(out => [out.signature, out] as const),
  );

  const normalized: NormalizedOutput[] = [];
  let fallbackCount = 0;

  for (const row of rows) {
    const hit = providerBySig.get(row.signature);
    if (hit) {
      normalized.push(hit);
    } else {
      normalized.push(movementRowToNormalizedOutput(row));
      fallbackCount += 1;
    }
  }

  return {
    normalized,
    received: rows.length,
    classified: normalized.filter(x => x.movement !== null).length,
    token_classified: normalized.filter(x => x.tokenMovement !== null).length,
    skipped: normalized.filter(x => x.skipped).length,
    used_provider_path: rows.length - fallbackCount,
    used_fallback_path: fallbackCount,
  };
}
