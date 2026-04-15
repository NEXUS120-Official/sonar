// ============================================================
// SONAR — Update Whale Reputation Stats
// POST /api/cron/update-whale-stats   (every hour)
// ============================================================
// Aggregates resolved whale_signal_outcomes (rolling 30d) and
// writes reputation fields back to the whales table:
//
//   hit_rate_30d      — % of signals correct at 1h window
//   signal_count_30d  — total resolved signals in last 30d
//   mean_return_30d   — average 1h return (%)
//   reputation_score  — 0-100 composite (hit_rate × volume weight)
//   smart_money_flag  — true if hit_rate≥65% AND signal_count≥5
//   last_reputation_at — timestamp of this update
//
// Only whales with ≥1 resolved outcome are touched.
// Whales with zero outcomes are left as-is.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-cron-secret') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

// Reputation score formula:
//   - Requires ≥3 signals for any score
//   - hit_rate × 100, scaled by log(signal_count+1)/log(10)
//     so 1 signal → 0.3×, 10 signals → 1.0×, 100 signals → 1.5× (capped at 1.5)
//   - Capped at 100
function computeReputation(hitRate: number, signalCount: number): number {
  if (signalCount < 3) return 0;
  const volumeWeight = Math.min(1.5, Math.log(signalCount + 1) / Math.log(10));
  return Math.min(100, Math.round(hitRate * 100 * volumeWeight));
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs  = Date.now();
  const db       = createAdminClient();
  const since30d = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();

  // 1. Aggregate resolved outcomes per whale (last 30d)
  const { data: outcomes, error: outErr } = await (db as any)
    .from('whale_signal_outcomes')
    .select('whale_id, hit_1h, return_1h, signal_direction')
    .eq('resolved', true)
    .gte('signal_time', since30d)
    .not('whale_id', 'is', null);

  if (outErr) {
    return NextResponse.json({ ok: false, error: outErr.message }, { status: 500 });
  }

  // Group by whale_id
  const byWhale = new Map<string, { hits: number; total: number; returns: number[] }>();

  for (const row of (outcomes ?? []) as { whale_id: string; hit_1h: boolean | null; return_1h: number | null; signal_direction: string }[]) {
    if (!row.whale_id) continue;
    if (!byWhale.has(row.whale_id)) byWhale.set(row.whale_id, { hits: 0, total: 0, returns: [] });
    const agg = byWhale.get(row.whale_id)!;
    agg.total++;
    if (row.hit_1h === true) agg.hits++;
    if (row.return_1h !== null) agg.returns.push(row.return_1h);
  }

  // 2. Update each whale
  const now = new Date().toISOString();
  let updated = 0;
  let smartMoneyCount = 0;

  for (const [whaleId, agg] of byWhale.entries()) {
    const hitRate    = agg.total > 0 ? agg.hits / agg.total : 0;
    const meanReturn = agg.returns.length > 0
      ? Math.round((agg.returns.reduce((s, v) => s + v, 0) / agg.returns.length) * 10000) / 10000
      : 0;
    const repScore    = computeReputation(hitRate, agg.total);
    const smartMoney  = hitRate >= 0.65 && agg.total >= 5;

    if (smartMoney) smartMoneyCount++;

    const { error: updateErr } = await (db as any)
      .from('whales')
      .update({
        hit_rate_30d:      Math.round(hitRate * 10000) / 10000,
        signal_count_30d:  agg.total,
        mean_return_30d:   meanReturn,
        reputation_score:  repScore,
        smart_money_flag:  smartMoney,
        last_reputation_at: now,
      })
      .eq('id', whaleId);

    if (!updateErr) updated++;
  }

  return NextResponse.json({
    ok:               true,
    whales_evaluated: byWhale.size,
    whales_updated:   updated,
    smart_money:      smartMoneyCount,
    duration_ms:      Date.now() - startMs,
  });
}

export const GET = POST;
