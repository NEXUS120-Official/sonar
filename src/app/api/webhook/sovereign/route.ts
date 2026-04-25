// ============================================================
// SONAR — Sovereign Webhook Route
// ============================================================
// New provider-agnostic ingest endpoint.
// Accepts raw tx rows or sovereign ingest envelopes and archives
// them into raw_transactions for replay-safe downstream handling.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { writeSystemHeartbeatSafe } from '@/lib/ops/system-heartbeats';


interface IncomingRawRow {
  signature?: unknown;
  source?: unknown;
  raw_json?: unknown;
  created_at?: unknown;
}

function verifySecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifySecret(req)) {
    const db = createAdminClient();
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_sovereign',
      status: 'unauthorized',
      source: 'sovereign_stream',
      message: 'Invalid sovereign webhook secret',
    });
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const body = await req.json().catch(() => null);

  await writeSystemHeartbeatSafe(db, {
    component: 'webhook_sovereign',
    status: 'active',
    source: 'sovereign_stream',
    message: 'Sovereign webhook received',
  });

  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.rows)
      ? body.rows
      : [];

  const normalizedRows = (rows as IncomingRawRow[])
    .filter((r) => typeof r.signature === 'string' && !!r.signature)
    .map((r) => ({
      signature: r.signature as string,
      source: typeof r.source === 'string' ? r.source : 'sovereign_stream',
      raw_json: r.raw_json ?? r,
      created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
    }));

  if (normalizedRows.length === 0) {
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_sovereign',
      status: 'degraded',
      source: 'sovereign_stream',
      message: 'No valid rows in sovereign webhook payload',
    });
    return NextResponse.json({
      ok: false,
      accepted: 0,
      error: 'no_valid_rows',
    }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .upsert(normalizedRows as any, { onConflict: 'signature' })
    .select('signature');

  if (error) {
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_sovereign',
      status: 'error',
      source: 'sovereign_stream',
      message: error.message,
      meta: { attempted: normalizedRows.length },
    });
    return NextResponse.json({
      ok: false,
      accepted: 0,
      error: error.message,
    }, { status: 500 });
  }

  await writeSystemHeartbeatSafe(db, {
    component: 'webhook_sovereign',
    status: 'ok',
    source: 'sovereign_stream',
    message: 'Sovereign webhook archived rows',
    meta: {
      accepted: data?.length ?? 0,
      attempted: normalizedRows.length,
      sample_signature: normalizedRows[0]?.signature ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    accepted: data?.length ?? 0,
    source_mode: 'sovereign_stream',
    archived_only: true,
  });
}
