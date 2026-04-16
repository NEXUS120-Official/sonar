// ============================================================
// SONAR Intel API — Exchange Flow
// GET /api/intel/exchange-flow?window=4h
// ============================================================
// Returns exchange inflow/outflow breakdown by exchange name,
// net flow trend, and the largest individual moves.
//
// Query params:
//   window  = 1h | 4h | 24h (default 4h)
//   limit   = max movements to return (default 20)
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WINDOW_MAP: Record<string, number> = { '1h': 1, '4h': 4, '24h': 24, '72h': 72 };

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-api-key') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const windowHours = WINDOW_MAP[searchParams.get('window') ?? '4h'] ?? 4;
  const limit       = Math.min(100, parseInt(searchParams.get('limit') ?? '20', 10));

  const db    = createAdminClient();
  const since = new Date(Date.now() - windowHours * 60 * 60_000).toISOString();

  // ── 1. Raw movements in window ────────────────────────────
  const { data: movRaw } = await db
    .from('movements')
    .select('flow_type, exchange, amount_usd, block_time, from_address, to_address, whale_id')
    .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
    .gte('block_time', since)
    .order('amount_usd', { ascending: false })
    .limit(500);

  const movements = (movRaw ?? []) as Array<{
    flow_type: string;
    exchange: string | null;
    amount_usd: number | null;
    block_time: string;
    from_address: string;
    to_address: string;
    whale_id: string | null;
  }>;

  // ── 2. Aggregate by exchange ───────────────────────────────
  const exchangeMap = new Map<string, { inflow: number; outflow: number; count: number }>();

  let totalInflow  = 0;
  let totalOutflow = 0;

  for (const m of movements) {
    const ex  = m.exchange ?? 'unknown';
    const amt = m.amount_usd ?? 0;
    if (!exchangeMap.has(ex)) exchangeMap.set(ex, { inflow: 0, outflow: 0, count: 0 });
    const agg = exchangeMap.get(ex)!;

    if (m.flow_type === 'exchange_deposit') {
      agg.inflow  += amt;
      totalInflow += amt;
    } else {
      agg.outflow  += amt;
      totalOutflow += amt;
    }
    agg.count++;
  }

  const net_flow_usd = totalOutflow - totalInflow; // positive = net outflow (bullish)

  const by_exchange = [...exchangeMap.entries()]
    .map(([name, v]) => ({
      name,
      inflow_usd:  Math.round(v.inflow),
      outflow_usd: Math.round(v.outflow),
      net_usd:     Math.round(v.outflow - v.inflow),
      count:       v.count,
    }))
    .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

  // ── 3. Largest individual moves ────────────────────────────
  const top_moves = movements.slice(0, limit).map(m => ({
    flow_type:  m.flow_type,
    exchange:   m.exchange,
    amount_usd: Math.round(m.amount_usd ?? 0),
    block_time: m.block_time,
    has_whale:  !!m.whale_id,
  }));

  // ── 4. Hourly series (for chart) ──────────────────────────
  // Bucket movements into 1h slots
  const seriesMap = new Map<string, { inflow: number; outflow: number }>();
  for (const m of movements) {
    const hour = new Date(m.block_time);
    hour.setMinutes(0, 0, 0);
    const key = hour.toISOString();
    if (!seriesMap.has(key)) seriesMap.set(key, { inflow: 0, outflow: 0 });
    const s = seriesMap.get(key)!;
    if (m.flow_type === 'exchange_deposit') s.inflow  += m.amount_usd ?? 0;
    else                                    s.outflow += m.amount_usd ?? 0;
  }

  const series = [...seriesMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({
      t,
      inflow_usd:  Math.round(v.inflow),
      outflow_usd: Math.round(v.outflow),
      net_usd:     Math.round(v.outflow - v.inflow),
    }));

  return NextResponse.json({
    ok: true,
    window_hours:    windowHours,
    since,
    summary: {
      total_inflow_usd:  Math.round(totalInflow),
      total_outflow_usd: Math.round(totalOutflow),
      net_flow_usd:      Math.round(net_flow_usd),
      direction:         net_flow_usd > 0 ? 'bullish' : net_flow_usd < 0 ? 'bearish' : 'neutral',
      movement_count:    movements.length,
    },
    by_exchange,
    top_moves,
    series,
  });
}
