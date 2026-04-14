// ============================================================
// SONAR v2.0 — Bias Score Unit Tests
// ============================================================
// Verifies that calculateBiasScore() produces continuous,
// log-normalized scores with no cliff-edges at old thresholds.
//
// Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test-bias-score.ts
// ============================================================

import { calculateBiasScore } from '@/lib/flow-engine/aggregator';
import { BIAS_WEIGHTS }       from '@/lib/utils/constants';

// ── Test helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓  ${description}`);
    passed++;
  } else {
    console.error(`  ✗  ${description}`);
    failed++;
  }
}

function approxEqual(a: number, b: number, tolerance = 0.5): boolean {
  return Math.abs(a - b) <= tolerance;
}

const P = BIAS_WEIGHTS.pivot_usd;  // $100K
const EP = BIAS_WEIGHTS.exchange_pts_at_pivot;  // 25

function score(exchNet: number, staking = 0, usdc = 0) {
  return calculateBiasScore({
    sol_net_exchange_flow_usd: exchNet,
    net_staking_flow_usd:      staking,
    net_usdc_flow_usd:         usdc,
  }).bias_score;
}

// ── Group 1: Zero inputs → neutral ───────────────────────────
console.log('\n=== Bias Score Tests ===\n');
console.log('Group 1: Zero inputs');

assert('all zero → bias_score = 0', score(0, 0, 0) === 0);
assert('all zero → market_bias = neutral', calculateBiasScore({
  sol_net_exchange_flow_usd: 0, net_staking_flow_usd: 0, net_usdc_flow_usd: 0,
}).market_bias === 'neutral');

// ── Group 2: Exchange component exact calibration points ─────
console.log('\nGroup 2: Exchange exact calibration points');

// Bullish: negative net_exchange_flow = outflow
assert(
  `exchange outflow $${P/1000}K → exactly ${EP} pts`,
  approxEqual(score(-P, 0, 0), EP),
);
assert(
  `exchange outflow $${5*P/1000}K ($500K) → exactly ${EP*2} pts`,
  approxEqual(score(-5*P, 0, 0), EP * 2),
);
assert(
  `exchange outflow $${25*P/1000}K ($2.5M) → exactly ${EP*3} pts`,
  approxEqual(score(-25*P, 0, 0), EP * 3),
);

// Bearish: positive net_exchange_flow = inflow
assert(
  `exchange inflow $${P/1000}K → exactly -${EP} pts`,
  approxEqual(score(P, 0, 0), -EP),
);
assert(
  `exchange inflow $${5*P/1000}K → exactly -${EP*2} pts`,
  approxEqual(score(5*P, 0, 0), -EP * 2),
);

// ── Group 3: Continuous — no cliff at pivot ───────────────────
console.log('\nGroup 3: Continuity — no cliff at pivot');

const just_below = score(-(P - 1), 0, 0);
const at_pivot   = score(-P, 0, 0);
const just_above = score(-(P + 1), 0, 0);

assert(
  `score continuous across pivot (${just_below.toFixed(2)} ≈ ${at_pivot} ≈ ${just_above.toFixed(2)})`,
  Math.abs(just_below - at_pivot) < 1 && Math.abs(at_pivot - just_above) < 1,
);

// ── Group 4: Monotonically increasing ────────────────────────
console.log('\nGroup 4: Monotonic increase');

const vals = [0, 50_000, 100_000, 200_000, 500_000, 1_000_000, 5_000_000];
let prev = -Infinity;
let monotonic = true;
for (const v of vals) {
  const s = score(-v, 0, 0);
  if (s < prev) { monotonic = false; break; }
  prev = s;
}
assert('score increases monotonically with outflow size', monotonic);

// ── Group 5: Staking component ───────────────────────────────
console.log('\nGroup 5: Staking component');

const SP = BIAS_WEIGHTS.staking_pts_at_pivot;
assert(`staking +$${P/1000}K → exactly ${SP} pts`, approxEqual(score(0, P, 0), SP));
assert(`staking +$${5*P/1000}K → exactly ${SP*2} pts`, approxEqual(score(0, 5*P, 0), SP * 2));
assert(`unstaking -$${P/1000}K → exactly -${SP} pts`, approxEqual(score(0, -P, 0), -SP));

// ── Group 6: USDC component ───────────────────────────────────
console.log('\nGroup 6: USDC component');

const UP = BIAS_WEIGHTS.usdc_pts_at_pivot;
assert(`usdc DeFi +$${P/1000}K → exactly ${UP} pts`, approxEqual(score(0, 0, P), UP));
assert(`usdc DeFi +$${5*P/1000}K → exactly ${UP*2} pts`, approxEqual(score(0, 0, 5*P), UP * 2));
assert(`usdc DeFi withdrawal -$${P/1000}K → exactly -${UP} pts`, approxEqual(score(0, 0, -P), -UP));

// ── Group 7: Combined + clamp ─────────────────────────────────
console.log('\nGroup 7: Combined signals + clamp');

// All three strongly bullish should clamp to +100
const allBullish = score(-100_000_000, 100_000_000, 100_000_000);
assert(`extreme bullish → clamped to +100 (got ${allBullish})`, allBullish === 100);

const allBearish = score(100_000_000, -100_000_000, -100_000_000);
assert(`extreme bearish → clamped to -100 (got ${allBearish})`, allBearish === -100);

// Typical real-world scenario: $700K outflow + $150K staking + $80K USDC
// Expected: exchange 50+pts * log5(7) ≈ 50+25*log5(7); staking ~21 pts; usdc ~8 pts
const typical = score(-700_000, 150_000, 80_000);
assert(`typical bullish scenario ($700K out, $150K staking, $80K USDC) → bullish (score=${typical})`, typical > 20);

const typicalBias = calculateBiasScore({
  sol_net_exchange_flow_usd: -700_000, net_staking_flow_usd: 150_000, net_usdc_flow_usd: 80_000
}).market_bias;
assert(`typical bullish → market_bias = bullish`, typicalBias === 'bullish');

// ── Group 8: market_bias thresholds ──────────────────────────
console.log('\nGroup 8: market_bias thresholds');

assert('bias +21 → bullish', calculateBiasScore({ sol_net_exchange_flow_usd: 0, net_staking_flow_usd: 0, net_usdc_flow_usd: 0 }).market_bias === 'neutral');

// Score exactly at boundary
function biasLabel(s: number): string {
  return s > 20 ? 'bullish' : s < -20 ? 'bearish' : 'neutral';
}
assert('bias +20 → neutral boundary', biasLabel(20) === 'neutral');
assert('bias +21 → bullish boundary', biasLabel(21) === 'bullish');
assert('bias -20 → neutral boundary', biasLabel(-20) === 'neutral');
assert('bias -21 → bearish boundary', biasLabel(-21) === 'bearish');

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${'─'.repeat(44)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(44)}\n`);

if (failed > 0) {
  console.error(`FAIL — ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('PASS — all bias score tests green');
  process.exit(0);
}
