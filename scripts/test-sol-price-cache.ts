// ============================================================
// SONAR v2.0 — SOL Price Cache Tests
// ============================================================
// Verifies that getCachedSolPrice() returns a plausible price
// and that the module-level exports work as expected.
//
// Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test-sol-price-cache.ts
// ============================================================

import { loadEnv } from './lib/load-env.js';
loadEnv();

import {
  getCachedSolPrice,
  getLastKnownSolPrice,
  cacheStalenessMs,
  SOL_PRICE_FALLBACK_USD,
} from '@/lib/helius/sol-price-cache';

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

// ── Main (async wrapper avoids top-level await CJS issue) ─────

async function main(): Promise<void> {
  console.log('\n=== SOL Price Cache Tests ===\n');

  // Before any fetch, getLastKnownSolPrice should return the fallback
  assert(
    `getLastKnownSolPrice() before first fetch returns SOL_PRICE_FALLBACK_USD (${SOL_PRICE_FALLBACK_USD})`,
    getLastKnownSolPrice() === SOL_PRICE_FALLBACK_USD,
  );
  assert(
    'cacheStalenessMs() returns Infinity before first fetch',
    cacheStalenessMs() === Infinity,
  );

  console.log('\n  Fetching live SOL price from Jupiter API...');
  const price = await getCachedSolPrice();

  assert(
    `getCachedSolPrice() returns a number > 0 (got $${price.toFixed(2)})`,
    price > 0,
  );
  assert(
    `price is in plausible SOL range ($10 – $10,000) — got $${price.toFixed(2)}`,
    price >= 10 && price <= 10_000,
  );
  assert(
    'cacheStalenessMs() < 1000ms immediately after fetch',
    cacheStalenessMs() < 1000,
  );
  assert(
    'getLastKnownSolPrice() matches getCachedSolPrice() result',
    getLastKnownSolPrice() === price,
  );

  // Second call should use cache (no additional network fetch)
  const price2 = await getCachedSolPrice();
  assert(
    'Second getCachedSolPrice() call returns same value (cache hit)',
    price2 === price,
  );

  console.log(`\n${'─'.repeat(44)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(44)}\n`);

  if (failed > 0) {
    console.error(`FAIL — ${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('PASS — all SOL price cache tests green');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
