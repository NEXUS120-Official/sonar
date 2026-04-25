import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { writeSystemHeartbeatSafe } from '@/lib/ops/system-heartbeats';

function verifyCronSecret(req: NextRequest): boolean {
  const got = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  return !!expected && got === expected;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    const db = createAdminClient();
    await writeSystemHeartbeatSafe(db, {
      component: 'probe_sovereign_ingest',
      status: 'unauthorized',
      source: 'cron',
      message: 'Invalid cron secret',
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const ts = new Date().toISOString();
  const signature = `probe_${Date.now()}`;

  const row = {
    signature,
    source: 'sovereign_probe',
    raw_json: {
      probe: true,
      inserted_by: 'probe_sovereign_ingest',
      created_at: ts,
      signature,
    },
    created_at: ts,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .upsert(row as any, { onConflict: 'signature' })
    .select('signature, created_at, source')
    .maybeSingle();

  if (error) {
    await writeSystemHeartbeatSafe(db, {
      component: 'probe_sovereign_ingest',
      status: 'error',
      source: 'cron',
      message: error.message,
    });
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await writeSystemHeartbeatSafe(db, {
    component: 'probe_sovereign_ingest',
    status: 'ok',
    source: 'cron',
    message: 'Synthetic sovereign raw row inserted',
    meta: {
      signature,
      source: 'sovereign_probe',
    },
  });

  return NextResponse.json({
    ok: true,
    signature,
    row: data ?? null,
    generated_at: ts,
  });
}
