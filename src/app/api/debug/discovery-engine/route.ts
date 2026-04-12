// ============================================================
// SONAR — Discovery Engine Diagnostics (CRON-SECRET GATED)
// GET /api/debug/discovery-engine
// ============================================================
// Calls each discovery source adapter directly and reports
// exactly how many candidates are returned + why any return 0.
// Remove after debugging.

import { type NextRequest, NextResponse } from 'next/server';
import { fetchBirdeyeTopTraders } from '@/lib/discovery/sources/birdeye';
import { createAdminClient } from '@/lib/supabase/server';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth     = req.headers.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return provided === secret;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const results: Record<string, unknown> = {
    env: {
      birdeye_key_set:    !!process.env.BIRDEYE_API_KEY,
      birdeye_key_length: process.env.BIRDEYE_API_KEY?.length ?? 0,
      supabase_url_set:   !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    },
  };

  // Step 1: Call Birdeye adapter
  try {
    const candidates = await fetchBirdeyeTopTraders(5);
    results['birdeye_adapter'] = {
      count:   candidates.length,
      sample:  candidates.slice(0, 2).map((c) => ({
        address:       c.address.slice(0, 8) + '…',
        tradeCount30d: c.tradeCount30d,
        totalVolume30d: c.totalVolume30d,
        source:        c.source,
      })),
    };
  } catch (err) {
    results['birdeye_adapter'] = { error: String(err) };
  }

  // Step 2: Check DB tables
  const db = createAdminClient();

  try {
    const { data, error } = await db.from('discovery_candidates').select('address').limit(1);
    results['discovery_candidates_table'] = {
      accessible: !error,
      error:      error?.message ?? null,
      hasRows:    (data?.length ?? 0) > 0,
    };
  } catch (err) {
    results['discovery_candidates_table'] = { error: String(err) };
  }

  try {
    const { data, error } = await db.from('whales').select('address').limit(3);
    results['whales_table'] = {
      accessible: !error,
      error:      error?.message ?? null,
      count:      data?.length ?? 0,
      sample:     data?.map((w) => w.address.slice(0, 8) + '…') ?? [],
    };
  } catch (err) {
    results['whales_table'] = { error: String(err) };
  }

  return NextResponse.json({ ok: true, ...results });
}
