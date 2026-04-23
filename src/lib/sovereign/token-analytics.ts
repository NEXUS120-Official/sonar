// ============================================================
// SONAR — Sovereign Token Analytics v1
// ============================================================
// Replay-safe DB query helpers for inspecting token intelligence
// coverage: program type distribution, delta pattern stats,
// Token-2022 extension frequency.
//
// Design:
//   - DB access only — no hot-path dependencies, no external APIs
//   - All queries scoped by time window (default 24h)
//   - Results are plain data, not cached
//   - Useful for: calibration, threshold tuning, coverage audit
//
// Block 28 deliverable (28E).
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

// ── Output shapes ─────────────────────────────────────────────

export interface TokenProgramStats {
  total_signals:         number;
  spl_token_count:       number;
  token_2022_count:      number;
  unknown_program_count: number;
  is_token_2022_count:   number;   // from is_token_2022 boolean (may differ from program type)
  token_2022_coverage_pct: number; // token_2022_count / total * 100 (only signals with token movement)
}

export interface TokenDeltaPatternStats {
  by_pattern: Array<{ pattern: string; count: number }>;
  asymmetric_count:      number;
  possible_fee_count:    number;
  analyzed_count:        number;   // signals where token_delta_pattern IS NOT NULL
  unanalyzed_count:      number;   // signals where token_delta_pattern IS NULL (no token movement / Helius path)
}

export interface Token2022ContextStats {
  token_2022_signals:          number;
  with_confidential_transfer:  number;
  with_transfer_hook:          number;
  with_permanent_delegate:     number;
  with_auditor_key:            number;
  with_transfer_fee:           number;
  // Delta-analysis-derived (not registry-confirmed)
  with_asymmetric_delta:       number;
  with_possible_fee_behavior:  number;
  // Top risk flags from token_risk_flags[] (GIN column)
  top_risk_flags:              Array<{ flag: string; count: number }>;
}

// ── 28E: getRecentTokenProgramStats ──────────────────────────

/**
 * Count sovereign signals by token program type in the given window.
 * Useful for understanding how much of the signal flow is Token-2022 vs SPL.
 */
export async function getRecentTokenProgramStats(
  db:    Db,
  hours: number = 24,
): Promise<TokenProgramStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    totalRes,
    splRes,
    t2022Res,
    unknownRes,
    isT2022Res,
  ] = await Promise.all([
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('token_program_type', 'spl_token'),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('token_program_type', 'token_2022'),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('token_program_type', 'unknown'),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('is_token_2022', true),
  ]);

  const total   = (totalRes.count   as number | null) ?? 0;
  const t2022   = (t2022Res.count   as number | null) ?? 0;
  const spl     = (splRes.count     as number | null) ?? 0;
  const analyzed = spl + t2022;  // signals that had a non-unknown program type

  return {
    total_signals:           total,
    spl_token_count:         spl,
    token_2022_count:        t2022,
    unknown_program_count:   (unknownRes.count as number | null) ?? 0,
    is_token_2022_count:     (isT2022Res.count as number | null) ?? 0,
    token_2022_coverage_pct: analyzed > 0 ? Math.round((t2022 / analyzed) * 100) : 0,
  };
}

// ── 28E: getRecentTokenDeltaPatternStats ─────────────────────

/**
 * Count sovereign signals by token delta pattern classification.
 * Only sovereign_rpc path signals have a non-null token_delta_pattern.
 */
export async function getRecentTokenDeltaPatternStats(
  db:    Db,
  hours: number = 24,
): Promise<TokenDeltaPatternStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    asymmetricRes,
    possibleFeeRes,
    analyzedRes,
    totalRes,
  ] = await Promise.all([
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_asymmetric_token_delta', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('possible_transfer_fee_behavior', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).not('token_delta_pattern', 'is', null),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff),
  ]);

  const total    = (totalRes.count    as number | null) ?? 0;
  const analyzed = (analyzedRes.count as number | null) ?? 0;

  // Fetch pattern distribution (lightweight — only pattern column)
  const { data: patternRows } = await dba
    .from('sovereign_signals')
    .select('token_delta_pattern')
    .gte('persisted_at', cutoff)
    .not('token_delta_pattern', 'is', null)
    .limit(5000);

  const patternCounts = new Map<string, number>();
  for (const row of (patternRows ?? []) as Array<{ token_delta_pattern: string | null }>) {
    const p = row.token_delta_pattern ?? 'unknown';
    patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
  }

  const by_pattern = [...patternCounts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);

  return {
    by_pattern,
    asymmetric_count:   (asymmetricRes.count   as number | null) ?? 0,
    possible_fee_count: (possibleFeeRes.count  as number | null) ?? 0,
    analyzed_count:     analyzed,
    unanalyzed_count:   total - analyzed,
  };
}

// ── 28E: getRecentToken2022ContextStats ───────────────────────

/**
 * Count Token-2022 extension presence and delta-derived signals
 * over the given window. Useful for evaluating fog-piercing coverage.
 */
export async function getRecentToken2022ContextStats(
  db:    Db,
  hours: number = 24,
): Promise<Token2022ContextStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    t2022Res,
    confTransRes,
    hookRes,
    permDelegateRes,
    auditorRes,
    feeRes,
    asymmetricRes,
    possibleFeeRes,
  ] = await Promise.all([
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('is_token_2022', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_confidential_transfer', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_transfer_hook', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_permanent_delegate', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_auditor_key', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_transfer_fee', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('has_asymmetric_token_delta', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('possible_transfer_fee_behavior', true),
  ]);

  // Top risk flags from GIN-indexed token_risk_flags column
  // Fetch flag data and aggregate in memory (GIN array column)
  const { data: flagRows } = await dba
    .from('sovereign_signals')
    .select('token_risk_flags')
    .gte('persisted_at', cutoff)
    .eq('is_token_2022', true)
    .limit(2000);

  const flagCounts = new Map<string, number>();
  for (const row of (flagRows ?? []) as Array<{ token_risk_flags: string[] | null }>) {
    for (const flag of row.token_risk_flags ?? []) {
      flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
    }
  }

  const top_risk_flags = [...flagCounts.entries()]
    .map(([flag, count]) => ({ flag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    token_2022_signals:         (t2022Res.count        as number | null) ?? 0,
    with_confidential_transfer: (confTransRes.count    as number | null) ?? 0,
    with_transfer_hook:         (hookRes.count         as number | null) ?? 0,
    with_permanent_delegate:    (permDelegateRes.count as number | null) ?? 0,
    with_auditor_key:           (auditorRes.count      as number | null) ?? 0,
    with_transfer_fee:          (feeRes.count          as number | null) ?? 0,
    with_asymmetric_delta:      (asymmetricRes.count   as number | null) ?? 0,
    with_possible_fee_behavior: (possibleFeeRes.count  as number | null) ?? 0,
    top_risk_flags,
  };
}


// ── 31D: deeper mint enrichment depth stats ───────────────────

export interface MintEnrichmentDepthStats {
  total_enriched_mints:     number;
  with_native_metadata:     number;
  with_transfer_fee_bps:    number;
  with_transfer_hook_prog:  number;
  with_freeze_authority:    number;
  with_mint_authority_live: number;
  high_confidence:          number;
  medium_confidence:        number;
  low_confidence:           number;
}

export async function getRecentMintEnrichmentDepthStats(
  db:    Db,
  hours: number = 24 * 7,
): Promise<MintEnrichmentDepthStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    totalRes,
    nativeMetaRes,
    feeBpsRes,
    hookProgRes,
    freezeAuthRes,
    mintAuthRes,
    hiRes,
    medRes,
    lowRes,
  ] = await Promise.all([
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).eq('has_native_metadata', true),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).not('transfer_fee_bps', 'is', null),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).not('transfer_hook_program', 'is', null),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).not('freeze_authority', 'is', null),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).not('mint_authority', 'is', null),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).eq('confidence', 'high'),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).eq('confidence', 'medium'),
    dba.from('sovereign_mint_enrichments').select('*', { count: 'exact', head: true })
      .gte('updated_at', cutoff).eq('confidence', 'low'),
  ]);

  return {
    total_enriched_mints:     (totalRes.count      as number | null) ?? 0,
    with_native_metadata:     (nativeMetaRes.count as number | null) ?? 0,
    with_transfer_fee_bps:    (feeBpsRes.count     as number | null) ?? 0,
    with_transfer_hook_prog:  (hookProgRes.count   as number | null) ?? 0,
    with_freeze_authority:    (freezeAuthRes.count as number | null) ?? 0,
    with_mint_authority_live: (mintAuthRes.count   as number | null) ?? 0,
    high_confidence:          (hiRes.count         as number | null) ?? 0,
    medium_confidence:        (medRes.count        as number | null) ?? 0,
    low_confidence:           (lowRes.count        as number | null) ?? 0,
  };
}


// ── 33C: privacy lifecycle stage stats ───────────────────────

export interface PrivacyLifecycleStageStats {
  by_stage: Array<{ stage: string; count: number }>;
  public_side_count: number;
  family_reemergence_count: number;
}

export async function getRecentPrivacyLifecycleStageStats(
  db:    Db,
  hours: number = 24 * 7,
): Promise<PrivacyLifecycleStageStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    publicSideRes,
    familyRes,
    stageRowsRes,
  ] = await Promise.all([
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('privacy_public_side', true),
    dba.from('sovereign_signals').select('*', { count: 'exact', head: true })
      .gte('persisted_at', cutoff).eq('privacy_reemergence_family_context', true),
    dba.from('sovereign_signals')
      .select('privacy_lifecycle_stage')
      .gte('persisted_at', cutoff)
      .limit(5000),
  ]);

  const counts = new Map<string, number>();
  for (const row of (stageRowsRes.data ?? []) as Array<{ privacy_lifecycle_stage: string | null }>) {
    const stage = row.privacy_lifecycle_stage ?? 'none';
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }

  const by_stage = [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => b.count - a.count);

  return {
    by_stage,
    public_side_count:        (publicSideRes.count as number | null) ?? 0,
    family_reemergence_count: (familyRes.count     as number | null) ?? 0,
  };
}


// ── 34A: privacy lifecycle token breakdown ───────────────────

export interface PrivacyLifecycleTokenBreakdownRow {
  token_mint:   string;
  token_symbol: string | null;
  stage:        string;
  signal_count: number;
  total_usd:    number;
}

export async function getPrivacyLifecycleTokenBreakdown(
  db:    Db,
  hours: number = 24 * 7,
  limit: number = 50,
): Promise<PrivacyLifecycleTokenBreakdownRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('sovereign_signals')
    .select('token_mint, token_symbol, privacy_lifecycle_stage, amount_usd')
    .gte('persisted_at', cutoff)
    .not('token_mint', 'is', null)
    .not('privacy_lifecycle_stage', 'is', null)
    .neq('privacy_lifecycle_stage', 'none')
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleTokenBreakdownRow>();

  for (const row of (data ?? []) as Array<{
    token_mint: string | null;
    token_symbol: string | null;
    privacy_lifecycle_stage: string | null;
    amount_usd: number | null;
  }>) {
    if (!row.token_mint || !row.privacy_lifecycle_stage) continue;
    const key = `${row.token_mint}::${row.privacy_lifecycle_stage}`;
    const prev = agg.get(key);
    if (prev) {
      prev.signal_count += 1;
      prev.total_usd += row.amount_usd ?? 0;
    } else {
      agg.set(key, {
        token_mint:   row.token_mint,
        token_symbol: row.token_symbol,
        stage:        row.privacy_lifecycle_stage,
        signal_count: 1,
        total_usd:    row.amount_usd ?? 0,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.total_usd - a.total_usd) || (b.signal_count - a.signal_count))
    .slice(0, limit);
}

// ── 34B: privacy lifecycle exchange-origin breakdown ─────────

export interface PrivacyLifecycleExchangeBreakdownRow {
  source_exchange: string;
  stage:           string;
  signal_count:    number;
  total_usd:       number;
  public_side_count: number;
}

export async function getPrivacyLifecycleExchangeBreakdown(
  db:    Db,
  hours: number = 24 * 7,
): Promise<PrivacyLifecycleExchangeBreakdownRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('sovereign_signals')
    .select('shadow_source_exchange, shadow_family_source_exchange, privacy_lifecycle_stage, amount_usd, privacy_public_side')
    .gte('persisted_at', cutoff)
    .neq('privacy_lifecycle_stage', 'none')
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleExchangeBreakdownRow>();

  for (const row of (data ?? []) as Array<{
    shadow_source_exchange: string | null;
    shadow_family_source_exchange: string | null;
    privacy_lifecycle_stage: string | null;
    amount_usd: number | null;
    privacy_public_side: boolean | null;
  }>) {
    const ex = row.shadow_source_exchange ?? row.shadow_family_source_exchange ?? 'unknown';
    const stage = row.privacy_lifecycle_stage ?? 'none';
    const key = `${ex}::${stage}`;
    const prev = agg.get(key);

    if (prev) {
      prev.signal_count += 1;
      prev.total_usd += row.amount_usd ?? 0;
      prev.public_side_count += row.privacy_public_side ? 1 : 0;
    } else {
      agg.set(key, {
        source_exchange:  ex,
        stage,
        signal_count:     1,
        total_usd:        row.amount_usd ?? 0,
        public_side_count: row.privacy_public_side ? 1 : 0,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.signal_count - a.signal_count) || (b.total_usd - a.total_usd));
}

// ── 34C: family privacy re-emergence leaderboard ─────────────

export interface PrivacyLifecycleFamilyLeaderboardRow {
  family_id:         string;
  source_exchange:   string | null;
  signal_count:      number;
  total_usd:         number;
  max_family_confidence: number | null;
  stage_counts:      Record<string, number>;
}

export async function getPrivacyLifecycleFamilyLeaderboard(
  db:    Db,
  hours: number = 24 * 7,
  limit: number = 25,
): Promise<PrivacyLifecycleFamilyLeaderboardRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('sovereign_signals')
    .select('shadow_family_id, shadow_family_source_exchange, shadow_family_confidence, privacy_lifecycle_stage, amount_usd')
    .gte('persisted_at', cutoff)
    .not('shadow_family_id', 'is', null)
    .neq('privacy_lifecycle_stage', 'none')
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleFamilyLeaderboardRow>();

  for (const row of (data ?? []) as Array<{
    shadow_family_id: string | null;
    shadow_family_source_exchange: string | null;
    shadow_family_confidence: number | null;
    privacy_lifecycle_stage: string | null;
    amount_usd: number | null;
  }>) {
    if (!row.shadow_family_id) continue;
    const prev = agg.get(row.shadow_family_id);
    const stage = row.privacy_lifecycle_stage ?? 'none';

    if (prev) {
      prev.signal_count += 1;
      prev.total_usd += row.amount_usd ?? 0;
      prev.max_family_confidence = Math.max(prev.max_family_confidence ?? 0, row.shadow_family_confidence ?? 0);
      prev.stage_counts[stage] = (prev.stage_counts[stage] ?? 0) + 1;
    } else {
      agg.set(row.shadow_family_id, {
        family_id: row.shadow_family_id,
        source_exchange: row.shadow_family_source_exchange,
        signal_count: 1,
        total_usd: row.amount_usd ?? 0,
        max_family_confidence: row.shadow_family_confidence,
        stage_counts: { [stage]: 1 },
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.signal_count - a.signal_count) || (b.total_usd - a.total_usd))
    .slice(0, limit);
}

// ── 34D: privacy lifecycle × risk flag co-occurrence ─────────

export interface PrivacyLifecycleRiskCooccurrenceRow {
  stage: string;
  risk_flag: string;
  count: number;
}

export async function getPrivacyLifecycleRiskCooccurrence(
  db:    Db,
  hours: number = 24 * 7,
  limit: number = 50,
): Promise<PrivacyLifecycleRiskCooccurrenceRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('sovereign_signals')
    .select('privacy_lifecycle_stage, token_risk_flags')
    .gte('persisted_at', cutoff)
    .neq('privacy_lifecycle_stage', 'none')
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleRiskCooccurrenceRow>();

  for (const row of (data ?? []) as Array<{
    privacy_lifecycle_stage: string | null;
    token_risk_flags: string[] | null;
  }>) {
    const stage = row.privacy_lifecycle_stage ?? 'none';
    for (const flag of row.token_risk_flags ?? []) {
      const key = `${stage}::${flag}`;
      const prev = agg.get(key);
      if (prev) {
        prev.count += 1;
      } else {
        agg.set(key, { stage, risk_flag: flag, count: 1 });
      }
    }
  }

  return [...agg.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export interface PrivacyLifecycleSequenceStats {
  by_stage_pair: Array<{ pair: string; count: number }>;
  avg_elapsed_seconds: number;
  high_confidence_count: number;
}

export async function getRecentPrivacyLifecycleSequenceStats(
  db: Db,
  hours: number = 24 * 7,
): Promise<PrivacyLifecycleSequenceStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    rowsRes,
    highConfRes,
  ] = await Promise.all([
    dba
      .from('privacy_lifecycle_sequences')
      .select('start_stage, end_stage, elapsed_seconds')
      .gte('end_event_time', cutoff)
      .limit(5000),
    dba
      .from('privacy_lifecycle_sequences')
      .select('*', { count: 'exact', head: true })
      .gte('end_event_time', cutoff)
      .gte('sequence_confidence', 70),
  ]);

  const pairCounts = new Map<string, number>();
  let elapsedSum = 0;
  let elapsedN = 0;

  for (const row of (rowsRes.data ?? []) as Array<{
    start_stage: string;
    end_stage: string;
    elapsed_seconds: number | null;
  }>) {
    const pair = `${row.start_stage} -> ${row.end_stage}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);

    if (typeof row.elapsed_seconds === 'number') {
      elapsedSum += row.elapsed_seconds;
      elapsedN += 1;
    }
  }

  return {
    by_stage_pair: [...pairCounts.entries()]
      .map(([pair, count]) => ({ pair, count }))
      .sort((a, b) => b.count - a.count),
    avg_elapsed_seconds: elapsedN > 0 ? Math.round(elapsedSum / elapsedN) : 0,
    high_confidence_count: (highConfRes.count as number | null) ?? 0,
  };
}


export interface PrivacyLifecycleEventStageStats {
  by_stage: Array<{ stage: string; count: number }>;
  public_side_count: number;
  total_events: number;
}

export async function getRecentPrivacyLifecycleEventStageStats(
  db: Db,
  hours: number = 24 * 7,
): Promise<PrivacyLifecycleEventStageStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    totalRes,
    publicSideRes,
    rowsRes,
  ] = await Promise.all([
    dba.from('privacy_lifecycle_events').select('*', { count: 'exact', head: true })
      .gte('event_time', cutoff),
    dba.from('privacy_lifecycle_events').select('*', { count: 'exact', head: true })
      .gte('event_time', cutoff).eq('is_public_side', true),
    dba.from('privacy_lifecycle_events')
      .select('privacy_lifecycle_stage')
      .gte('event_time', cutoff)
      .limit(5000),
  ]);

  const counts = new Map<string, number>();
  for (const row of (rowsRes.data ?? []) as Array<{ privacy_lifecycle_stage: string | null }>) {
    const stage = row.privacy_lifecycle_stage ?? 'none';
    counts.set(stage, (counts.get(stage) ?? 0) + 1);
  }

  return {
    by_stage: [...counts.entries()]
      .map(([stage, count]) => ({ stage, count }))
      .sort((a, b) => b.count - a.count),
    public_side_count: (publicSideRes.count as number | null) ?? 0,
    total_events: (totalRes.count as number | null) ?? 0,
  };
}

export interface PrivacyLifecycleEventTokenLeaderboardRow {
  token_mint: string | null;
  token_symbol: string | null;
  event_count: number;
  total_usd: number;
}

export async function getPrivacyLifecycleEventTokenLeaderboard(
  db: Db,
  hours: number = 24 * 7,
  limit: number = 25,
): Promise<PrivacyLifecycleEventTokenLeaderboardRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('privacy_lifecycle_events')
    .select('token_mint, token_symbol, amount_usd')
    .gte('event_time', cutoff)
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleEventTokenLeaderboardRow>();

  for (const row of (data ?? []) as Array<{
    token_mint: string | null;
    token_symbol: string | null;
    amount_usd: number | null;
  }>) {
    const key = row.token_mint ?? 'unknown';
    const prev = agg.get(key);
    if (prev) {
      prev.event_count += 1;
      prev.total_usd += row.amount_usd ?? 0;
    } else {
      agg.set(key, {
        token_mint: row.token_mint,
        token_symbol: row.token_symbol,
        event_count: 1,
        total_usd: row.amount_usd ?? 0,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.event_count - a.event_count) || (b.total_usd - a.total_usd))
    .slice(0, limit);
}

export interface PrivacyLifecycleEventExchangeStatsRow {
  source_exchange: string;
  event_count: number;
  public_side_count: number;
}

export async function getPrivacyLifecycleEventExchangeStats(
  db: Db,
  hours: number = 24 * 7,
): Promise<PrivacyLifecycleEventExchangeStatsRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('privacy_lifecycle_events')
    .select('shadow_source_exchange, is_public_side')
    .gte('event_time', cutoff)
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleEventExchangeStatsRow>();

  for (const row of (data ?? []) as Array<{
    shadow_source_exchange: string | null;
    is_public_side: boolean | null;
  }>) {
    const ex = row.shadow_source_exchange ?? 'unknown';
    const prev = agg.get(ex);
    if (prev) {
      prev.event_count += 1;
      prev.public_side_count += row.is_public_side ? 1 : 0;
    } else {
      agg.set(ex, {
        source_exchange: ex,
        event_count: 1,
        public_side_count: row.is_public_side ? 1 : 0,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => b.event_count - a.event_count);
}

export interface PrivacyLifecycleEventFamilyLeaderboardRow {
  shadow_family_id: string;
  event_count: number;
  total_usd: number;
}

export async function getPrivacyLifecycleEventFamilyLeaderboard(
  db: Db,
  hours: number = 24 * 7,
  limit: number = 25,
): Promise<PrivacyLifecycleEventFamilyLeaderboardRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('privacy_lifecycle_events')
    .select('shadow_family_id, amount_usd')
    .gte('event_time', cutoff)
    .not('shadow_family_id', 'is', null)
    .limit(5000);

  const agg = new Map<string, PrivacyLifecycleEventFamilyLeaderboardRow>();

  for (const row of (data ?? []) as Array<{
    shadow_family_id: string | null;
    amount_usd: number | null;
  }>) {
    if (!row.shadow_family_id) continue;
    const prev = agg.get(row.shadow_family_id);
    if (prev) {
      prev.event_count += 1;
      prev.total_usd += row.amount_usd ?? 0;
    } else {
      agg.set(row.shadow_family_id, {
        shadow_family_id: row.shadow_family_id,
        event_count: 1,
        total_usd: row.amount_usd ?? 0,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.event_count - a.event_count) || (b.total_usd - a.total_usd))
    .slice(0, limit);
}



export interface PrivacySequenceCandidateStats {
  by_type: Array<{ candidate_type: string; count: number }>;
  by_priority: Array<{ candidate_priority: string; count: number }>;
  high_confidence_count: number;
  total_candidates: number;
}

export async function getRecentPrivacySequenceCandidateStats(
  db: Db,
  hours: number = 24 * 7,
): Promise<PrivacySequenceCandidateStats> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    totalRes,
    highConfRes,
    rowsRes,
  ] = await Promise.all([
    dba.from('privacy_sequence_alert_candidates').select('*', { count: 'exact', head: true })
      .gte('end_event_time', cutoff),
    dba.from('privacy_sequence_alert_candidates').select('*', { count: 'exact', head: true })
      .gte('end_event_time', cutoff).gte('candidate_confidence', 70),
    dba.from('privacy_sequence_alert_candidates')
      .select('candidate_type, candidate_priority')
      .gte('end_event_time', cutoff)
      .limit(5000),
  ]);

  const typeCounts = new Map<string, number>();
  const priorityCounts = new Map<string, number>();

  for (const row of (rowsRes.data ?? []) as Array<{
    candidate_type: string | null;
    candidate_priority: string | null;
  }>) {
    const t = row.candidate_type ?? 'unknown';
    const p = row.candidate_priority ?? 'unknown';
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    priorityCounts.set(p, (priorityCounts.get(p) ?? 0) + 1);
  }

  return {
    by_type: [...typeCounts.entries()]
      .map(([candidate_type, count]) => ({ candidate_type, count }))
      .sort((a, b) => b.count - a.count),
    by_priority: [...priorityCounts.entries()]
      .map(([candidate_priority, count]) => ({ candidate_priority, count }))
      .sort((a, b) => b.count - a.count),
    high_confidence_count: (highConfRes.count as number | null) ?? 0,
    total_candidates: (totalRes.count as number | null) ?? 0,
  };
}

export interface PrivacySequenceCandidateLeaderboardRow {
  candidate_id: string;
  candidate_type: string;
  candidate_priority: string;
  candidate_confidence: number;
  token_mint: string | null;
  token_symbol: string | null;
  shadow_family_id: string | null;
  start_stage: string;
  end_stage: string;
  elapsed_seconds: number | null;
  end_event_time: string;
}

export async function getPrivacySequenceCandidateLeaderboard(
  db: Db,
  hours: number = 24 * 7,
  limit: number = 25,
): Promise<PrivacySequenceCandidateLeaderboardRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('privacy_sequence_alert_candidates')
    .select(
      'candidate_id, candidate_type, candidate_priority, candidate_confidence, ' +
      'token_mint, token_symbol, shadow_family_id, start_stage, end_stage, ' +
      'elapsed_seconds, end_event_time'
    )
    .gte('end_event_time', cutoff)
    .order('candidate_confidence', { ascending: false })
    .order('end_event_time', { ascending: false })
    .limit(limit);

  return (data ?? []) as PrivacySequenceCandidateLeaderboardRow[];
}

export interface PrivacySequenceCandidateFamilyStatsRow {
  shadow_family_id: string;
  candidate_count: number;
  max_confidence: number;
}

export async function getPrivacySequenceCandidateFamilyStats(
  db: Db,
  hours: number = 24 * 7,
  limit: number = 25,
): Promise<PrivacySequenceCandidateFamilyStatsRow[]> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('privacy_sequence_alert_candidates')
    .select('shadow_family_id, candidate_confidence')
    .gte('end_event_time', cutoff)
    .not('shadow_family_id', 'is', null)
    .limit(5000);

  const agg = new Map<string, PrivacySequenceCandidateFamilyStatsRow>();

  for (const row of (data ?? []) as Array<{
    shadow_family_id: string | null;
    candidate_confidence: number | null;
  }>) {
    if (!row.shadow_family_id) continue;
    const prev = agg.get(row.shadow_family_id);
    const conf = row.candidate_confidence ?? 0;
    if (prev) {
      prev.candidate_count += 1;
      prev.max_confidence = Math.max(prev.max_confidence, conf);
    } else {
      agg.set(row.shadow_family_id, {
        shadow_family_id: row.shadow_family_id,
        candidate_count: 1,
        max_confidence: conf,
      });
    }
  }

  return [...agg.values()]
    .sort((a, b) => (b.candidate_count - a.candidate_count) || (b.max_confidence - a.max_confidence))
    .slice(0, limit);
}
