// ============================================================
// SONAR — Enrich Sovereign Mints Cron
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  loadPendingMintQueue,
  loadRawMintSnapshot,
  inspectRawMintSnapshot,
  upsertMintInspection,
  markMintQueueStatus,
} from '@/lib/sovereign/sovereign-mint-enricher';

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
  const queue = await loadPendingMintQueue(db, 100);

  let scanned = 0;
  let enriched = 0;
  let missing_snapshot = 0;
  let failed = 0;

  for (const mint of queue) {
    scanned += 1;

    try {
      const raw = await loadRawMintSnapshot(db, mint);

      if (!raw) {
        missing_snapshot += 1;
        continue;
      }

      const inspection = inspectRawMintSnapshot(mint, raw);
      await upsertMintInspection(db, inspection);
      await markMintQueueStatus(db, mint, 'done', null);
      enriched += 1;
    } catch (err) {
      failed += 1;
      await markMintQueueStatus(
        db,
        mint,
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return NextResponse.json({
    ok: true,
    scanned,
    enriched,
    missing_snapshot,
    failed,
    source_mode: 'sovereign_mint_scanner_v1',
  });
}

export const GET = POST;
