// ============================================================
// SONAR v2.0 — Confirmation Count Unit Tests
// ============================================================
// Verifies calculateConfirmationCount() accurately counts
// sub-signals agreeing with the overall bias direction.
//
// Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test-confirmation-count.ts
// ============================================================

import { calculateConfirmationCount } from '@/lib/flow-engine/aggregator';
import { CONFIRMATION_MIN_USD }       from '@/lib/utils/constants';
import type { MarketBias }            from '@/lib/supabase/types';

// ── Test helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description: string, actual: number | boolean, expected: number | boolean): void {
  if (actual === expected) {
    console.log(`  ✓  ${description}`);
    passed++;
  } else {
    console.error(`  ✗  ${description}  —  expected ${expected}, got ${actual}`);
    failed++;
  }
}

const MIN = CONFIRMATION_MIN_USD;  // $50K

function cc(
  bias:    MarketBias,
  exch:    number,  // sol_net_exchange_flow_usd (negative = outflow = bullish)
  staking: number,  // net_staking_flow_usd (positive = staked = bullish)
  usdc:    number,  // net_usdc_flow_usd (positive = defi inflow = bullish)
): number {
  return calculateConfirmationCount(bias, {
    sol_net_exchange_flow_usd: exch,
    net_staking_flow_usd:      staking,
    net_usdc_flow_usd:         usdc,
  });
}

// ── Tests ─────────────────────────────────────────────────────

console.log('\n=== Confirmation Count Tests ===\n');

// ── Group 1: No signals → 0 ──────────────────────────────────
console.log('Group 1: No active sub-signals');

assert('bullish + no signals → 0',  cc('bullish', 0, 0, 0), 0);
assert('bearish + no signals → 0',  cc('bearish', 0, 0, 0), 0);
assert('neutral + no signals → 0',  cc('neutral', 0, 0, 0), 0);

// ── Group 2: All three agree → 3 ─────────────────────────────
console.log('\nGroup 2: All three sub-signals agree');

// Bullish: exchange outflow + staking inflow + USDC inflow
assert('bullish + all three agree → 3',
  cc('bullish', -(MIN + 10_000), MIN + 10_000, MIN + 10_000), 3);

// Bearish: exchange inflow + unstaking + USDC outflow
assert('bearish + all three agree → 3',
  cc('bearish', MIN + 10_000, -(MIN + 10_000), -(MIN + 10_000)), 3);

// ── Group 3: Partial agreement ────────────────────────────────
console.log('\nGroup 3: Partial agreement');

// Only exchange agrees (bullish)
assert('bullish + only exchange → 1',
  cc('bullish', -(MIN + 1), 0, 0), 1);

// Exchange + staking agree (bullish), USDC contradicts
assert('bullish + exchange+staking agree, USDC contradicts → 2',
  cc('bullish', -(MIN + 1), MIN + 1, -(MIN + 1)), 2);

// All contradict the bias
assert('bullish but all bearish → 0',
  cc('bullish', MIN + 1, -(MIN + 1), -(MIN + 1)), 0);

// ── Group 4: Noise floor boundary ─────────────────────────────
console.log('\nGroup 4: Noise floor boundary (MIN = $' + MIN/1000 + 'K)');

// Exactly at noise floor — not counted (> MIN required, not >= MIN)
assert(`bullish + exch outflow exactly $${MIN/1000}K → NOT counted (strictly > MIN)`,
  cc('bullish', -MIN, 0, 0), 0);  // MIN is not > MIN, so not counted

// Just above noise floor — counted
assert(`bullish + exch outflow $${MIN/1000 + 0.001}K → counted`,
  cc('bullish', -(MIN + 1), 0, 0), 1);

// ── Group 5: Neutral bias ─────────────────────────────────────
console.log('\nGroup 5: Neutral bias (counts any active signal)');

// All active (mixed directions)
assert('neutral + all three active (mixed) → 3',
  cc('neutral', MIN + 1, -(MIN + 1), MIN + 1), 3);

// Only exchange active
assert('neutral + only exchange active → 1',
  cc('neutral', -(MIN + 1), 0, 0), 1);

// Two active, one below noise floor
assert('neutral + 2 active → 2',
  cc('neutral', MIN + 1, MIN + 1, MIN - 1), 2);

// ── Group 6: Integration with typical values ──────────────────
console.log('\nGroup 6: Typical flow values');

// Strong accumulation day: $800K outflow, $300K staking, $60K USDC
assert('strong bullish day → 3',
  cc('bullish', -800_000, 300_000, 60_000), 3);

// Light distribution: $600K inflow, minimal staking, no USDC
assert('light distribution (only exchange bearish) → 1',
  cc('bearish', 600_000, 10_000, 5_000), 1);

// Neutral with some activity (staking active, exchange flat)
assert('neutral with staking active → 1',
  cc('neutral', 10_000, 200_000, 0), 1);

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${'─'.repeat(44)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(44)}\n`);

if (failed > 0) {
  console.error(`FAIL — ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('PASS — all confirmation count tests green');
  process.exit(0);
}
