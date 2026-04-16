// ============================================================
// SONAR Intel API — Whale Clusters
// GET /api/intel/clusters?window=24h
// ============================================================
// Returns active wallet clusters:
//   - behavioral groupings derived from co-movement patterns
//   - whale cohorts grouped by flow type dominance
//   - smart money vs. regular whale split
//
// This is one of the most unique signals in SONAR:
// whale cohort behavior predicts rotations before price reacts.
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

  // ── 1. Active whales with recent movements ─────────────────
  const { data: movRaw } = await db
    .from('movements')
    .select('whale_id, flow_type, amount_usd, block_time')
    .gte('block_time', since)
    .not('whale_id', 'is', null);

  const movements = (movRaw ?? []) as Array<{
    whale_id: string;
    flow_type: string;
    amount_usd: number | null;
    block_time: string;
  }>;

  if (movements.length === 0) {
    return NextResponse.json({
      ok: true, window_hours: windowHours,
      clusters: [], smart_money: { count: 0, flow_bias: 'neutral' },
    });
  }

  // ── 2. Aggregate per whale ─────────────────────────────────
  const whaleIds = [...new Set(movements.map(m => m.whale_id))];

  const { data: whaleRaw } = await db
    .from('whales')
    .select('id, label, address, smart_money_flag, reputation_score, whale_type')
    .in('id', whaleIds);

  type WhaleMeta = {
    id: string; label: string | null; address: string;
    smart_money_flag: boolean | null; reputation_score: number | null; whale_type: string | null;
  };

  const whaleMap = new Map<string, WhaleMeta>(
    ((whaleRaw ?? []) as WhaleMeta[]).map(w => [w.id, w]),
  );

  // Per-whale flow tallies
  const whaleTally = new Map<string, {
    deposit: number; withdrawal: number; stake: number; unstake: number;
    defi_in: number; defi_out: number; total_usd: number; moves: number;
  }>();

  for (const m of movements) {
    if (!whaleTally.has(m.whale_id)) {
      whaleTally.set(m.whale_id, {
        deposit: 0, withdrawal: 0, stake: 0, unstake: 0,
        defi_in: 0, defi_out: 0, total_usd: 0, moves: 0,
      });
    }
    const t = whaleTally.get(m.whale_id)!;
    const v = m.amount_usd ?? 0;
    t.total_usd += v;
    t.moves++;
    if (m.flow_type === 'exchange_deposit')    t.deposit    += v;
    if (m.flow_type === 'exchange_withdrawal') t.withdrawal += v;
    if (m.flow_type === 'stake')               t.stake      += v;
    if (m.flow_type === 'unstake')             t.unstake    += v;
    if (m.flow_type === 'defi_deposit')        t.defi_in    += v;
    if (m.flow_type === 'defi_withdrawal')     t.defi_out   += v;
  }

  // ── 3. Classify each whale into a behavioral cluster ───────
  function classifyWhale(t: typeof whaleTally extends Map<string, infer V> ? V : never): string {
    if (t.withdrawal > t.deposit * 2 && t.withdrawal > 50_000) return 'accumulator';
    if (t.deposit    > t.withdrawal * 2 && t.deposit > 50_000) return 'distributor';
    if (t.stake      > t.unstake   * 2 && t.stake  > 50_000)  return 'staker';
    if (t.unstake    > t.stake     * 2 && t.unstake > 50_000)  return 'de-staker';
    if (t.defi_in    > t.defi_out  * 2 && t.defi_in > 50_000) return 'defi_entrant';
    if (t.defi_out   > t.defi_in   * 2 && t.defi_out > 50_000) return 'defi_exiter';
    return 'mixed';
  }

  // ── 4. Build cluster groups ────────────────────────────────
  const clusterBuckets = new Map<string, {
    type: string; members: string[]; total_usd: number; smart_money_count: number;
  }>();

  for (const [wid, tally] of whaleTally) {
    const meta  = whaleMap.get(wid);
    const ctype = classifyWhale(tally);
    if (!clusterBuckets.has(ctype)) {
      clusterBuckets.set(ctype, { type: ctype, members: [], total_usd: 0, smart_money_count: 0 });
    }
    const bucket = clusterBuckets.get(ctype)!;
    bucket.members.push(wid);
    bucket.total_usd += tally.total_usd;
    if (meta?.smart_money_flag) bucket.smart_money_count++;
  }

  const clusters = [...clusterBuckets.values()]
    .filter(c => c.members.length > 0)
    .map(c => ({
      type:               c.type,
      member_count:       c.members.length,
      smart_money_count:  c.smart_money_count,
      total_volume_usd:   Math.round(c.total_usd),
      signal:             clusterSignal(c.type),
    }))
    .sort((a, b) => b.total_volume_usd - a.total_volume_usd);

  // ── 5. Smart money cohort summary ─────────────────────────
  const smartWhales = [...whaleTally.entries()].filter(
    ([wid]) => whaleMap.get(wid)?.smart_money_flag,
  );

  let smNetBullish = 0;
  let smNetBearish = 0;
  for (const [, t] of smartWhales) {
    smNetBullish += t.withdrawal + t.unstake + t.defi_in;
    smNetBearish += t.deposit    + t.stake   + t.defi_out;
  }
  const smBias = smNetBullish > smNetBearish * 1.2 ? 'bullish'
               : smNetBearish > smNetBullish * 1.2 ? 'bearish'
               : 'neutral';

  return NextResponse.json({
    ok: true,
    window_hours: windowHours,
    since,
    clusters,
    smart_money: {
      count:     smartWhales.length,
      flow_bias: smBias,
      net_bullish_usd: Math.round(smNetBullish),
      net_bearish_usd: Math.round(smNetBearish),
    },
    total_active_whales: whaleIds.length,
  });
}

function clusterSignal(type: string): 'bullish' | 'bearish' | 'neutral' {
  if (['accumulator', 'de-staker', 'defi_entrant'].includes(type)) return 'bullish';
  if (['distributor', 'staker', 'defi_exiter'].includes(type))     return 'bearish';
  return 'neutral';
}
