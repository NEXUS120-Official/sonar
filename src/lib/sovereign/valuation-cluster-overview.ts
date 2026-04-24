// ============================================================
// SONAR — Valuation Cluster Overview
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import {
  getTokenValuationGapLeaderboard,
  getWhaleValuationCompletenessRows,
  getExchangeValuationCompletenessRows,
} from '@/lib/sovereign/valuation-cluster-analytics';

type Db = ReturnType<typeof createAdminClient>;

export interface ValuationClusterOverview {
  limit: number;
  token_gap_leaderboard: Awaited<ReturnType<typeof getTokenValuationGapLeaderboard>>;
  whale_completeness: Awaited<ReturnType<typeof getWhaleValuationCompletenessRows>>;
  exchange_completeness: Awaited<ReturnType<typeof getExchangeValuationCompletenessRows>>;
  generated_at: string;
}

export async function buildValuationClusterOverview(
  db: Db,
  limit: number,
): Promise<ValuationClusterOverview> {
  const [
    token_gap_leaderboard,
    whale_completeness,
    exchange_completeness,
  ] = await Promise.all([
    getTokenValuationGapLeaderboard(db, limit),
    getWhaleValuationCompletenessRows(db, Math.max(limit * 4, 50)),
    getExchangeValuationCompletenessRows(db, limit),
  ]);

  return {
    limit,
    token_gap_leaderboard,
    whale_completeness,
    exchange_completeness,
    generated_at: new Date().toISOString(),
  };
}
