// ============================================================
// SONAR v2.0 — Whale Cohort Analysis (Innovation 7)
// ============================================================
// Groups active whales by behaviour pattern over a look-back
// window and assigns a cohort label.
//
// Cohorts:
//   accumulator  — consistently withdrawing from exchanges / adding to staking
//   distributor  — consistently depositing to exchanges / reducing staking
//   staker       — high staking ratio, low exchange activity
//   defi_user    — dominant DeFi deposits / withdrawals
//   opportunist  — switches between accumulator & distributor within window
//   dormant      — no activity in window
// ============================================================

export type WhaleCohort =
  | 'accumulator'
  | 'distributor'
  | 'staker'
  | 'defi_user'
  | 'opportunist'
  | 'dormant';

export interface WhaleMovementSummary {
  whale_address:        string;
  label?:               string | null;
  total_value_usd?:     number | null;
  // Aggregated net flows for the whale over the window
  net_exchange_usd:     number;  // outflow positive = accumulation
  net_staking_usd:      number;  // positive = adding stake
  net_defi_usd:         number;  // positive = adding to DeFi
  net_stablecoin_usd:   number;
  movement_count:       number;
  window_hours:         number;
  // Directional consistency: ratio of same-direction movements
  exchange_consistency: number;  // 0-1 (1 = all same direction)
}

export interface CohortResult {
  address:      string;
  label?:       string | null;
  cohort:       WhaleCohort;
  cohort_score: number;         // strength of classification 0-100
  signals:      string[];       // human-readable reasons
  total_value_usd?: number | null;
  net_exchange_usd: number;
  net_staking_usd:  number;
  net_defi_usd:     number;
  movement_count:   number;
}

const NOISE_USD = 5_000;  // ignore net flows below this

export function classifyWhaleCohort(w: WhaleMovementSummary): CohortResult {
  const signals: string[] = [];

  // --- Dormant ---
  if (w.movement_count === 0) {
    return {
      address: w.whale_address,
      label: w.label,
      cohort: 'dormant',
      cohort_score: 100,
      signals: ['no activity in window'],
      total_value_usd: w.total_value_usd,
      net_exchange_usd: 0,
      net_staking_usd: 0,
      net_defi_usd: 0,
      movement_count: 0,
    };
  }

  // Normalise to scores
  const exchAcc   = w.net_exchange_usd;   // positive = net withdrawal = accumulation
  const stakeNet  = w.net_staking_usd;    // positive = staking more
  const defiNet   = w.net_defi_usd;

  // ── Staker: high staking relative to exchange ──
  const stakingDominant =
    Math.abs(stakeNet) > NOISE_USD &&
    Math.abs(stakeNet) > Math.abs(exchAcc) * 1.5;

  // ── DeFi user: high defi relative to exchange ──
  const defiDominant =
    Math.abs(defiNet) > NOISE_USD &&
    Math.abs(defiNet) > Math.abs(exchAcc) * 1.5 &&
    !stakingDominant;

  // ── Accumulator / distributor ──
  const accBias = exchAcc > NOISE_USD;
  const disBias = exchAcc < -NOISE_USD;

  // ── Opportunist: low consistency + meaningful exchange activity ──
  const inconsistent =
    w.exchange_consistency < 0.55 &&
    Math.abs(exchAcc) > NOISE_USD;

  let cohort: WhaleCohort;
  let cohort_score: number;

  if (stakingDominant) {
    cohort = 'staker';
    cohort_score = Math.min(100, Math.round((Math.abs(stakeNet) / 100_000) * 50 + 50));
    if (stakeNet > 0)  signals.push(`added ${fmt(stakeNet)} to staking`);
    else               signals.push(`unstaked ${fmt(Math.abs(stakeNet))}`);
    if (accBias) signals.push(`also withdrew ${fmt(exchAcc)} from exchanges`);
  } else if (defiDominant) {
    cohort = 'defi_user';
    cohort_score = Math.min(100, Math.round((Math.abs(defiNet) / 50_000) * 50 + 50));
    signals.push(`net ${fmt(Math.abs(defiNet))} DeFi ${defiNet > 0 ? 'deposit' : 'withdrawal'}`);
  } else if (inconsistent) {
    cohort = 'opportunist';
    cohort_score = Math.round((1 - w.exchange_consistency) * 100);
    signals.push(`mixed direction (consistency ${Math.round(w.exchange_consistency * 100)}%)`);
    signals.push(`${w.movement_count} movements`);
  } else if (accBias) {
    cohort = 'accumulator';
    cohort_score = Math.min(100, Math.round((exchAcc / 200_000) * 50 + 50));
    signals.push(`net ${fmt(exchAcc)} exchange outflow (accumulation)`);
    if (stakeNet > NOISE_USD) signals.push(`also staking +${fmt(stakeNet)}`);
  } else if (disBias) {
    cohort = 'distributor';
    cohort_score = Math.min(100, Math.round((Math.abs(exchAcc) / 200_000) * 50 + 50));
    signals.push(`net ${fmt(Math.abs(exchAcc))} exchange inflow (distribution)`);
  } else {
    cohort = 'dormant';
    cohort_score = 60;
    signals.push('low net activity');
  }

  return {
    address:      w.whale_address,
    label:        w.label,
    cohort,
    cohort_score,
    signals,
    total_value_usd: w.total_value_usd,
    net_exchange_usd: w.net_exchange_usd,
    net_staking_usd:  w.net_staking_usd,
    net_defi_usd:     w.net_defi_usd,
    movement_count:   w.movement_count,
  };
}

function fmt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `$${Math.round(abs / 1_000)}K`;
  return `$${Math.round(abs)}`;
}

// ── Aggregate a set of CohortResults into group-level summary ──

export interface CohortGroupSummary {
  cohort:     WhaleCohort;
  count:      number;
  pct:        number;   // % of active whales
  net_exchange_usd: number;
  net_staking_usd:  number;
}

export function summariseCohorts(results: CohortResult[]): CohortGroupSummary[] {
  const active = results.filter(r => r.cohort !== 'dormant');
  const total  = active.length || 1;

  const COHORTS: WhaleCohort[] = ['accumulator', 'distributor', 'staker', 'defi_user', 'opportunist', 'dormant'];
  return COHORTS.map(cohort => {
    const group = results.filter(r => r.cohort === cohort);
    return {
      cohort,
      count: group.length,
      pct:   cohort === 'dormant' ? 0 : Math.round((group.length / total) * 100),
      net_exchange_usd: group.reduce((s, r) => s + r.net_exchange_usd, 0),
      net_staking_usd:  group.reduce((s, r) => s + r.net_staking_usd,  0),
    };
  }).filter(g => g.count > 0);
}
