import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { ingestAddressHistory } from '@/lib/ingest/ingest-rpc';
import { writeSystemHeartbeatSafe } from '@/lib/ops/system-heartbeats';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

function parsePositiveInt(value: string | null, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    const db = createAdminClient();
    await writeSystemHeartbeatSafe(db, {
      component: 'cron_archive_sovereign_history',
      status: 'unauthorized',
      source: 'cron',
      message: 'Invalid cron secret',
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const url = new URL(req.url);

  const whaleLimit = parsePositiveInt(url.searchParams.get('whale_limit'), 3, 1, 20);
  const txLimit = parsePositiveInt(url.searchParams.get('tx_limit'), 25, 1, 100);

  await writeSystemHeartbeatSafe(db, {
    component: 'cron_archive_sovereign_history',
    status: 'active',
    source: 'cron',
    message: 'Sovereign history archive started',
    meta: { whale_limit: whaleLimit, tx_limit: txLimit },
  });

  try {
    const { data: whales, error: whaleErr } = await db
      .from('whales')
      .select('address')
      .eq('is_active', true)
      .limit(whaleLimit);

    if (whaleErr) throw whaleErr;

    const addresses = ((whales ?? []) as Array<{ address: string }>).map((w) => w.address).filter(Boolean);

    const receipts = [];
    for (const address of addresses) {
      const receipt = await ingestAddressHistory(db as any, address, { limit: txLimit });
      receipts.push({
        address,
        fetched: receipt.fetched,
        archived: receipt.archived,
        skipped: receipt.skipped,
        provider: receipt.provider,
        errors: receipt.errors,
      });
    }

    const totalFetched = receipts.reduce((n, r) => n + r.fetched, 0);
    const totalArchived = receipts.reduce((n, r) => n + r.archived, 0);
    const totalSkipped = receipts.reduce((n, r) => n + r.skipped, 0);

    await writeSystemHeartbeatSafe(db, {
      component: 'cron_archive_sovereign_history',
      status: 'ok',
      source: 'cron',
      message: 'Sovereign history archive completed',
      meta: {
        whale_limit: whaleLimit,
        tx_limit: txLimit,
        addresses: addresses.length,
        total_fetched: totalFetched,
        total_archived: totalArchived,
        total_skipped: totalSkipped,
      },
    });

    return NextResponse.json({
      ok: true,
      whale_limit: whaleLimit,
      tx_limit: txLimit,
      addresses,
      receipts,
      total_fetched: totalFetched,
      total_archived: totalArchived,
      total_skipped: totalSkipped,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    await writeSystemHeartbeatSafe(db, {
      component: 'cron_archive_sovereign_history',
      status: 'error',
      source: 'cron',
      message: err instanceof Error ? err.message : String(err),
      meta: { whale_limit: whaleLimit, tx_limit: txLimit },
    });

    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = POST;
