// ============================================================
// SONAR — Shadow Family Analytics v1
// ============================================================
// Replay-safe DB query helpers for inspecting family intelligence
// coverage, alert archetype distribution, and lineage health.
//
// Design:
//   - DB access only — no hot-path dependencies
//   - All queries scoped by time window (default 24h)
//   - Results are plain data, not cached — callers decide TTL
//   - No external APIs, no fabricated data
//
// Typical callers:
//   - process-flows cron (summary logging, 27A)
//   - analytics endpoint (future operator tooling)
//   - manual debugging sessions
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

// ── Output shapes ─────────────────────────────────────────────

export interface FamilySignalStats {
  // Total sovereign signals in the window
  total_signals:              number;
  // Signals that have a shadow family context
  with_family_id:             number;
  family_coverage_pct:        number;  // with_family_id / total_signals * 100, rounded
  // Behavioral facet breakdowns (subset of with_family_id)
  with_gas_funding:           number;
  with_fan_out:               number;
  with_fan_in:                number;
  with_temporal_correlation:  number;
  with_privacy_activation:    number;
  with_token2022_activity:    number;
  // Confidence summary
  avg_family_confidence:      number | null;
  by_confidence_tier:         Array<{ tier: string; count: number }>;
  by_source_exchange:         Array<{ exchange: string; count: number }>;
}

export interface TopShadowFamily {
  family_id:              string;
  root_wallet:            string;
  source_exchange:        string | null;
  total_members:          number;
  confidence:             number;
  confidence_tier:        string;
  has_gas_funding:        boolean;
  has_fan_out:            boolean;
  has_privacy_activation: boolean;
  signal_count:           number;  // sovereign_signals referencing this family in the window
}

export interface FamilyArchetypeStats {
  // Alert counts from the `alerts` table in the window
  shadow_family_fan_out:                   number;
  shadow_gas_funding_chain:                number;
  // Signal-level: high-confidence signals that are also family-backed
  sovereign_high_confidence_family_backed: number;
  // Signal-level: all family-linked signals in the window
  total_family_linked:                     number;
}

export interface FamilyCovariance {
  gas_and_fan_out:    number;   // signals where BOTH has_gas_funding AND has_fan_out
  gas_only:           number;
  fan_out_only:       number;
  privacy_and_gas:    number;
  privacy_and_fan_out: number;
}

// ── 27A: getRecentFamilySignalStats ──────────────────────────

/**
 * Aggregate family intelligence coverage over recent sovereign signals.
 * Returns counts, coverage %, tier/exchange breakdowns.
 * Uses 8 parallel count queries + 1 detail query; total ~9 DB round-trips.
 */
export async function getRecentFamilySignalStats(
  db:    Db,
  hours: number = 24,
): Promise<FamilySignalStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    totalRes,
    withFamilyRes,
    withGasRes,
    withFanOutRes,
    withFanInRes,
    withTemporalRes,
    withPrivacyRes,
    withToken2022Res,
  ] = await Promise.all([
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).not('shadow_family_id', 'is', null),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_gas_funding', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_fan_out', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_fan_in', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_temporal_correlation', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_privacy_activation', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true }).gte('persisted_at', cutoff).eq('shadow_family_has_token2022_activity', true),
  ]);

  const total     = (totalRes.count    as number | null) ?? 0;
  const withFamily = (withFamilyRes.count as number | null) ?? 0;

  // Fetch lightweight detail rows for tier/exchange grouping
  // Cap at 2000 — sufficient for pattern detection without memory pressure
  const { data: familyRows } = await dba
    .from('sovereign_signals')
    .select('shadow_family_confidence_tier, shadow_family_source_exchange, shadow_family_confidence')
    .gte('persisted_at', cutoff)
    .not('shadow_family_id', 'is', null)
    .limit(2000);

  const tierCounts = new Map<string, number>();
  const exchCounts = new Map<string, number>();
  let totalConf = 0;
  let confCount = 0;

  for (const row of (familyRows ?? []) as Array<{
    shadow_family_confidence_tier: string | null;
    shadow_family_source_exchange: string | null;
    shadow_family_confidence:      number | null;
  }>) {
    const tier = row.shadow_family_confidence_tier ?? 'unknown';
    const exch = row.shadow_family_source_exchange ?? 'unknown';
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    exchCounts.set(exch, (exchCounts.get(exch) ?? 0) + 1);
    if (row.shadow_family_confidence !== null) {
      totalConf += row.shadow_family_confidence;
      confCount++;
    }
  }

  const by_confidence_tier = [...tierCounts.entries()]
    .map(([tier, count]) => ({ tier, count }))
    .sort((a, b) => b.count - a.count);

  const by_source_exchange = [...exchCounts.entries()]
    .map(([exchange, count]) => ({ exchange, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total_signals:             total,
    with_family_id:            withFamily,
    family_coverage_pct:       total > 0 ? Math.round((withFamily / total) * 100) : 0,
    with_gas_funding:          (withGasRes.count       as number | null) ?? 0,
    with_fan_out:              (withFanOutRes.count     as number | null) ?? 0,
    with_fan_in:               (withFanInRes.count      as number | null) ?? 0,
    with_temporal_correlation: (withTemporalRes.count  as number | null) ?? 0,
    with_privacy_activation:   (withPrivacyRes.count   as number | null) ?? 0,
    with_token2022_activity:   (withToken2022Res.count as number | null) ?? 0,
    avg_family_confidence:     confCount > 0 ? Math.round(totalConf / confCount) : null,
    by_confidence_tier,
    by_source_exchange,
  };
}

// ── 27A: getTopShadowFamilies ─────────────────────────────────

/**
 * Return the top N shadow families by confidence, annotated with
 * how many sovereign signals referenced each family in the time window.
 */
export async function getTopShadowFamilies(
  db:    Db,
  hours: number = 24,
  limit: number = 10,
): Promise<TopShadowFamily[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data: families } = await dba
    .from('shadow_families')
    .select(
      'family_id, root_wallet, source_exchange, total_members, ' +
      'confidence, confidence_tier, has_gas_funding, has_fan_out, has_privacy_activation',
    )
    .order('confidence', { ascending: false })
    .limit(limit * 3);  // over-fetch so we can sort by signal_count secondarily

  if (!families?.length) return [];

  type FamilyRow = {
    family_id:              string;
    root_wallet:            string;
    source_exchange:        string | null;
    total_members:          number;
    confidence:             number;
    confidence_tier:        string;
    has_gas_funding:        boolean;
    has_fan_out:            boolean;
    has_privacy_activation: boolean;
  };

  const familyIds = (families as FamilyRow[]).map(f => f.family_id);

  const { data: signalRows } = await dba
    .from('sovereign_signals')
    .select('shadow_family_id')
    .gte('persisted_at', cutoff)
    .in('shadow_family_id', familyIds);

  const signalCounts = new Map<string, number>();
  for (const row of (signalRows ?? []) as Array<{ shadow_family_id: string | null }>) {
    if (!row.shadow_family_id) continue;
    signalCounts.set(row.shadow_family_id, (signalCounts.get(row.shadow_family_id) ?? 0) + 1);
  }

  return (families as FamilyRow[])
    .map(f => ({ ...f, signal_count: signalCounts.get(f.family_id) ?? 0 }))
    .sort((a, b) => b.signal_count - a.signal_count || b.confidence - a.confidence)
    .slice(0, limit);
}

// ── 27A: getFamilyArchetypeStats ──────────────────────────────

/**
 * Count alert archetypes and high-confidence family-backed signals
 * over the given window. Useful for calibrating alert thresholds.
 */
export async function getFamilyArchetypeStats(
  db:    Db,
  hours: number = 24,
): Promise<FamilyArchetypeStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    fanOutRes,
    gasRes,
    highConfFamilyRes,
    totalFamilyRes,
  ] = await Promise.all([
    dba.from('alerts').select('*', { count: 'exact', head: true })
      .eq('alert_type', 'shadow_family_fan_out').gte('created_at', cutoff),
    dba.from('alerts').select('*', { count: 'exact', head: true })
      .eq('alert_type', 'shadow_gas_funding_chain').gte('created_at', cutoff),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .in('signal_confidence', ['direct_proof', 'strong_evidence'])
      .not('shadow_family_id', 'is', null),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .not('shadow_family_id', 'is', null),
  ]);

  return {
    shadow_family_fan_out:                   (fanOutRes.count          as number | null) ?? 0,
    shadow_gas_funding_chain:                (gasRes.count             as number | null) ?? 0,
    sovereign_high_confidence_family_backed: (highConfFamilyRes.count  as number | null) ?? 0,
    total_family_linked:                     (totalFamilyRes.count     as number | null) ?? 0,
  };
}

// ── 27D: getFamilyCovariance ──────────────────────────────────

/**
 * How often do gas-funding, fan-out, and privacy co-occur in the same signal?
 * Useful for understanding which behavioral combos are most common.
 */
export async function getFamilyCovariance(
  db:    Db,
  hours: number = 24,
): Promise<FamilyCovariance> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    gasAndFanOutRes,
    gasOnlyRes,
    fanOutOnlyRes,
    privacyAndGasRes,
    privacyAndFanOutRes,
  ] = await Promise.all([
    // Both gas-funding and fan-out
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .eq('shadow_family_has_gas_funding', true)
      .eq('shadow_family_has_fan_out', true),
    // Gas-funding but not fan-out
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .eq('shadow_family_has_gas_funding', true)
      .eq('shadow_family_has_fan_out', false),
    // Fan-out but not gas-funding
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .eq('shadow_family_has_gas_funding', false)
      .eq('shadow_family_has_fan_out', true),
    // Privacy activation + gas funding
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .eq('shadow_family_has_privacy_activation', true)
      .eq('shadow_family_has_gas_funding', true),
    // Privacy activation + fan-out
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff)
      .eq('shadow_family_has_privacy_activation', true)
      .eq('shadow_family_has_fan_out', true),
  ]);

  return {
    gas_and_fan_out:     (gasAndFanOutRes.count    as number | null) ?? 0,
    gas_only:            (gasOnlyRes.count          as number | null) ?? 0,
    fan_out_only:        (fanOutOnlyRes.count       as number | null) ?? 0,
    privacy_and_gas:     (privacyAndGasRes.count    as number | null) ?? 0,
    privacy_and_fan_out: (privacyAndFanOutRes.count as number | null) ?? 0,
  };
}

// ── 27D: getFamilyAlertLeaderboard ───────────────────────────

/**
 * Which family_ids are generating the most signals and/or alerts?
 * Returns up to `limit` family_ids sorted by recent signal activity.
 */
export async function getFamilyAlertLeaderboard(
  db:    Db,
  hours: number = 24,
  limit: number = 10,
): Promise<Array<{ family_id: string; signal_count: number; alert_count: number; source_exchange: string | null }>> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // Signals by family
  const { data: sigRows } = await dba
    .from('sovereign_signals')
    .select('shadow_family_id, shadow_family_source_exchange')
    .gte('persisted_at', cutoff)
    .not('shadow_family_id', 'is', null)
    .limit(5000);

  type SigRow = { shadow_family_id: string | null; shadow_family_source_exchange: string | null };

  const familySignals = new Map<string, { count: number; exchange: string | null }>();
  for (const row of (sigRows ?? []) as SigRow[]) {
    if (!row.shadow_family_id) continue;
    const existing = familySignals.get(row.shadow_family_id);
    if (existing) {
      existing.count++;
    } else {
      familySignals.set(row.shadow_family_id, {
        count:    1,
        exchange: row.shadow_family_source_exchange,
      });
    }
  }

  if (familySignals.size === 0) return [];

  // Alerts by family (stored in data.consolidation_key as archetype::family_id)
  const topFamilyIds = [...familySignals.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, limit)
    .map(([id]) => id);

  // Count alerts where consolidation_key ends with the family_id
  // PostgREST can't do LIKE on JSONB easily; count per family from the signal data
  const alertCounts = new Map<string, number>();
  const { data: alertRows } = await dba
    .from('alerts')
    .select('data')
    .in('alert_type', ['shadow_family_fan_out', 'shadow_gas_funding_chain'])
    .gte('created_at', cutoff)
    .limit(500);

  for (const row of (alertRows ?? []) as Array<{ data: unknown }>) {
    const d = row.data as Record<string, unknown> | null;
    const key = typeof d?.consolidation_key === 'string' ? d.consolidation_key : '';
    // consolidation_key format: "archetype::family_id"
    const parts = key.split('::');
    const familyId = parts[1] ?? '';
    if (familyId && topFamilyIds.includes(familyId)) {
      alertCounts.set(familyId, (alertCounts.get(familyId) ?? 0) + 1);
    }
  }

  return topFamilyIds.map(id => ({
    family_id:       id,
    signal_count:    familySignals.get(id)?.count    ?? 0,
    alert_count:     alertCounts.get(id)             ?? 0,
    source_exchange: familySignals.get(id)?.exchange ?? null,
  }));
}
