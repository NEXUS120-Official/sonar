// ============================================================
// SONAR — Privacy Lifecycle Intelligence API
// GET /api/intel/privacy-lifecycle
// ============================================================
// Query surface for privacy lifecycle intelligence:
// - event stage stats
// - event token leaderboard
// - event exchange stats
// - event family leaderboard
// - sequence stats
//
// Purpose:
// expose the privacy lifecycle intelligence layer as a reusable,
// replay-safe API surface for dashboards, internal tools, and
// future premium intelligence endpoints.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { buildPrivacyLifecycleOverview } from '@/lib/sovereign/privacy-lifecycle-overview';

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();
  const { searchParams } = new URL(req.url);

  const hours = parsePositiveInt(searchParams.get('hours'), 24 * 7);
  const limit = parsePositiveInt(searchParams.get('limit'), 25);

  try {
    const overview = await buildPrivacyLifecycleOverview(db, hours, limit);

    return NextResponse.json({
      ok: true,
      ...overview,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
