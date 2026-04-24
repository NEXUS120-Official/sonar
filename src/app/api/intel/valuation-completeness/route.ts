// ============================================================
// SONAR — Valuation Completeness Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getPartialAccountValuations } from '@/lib/sovereign/valuation-analytics';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: whales, error } = await (db as any)
    .from('sovereign_whale_candidates')
    .select('address, estimated_balance_usd, priced_component_count, unpriced_component_count, valuation_completeness_ratio, valuation_status')
    .order('first_seen_at', { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const partial_account_valuations = await getPartialAccountValuations(db, 50);

  return NextResponse.json({
    ok: true,
    whale_candidates: whales ?? [],
    partial_account_valuations,
    source_mode: 'sovereign_valuation_completeness_v1',
    generated_at: new Date().toISOString(),
  });
}
