// ============================================================
// SONAR — Valuation Cluster Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { buildValuationClusterOverview } from '@/lib/sovereign/valuation-cluster-overview';

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();
  const limit = parsePositiveInt(req.nextUrl.searchParams.get('limit'), 25);

  try {
    const overview = await buildValuationClusterOverview(db, limit);

    return NextResponse.json({
      ok: true,
      ...overview,
      source_mode: 'sovereign_valuation_cluster_intel_v1',
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
