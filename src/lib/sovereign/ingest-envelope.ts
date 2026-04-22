// ============================================================
// SONAR — Sovereign Ingest Envelope
// ============================================================
// Canonical source-agnostic ingest contract for sovereign input.
// This is the seam that lets replay batches, webhooks, and future
// streaming providers (Yellowstone / Geyser / Jito) feed the same
// downstream normalization pipeline without source-coupling.
// ============================================================

import type { RawTxPayload } from '@/lib/decoder';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';

export type SovereignSourceKind =
  | 'helius_webhook'
  | 'raw_transactions_replay'
  | 'sovereign_rpc_batch'
  | 'sovereign_stream'
  | 'unknown';

export interface SovereignIngestEnvelope {
  source_kind: SovereignSourceKind;
  signature:   string;
  received_at: string;
  source:      string;
  raw:         RawTxPayload | RawTxRow['raw_json'];
  raw_row:     RawTxRow | null;
}

export function envelopeFromRawTxRow(
  row: RawTxRow,
  sourceKind: SovereignSourceKind = 'raw_transactions_replay',
): SovereignIngestEnvelope {
  return {
    source_kind: sourceKind,
    signature:   row.signature,
    received_at: new Date().toISOString(),
    source:      row.source,
    raw:         row.raw_json,
    raw_row:     row,
  };
}

export function envelopeFromHeliusPayload(
  tx: RawTxPayload,
): SovereignIngestEnvelope {
  return {
    source_kind: 'helius_webhook',
    signature:   (tx as any)?.signature ?? '',
    received_at: new Date().toISOString(),
    source:      'helius_webhook',
    raw:         tx,
    raw_row:     null,
  };
}
