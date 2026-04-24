// ============================================================
// Intel — Weekly Report + Flow Heatmap + Cohort deep-dive
// ============================================================

import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase/server';
import { WeeklyReport } from '@/components/WeeklyReport';
import { FlowHeatmap } from '@/components/FlowHeatmap';
import { CohortCard } from '@/components/CohortCard';
import {
  classifyWhaleCohort,
  summariseCohorts,
  type WhaleMovementSummary,
} from '@/lib/flow-engine/cohort-analysis';
import type { FlowSnapshotRow, MovementRow, BiasIndexHistoryRow } from '@/lib/supabase/types';

async function getData() {
  const db     = createAdminClient();
  const since7 = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  const since1 = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [biasRes, snap168Res, heatmapRes, whalesRes, movsRes] = await Promise.all([
    // 7d bias history
    db.from('bias_index_history')
      .select('score, bias, created_at')
      .gte('created_at', since7)
      .order('created_at', { ascending: true }),

    // Latest 168h snapshot for flow summary
    db.from('flow_snapshots')
      .select('sol_net_exchange_flow_usd, net_staking_flow_usd, net_usdc_flow_usd, net_defi_flow_usd, large_movements_count, unique_whales_active')
      .eq('window_hours', 168)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // 7d of 1h snapshots for heatmap
    db.from('flow_snapshots')
      .select('sol_net_exchange_flow_usd, created_at')
      .eq('window_hours', 1)
      .gte('created_at', since7)
      .order('created_at', { ascending: true }),

    // Active whales
    db.from('whales')
      .select('id, address, label, total_value_usd')
      .eq('is_active', true),

    // 24h movements for cohort
    db.from('movements')
      .select('whale_id, flow_type, amount_usd')
      .not('whale_id', 'is', null)
      .gte('block_time', since1),
  ]);

  // ── Bias history (downsampled 4h) ──
  const rawBias = (biasRes.data ?? []) as Pick<BiasIndexHistoryRow, 'score' | 'bias' | 'created_at'>[];
  const biasBuckets = new Map<string, any>();
  for (const p of rawBias) {
    const slot = Math.floor(new Date(p.created_at).getTime() / (4 * 3_600_000));
    biasBuckets.set(String(slot), p);
  }
  const biasHistory = Array.from(biasBuckets.values());

  const scores     = rawBias.map((p: any) => p.score as number);
  const avgScore   = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null;
  const highScore  = scores.length ? Math.max(...scores) : null;
  const lowScore   = scores.length ? Math.min(...scores) : null;
  const biasCounts: Record<string, number> = {};
  for (const p of rawBias) biasCounts[p.bias] = (biasCounts[p.bias] ?? 0) + 1;
  const dominantBias = Object.keys(biasCounts).sort((a, b) => biasCounts[b] - biasCounts[a])[0] ?? null;

  // ── Flow summary ──
  const snap = snap168Res.data as any;
  const flowSummary = {
    net_exchange_usd:   snap ? -(snap.sol_net_exchange_flow_usd ?? 0) : 0,
    net_staking_usd:    snap?.net_staking_flow_usd    ?? 0,
    net_stablecoin_usd: snap?.net_usdc_flow_usd       ?? 0,
    net_defi_usd:       snap?.net_defi_flow_usd       ?? 0,
    total_movements:    snap?.large_movements_count   ?? 0,
    unique_whales:      snap?.unique_whales_active    ?? 0,
  };

  // Week label
  const now   = new Date();
  const start = new Date(Date.now() - 7 * 24 * 3_600_000);
  const fmt   = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const weekLabel = `${fmt(start)} – ${fmt(now)}`;

  // ── Heatmap cells ──
  const heatRows = (heatmapRes.data ?? []) as any[];
  const grid = new Map<string, { sum: number; count: number }>();
  for (const row of heatRows) {
    const d    = new Date(row.created_at as string);
    const day  = (d.getDay() + 6) % 7;
    const hour = d.getHours();
    const key  = `${day}:${hour}`;
    if (!grid.has(key)) grid.set(key, { sum: 0, count: 0 });
    grid.get(key)!.sum   += (row.sol_net_exchange_flow_usd as number) ?? 0;
    grid.get(key)!.count += 1;
  }
  const cells = Array.from(grid.entries()).map(([key, { sum, count }]) => {
    const [day, hour] = key.split(':').map(Number);
    return { day, hour, value: count > 0 ? sum / count : 0, count };
  });
  const vals = cells.map(c => c.value);
  const heatMin = vals.length ? Math.min(...vals) : 0;
  const heatMax = vals.length ? Math.max(...vals) : 0;

  // ── Cohort ──
  const whales = (whalesRes.data ?? []) as any[];
  const rawMovs = (movsRes.data ?? []) as any[];
  const aggMap = new Map<string, WhaleMovementSummary>();
  for (const w of whales) {
    aggMap.set(w.id, {
      whale_address: w.address, label: w.label, total_value_usd: w.total_value_usd,
      net_exchange_usd: 0, net_staking_usd: 0, net_defi_usd: 0, net_stablecoin_usd: 0,
      movement_count: 0, window_hours: 24, exchange_consistency: 1,
    });
  }
  for (const m of rawMovs) {
    const agg = aggMap.get(m.whale_id);
    if (!agg) continue;
    const usd = (m.amount_usd as number) ?? 0;
    agg.movement_count += 1;
    if (m.flow_type === 'exchange_withdrawal') agg.net_exchange_usd += usd;
    else if (m.flow_type === 'exchange_deposit') agg.net_exchange_usd -= usd;
    else if (m.flow_type === 'stake')            agg.net_staking_usd  += usd;
    else if (m.flow_type === 'unstake')          agg.net_staking_usd  -= usd;
    else if (m.flow_type === 'defi_deposit')     agg.net_defi_usd     += usd;
    else if (m.flow_type === 'defi_withdrawal')  agg.net_defi_usd     -= usd;
  }
  const cohortResults = Array.from(aggMap.values()).map(classifyWhaleCohort);
  const cohortGroups  = summariseCohorts(cohortResults);
  const cohortActive  = cohortResults.filter(r => r.cohort !== 'dormant').sort((a, b) => b.cohort_score - a.cohort_score);
  const cohortDormant = cohortResults.filter(r => r.cohort === 'dormant').length;

  return {
    biasHistory, flowSummary, dominantBias, avgScore, highScore, lowScore, weekLabel,
    cells, heatMin, heatMax,
    cohortGroups, cohortActive, cohortDormant, totalWhales: whales.length,
  };
}

export default async function IntelPage() {
  const {
    biasHistory, flowSummary, dominantBias, avgScore, highScore, lowScore, weekLabel,
    cells, heatMin, heatMax,
    cohortGroups, cohortActive, cohortDormant, totalWhales,
  } = await getData();

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Intelligence
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
          Weekly summary · flow heatmap · whale cohort analysis
        </p>
      </div>

      {/* Valuation Coverage entrypoint */}
      <Link
        href="/dashboard/valuation-coverage"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Valuation Coverage</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Price freshness, coverage quality, unknown-price queue, and valuation doctrine observability.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Price Merge entrypoint */}
      <Link
        href="/dashboard/price-merge"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Price Merge Policy</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Ranked price candidates, effective selection, and deterministic valuation-source auditability.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Valuation Completeness entrypoint */}
      <Link
        href="/dashboard/valuation-completeness"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Valuation Completeness</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Priced vs unpriced asset propagation across sovereign account-state and whale candidate ranking.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Valuation Clusters entrypoint */}
      <Link
        href="/dashboard/valuation-clusters"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Valuation Clusters</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Token-level valuation gaps and exchange / whale completeness intelligence.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Sovereign Whale Ranking entrypoint */}
      <Link
        href="/dashboard/sovereign-whale-ranking"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Sovereign Whale Ranking</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Confidence-weighted, valuation-aware sovereign whale candidate ranking.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Exchange Lineage entrypoint */}
      <Link
        href="/dashboard/exchange-lineage"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Exchange Lineage</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Confidence-scored exchange-origin and cex-to-shadow lineage intelligence.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Privacy Lifecycle entrypoint */}
      <Link
        href="/dashboard/privacy-lifecycle"
        className="block rounded-xl border p-5 transition hover:opacity-90"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p
              className="text-xs uppercase tracking-widest mb-3"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
            >
              New Intel Surface
            </p>
            <h2 className="text-lg font-semibold">Privacy Lifecycle</h2>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: '#6b6b80' }}>
              Event stages, re-emergence sequences, exchange-origin context, and
              family-level privacy flow intelligence.
            </p>
          </div>
          <div className="text-sm font-medium shrink-0" style={{ color: '#22d3ee' }}>
            Open dashboard →
          </div>
        </div>
      </Link>

      {/* Weekly Report + Cohort side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Weekly Report */}
        <div
          className="rounded-xl border p-5"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <WeeklyReport
            biasHistory={biasHistory}
            flowSummary={flowSummary}
            dominantBias={dominantBias}
            avgScore={avgScore}
            highScore={highScore}
            lowScore={lowScore}
            weekLabel={weekLabel}
          />
        </div>

        {/* Cohort deep-dive */}
        <div
          className="rounded-xl border p-5"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            Whale Cohorts · 24h
          </p>
          {cohortGroups.length > 0 ? (
            <CohortCard
              groups={cohortGroups}
              whales={cohortActive}
              dormant={cohortDormant}
              total={totalWhales}
              hours={24}
              showWhales={true}
            />
          ) : (
            <div style={{ color: '#4b4b60', fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
              No movement data yet — cohorts populate once whales are active.
            </div>
          )}
        </div>

      </div>

      {/* Flow Heatmap */}
      <div
        className="rounded-xl border p-5"
        style={{ background: '#12121a', borderColor: '#1e1e2e' }}
      >
        <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
          Exchange Flow Heatmap · 7d × 24h
        </p>
        <FlowHeatmap cells={cells} min={heatMin} max={heatMax} />
      </div>

    </div>
  );
}
