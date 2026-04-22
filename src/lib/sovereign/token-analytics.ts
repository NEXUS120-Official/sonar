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
