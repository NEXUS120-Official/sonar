import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { writeSystemHeartbeatSafe } from '@/lib/ops/system-heartbeats';
import { replayRawTransactionsIntoMovements } from '@/lib/sovereign/raw-replay-bridge';

function verifyCronSecret(req: NextRequest): boolean {
  const got = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  return !!expected && got === expected;
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    const db = createAdminClient();
    await writeSystemHeartbeatSafe(db, {
      component: 'cron_replay_raw_transactions',
      status: 'unauthorized',
      source: 'cron',
      message: 'Invalid cron secret',
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const limit = parsePositiveInt(req.nextUrl.searchParams.get('limit'), 100);

  await writeSystemHeartbeatSafe(db, {
    component: 'cron_replay_raw_transactions',
    status: 'active',
    source: 'cron',
    message: 'Replay raw transactions run started',
    meta: { limit },
  });

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('raw_transactions')
      .select('signature, slot, block_time, raw_json, source, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const rows = (data ?? []) as Array<{
      signature: string;
      slot: number;
      block_time: string | null;
      raw_json: unknown;
      source: string;
      created_at: string;
    }>;

    const nonProbeRows = rows.filter((row) => row.source !== 'sovereign_probe');

    const receipt = await replayRawTransactionsIntoMovements(
      db,
      nonProbeRows.map((row) => ({
        signature: row.signature,
        slot: row.slot,
        block_time: row.block_time,
        is_vote: false,
        status: 'success',
        fee: null,
        raw_json: row.raw_json,
        source: row.source,
      }))
    );

    await writeSystemHeartbeatSafe(db, {
      component: 'cron_replay_raw_transactions',
      status: 'ok',
      source: 'cron',
      message: 'Replay raw transactions run completed',
      meta: {
        limit,
        fetched_rows: rows.length,
        replay_rows: nonProbeRows.length,
        ...receipt,
      },
    });

    return NextResponse.json({
      ok: true,
      limit,
      fetched_rows: rows.length,
      replay_rows: nonProbeRows.length,
      ...receipt,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    await writeSystemHeartbeatSafe(db, {
      component: 'cron_replay_raw_transactions',
      status: 'error',
      source: 'cron',
      message: err instanceof Error ? err.message : String(err),
      meta: { limit },
    });

    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
