// ============================================================
// SONAR — Sovereign Mint State Webhook
// ============================================================
// Archival-first endpoint for sovereign mint/account state payloads.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

function verifySecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifySecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();
  const body = await req.json().catch(() => null);

  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.rows)
      ? body.rows
      : body ? [body] : [];

  const normalizedRows = (rows as Array<Record<string, unknown>>)
    .filter((r) => typeof r['mint'] === 'string' && !!r['mint'])
    .map((r) => ({
      signature: `mint_state::${String(r['mint'])}::${new Date().toISOString()}`,
      source: 'sovereign_mint_state',
      raw_json: r,
      created_at: new Date().toISOString(),
    }));

  if (normalizedRows.length === 0) {
    return NextResponse.json(
      { ok: false, accepted: 0, error: 'no_valid_rows' },
      { status: 400 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .insert(normalizedRows as any)
    .select('signature');

  if (error) {
    return NextResponse.json(
      { ok: false, accepted: 0, error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    accepted: data?.length ?? 0,
    source_mode: 'sovereign_mint_scanner_v1',
    archived_only: true,
  });
}
