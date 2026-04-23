// ============================================================
// SONAR — Sovereign History Runtime
// ============================================================
// Source-agnostic replay/backfill runtime.
// Converts raw_transactions rows into provider-agnostic envelopes,
// normalizes them, and returns receipts suitable for backfill paths.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';
import type { NormalizedOutput, NormalizationContext } from '@/lib/normalizer';
import {
  rawRowsToReplayEnvelopes,
  normalizeReplayEnvelopes,
} from './provider-webhook-runtime';

type Db = ReturnType<typeof createAdminClient>;

export interface SovereignHistoryFetchOptions {
  since?: string | null;
  limit?: number;
  source_prefix?: string | null;
}

export interface SovereignHistoryBatchReceipt {
  raw_rows: RawTxRow[];
  normalized: NormalizedOutput[];
  used_provider_path: number;
  used_fallback_path: number;
}

export async function fetchRawTransactionsForReplay(
  db: Db,
  options: SovereignHistoryFetchOptions = {},
): Promise<RawTxRow[]> {
  const since = options.since ?? null;
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const sourcePrefix = options.source_prefix ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (db as any)
    .from('raw_transactions')
    .select('*')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (since) {
    q = q.gte('created_at', since);
  }

  if (sourcePrefix) {
    q = q.ilike('source', `${sourcePrefix}%`);
  }

  const { data, error } = await q;
  if (error) throw error;

  return (data ?? []) as RawTxRow[];
}

export function normalizeReplayBatchFromRawRows(
  rows: RawTxRow[],
  ctx: NormalizationContext,
): SovereignHistoryBatchReceipt {
  const envelopes = rawRowsToReplayEnvelopes(rows);
  const replay = normalizeReplayEnvelopes(envelopes, ctx);

  return {
    raw_rows: rows,
    normalized: replay.normalized,
    used_provider_path: replay.normalized.length,
    used_fallback_path: 0,
  };
}
