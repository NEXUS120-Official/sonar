// ============================================================
// SONAR v2.0 — Bias Index™
// ============================================================
// 4-component score from -100 (extreme bearish) to +100 (extreme bullish).
//
// Components (equal 100 pts total):
//   Exchange flow  40 pts — primary signal
//   Staking flow   20 pts — conviction signal
//   Stablecoin     20 pts — dry-powder / profit-taking signal
//   DeFi activity  20 pts — risk-on / risk-off signal
//
// Called by /api/bias-index and saved to bias_index_history by process-flows.
// ============================================================

export type BiasLabel =
  | 'extreme_bearish'
  | 'bearish'
  | 'neutral'
  | 'bullish'
  | 'extreme_bullish';

export interface BiasComponent {
  score:          number;   // contribution to total (-max..+max)
  raw_usd:        number;   // raw net flow that generated this score
  interpretation: string;
}

export interface BiasIndexResult {
  score:      number;    // -100 to +100
  bias:       BiasLabel;
  components: {
    exchange:    BiasComponent;
    staking:     BiasComponent;
    stablecoin:  BiasComponent;
    defi:        BiasComponent;
  };
  confidence:  number;   // 0-100, based on how many components have signal
  updated_at:  Date;
}

// ── Internal scorer ────────────────────────────────────────────
// Linear ramp: 0 → maxPts as |value| goes 0 → pivot.
// Beyond pivot: logarithmic extension (doubles every 5× pivot).
// Capped at maxPts.

function componentScore(netUsd: number, pivotUsd: number, maxPts: number): number {
  const abs = Math.abs(netUsd);
  if (abs < 1_000) return 0; // noise floor

  let pts: number;
  if (abs <= pivotUsd) {
    pts = maxPts * (abs / pivotUsd);
  } else {
    pts = maxPts * (1 + Math.log(abs / pivotUsd) / Math.log(5));
  }
  pts = Math.min(pts, maxPts);

  return netUsd >= 0 ? pts : -pts;
}

// ── Interpretation helpers ─────────────────────────────────────

function exchangeInterp(net: number): string {
  // Convention: negative net_exchange_flow_usd = net outflow (accumulation = bullish)
  const abs = Math.abs(net);
  if (abs < 50_000)   return 'balanced';
  if (net < 0) {
    if (abs < 250_000)   return 'mild accumulation';
    if (abs < 1_000_000) return 'moderate accumulation';
    return 'strong accumulation';
  }
  if (abs < 250_000)   return 'mild distribution';
  if (abs < 1_000_000) return 'moderate distribution';
  return 'strong distribution';
}

function stakingInterp(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000)   return 'flat';
  if (net > 0) return abs < 200_000 ? 'mild staking' : abs < 1_000_000 ? 'moderate staking' : 'heavy staking';
  return abs < 200_000 ? 'mild unstaking' : abs < 1_000_000 ? 'moderate unstaking' : 'heavy unstaking';
}

function stablecoinInterp(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000) return 'idle';
  if (net > 0) return abs < 200_000 ? 'mild deployment' : 'active deployment (buy-ready)';
  return abs < 200_000 ? 'mild withdrawal' : 'profit taking';
}

function defiInterp(net: number): string {
  const abs = Math.abs(net);
  if (abs < 50_000) return 'flat';
  if (net > 0) return abs < 200_000 ? 'mild risk-on' : 'risk-on (capital deploying)';
  return abs < 200_000 ? 'mild risk-off' : 'risk-off (capital withdrawing)';
}

// ── Bias label ─────────────────────────────────────────────────

function biasLabel(score: number): BiasLabel {
  if (score >= 60)  return 'extreme_bullish';
  if (score >= 20)  return 'bullish';
  if (score <= -60) return 'extreme_bearish';
  if (score <= -20) return 'bearish';
  return 'neutral';
}

// ── Main export ────────────────────────────────────────────────

export interface BiasIndexInput {
  /** negative = net outflow (accumulation = bullish) */
  sol_net_exchange_flow_usd: number;
  net_staking_flow_usd:      number;
  /** USDC net toward DeFi (positive = buy-ready = bullish) */
  net_usdc_flow_usd:         number;
  /** DeFi net deposit (positive = risk-on = bullish) */
  net_defi_flow_usd:         number;
}

export function calculateBiasIndex(input: BiasIndexInput): BiasIndexResult {
  const EXCHANGE_PIVOT   = 500_000;
  const STAKING_PIVOT    = 200_000;
  const STABLECOIN_PIVOT = 200_000;
  const DEFI_PIVOT       = 100_000;

  // Exchange: negative net = outflow = accumulation = bullish → flip sign
  const exchNet   = -input.sol_net_exchange_flow_usd;
  const exchScore = componentScore(exchNet, EXCHANGE_PIVOT, 40);

  const stakeScore  = componentScore(input.net_staking_flow_usd, STAKING_PIVOT, 20);
  const stableScore = componentScore(input.net_usdc_flow_usd, STABLECOIN_PIVOT, 20);
  const defiScore   = componentScore(input.net_defi_flow_usd, DEFI_PIVOT, 20);

  const raw   = exchScore + stakeScore + stableScore + defiScore;
  const score = Math.max(-100, Math.min(100, Math.round(raw)));

  // Confidence: count components with meaningful signal (>$10K)
  const active = [
    Math.abs(exchNet)                          > 10_000 ? 1 : 0,
    Math.abs(input.net_staking_flow_usd)       > 10_000 ? 1 : 0,
    Math.abs(input.net_usdc_flow_usd)          > 10_000 ? 1 : 0,
    Math.abs(input.net_defi_flow_usd)          > 10_000 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const confidence = active === 4 ? 100 : active === 3 ? 75 : active === 2 ? 50 : 25;

  return {
    score,
    bias: biasLabel(score),
    components: {
      exchange: {
        score:          Math.round(exchScore),
        raw_usd:        exchNet,
        interpretation: exchangeInterp(exchNet),
      },
      staking: {
        score:          Math.round(stakeScore),
        raw_usd:        input.net_staking_flow_usd,
        interpretation: stakingInterp(input.net_staking_flow_usd),
      },
      stablecoin: {
        score:          Math.round(stableScore),
        raw_usd:        input.net_usdc_flow_usd,
        interpretation: stablecoinInterp(input.net_usdc_flow_usd),
      },
      defi: {
        score:          Math.round(defiScore),
        raw_usd:        input.net_defi_flow_usd,
        interpretation: defiInterp(input.net_defi_flow_usd),
      },
    },
    confidence,
    updated_at: new Date(),
  };
}
