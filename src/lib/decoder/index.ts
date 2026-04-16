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

// ── Decoder metadata ──────────────────────────────────────────

export const DECODER_VERSION = 'helius_enhanced_v1';

/**
 * Returns whether this decoder can handle a raw_transactions row
 * based on its source field.
 */
export function canDecode(source: string): boolean {
  return (
    source === 'helius_webhook' ||
    source === 'helius_history' ||
    source === 'helius_backfill'
  );
}
