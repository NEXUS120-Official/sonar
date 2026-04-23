// ============================================================
// SONAR — Sovereign Ingest Pipeline
// ============================================================
// Source-agnostic normalization seam.
// Accepts canonical ingest envelopes and produces NormalizedOutput
// through the existing normalizer, without embedding provider-
// specific logic into downstream code paths.
// ============================================================

import { txToRawRow, type RawTxPayload } from '@/lib/decoder';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';
import {
  normalizeRawTx,
  type NormalizationContext,
  type NormalizedOutput,
} from '@/lib/normalizer';
import type { SovereignIngestEnvelope } from './ingest-envelope';

function toRawTxRow(envelope: SovereignIngestEnvelope): RawTxRow {
  if (envelope.raw_row) return envelope.raw_row;

  return txToRawRow(
    envelope.raw as RawTxPayload,
    envelope.source,
  ) as RawTxRow;
}

export function normalizeIngestEnvelope(
  envelope: SovereignIngestEnvelope,
  ctx: NormalizationContext,
): NormalizedOutput {
  return normalizeRawTx(toRawTxRow(envelope), ctx);
}

export function normalizeIngestEnvelopeBatch(
  envelopes: ReadonlyArray<SovereignIngestEnvelope>,
  ctx: NormalizationContext,
): NormalizedOutput[] {
  return envelopes
    .map((env) => normalizeIngestEnvelope(env, ctx))
    .filter((out) => !out.skipped && (out.movement !== null || out.tokenMovement !== null));
}
