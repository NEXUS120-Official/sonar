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
import {
  getRecentPrivacyLifecycleEventStageStats,
  getPrivacyLifecycleEventTokenLeaderboard,
  getPrivacyLifecycleEventExchangeStats,
  getPrivacyLifecycleEventFamilyLeaderboard,
  getRecentPrivacyLifecycleSequenceStats,
} from '@/lib/sovereign/token-analytics';

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
    const [
      event_stage_stats,
      event_token_leaderboard,
      event_exchange_stats,
      event_family_leaderboard,
      sequence_stats,
    ] = await Promise.all([
      getRecentPrivacyLifecycleEventStageStats(db, hours),
      getPrivacyLifecycleEventTokenLeaderboard(db, hours, limit),
      getPrivacyLifecycleEventExchangeStats(db, hours),
      getPrivacyLifecycleEventFamilyLeaderboard(db, hours, limit),
      getRecentPrivacyLifecycleSequenceStats(db, hours),
    ]);

    return NextResponse.json({
      ok: true,
      hours,
      limit,
      event_stage_stats,
      event_token_leaderboard,
      event_exchange_stats,
      event_family_leaderboard,
      sequence_stats,
      generated_at: new Date().toISOString(),
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
