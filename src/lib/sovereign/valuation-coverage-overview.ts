// ============================================================
// SONAR — Valuation Coverage Overview Composer
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import {
  getValuationCoverageStats,
  getValuationCoverageRows,
  getTopStaleAssets,
  getUnknownPriceAssets,
  getAlertDoctrineStats,
  getPartialAccountValuations,
} from '@/lib/sovereign/valuation-analytics';

type Db = ReturnType<typeof createAdminClient>;

export interface ValuationCoverageOverview {
  limit: number;
  coverage_stats: Awaited<ReturnType<typeof getValuationCoverageStats>>;
  coverage_rows: Awaited<ReturnType<typeof getValuationCoverageRows>>;
  top_stale_assets: Awaited<ReturnType<typeof getTopStaleAssets>>;
  unknown_price_assets: Awaited<ReturnType<typeof getUnknownPriceAssets>>;
  alert_doctrine_stats: Awaited<ReturnType<typeof getAlertDoctrineStats>>;
  partial_account_valuations: Awaited<ReturnType<typeof getPartialAccountValuations>>;
  generated_at: string;
}

export async function buildValuationCoverageOverview(
  db: Db,
  limit: number,
): Promise<ValuationCoverageOverview> {
  const [
    coverage_stats,
    coverage_rows,
    top_stale_assets,
    unknown_price_assets,
    alert_doctrine_stats,
    partial_account_valuations,
  ] = await Promise.all([
    getValuationCoverageStats(db),
    getValuationCoverageRows(db, Math.max(limit * 4, 100)),
    getTopStaleAssets(db, limit),
    getUnknownPriceAssets(db, limit),
    getAlertDoctrineStats(db),
    getPartialAccountValuations(db, limit),
  ]);

  return {
    limit,
    coverage_stats,
    coverage_rows,
    top_stale_assets,
    unknown_price_assets,
    alert_doctrine_stats,
    partial_account_valuations,
    generated_at: new Date().toISOString(),
  };
}
