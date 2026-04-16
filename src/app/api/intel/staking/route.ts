// ============================================================
// SONAR Intel API — Staking Velocity
// GET /api/intel/staking?window=24h
// ============================================================
// Staking velocity is one of SONAR's most unique signals.
// Unlike raw staking flow, velocity measures ACCELERATION —
// how fast are staking/unstaking decisions changing?
//
// High positive velocity → whales are suddenly rushing to stake
//   → risk-off / defensive positioning → bearish SOL short-term
//   → but bullish for network security / long-term
//
// High negative velocity → mass unstaking acceleration
//   → whales want liquid SOL → usually precedes large moves
//
// Response:
//   current_net_flow_usd     - net staking flow in window
//   velocity                 - change in staking rate (derivative)
//   acceleration             - change in velocity (2nd derivative)
//   series                   - hourly staking/unstaking time series
//   largest_stakers          - top stakers in window with labels
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
  // Double the window for velocity calculation (we need "before" to compute derivative)
  const since = new Date(Date.now() - windowHours * 2 * 60 * 60_000).toISOString();

  // ── 1. Load staking movements ──────────────────────────────
  const { data: movRaw } = await db
    .from('movements')
    .select('flow_type, amount_usd, block_time, whale_id, from_address')
    .in('flow_type', ['stake', 'unstake'])
    .gte('block_time', since)
    .order('block_time', { ascending: true })
    .limit(1000);

  const movements = (movRaw ?? []) as Array<{
    flow_type: string;
    amount_usd: number | null;
    block_time: string;
    whale_id: string | null;
    from_address: string;
  }>;

  // ── 2. Split into two halves for velocity calculation ──────
  const halfMs  = Date.now() - windowHours * 60 * 60_000;
  const inWindow = movements.filter(m => new Date(m.block_time).getTime() >= halfMs);
  const before   = movements.filter(m => new Date(m.block_time).getTime() < halfMs);

  function netStaking(mvs: typeof movements): number {
    let stake = 0, unstake = 0;
    for (const m of mvs) {
      const v = m.amount_usd ?? 0;
      if (m.flow_type === 'stake')   stake   += v;
      if (m.flow_type === 'unstake') unstake += v;
    }
    return stake - unstake; // positive = net stake (bearish for price), negative = net unstake (bullish)
  }

  const currentNet = netStaking(inWindow);
  const priorNet   = netStaking(before);
  const velocity   = currentNet - priorNet; // positive = staking is accelerating

  // ── 3. Hourly time series ──────────────────────────────────
  const seriesMap = new Map<string, { staked: number; unstaked: number }>();

  for (const m of inWindow) {
    const hour = new Date(m.block_time);
    hour.setMinutes(0, 0, 0);
    const key = hour.toISOString();
    if (!seriesMap.has(key)) seriesMap.set(key, { staked: 0, unstaked: 0 });
    const s = seriesMap.get(key)!;
    if (m.flow_type === 'stake')   s.staked   += m.amount_usd ?? 0;
    if (m.flow_type === 'unstake') s.unstaked += m.amount_usd ?? 0;
  }

  const series = [...seriesMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => ({
      t,
      staked_usd:   Math.round(v.staked),
      unstaked_usd: Math.round(v.unstaked),
      net_usd:      Math.round(v.staked - v.unstaked),
    }));

  // Compute 2nd derivative (acceleration) from series
  const nets = series.map(s => s.net_usd);
  let acceleration = 0;
  if (nets.length >= 3) {
    const d1 = nets[nets.length - 1] - nets[nets.length - 2];
    const d2 = nets[nets.length - 2] - nets[nets.length - 3];
    acceleration = d1 - d2;
  }

  // ── 4. Largest individual staking moves ────────────────────
  const whaleIds = [...new Set(inWindow.map(m => m.whale_id).filter(Boolean) as string[])];

  type WhaleMeta = { id: string; label: string | null; smart_money_flag: boolean | null };
  let whaleMap = new Map<string, WhaleMeta>();

  if (whaleIds.length > 0) {
    const { data: whaleRaw } = await db
      .from('whales')
      .select('id, label, smart_money_flag')
      .in('id', whaleIds);
    whaleMap = new Map(((whaleRaw ?? []) as WhaleMeta[]).map(w => [w.id, w]));
  }

  const topMoves = [...inWindow]
    .sort((a, b) => (b.amount_usd ?? 0) - (a.amount_usd ?? 0))
    .slice(0, 10)
    .map(m => {
      const whale = m.whale_id ? whaleMap.get(m.whale_id) : null;
      return {
        flow_type:   m.flow_type,
        amount_usd:  Math.round(m.amount_usd ?? 0),
        block_time:  m.block_time,
        whale_label: whale?.label ?? (m.from_address ? `${m.from_address.slice(0, 8)}…` : null),
        smart_money: whale?.smart_money_flag ?? false,
      };
    });

  // ── 5. Signal interpretation ───────────────────────────────
  const signal =
    velocity < -200_000 ? 'bullish'    // rapid unstaking → whales want liquid SOL
  : velocity >  200_000 ? 'bearish'   // rapid staking → defensive
  : currentNet < -100_000 ? 'bullish' // net unstaking in window
  : currentNet >  100_000 ? 'bearish' // net staking in window
  : 'neutral';

  return NextResponse.json({
    ok: true,
    window_hours: windowHours,
    since: new Date(halfMs).toISOString(),
    staking: {
      current_net_flow_usd: Math.round(currentNet),
      prior_net_flow_usd:   Math.round(priorNet),
      velocity_usd:         Math.round(velocity),
      acceleration_usd:     Math.round(acceleration),
      signal,
      interpretation: signal === 'bullish'
        ? 'Whales are unstaking — liquid SOL expected'
        : signal === 'bearish'
        ? 'Whales are staking — defensive positioning'
        : 'Staking flow neutral',
    },
    totals: {
      staked_usd:   Math.round(inWindow.filter(m => m.flow_type === 'stake').reduce((s, m) => s + (m.amount_usd ?? 0), 0)),
      unstaked_usd: Math.round(inWindow.filter(m => m.flow_type === 'unstake').reduce((s, m) => s + (m.amount_usd ?? 0), 0)),
      move_count:   inWindow.length,
    },
    series,
    top_moves: topMoves,
  });
}
