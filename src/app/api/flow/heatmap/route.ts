// ============================================================
// SONAR v2.0 — GET /api/flow/heatmap (Innovation 6)
// ============================================================
// Returns a 7×24 grid (day × hour) of net_exchange_flow_usd
// from the last 7 days of 1h snapshots.
// Used by FlowHeatmap component.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface HeatmapCell {
  day:     number;  // 0=Mon … 6=Sun
  hour:    number;  // 0-23
  value:   number;  // net_exchange_flow_usd
  count:   number;  // snapshots averaged into this cell
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const db    = createAdminClient();
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await db
      .from('flow_snapshots')
      .select('window_hours, sol_net_exchange_flow_usd, created_at')
      .eq('window_hours', 1)
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // Aggregate into day×hour buckets
    const grid: Record<string, { sum: number; count: number }> = {};

    for (const row of (data ?? []) as any[]) {
      const d    = new Date(row.created_at as string);
      const day  = (d.getDay() + 6) % 7; // 0=Mon
      const hour = d.getHours();
      const key  = `${day}:${hour}`;
      if (!grid[key]) grid[key] = { sum: 0, count: 0 };
      grid[key].sum   += (row.sol_net_exchange_flow_usd as number) ?? 0;
      grid[key].count += 1;
    }

    const cells: HeatmapCell[] = [];
    for (const [key, { sum, count }] of Object.entries(grid)) {
      const [day, hour] = key.split(':').map(Number);
      cells.push({ day, hour, value: count > 0 ? sum / count : 0, count });
    }

    // Compute min/max for frontend normalization
    const values = cells.map(c => c.value);
    const min    = values.length ? Math.min(...values) : 0;
    const max    = values.length ? Math.max(...values) : 0;

    return NextResponse.json({ ok: true, cells, min, max, window: '7d_1h_snapshots' });
  } catch (err) {
    console.error('[api/flow/heatmap]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
