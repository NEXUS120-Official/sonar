// ============================================================
// SONAR v2.0 — GET /api/flow/exchange
// ============================================================
// Returns exchange flow breakdown:
//   - net flow per exchange (last 24h)
//   - top recent exchange movements
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/exchange] ${msg}`, ctx ?? '');
}

const WINDOW_HOURS = 24;
const TOP_MOVEMENTS = 20;

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();
    const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: rawMovements, error } = await db
      .from('movements')
      .select('id, from_address, to_address, from_label, to_label, flow_type, flow_direction, exchange, amount_usd, token, block_time')
      .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
      .gte('block_time', cutoff)
      .order('block_time', { ascending: false })
      .limit(500);

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const movements = (rawMovements ?? []) as Pick<
      MovementRow,
      'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' |
      'flow_type' | 'flow_direction' | 'exchange' | 'amount_usd' | 'token' | 'block_time'
    >[];

    // Group by exchange
    const exchangeMap = new Map<string, { inflow: number; outflow: number; count: number }>();
    for (const m of movements) {
      const key = m.exchange ?? 'unknown';
      const entry = exchangeMap.get(key) ?? { inflow: 0, outflow: 0, count: 0 };
      const usd = m.amount_usd ?? 0;
      if (m.flow_type === 'exchange_deposit')    entry.inflow  += usd;
      if (m.flow_type === 'exchange_withdrawal') entry.outflow += usd;
      entry.count++;
      exchangeMap.set(key, entry);
    }

    const byExchange = Array.from(exchangeMap.entries())
      .map(([exchange, v]) => ({
        exchange,
        inflow_usd:  v.inflow,
        outflow_usd: v.outflow,
        net_usd:     v.outflow - v.inflow, // positive = net outflow = accumulation
        count:       v.count,
      }))
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

    // Totals
    const total_inflow  = movements.filter(m => m.flow_type === 'exchange_deposit').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const total_outflow = movements.filter(m => m.flow_type === 'exchange_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

    return NextResponse.json({
      ok:          true,
      window_hours: WINDOW_HOURS,
      totals: {
        inflow_usd:  total_inflow,
        outflow_usd: total_outflow,
        net_usd:     total_outflow - total_inflow,
        count:       movements.length,
      },
      by_exchange:  byExchange,
      recent:       movements.slice(0, TOP_MOVEMENTS).map(formatMovement),
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

function formatMovement(m: Pick<MovementRow, 'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' | 'flow_type' | 'exchange' | 'amount_usd' | 'token' | 'block_time'>) {
  return {
    id:          m.id,
    flow_type:   m.flow_type,
    exchange:    m.exchange,
    token:       m.token,
    amount_usd:  m.amount_usd,
    from:        m.from_label ?? m.from_address,
    to:          m.to_label   ?? m.to_address,
    block_time:  m.block_time,
  };
}
