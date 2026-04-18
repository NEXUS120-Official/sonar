// ============================================================
// SONAR — Sovereign RPC Transformers
// ============================================================
// Pure functions: Solana RPC response shapes → SONAR provider
// interface types (RawTransactionEvent, AddressHistory, RawTxRow).
//
// All outputs carry source='sovereign_rpc'. The ingest layer's
// historyToRawRow() will append '_history' for AddressHistory
// items, producing 'sovereign_rpc_history' in raw_transactions.
//
// Decoder note:
//   The raw field in RawTransactionEvent / AddressHistory stores
//   the native Solana getTransaction JSON (SolanaTransactionResult).
//   This payload CANNOT be decoded by the Helius-format parsers in
//   src/lib/decoder. Archive is intentional; source-based dispatch
//   (decodeSovereignMovement) must be added before normalization
//   of sovereign_rpc rows is enabled.
// ============================================================

import type { RawTransactionEvent, AddressHistory } from '@/lib/providers/interfaces';
import type { RawTxRow }                            from '@/lib/ingest/ingest-rpc';
import type { SolanaTransactionResult, SolanaSignatureInfo } from './rpc-client';
import { SOVEREIGN_SOURCE }                         from './rpc-client';

// ── solTxToRawTransactionEvent ────────────────────────────────
// Maps a native getTransaction result to the RawTransactionEvent
// interface consumed by HistoricalProvider callers.

export function solTxToRawTransactionEvent(
  tx:        SolanaTransactionResult,
  signature: string,
): RawTransactionEvent {
  return {
    signature,
    slot:       tx.slot,
    block_time: tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(0),
    fee:        tx.meta?.fee ?? 0,
    success:    tx.meta?.err === null,
    raw:        tx,
    source:     SOVEREIGN_SOURCE,
  };
}

// ── solTxToAddressHistory ─────────────────────────────────────
// Builds an AddressHistory entry from a getSignaturesForAddress
// row plus the (optionally fetched) full transaction.
//
// When `tx` is null (fetch failed or not found):
//   raw = sigInfo — signature metadata is still useful for
//   archiving the existence of the transaction.
// When `tx` is available:
//   raw = tx — full native payload for future sovereign decoder.

export function solTxToAddressHistory(
  sigInfo: SolanaSignatureInfo,
  tx:      SolanaTransactionResult | null,
): AddressHistory {
  return {
    signature:  sigInfo.signature,
    block_time: sigInfo.blockTime ? new Date(sigInfo.blockTime * 1000) : new Date(0),
    slot:       sigInfo.slot,
    raw:        tx ?? sigInfo,
    source:     SOVEREIGN_SOURCE,
  };
}

// ── solTxToRawRow ─────────────────────────────────────────────
// Maps a native getTransaction result directly to a RawTxRow for
// callers that want to write raw_transactions without going
// through the AddressHistory → historyToRawRow path.
// source='sovereign_rpc' (no _history suffix — this is a direct
// transaction fetch, not a history-page result).

export function solTxToRawRow(
  tx:        SolanaTransactionResult,
  signature: string,
): RawTxRow {
  return {
    signature,
    slot:       tx.slot,
    block_time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    is_vote:    false,
    status:     tx.meta?.err === null ? 'success' : 'failed',
    fee:        tx.meta?.fee ?? null,
    raw_json:   tx,
    source:     SOVEREIGN_SOURCE,
  };
}
