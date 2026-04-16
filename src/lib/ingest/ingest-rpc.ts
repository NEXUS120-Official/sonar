// ============================================================
// SONAR — Ingest-RPC Service
// ============================================================
// Thin orchestration layer between the provider tier and the
// raw data plane.  Callers fetch historical data via the
// HistoricalProvider interface and this module handles the
// archive write to raw_transactions.
//
// Current provider: Helius (HeliusHistoricalProvider)
// Future provider: SovereignSolanaProvider (Agave RPC)
//
// Usage:
//   const result = await ingestAddressHistory(db, address, opts);
//   // raw_transactions now has the data; caller may pass to decoder
//
// Design rules:
//   - Never throws on partial failure — returns a receipt
//   - Idempotent: upsert on signature with ignoreDuplicates
//   - Never touches movements / token_movements — that is the decoder's job
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getHistoricalProvider } from '@/lib/providers';
import type { AddressHistory } from '@/lib/providers/interfaces';

// ── Types ─────────────────────────────────────────────────────

/**
 * Shape of a raw_transactions row — the immutable append-only log.
 * Defined here (ingest layer) because that is where raw_transactions
 * is written. The normalizer and any other consumer imports from here.
 */
export interface RawTxRow {
  signature:  string;
  slot:       number | null;
  block_time: string | null;
  is_vote:    boolean;
  status:     string | null;
  fee:        number | null;
  raw_json:   unknown;
  source:     string;
}

/**
 * Canonical mapping: AddressHistory → RawTxRow.
 *
 * Single definition used by both the archive write path (inside
 * ingestAddressHistory) and by any downstream caller that needs
 * to convert history items into the normalizer's input shape.
 *
 * source is suffixed with '_history' so the decoder/normalizer can
 * distinguish historical backfill from live webhook events, and so
 * canDecode() accepts these rows correctly.
 */
export function historyToRawRow(item: AddressHistory): RawTxRow {
  return {
    signature:  item.signature,
    slot:       item.slot   ?? null,
    block_time: item.block_time ? item.block_time.toISOString() : null,
    is_vote:    false,
    status:     'success',   // AddressHistory only returns confirmed txns
    fee:        (item.raw as any)?.fee ?? null,
    raw_json:   item.raw,
    source:     `${item.source}_history`,
  };
}

export interface IngestOptions {
  limit?:  number;
  before?: string;
  type?:   string;   // 'SWAP' | 'ADD_LIQUIDITY' | 'WITHDRAW_LIQUIDITY' | undefined (all)
}

export interface IngestReceipt {
  address:       string;
  fetched:       number;
  archived:      number;
  skipped:       number;
  errors:        string[];
  provider:      string;
  duration_ms:   number;
  /** Raw history items — available for downstream decoder/normalizer use. */
  items:         AddressHistory[];
}

// ── Core function ─────────────────────────────────────────────

/**
 * Fetch address history from the historical provider and archive
 * raw payloads into raw_transactions.
 *
 * Returns a receipt; never throws.
 */
export async function ingestAddressHistory(
  db:      SupabaseClient,
  address: string,
  opts:    IngestOptions = {},
): Promise<IngestReceipt> {
  const startMs  = Date.now();
  const errors:  string[] = [];
  let   fetched  = 0;
  let   archived = 0;
  let   skipped  = 0;

  const provider = getHistoricalProvider();

  let history: AddressHistory[] = [];
  try {
    history = await provider.getAddressHistory(address, opts);
    fetched = history.length;
  } catch (err) {
    errors.push(`fetch failed: ${String(err)}`);
    return { address, fetched: 0, archived: 0, skipped: 0, errors, provider: provider.name, duration_ms: Date.now() - startMs, items: [] };
  }

  if (fetched === 0) {
    return { address, fetched: 0, archived: 0, skipped: 0, errors, provider: provider.name, duration_ms: Date.now() - startMs, items: [] };
  }

  // Build raw_transactions rows using the canonical mapping
  const rows = history.filter(h => h.signature).map(historyToRawRow);

  if (rows.length === 0) {
    return { address, fetched, archived: 0, skipped: 0, errors, provider: provider.name, duration_ms: Date.now() - startMs, items: history };
  }

  try {
    const { error } = await (db as any)
      .from('raw_transactions')
      .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true });

    if (error) {
      errors.push(`archive failed: ${error.message}`);
      skipped = rows.length;
    } else {
      archived = rows.length;
    }
  } catch (err) {
    errors.push(`archive threw: ${String(err)}`);
    skipped = rows.length;
  }

  return {
    address,
    fetched,
    archived,
    skipped,
    errors,
    provider: provider.name,
    duration_ms: Date.now() - startMs,
    items: history,
  };
}

/**
 * Batch version: ingest multiple addresses sequentially.
 * Inserts a delay between calls to respect provider rate limits.
 */
export async function ingestAddressBatch(
  db:           SupabaseClient,
  addresses:    string[],
  opts:         IngestOptions = {},
  delayMs = 400,
): Promise<IngestReceipt[]> {
  const receipts: IngestReceipt[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const receipt = await ingestAddressHistory(db, addresses[i], opts);
    receipts.push(receipt);
    if (i < addresses.length - 1 && delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return receipts;
}
