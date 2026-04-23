// ============================================================
// SONAR — Provider Webhook Runtime
// ============================================================
// Provider-agnostic ingest runtime for webhook-style sources.
// This moves normalization/persistence behavior out of the
// Helius-named adapter and prepares SONAR for sovereign ingest.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { RawTxPayload } from '@/lib/decoder';
import type { NormalizedOutput, NormalizationContext } from '@/lib/normalizer';
import { envelopeFromHeliusPayload, envelopeFromRawTxRow, type SovereignIngestEnvelope } from '@/lib/sovereign/ingest-envelope';
import { normalizeIngestEnvelope } from '@/lib/sovereign/ingest-pipeline';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';

type Db = ReturnType<typeof createAdminClient>;

export interface ProviderRuntimeReceipt {
  normalized: NormalizedOutput[];
  classified: number;
  token_classified: number;
}

export function heliusPayloadsToEnvelopes(
  txns: RawTxPayload[],
): SovereignIngestEnvelope[] {
  return txns.map((tx) => envelopeFromHeliusPayload(tx));
}

export function rawRowsToReplayEnvelopes(
  rows: RawTxRow[],
  sourceKind: 'raw_transactions_replay' | 'sovereign_rpc_batch' | 'sovereign_stream' = 'raw_transactions_replay',
): SovereignIngestEnvelope[] {
  return rows.map((row) => envelopeFromRawTxRow(row, sourceKind));
}

export function normalizeWebhookEnvelopes(
  envelopes: ReadonlyArray<SovereignIngestEnvelope>,
  ctx: NormalizationContext,
): ProviderRuntimeReceipt {
  const normalized: NormalizedOutput[] = envelopes.map((env) => {
    try {
      return normalizeIngestEnvelope(env, ctx);
    } catch {
      return {
        signature:          env.signature ?? '',
        movement:           null,
        tokenMovement:      null,
        whaleAddressHint:   null,
        skipped:            true,
        tokenDeltaAnalysis: null,
      };
    }
  });

  return {
    normalized,
    classified: normalized.filter((out) => out.movement !== null).length,
    token_classified: normalized.filter((out) => out.tokenMovement !== null).length,
  };
}
