// ============================================================
// SONAR — Decoder Service
// ============================================================
// Converts raw Helius transaction payloads (as stored in
// raw_transactions) into SONAR-native movement primitives.
//
// Two decoders exist today:
//   decodeMovement     — SOL/USDC flows → MovementRow shape
//   decodeTokenMovement — SPL token swaps/LP → TokenMovementRow shape
//
// Both decoders are stateless and pure: given a raw payload and
// context (whale address set, SOL price), they return a typed
// result or null.
//
// Future: when SovereignSolanaProvider is active, the raw_json
// shape may differ from Helius enhanced transactions.  At that
// point, introduce a second decoder implementation here and
// dispatch based on the `source` field on the raw row.
//
// Usage:
//   import { decodeMovement, decodeTokenMovement } from '@/lib/decoder';
//   const movement = decodeMovement(rawTx.raw_json, whaleSet, solPrice);
// ============================================================

// Re-export the parse functions under decoder-service names.
// Callers should import from '@/lib/decoder', not from the
// helius-specific parse modules directly.

export {
  parseMovement   as decodeMovement,
  type HeliusEnhancedTx as RawTxPayload,
  type HeliusNativeTransfer,
  type HeliusTokenTransfer,
} from '@/lib/helius/parse-movement';

export {
  parseTokenMovement  as decodeTokenMovement,
  type ParsedTokenMovement as DecodedTokenMovement,
} from '@/lib/helius/parse-token-movement';

// ── In-memory RawTxRow construction ──────────────────────────
// Converts a live payload into the RawTxRow shape so the normalizer
// can be called without a DB round-trip.

import type { HeliusEnhancedTx } from '@/lib/helius/parse-movement';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';
export type { RawTxRow } from '@/lib/ingest/ingest-rpc';

export function txToRawRow(
  tx:     HeliusEnhancedTx,
  source: string = 'helius_webhook',
): RawTxRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = tx as any;
  return {
    signature:  tx.signature,
    slot:       raw.slot ?? null,
    block_time: tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null,
    is_vote:    false,
    status:     raw.transactionError ? 'failed' : 'success',
    fee:        tx.fee ?? null,
    raw_json:   tx,
    source,
  };
}

// ── Decoder metadata ──────────────────────────────────────────

export const DECODER_VERSION = 'helius_enhanced_v1';

export { decodeSovereignMovement }      from '@/lib/decoder/sovereign';
export { decodeSovereignTokenMovement } from '@/lib/decoder/sovereign-token';

/**
 * Returns whether this decoder can handle a raw_transactions row
 * based on its source field.
 *
 * Source dispatch in normalizer/index.ts:
 *   source.startsWith('sovereign_rpc') → decodeSovereignMovement()
 *     SOL and USDC flows via balance-delta extraction — OPERATIONAL.
 *     SPL token movements deferred (tokenMovement = null).
 *   source.startsWith('helius')        → decodeMovement() + decodeTokenMovement()
 *     Full Helius enhanced-transaction decode — OPERATIONAL.
 */
export function canDecode(source: string): boolean {
  return (
    source === 'helius_webhook'  ||
    source === 'helius_history'  ||
    source === 'helius_backfill' ||
    // sovereign_rpc sources: dispatch implemented in normalizer/index.ts.
    // decodeSovereignMovement() handles SOL + USDC via balance-delta extraction.
    source === 'sovereign_rpc'         ||  // direct getTransaction fetch
    source === 'sovereign_rpc_history'    // getAddressHistory via historyToRawRow
  );
}
