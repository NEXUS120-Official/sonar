// ============================================================
// SONAR — Privacy Lifecycle Overview Composer
// ============================================================
// Pure-ish orchestration layer for privacy lifecycle intelligence.
// Centralizes the overview composition used by API/runtime surfaces
// so the route layer stays thin and future reuse stays cheap.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import {
  getRecentPrivacyLifecycleEventStageStats,
  getPrivacyLifecycleEventTokenLeaderboard,
  getPrivacyLifecycleEventExchangeStats,
  getPrivacyLifecycleEventFamilyLeaderboard,
  getRecentPrivacyLifecycleSequenceStats,
} from '@/lib/sovereign/token-analytics';

type Db = ReturnType<typeof createAdminClient>;

export interface PrivacyLifecycleOverview {
  hours: number;
  limit: number;
  event_stage_stats: Awaited<ReturnType<typeof getRecentPrivacyLifecycleEventStageStats>>;
  event_token_leaderboard: Awaited<ReturnType<typeof getPrivacyLifecycleEventTokenLeaderboard>>;
  event_exchange_stats: Awaited<ReturnType<typeof getPrivacyLifecycleEventExchangeStats>>;
  event_family_leaderboard: Awaited<ReturnType<typeof getPrivacyLifecycleEventFamilyLeaderboard>>;
  sequence_stats: Awaited<ReturnType<typeof getRecentPrivacyLifecycleSequenceStats>>;
  generated_at: string;
}

export async function buildPrivacyLifecycleOverview(
  db: Db,
  hours: number,
  limit: number,
): Promise<PrivacyLifecycleOverview> {
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

  return {
    hours,
    limit,
    event_stage_stats,
    event_token_leaderboard,
    event_exchange_stats,
    event_family_leaderboard,
    sequence_stats,
    generated_at: new Date().toISOString(),
  };
}
