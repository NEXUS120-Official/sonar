// ============================================================
// SONAR — Valuation Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { applyPriceDoctrine } from '@/lib/sovereign/sovereign-price-doctrine';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_price_registry')
    .select('asset_key, price_usd, price_confidence, valuation_reason, last_price_at, price_source_mode')
    .order('last_price_at', { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    asset_key: string;
    price_usd: number | null;
    price_confidence: 'high' | 'medium' | 'low' | 'unknown';
    valuation_reason: string | null;
    last_price_at: string;
    price_source_mode: string;
  }>;

  const doctrined = rows.map((row) =>
    applyPriceDoctrine({
      asset_key: row.asset_key,
      amount: 1,
      price_usd: row.price_usd,
      price_confidence: row.price_confidence,
      valuation_reason: row.valuation_reason ?? 'valuation surface sample',
      last_price_at: row.last_price_at,
      price_source_mode: row.price_source_mode,
    })
  );

  const stale_count = doctrined.filter((r) => r.is_stale_price).length;
  const unknown_count = doctrined.filter((r) => r.effective_confidence === 'unknown').length;

  return NextResponse.json({
    ok: true,
    count: doctrined.length,
    stale_count,
    unknown_count,
    rows: doctrined,
    source_mode: 'sovereign_price_doctrine_v1',
  });
}
