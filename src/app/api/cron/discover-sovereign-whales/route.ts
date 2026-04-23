// ============================================================
// SONAR — Discover Sovereign Whales Cron
// ============================================================
// Provider-agnostic whale discovery using sovereign runtime.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { mergeSovereignWhaleCandidates } from '@/lib/providers/adapters/sovereign-whale-discovery-runtime';

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
  const candidates = await mergeSovereignWhaleCandidates(db);

  let inserted = 0;
  let skipped = 0;

  for (const c of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('whales')
      .upsert({
        address: c.address,
        is_active: true,
        total_value_usd: c.estimated_balance_usd,
        discovery_method: c.discovery_method,
        discovered_at: c.first_seen_at,
        whale_type: 'unknown',
        label: null,
      }, { onConflict: 'address' });

    if (error) skipped += 1;
    else inserted += 1;
  }

  return NextResponse.json({
    ok: true,
    candidates: candidates.length,
    inserted,
    skipped,
    source_mode: 'sovereign_whale_discovery_v1',
  });
}

export const GET = POST;
