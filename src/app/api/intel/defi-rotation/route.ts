// ============================================================
// SONAR Intel API — DeFi Rotation
// GET /api/intel/defi-rotation?window=24h
// ============================================================
// Tracks capital rotation between DeFi protocols.
// When whales shift capital from one protocol class to another,
// that often precedes sector repricing.
//
// Signals:
//   - Net DeFi flow (deposit vs withdrawal overall)
//   - Protocol breakdown (which protocols are gaining/losing)
//   - Smart money DeFi positioning
//   - Rotation velocity (how fast capital is moving between protocols)
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WINDOW_MAP: Record<string, number> = { '4h': 4, '24h': 24, '72h': 72 };

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
  const windowHours = WINDOW_MAP[searchParams.get('window') ?? '24h'] ?? 24;

  const db    = createAdminClient();
  const since = new Date(Date.now() - windowHours * 60 * 60_000).toISOString();

  // ── 1. Load DeFi movements ────────────────────────────────
  const { data: movRaw } = await db
    .from('movements')
    .select('flow_type, protocol, exchange, amount_usd, block_time, whale_id')
    .in('flow_type', ['defi_deposit', 'defi_withdrawal'])
    .gte('block_time', since)
    .order('block_time', { ascending: true })
    .limit(1000);

  const movements = (movRaw ?? []) as Array<{
    flow_type: string;
    protocol: string | null;
    exchange: string | null;
    amount_usd: number | null;
    block_time: string;
    whale_id: string | null;
  }>;

  if (movements.length === 0) {
    return NextResponse.json({
      ok: true, window_hours: windowHours, since,
      summary: { net_flow_usd: 0, total_deposits_usd: 0, total_withdrawals_usd: 0, direction: 'neutral', movement_count: 0 },
      by_protocol: [], series: [], smart_money_positioning: 'neutral',
    });
  }

  // ── 2. Aggregate by protocol ───────────────────────────────
  const protocolMap = new Map<string, { deposits: number; withdrawals: number; count: number; whale_count: Set<string> }>();

  let totalDeposits    = 0;
  let totalWithdrawals = 0;

  for (const m of movements) {
    const key = m.protocol ?? m.exchange ?? 'unknown';
    const amt = m.amount_usd ?? 0;
    if (!protocolMap.has(key)) protocolMap.set(key, { deposits: 0, withdrawals: 0, count: 0, whale_count: new Set() });
    const agg = protocolMap.get(key)!;
    agg.count++;
    if (m.whale_id) agg.whale_count.add(m.whale_id);
    if (m.flow_type === 'defi_deposit') { agg.deposits += amt; totalDeposits += amt; }
    else                                { agg.withdrawals += amt; totalWithdrawals += amt; }
  }

  const net_flow_usd = totalDeposits - totalWithdrawals; // positive = net into DeFi (bullish for DeFi)

  const by_protocol = [...protocolMap.entries()]
    .map(([name, v]) => ({
      protocol:       name,
      deposits_usd:   Math.round(v.deposits),
      withdrawals_usd: Math.round(v.withdrawals),
      net_usd:        Math.round(v.deposits - v.withdrawals),
      count:          v.count,
      unique_whales:  v.whale_count.size,
      direction:      v.deposits > v.withdrawals * 1.2 ? 'inflow'
                    : v.withdrawals > v.deposits * 1.2 ? 'outflow'
                    : 'balanced',
    }))
    .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

  // ── 3. Smart money DeFi positioning ───────────────────────
  const whaleIds = [...new Set(movements.map(m => m.whale_id).filter(Boolean) as string[])];
  let smDeFi = 0, smTotal = 0;

  if (whaleIds.length > 0) {
    const { data: whaleRaw } = await db
      .from('whales')
      .select('id, smart_money_flag')
      .in('id', whaleIds);

    const smIds = new Set(
      ((whaleRaw ?? []) as { id: string; smart_money_flag: boolean | null }[])
        .filter(w => w.smart_money_flag)
        .map(w => w.id),
    );

    for (const m of movements) {
      if (!m.whale_id) continue;
      const v = m.amount_usd ?? 0;
      smTotal += v;
      if (smIds.has(m.whale_id)) smDeFi += v;
    }
  }

  const sm_pct = smTotal > 0 ? smDeFi / smTotal : 0;

  // ── 4. Hourly rotation series ─────────────────────────────
  const seriesMap = new Map<string, { deposits: number; withdrawals: number }>();
  for (const m of movements) {
    const hour = new Date(m.block_time);
    hour.setMinutes(0, 0, 0);
    const key = hour.toISOString();
    if (!seriesMap.has(key)) seriesMap.set(key, { deposits: 0, withdrawals: 0 });
    const s = seriesMap.get(key)!;
    if (m.flow_type === 'defi_deposit')    s.deposits    += m.amount_usd ?? 0;
    if (m.flow_type === 'defi_withdrawal') s.withdrawals += m.amount_usd ?? 0;
  }

  const series = [...seriesMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({
      t,
      deposits_usd:    Math.round(v.deposits),
      withdrawals_usd: Math.round(v.withdrawals),
      net_usd:         Math.round(v.deposits - v.withdrawals),
    }));

  // ── 5. Rotation velocity ───────────────────────────────────
  // High velocity = lots of capital moving fast between protocols
  const totalVolume = totalDeposits + totalWithdrawals;
  const hours       = windowHours;
  const velocity_per_hour = Math.round(totalVolume / hours);

  const direction =
    net_flow_usd > 100_000  ? 'risk_on'  :  // capital flowing in
    net_flow_usd < -100_000 ? 'risk_off' :   // capital flowing out
    'rotation';                                // internal churn

  return NextResponse.json({
    ok: true,
    window_hours: windowHours,
    since,
    summary: {
      total_deposits_usd:    Math.round(totalDeposits),
      total_withdrawals_usd: Math.round(totalWithdrawals),
      net_flow_usd:          Math.round(net_flow_usd),
      direction,
      movement_count:        movements.length,
      velocity_per_hour_usd: velocity_per_hour,
    },
    smart_money: {
      pct_of_volume: Math.round(sm_pct * 100),
      positioning:   sm_pct > 0.4 ? 'heavy_smart_money' : sm_pct > 0.15 ? 'moderate' : 'retail_dominated',
    },
    by_protocol,
    series,
  });
}
