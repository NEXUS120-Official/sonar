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
  getRecentPrivacySequenceCandidateStats,
  getPrivacySequenceCandidateLeaderboard,
  getPrivacySequenceCandidateFamilyStats,
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
  candidate_stats: Awaited<ReturnType<typeof getRecentPrivacySequenceCandidateStats>>;
  candidate_leaderboard: Awaited<ReturnType<typeof getPrivacySequenceCandidateLeaderboard>>;
  candidate_family_stats: Awaited<ReturnType<typeof getPrivacySequenceCandidateFamilyStats>>;
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
    candidate_stats,
    candidate_leaderboard,
    candidate_family_stats,
  ] = await Promise.all([
    getRecentPrivacyLifecycleEventStageStats(db, hours),
    getPrivacyLifecycleEventTokenLeaderboard(db, hours, limit),
    getPrivacyLifecycleEventExchangeStats(db, hours),
    getPrivacyLifecycleEventFamilyLeaderboard(db, hours, limit),
    getRecentPrivacyLifecycleSequenceStats(db, hours),
    getRecentPrivacySequenceCandidateStats(db, hours),
    getPrivacySequenceCandidateLeaderboard(db, hours, limit),
    getPrivacySequenceCandidateFamilyStats(db, hours, limit),
  ]);

  return {
    hours,
    limit,
    event_stage_stats,
    event_token_leaderboard,
    event_exchange_stats,
    event_family_leaderboard,
    sequence_stats,
    candidate_stats,
    candidate_leaderboard,
    candidate_family_stats,
    generated_at: new Date().toISOString(),
  };
}
