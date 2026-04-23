// ============================================================
// SONAR — Sovereign History Backfill Cron
// ============================================================
// Reads raw_transactions from sovereign / replay-compatible sources,
// runs provider-agnostic replay normalization, and returns a receipt.
// Additive step: no destructive migration of legacy backfill path yet.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  fetchRawTransactionsForReplay,
  normalizeReplayBatchFromRawRows,
} from '@/lib/providers/adapters/sovereign-history-runtime';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const url = new URL(req.url);

  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') ?? '500', 10) || 500, 5000));
  const since = url.searchParams.get('since');
  const source_prefix = url.searchParams.get('source_prefix') ?? 'sovereign';

  const rows = await fetchRawTransactionsForReplay(db, {
    since,
    limit,
    source_prefix,
  });

  const receipt = normalizeReplayBatchFromRawRows(rows, {
    whaleAddressSet: new Set<string>(),
    solPriceUsd: 0,
  });

  return NextResponse.json({
    ok: true,
    scanned_raw_rows: receipt.raw_rows.length,
    normalized_rows: receipt.normalized.length,
    used_provider_path: receipt.used_provider_path,
    used_fallback_path: receipt.used_fallback_path,
    source_prefix,
    since,
    limit,
  });
}

export const GET = POST;
