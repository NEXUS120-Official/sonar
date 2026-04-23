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
  | 'geyser_stream'
  | 'jito_stream'
  | 'sovereign_stream'
  | 'unknown';

export type SovereignStreamProvider =
  | 'geyser'
  | 'yellowstone'
  | 'jito'
  | 'unknown';

export interface SovereignStreamCursor {
  slot?: number | null;
  index?: number | null;
  provider_offset?: string | null;
}

export interface SovereignIngestEnvelope {
  source_kind: SovereignSourceKind;
  signature:   string;
  received_at: string;
  source:      string;
  raw:         RawTxPayload | RawTxRow['raw_json'];
  raw_row:     RawTxRow | null;

  // ── Streaming-ready metadata (Block 39) ────────────────────
  provider:    SovereignStreamProvider;
  slot:        number | null;
  cursor:      SovereignStreamCursor | null;
  replayable:  boolean;
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
    provider:    'unknown',
    slot:        null,
    cursor:      null,
    replayable:  true,
  };
}

export function envelopeFromHeliusPayload(
  tx: RawTxPayload,
): SovereignIngestEnvelope {
  return {
    source_kind: 'helius_webhook',
    signature:   (tx as { signature?: string })?.signature ?? '',
    received_at: new Date().toISOString(),
    source:      'helius_webhook',
    raw:         tx,
    raw_row:     null,
    provider:    'unknown',
    slot:        null,
    cursor:      null,
    replayable:  true,
  };
}

export function envelopeFromStreamPayload(args: {
  signature:   string;
  raw:         RawTxPayload | RawTxRow['raw_json'];
  provider?:   SovereignStreamProvider;
  source_kind?: SovereignSourceKind;
  source?:     string;
  received_at?: string;
  slot?:       number | null;
  cursor?:     SovereignStreamCursor | null;
}): SovereignIngestEnvelope {
  return {
    source_kind: args.source_kind ?? 'sovereign_stream',
    signature:   args.signature,
    received_at: args.received_at ?? new Date().toISOString(),
    source:      args.source ?? 'sovereign_stream',
    raw:         args.raw,
    raw_row:     null,
    provider:    args.provider ?? 'unknown',
    slot:        args.slot ?? null,
    cursor:      args.cursor ?? null,
    replayable:  false,
  };
}
