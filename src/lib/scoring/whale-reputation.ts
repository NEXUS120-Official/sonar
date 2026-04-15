// ============================================================
// SONAR v2.0 — Whale Reputation Scoring
// ============================================================
// Computes and persists whale reputation scores based on
// resolved signal outcomes over a rolling 30-day window.
//
// Called by the cron/resolve-outcomes job and on-demand.
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';

// ── Types ─────────────────────────────────────────────────────

export interface ReputationStats {
  whaleId:          string;
  signalCount30d:   number;
  hitRate30d:       number;       // at 1h window (most stable)
  meanReturn30d:    number;       // mean return at 1h
  reputationScore:  number;       // 0.0–1.0 composite
  smartMoneyFlag:   boolean;      // true if hitRate30d > 0.62 AND signalCount30d >= 10
}

// ── Score formula ──────────────────────────────────────────────
//
// base         = hitRate30d (0.0–1.0)
// volume_bonus = min(signalCount30d / 50, 0.1)  -- up to +0.1 for active whales
// return_bonus = clamp(meanReturn30d / 0.05, -0.1, 0.1)  -- ±0.1 based on mean return
// score        = clamp(base + volume_bonus + return_bonus, 0.0, 1.0)

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function computeScore(hitRate: number, signalCount: number, meanReturn: number): number {
  const base         = hitRate;
  const volumeBonus  = Math.min(signalCount / 50, 0.1);
  const returnBonus  = clamp(meanReturn / 0.05, -0.1, 0.1);
  return clamp(base + volumeBonus + returnBonus, 0.0, 1.0);
}

// ── Per-whale computation ─────────────────────────────────────

export async function computeReputationStats(
  whaleId: string,
  db: ReturnType<typeof createAdminClient>,
): Promise<ReputationStats> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch resolved outcomes in the 30d window
  const { data: outcomes, error } = await (db as any)
    .from('whale_signal_outcomes')
    .select('hit_1h, return_1h, signal_direction')
    .eq('whale_id', whaleId)
    .eq('resolved', true)
    .gte('signal_time', since30d);

  if (error) {
    console.error('[whale-reputation] fetch outcomes error', error);
    // Return neutral defaults on error
    return {
      whaleId,
      signalCount30d:  0,
      hitRate30d:      0.5,
      meanReturn30d:   0,
      reputationScore: 0.5,
      smartMoneyFlag:  false,
    };
  }

  const rows = (outcomes ?? []) as Array<{
    hit_1h:           boolean | null;
    return_1h:        number | null;
    signal_direction: string;
  }>;

  const signalCount30d = rows.length;

  if (signalCount30d === 0) {
    return {
      whaleId,
      signalCount30d:  0,
      hitRate30d:      0.5,
      meanReturn30d:   0,
      reputationScore: 0.5,
      smartMoneyFlag:  false,
    };
  }

  // Compute hit rate at 1h window (most stable signal window)
  const resolvedWithHit = rows.filter((r) => r.hit_1h !== null);
  const hitCount        = resolvedWithHit.filter((r) => r.hit_1h === true).length;
  const hitRate30d      = resolvedWithHit.length > 0 ? hitCount / resolvedWithHit.length : 0.5;

  // Compute mean return at 1h
  const resolvedWithReturn = rows.filter((r) => r.return_1h !== null);
  const meanReturn30d      =
    resolvedWithReturn.length > 0
      ? resolvedWithReturn.reduce((sum, r) => sum + (r.return_1h ?? 0), 0) / resolvedWithReturn.length
      : 0;

  const reputationScore = computeScore(hitRate30d, signalCount30d, meanReturn30d);
  const smartMoneyFlag  = hitRate30d > 0.62 && signalCount30d >= 10;

  return {
    whaleId,
    signalCount30d,
    hitRate30d,
    meanReturn30d,
    reputationScore,
    smartMoneyFlag,
  };
}

// ── Upsert reputation back to whales table ────────────────────

async function persistReputationStats(
  stats: ReputationStats,
  db: ReturnType<typeof createAdminClient>,
): Promise<void> {
  const { error } = await (db as any)
    .from('whales')
    .update({
      reputation_score:   stats.reputationScore,
      signal_count_30d:   stats.signalCount30d,
      hit_rate_30d:       stats.hitRate30d,
      mean_return_30d:    stats.meanReturn30d,
      last_reputation_at: new Date().toISOString(),
      smart_money_flag:   stats.smartMoneyFlag,
    })
    .eq('id', stats.whaleId);

  if (error) {
    console.error('[whale-reputation] persist error for whale', stats.whaleId, error);
  }
}

// ── Batch update all whales ───────────────────────────────────

export async function updateAllReputations(
  db: ReturnType<typeof createAdminClient>,
): Promise<{ updated: number; smart_money_count: number }> {
  // Fetch all active whale IDs
  const { data: whaleRows, error } = await db
    .from('whales')
    .select('id')
    .eq('is_active', true);

  if (error) {
    console.error('[whale-reputation] failed to fetch whale ids', error);
    return { updated: 0, smart_money_count: 0 };
  }

  const whaleIds = ((whaleRows ?? []) as { id: string }[]).map((w) => w.id);

  let updated          = 0;
  let smartMoneyCount  = 0;

  for (const whaleId of whaleIds) {
    const stats = await computeReputationStats(whaleId, db);
    await persistReputationStats(stats, db);
    updated++;
    if (stats.smartMoneyFlag) smartMoneyCount++;
  }

  console.log(
    `[whale-reputation] updated=${updated} smart_money=${smartMoneyCount}`,
  );

  return { updated, smart_money_count: smartMoneyCount };
}

// ── Batch update a specific set of whale IDs ─────────────────

export async function updateReputationsForWhales(
  whaleIds: string[],
  db: ReturnType<typeof createAdminClient>,
): Promise<{ updated: number; smart_money_count: number }> {
  const unique = [...new Set(whaleIds)];
  let updated         = 0;
  let smartMoneyCount = 0;

  for (const whaleId of unique) {
    const stats = await computeReputationStats(whaleId, db);
    await persistReputationStats(stats, db);
    updated++;
    if (stats.smartMoneyFlag) smartMoneyCount++;
  }

  return { updated, smart_money_count: smartMoneyCount };
}
