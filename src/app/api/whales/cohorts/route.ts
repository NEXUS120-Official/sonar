// ============================================================
// SONAR v2.0 — GET /api/whales/cohorts (Innovation 7)
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  classifyWhaleCohort,
  summariseCohorts,
  type WhaleMovementSummary,
} from '@/lib/flow-engine/cohort-analysis';
import type { WhaleRow, MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const hours = Math.min(
      Number(new URL(req.url).searchParams.get('hours') ?? 24),
      168,
    );
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const db    = createAdminClient();

    // 1. Active whales
    const { data: whales, error: whaleErr } = await db
      .from('whales')
      .select('id, address, label, total_value_usd')
      .eq('is_active', true);

    if (whaleErr) return NextResponse.json({ ok: false, error: whaleErr.message }, { status: 500 });

    // Build id → whale map
    const whaleById = new Map<string, Pick<WhaleRow, 'address' | 'label' | 'total_value_usd'>>();
    for (const w of (whales ?? []) as any[]) {
      whaleById.set(w.id, { address: w.address, label: w.label, total_value_usd: w.total_value_usd });
    }

    // 2. Movements in window (whale_id, flow_type, flow_direction, amount_usd)
    const { data: movements, error: movErr } = await db
      .from('movements')
      .select('whale_id, flow_type, flow_direction, amount_usd')
      .not('whale_id', 'is', null)
      .gte('created_at', since);

    if (movErr) return NextResponse.json({ ok: false, error: movErr.message }, { status: 500 });

    // 3. Aggregate per whale
    const aggMap = new Map<string, WhaleMovementSummary>();
    for (const [id, w] of whaleById.entries()) {
      aggMap.set(id, {
        whale_address:        w.address,
        label:                w.label,
        total_value_usd:      w.total_value_usd,
        net_exchange_usd:     0,
        net_staking_usd:      0,
        net_defi_usd:         0,
        net_stablecoin_usd:   0,
        movement_count:       0,
        window_hours:         hours,
        exchange_consistency: 1,
      });
    }

    // Track exchange directions for consistency
    const exchDirs = new Map<string, number[]>();

    for (const m of (movements ?? []) as any[]) {
      const whaleId = m.whale_id as string;
      const agg = aggMap.get(whaleId);
      if (!agg) continue;

      const usd = (m.amount_usd as number | null) ?? 0;
      agg.movement_count += 1;

      const ft = m.flow_type as MovementRow['flow_type'];

      if (ft === 'exchange_withdrawal') {
        // Withdrawal from exchange = accumulation = bullish
        agg.net_exchange_usd += usd;
        if (!exchDirs.has(whaleId)) exchDirs.set(whaleId, []);
        exchDirs.get(whaleId)!.push(1);
      } else if (ft === 'exchange_deposit') {
        // Deposit to exchange = distribution = bearish
        agg.net_exchange_usd -= usd;
        if (!exchDirs.has(whaleId)) exchDirs.set(whaleId, []);
        exchDirs.get(whaleId)!.push(-1);
      } else if (ft === 'stake') {
        agg.net_staking_usd += usd;
      } else if (ft === 'unstake') {
        agg.net_staking_usd -= usd;
      } else if (ft === 'defi_deposit') {
        agg.net_defi_usd += usd;
      } else if (ft === 'defi_withdrawal') {
        agg.net_defi_usd -= usd;
      }
    }

    // Consistency scores
    for (const [id, dirs] of exchDirs.entries()) {
      const agg = aggMap.get(id);
      if (!agg || dirs.length < 2) continue;
      const pos = dirs.filter(d => d > 0).length;
      agg.exchange_consistency = Math.max(pos, dirs.length - pos) / dirs.length;
    }

    // 4. Classify
    const results = Array.from(aggMap.values()).map(classifyWhaleCohort);
    const groups  = summariseCohorts(results);
    const active  = results
      .filter(r => r.cohort !== 'dormant')
      .sort((a, b) => b.cohort_score - a.cohort_score);

    return NextResponse.json({
      ok:      true,
      hours,
      groups,
      whales:  active,
      dormant: results.filter(r => r.cohort === 'dormant').length,
      total:   results.length,
    });
  } catch (err) {
    console.error('[api/whales/cohorts]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
