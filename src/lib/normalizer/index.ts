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
import { decodeSovereignMovement }      from '@/lib/decoder/sovereign';
import { decodeSovereignTokenMovement } from '@/lib/decoder/sovereign-token';
import type { MovementRow, TokenMovementRow } from '@/lib/supabase/types';
import type { SovereignTokenRegistry }  from '@/lib/sovereign/token-registry';
import { GLOBAL_MINT_ENRICHMENT_QUEUE } from '@/lib/sovereign/mint-enricher';
// RawTxRow lives in the ingest layer — that is where raw_transactions is defined.
export type { RawTxRow } from '@/lib/ingest/ingest-rpc';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';

// ── Types ─────────────────────────────────────────────────────

export interface NormalizationContext {
  whaleAddressSet: Set<string>;
  solPriceUsd:     number;
  /**
   * Immutable registry snapshot injected from the adapter layer.
   * When provided, the sovereign token decoder uses it for symbol,
   * name, decimals, is_new_token, and Token-2022 detection.
   * Omit in tests or when a DB connection is unavailable — the
   * decoder falls back to well-known entries only.
   */
  tokenRegistry?:  SovereignTokenRegistry;
}

export interface NormalizedOutput {
  signature:        string;
  movement:         Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> | null;
  tokenMovement:    Omit<TokenMovementRow, 'id' | 'created_at'> | null;
  /** whale_address from the token movement decoder — not stored in DB, used for whale_id resolution */
  whaleAddressHint: string | null;
  skipped:          boolean;   // true if source is not decodable or payload malformed
}

// ── Normalize a single raw_transactions row ───────────────────

export function normalizeRawTx(
  row: RawTxRow,
  ctx: NormalizationContext,
): NormalizedOutput {
  const base: NormalizedOutput = {
    signature:        row.signature,
    movement:         null,
    tokenMovement:    null,
    whaleAddressHint: null,
    skipped:          false,
  };

  if (!canDecode(row.source)) {
    return { ...base, skipped: true };
  }

  // ── Sovereign RPC path ────────────────────────────────────────
  // Native Solana getTransaction payloads decoded by balance-delta
  // extraction for both SOL/USDC flows and SPL token movements.
  if (row.source.startsWith('sovereign_rpc')) {
    try {
      const m = decodeSovereignMovement(row.raw_json, ctx.whaleAddressSet, ctx.solPriceUsd);
      if (m) base.movement = m as Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>;
    } catch { /* malformed payload — skip movement */ }

    try {
      const tm = decodeSovereignTokenMovement(
        row.raw_json, ctx.whaleAddressSet, ctx.solPriceUsd, ctx.tokenRegistry,
      );
      if (tm) {
        base.whaleAddressHint = tm.whale_address ?? null;
        // Enqueue unknown mints for background sovereign inspection (O(1), non-blocking).
        // The cron /api/cron/enrich-unknown-mints drains the queue asynchronously.
        if (tm.is_new_token && tm.token_mint) {
          GLOBAL_MINT_ENRICHMENT_QUEUE.enqueue(tm.token_mint);
        }
        const { whale_address: _wa, ...rest } = tm;
        void _wa;
        base.tokenMovement = rest as Omit<TokenMovementRow, 'id' | 'created_at'>;
      }
    } catch { /* malformed payload — skip token movement */ }

    return base;
  }

  // ── Helius enhanced-transaction path ─────────────────────────
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
      base.whaleAddressHint = tm.whale_address ?? null;
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
