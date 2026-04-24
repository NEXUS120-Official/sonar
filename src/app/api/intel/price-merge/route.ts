// ============================================================
// SONAR — Price Merge Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { loadPriceCandidates } from '@/lib/sovereign/sovereign-price-runtime';
import { selectEffectiveSovereignPrice } from '@/lib/sovereign/sovereign-price-merge-policy';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();
  const assetKey = req.nextUrl.searchParams.get('asset') ?? 'SOL';

  try {
    const candidates = await loadPriceCandidates(db, assetKey);
    const selected = selectEffectiveSovereignPrice(candidates);

    return NextResponse.json({
      ok: true,
      asset_key: assetKey,
      effective: selected.effective,
      ranked_candidates: selected.ranked_candidates,
      candidate_count: selected.ranked_candidates.length,
      source_mode: 'sovereign_price_merge_policy_v1',
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
