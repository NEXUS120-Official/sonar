// ============================================================
// SONAR — Valuation Coverage Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  getValuationCoverageStats,
  getValuationCoverageRows,
  getTopStaleAssets,
  getUnknownPriceAssets,
  getAlertDoctrineStats,
  getPartialAccountValuations,
} from '@/lib/sovereign/valuation-analytics';

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();
  const sp = req.nextUrl.searchParams;
  const limit = parsePositiveInt(sp.get('limit'), 25);

  try {
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

    return NextResponse.json({
      ok: true,
      limit,
      coverage_stats,
      coverage_rows,
      top_stale_assets,
      unknown_price_assets,
      alert_doctrine_stats,
      partial_account_valuations,
      generated_at: new Date().toISOString(),
      source_mode: 'sovereign_valuation_coverage_v1',
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
