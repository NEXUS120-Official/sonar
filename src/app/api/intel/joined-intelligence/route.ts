import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getRecentJoinedIntelligence } from '@/lib/sovereign/joined-intelligence-analytics';

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
    const rows = await getRecentJoinedIntelligence(db, limit);

    return NextResponse.json({
      ok: true,
      limit,
      rows,
      generated_at: new Date().toISOString(),
      source_mode: 'joined_intelligence_records_v1',
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
