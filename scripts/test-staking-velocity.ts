// ============================================================
// SONAR v2.0 — Staking Velocity Unit Tests
// ============================================================
// Verifies computeStakingVelocity() correctly computes the
// rate of change in net staking flow between snapshots.
//
// Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test-staking-velocity.ts
// ============================================================

import { computeStakingVelocity } from '@/lib/flow-engine/aggregator';

// ── Test helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description: string, actual: number | null, expected: number | null, tol = 0.01): void {
  const ok =
    actual === null
      ? expected === null
      : expected !== null && Math.abs(actual - expected) <= Math.abs(expected) * tol + 0.01;
  if (ok) {
    console.log(`  ✓  ${description}`);
    passed++;
  } else {
    console.error(`  ✗  ${description}  —  expected ${expected}, got ${actual}`);
    failed++;
  }
}

// ── Tests ─────────────────────────────────────────────────────

console.log('\n=== Staking Velocity Tests ===\n');

// ── Group 1: Basic rate of change ─────────────────────────────
console.log('Group 1: Basic rate of change');

// $100K → $200K = 100% increase
assert('100K → 200K = +100%', computeStakingVelocity(200_000, 100_000), 100);

// $200K → $100K = -50%
assert('200K → 100K = -50%', computeStakingVelocity(100_000, 200_000), -50);

// $100K → $100K = 0% (no change)
assert('100K → 100K = 0%', computeStakingVelocity(100_000, 100_000), 0);

// ── Group 2: Sign changes ─────────────────────────────────────
console.log('\nGroup 2: Sign changes (staking → unstaking)');

// $100K staking → -$100K unstaking = -200% change
assert('$100K → -$100K = -200%', computeStakingVelocity(-100_000, 100_000), -200);

// -$100K → $100K = +200%
assert('-$100K → $100K = +200%', computeStakingVelocity(100_000, -100_000), 200);

// ── Group 3: Cap at ±1000% ────────────────────────────────────
console.log('\nGroup 3: Cap at ±1000%');

// From $10K to $100M → would be ~999900%, capped at 1000%
assert('extreme positive → capped at 1000%', computeStakingVelocity(100_000_000, 10_000), 1000);
assert('extreme negative → capped at -1000%', computeStakingVelocity(-100_000_000, 10_000), -1000);

// ── Group 4: Floor denominator ────────────────────────────────
console.log('\nGroup 4: Floor denominator ($10K)');

// previous = $5K (below floor) → denominator = $10K
// current = $20K → velocity = (20K - 5K) / 10K * 100 = 150%
assert('prev $5K, cur $20K → 150% (using $10K floor)', computeStakingVelocity(20_000, 5_000), 150);

// previous = $0, current = $20K → (20K - 0) / 10K * 100 = 200%
assert('prev $0, cur $20K → 200% (floor denominator)', computeStakingVelocity(20_000, 0), 200);

// ── Group 5: Returns null below noise floor ───────────────────
console.log('\nGroup 5: Null when both below $10K floor');

assert('both $0 → null', computeStakingVelocity(0, 0), null);
assert('$5K → $8K → null (both below floor)', computeStakingVelocity(8_000, 5_000), null);
assert('$0 → $9_999 → null', computeStakingVelocity(9_999, 0), null);

// Exactly at floor ($10K) is NOT null (floor is strictly less than)
const tenK = computeStakingVelocity(10_000, 0);
const isNotNull = tenK !== null;
if (isNotNull) {
  console.log(`  ✓  $10K crosses floor threshold → not null (got ${tenK?.toFixed(2)}%)`);
  passed++;
} else {
  console.error(`  ✗  $10K should cross floor threshold`);
  failed++;
}

// ── Group 6: Typical values ───────────────────────────────────
console.log('\nGroup 6: Typical real-world values');

// Mild staking increase: $500K → $600K = 20%
assert('$500K → $600K = 20% increase', computeStakingVelocity(600_000, 500_000), 20);

// Significant unstaking: $800K → $200K = -75%
assert('$800K → $200K = -75% (mass unstaking)', computeStakingVelocity(200_000, 800_000), -75);

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${'─'.repeat(44)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(44)}\n`);

if (failed > 0) {
  console.error(`FAIL — ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('PASS — all staking velocity tests green');
  process.exit(0);
}
