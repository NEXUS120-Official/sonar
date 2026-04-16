// ============================================================
// SONAR — Normalizer Service
// ============================================================
// Sits between the raw data plane (raw_transactions) and the
// product tables (movements, token_movements).
//
// Responsibility:
//   Given a raw_transactions row, produce zero or more
//   normalized movement records ready for product-layer upsert.
//
// Today the normalization is a thin pass-through:
//   raw_json → decodeMovement / decodeTokenMovement → typed rows
//
// Future: when sovereign RPC data arrives in a different raw
// shape, normalization logic lives here, not in callers.
//
// Usage:
//   const { movements, tokenMovements } = normalizeRawTx(row, ctx);
//   // upsert movements + tokenMovements into product tables
// ============================================================

import {
  decodeMovement,
  decodeTokenMovement,
  canDecode,
  type RawTxPayload,
} from '@/lib/decoder';
import type { MovementRow, TokenMovementRow } from '@/lib/supabase/types';
// RawTxRow lives in the ingest layer — that is where raw_transactions is defined.
export type { RawTxRow } from '@/lib/ingest/ingest-rpc';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';

// ── Types ─────────────────────────────────────────────────────

export interface NormalizationContext {
  whaleAddressSet: Set<string>;
  solPriceUsd:     number;
}

export interface NormalizedOutput {
  signature:     string;
  movement:      Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> | null;
  tokenMovement: Omit<TokenMovementRow, 'id' | 'created_at'> | null;
  skipped:       boolean;   // true if source is not decodable or payload malformed
}

// ── Normalize a single raw_transactions row ───────────────────

export function normalizeRawTx(
  row: RawTxRow,
  ctx: NormalizationContext,
): NormalizedOutput {
  const base: NormalizedOutput = {
    signature:     row.signature,
    movement:      null,
    tokenMovement: null,
    skipped:       false,
  };

  // Skip sources this decoder can't handle yet (e.g., future sovereign RPC)
  if (!canDecode(row.source)) {
    return { ...base, skipped: true };
  }

  const payload = row.raw_json as RawTxPayload;

  // Decode SOL/USDC flow movement
  try {
    const m = decodeMovement(payload, ctx.whaleAddressSet, ctx.solPriceUsd);
    if (m) base.movement = m as Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>;
  } catch { /* malformed payload — skip movement */ }

  // Decode SPL token movement
  try {
    const tm = decodeTokenMovement(payload, ctx.whaleAddressSet, ctx.solPriceUsd);
    if (tm) {
      const { whale_address: _wa, ...rest } = tm;
      void _wa;
      base.tokenMovement = rest as Omit<TokenMovementRow, 'id' | 'created_at'>;
    }
  } catch { /* malformed payload — skip token movement */ }

  return base;
}

/**
 * Normalize a batch of raw_transactions rows.
 * Returns only rows where at least one movement was decoded.
 */
export function normalizeRawTxBatch(
  rows: RawTxRow[],
  ctx:  NormalizationContext,
): NormalizedOutput[] {
  return rows
    .map(row => normalizeRawTx(row, ctx))
    .filter(out => !out.skipped && (out.movement !== null || out.tokenMovement !== null));
}
