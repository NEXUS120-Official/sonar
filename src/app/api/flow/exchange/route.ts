// ============================================================
// SONAR v2.0 — GET /api/flow/exchange
// ============================================================
// Exchange flow breakdown with trend vs prior period.
//
// Query params:
//   window_hours  default 24 (supported: 4, 24)
//
// Returns:
//   - per-exchange inflow / outflow / net with trend delta
//   - per-exchange interpretation (accumulation / distribution / balanced)
//   - top recent exchange movements
//   - publishable_summary for daily publishing
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/exchange] ${msg}`, ctx ?? '');
}

const DEFAULT_WINDOW = 24;
const TOP_MOVEMENTS  = 20;

// ── Helpers ──────────────────────────────────────────────────

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * Interpret a net exchange flow value.
 * Convention: positive net = net outflow (outflow > inflow) = accumulation = bullish.
 */
function interpretNetFlow(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000) return 'balanced';
  if (net > 0) {
    if (abs < 250_000) return 'mild accumulation';
    if (abs < 1_000_000) return 'moderate accumulation';
    return 'strong accumulation';
  } else {
    if (abs < 250_000) return 'mild distribution';
    if (abs < 1_000_000) return 'moderate distribution';
    return 'strong distribution';
  }
}

type ExchangeBucket = { inflow: number; outflow: number; count: number };

function aggregateByExchange(
  movements: Pick<MovementRow, 'flow_type' | 'exchange' | 'amount_usd'>[],
): Map<string, ExchangeBucket> {
  const map = new Map<string, ExchangeBucket>();
  for (const m of movements) {
    const key = m.exchange ?? 'unknown';
    const entry = map.get(key) ?? { inflow: 0, outflow: 0, count: 0 };
    const usd = m.amount_usd ?? 0;
    if (m.flow_type === 'exchange_deposit')    entry.inflow  += usd;
    if (m.flow_type === 'exchange_withdrawal') entry.outflow += usd;
    entry.count++;
    map.set(key, entry);
  }
  return map;
}

// ── Handler ───────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const db = createAdminClient();
    const url = new URL(req.url);
    const windowHours = Number(url.searchParams.get('window_hours') ?? DEFAULT_WINDOW);

    const now        = Date.now();
    const cutoffCurr = new Date(now - windowHours * 60 * 60 * 1000).toISOString();
    const cutoffPrev = new Date(now - 2 * windowHours * 60 * 60 * 1000).toISOString();

    // Load current + prior window in one query (2× window back)
    const { data: rawMovements, error } = await db
      .from('movements')
      .select('id, from_address, to_address, from_label, to_label, flow_type, flow_direction, exchange, amount_usd, token, block_time')
      .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
      .gte('block_time', cutoffPrev)
      .order('block_time', { ascending: false })
      .limit(1_000);

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const all = (rawMovements ?? []) as Pick<
      MovementRow,
      'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' |
      'flow_type' | 'flow_direction' | 'exchange' | 'amount_usd' | 'token' | 'block_time'
    >[];

    const currMovements = all.filter(m => m.block_time >= cutoffCurr);
    const prevMovements = all.filter(m => m.block_time < cutoffCurr);

    const currMap = aggregateByExchange(currMovements);
    const prevMap = aggregateByExchange(prevMovements);

    // ── Per-exchange results with trend ──────────────────────
    const byExchange = Array.from(currMap.entries())
      .map(([exchange, v]) => {
        const prev    = prevMap.get(exchange) ?? { inflow: 0, outflow: 0, count: 0 };
        const net     = v.outflow - v.inflow;         // positive = accumulation
        const prevNet = prev.outflow - prev.inflow;

        const netChangePct = prevNet !== 0
          ? Math.round(((net - prevNet) / Math.abs(prevNet)) * 100)
          : null;

        return {
          exchange,
          inflow_usd:  v.inflow,
          outflow_usd: v.outflow,
          net_usd:     net,
          count:       v.count,
          trend: {
            prev_net_usd:    prevNet,
            net_change_pct:  netChangePct, // null if no prior activity
          },
          interpretation: interpretNetFlow(net),
        };
      })
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

    // ── Totals ────────────────────────────────────────────────
    const totalInflow  = currMovements.filter(m => m.flow_type === 'exchange_deposit')   .reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalOutflow = currMovements.filter(m => m.flow_type === 'exchange_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalNet     = totalOutflow - totalInflow;

    const prevTotalInflow  = prevMovements.filter(m => m.flow_type === 'exchange_deposit')   .reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const prevTotalOutflow = prevMovements.filter(m => m.flow_type === 'exchange_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const prevTotalNet     = prevTotalOutflow - prevTotalInflow;

    // ── Publishable summary ───────────────────────────────────
    const dominant = byExchange[0] ?? null;
    const direction = interpretNetFlow(totalNet);
    const netChangePct = prevTotalNet !== 0
      ? Math.round(((totalNet - prevTotalNet) / Math.abs(prevTotalNet)) * 100)
      : null;

    const publishableSummary = {
      direction,
      headline: `${fmtUsd(totalNet)} net exchange flow — ${direction}`,
      total_net_usd: totalNet,
      prev_net_usd:  prevTotalNet,
      net_change_pct: netChangePct,
      dominant_exchange:     dominant?.exchange ?? null,
      dominant_net_usd:      dominant?.net_usd  ?? 0,
      dominant_interpretation: dominant ? interpretNetFlow(dominant.net_usd) : null,
      active_exchanges:      byExchange.length,
    };

    log(`${currMovements.length} current / ${prevMovements.length} prior movements — net ${fmtUsd(totalNet)}`);

    return NextResponse.json({
      ok:           true,
      window_hours: windowHours,
      totals: {
        inflow_usd:  totalInflow,
        outflow_usd: totalOutflow,
        net_usd:     totalNet,         // positive = net outflow = accumulation
        count:       currMovements.length,
        prev_net_usd: prevTotalNet,
        net_change_pct: netChangePct,
      },
      publishable_summary: publishableSummary,
      by_exchange:  byExchange,
      recent:       currMovements.slice(0, TOP_MOVEMENTS).map(formatMovement),
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

function formatMovement(m: Pick<MovementRow, 'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' | 'flow_type' | 'exchange' | 'amount_usd' | 'token' | 'block_time'>) {
  return {
    id:         m.id,
    flow_type:  m.flow_type,
    exchange:   m.exchange,
    token:      m.token,
    amount_usd: m.amount_usd,
    from:       m.from_label ?? m.from_address,
    to:         m.to_label   ?? m.to_address,
    block_time: m.block_time,
  };
}
