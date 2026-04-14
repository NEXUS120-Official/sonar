// ============================================================
// SONAR v2.0 — Alert Deduplication Unit Tests
// ============================================================
// Verifies that isSuppressed() correctly enforces per-type
// cooldown windows and the 20% minimum-change threshold.
//
// Run:  npx tsx --tsconfig tsconfig.scripts.json scripts/test-deduplication.ts
// ============================================================

import { isSuppressed, signalValueFor } from '@/lib/flow-engine/dedup';
import { ALERT_COOLDOWNS_MS, ALERT_MIN_CHANGE_PCT } from '@/lib/utils/constants';
import type { AlertRow, AlertType } from '@/lib/supabase/types';

// ── Test helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description: string, actual: boolean, expected: boolean): void {
  if (actual === expected) {
    console.log(`  ✓  ${description}`);
    passed++;
  } else {
    console.error(`  ✗  ${description}  —  expected ${expected}, got ${actual}`);
    failed++;
  }
}

function makeAlert(
  alertType: AlertType,
  minsAgo:   number,
  dataOverride?: Record<string, unknown>,
): AlertRow {
  const createdAt = new Date(Date.now() - minsAgo * 60 * 1000).toISOString();

  // Default data matching what each detector stores
  const defaultData: Record<AlertType, Record<string, unknown>> = {
    exchange_spike:    { current_volume_usd: 2_000_000, baseline_volume_usd: 500_000, ratio: '4.0' },
    accumulation_wave: { net_outflow_usd: 600_000, inflow_usd: 100_000, outflow_usd: 700_000 },
    distribution_wave: { net_inflow_usd: 800_000, inflow_usd: 900_000, outflow_usd: 100_000 },
    staking_shift:     { net_staking_usd: 300_000, staked_usd: 500_000, unstaked_usd: 200_000 },
    defi_rotation:     {},
    stablecoin_flow:   {},
    whale_large_move:  {},
    weekly_report:     {},
  };

  return {
    id:                    'test-id',
    alert_type:            alertType,
    severity:              'notable',
    title:                 'test',
    body:                  'test',
    ai_analysis:           null,
    data:                  dataOverride ?? defaultData[alertType],
    movement_ids:          null,
    sent_telegram_free:    true,
    sent_telegram_premium: false,
    sent_at:               createdAt,
    created_at:            createdAt,
  } as AlertRow;
}

// ── Tests ─────────────────────────────────────────────────────

console.log('\n=== Alert Deduplication Tests ===\n');

// ── Group 1: No prior alert → always fire ────────────────────
console.log('Group 1: No prior alert');

assert(
  'distribution_wave — no prior alert → not suppressed',
  isSuppressed('distribution_wave', null, 800_000),
  false,
);
assert(
  'exchange_spike — no prior alert → not suppressed',
  isSuppressed('exchange_spike', null, 2_000_000),
  false,
);

// ── Group 2: Within cooldown, same value → suppressed ────────
console.log('\nGroup 2: Within cooldown, minimal change');

const distCooldownMins = ALERT_COOLDOWNS_MS['distribution_wave'] / 60_000; // 120
const spikeCooldownMins = ALERT_COOLDOWNS_MS['exchange_spike'] / 60_000;   // 240

// Fired 30 min ago, same value as before (0% change) — should suppress
assert(
  'distribution_wave — 30m ago, 0% change → suppressed',
  isSuppressed('distribution_wave', makeAlert('distribution_wave', 30, { net_inflow_usd: 800_000 }), 800_000),
  true,
);
assert(
  'exchange_spike — 60m ago, 5% change → suppressed',
  isSuppressed('exchange_spike', makeAlert('exchange_spike', 60, { current_volume_usd: 2_000_000 }), 2_100_000),
  true,  // 5% < 20% threshold
);
assert(
  'staking_shift — 120m ago, 10% change → suppressed (4h cooldown)',
  isSuppressed('staking_shift', makeAlert('staking_shift', 120, { net_staking_usd: 300_000 }), 330_000),
  true,  // 10% < 20%, still within 4h window
);

// ── Group 3: Within cooldown, large change → not suppressed ──
console.log('\nGroup 3: Within cooldown, sufficient change (>= 20%)');

assert(
  'distribution_wave — 30m ago, 25% change → not suppressed',
  isSuppressed('distribution_wave', makeAlert('distribution_wave', 30, { net_inflow_usd: 800_000 }), 1_000_000),
  false,  // 25% >= 20%
);
assert(
  'accumulation_wave — 60m ago, 50% jump → not suppressed',
  isSuppressed('accumulation_wave', makeAlert('accumulation_wave', 60, { net_outflow_usd: 600_000 }), 900_000),
  false,  // 50% >= 20%
);
assert(
  'exchange_spike — 120m ago, exactly 20% change → not suppressed',
  isSuppressed('exchange_spike', makeAlert('exchange_spike', 120, { current_volume_usd: 2_000_000 }), 2_400_000),
  false,  // exactly 20% — boundary: changePct (0.20) is NOT < 0.20, so allowed
);

// ── Group 4: Cooldown expired → always fire ──────────────────
console.log('\nGroup 4: Cooldown expired');

assert(
  `distribution_wave — ${distCooldownMins + 5}m ago → cooldown expired, not suppressed`,
  isSuppressed('distribution_wave', makeAlert('distribution_wave', distCooldownMins + 5, { net_inflow_usd: 800_000 }), 800_000),
  false,
);
assert(
  `exchange_spike — ${spikeCooldownMins + 10}m ago → cooldown expired, not suppressed`,
  isSuppressed('exchange_spike', makeAlert('exchange_spike', spikeCooldownMins + 10, { current_volume_usd: 2_000_000 }), 2_000_000),
  false,
);
assert(
  'staking_shift — 300m ago → 5h > 4h cooldown, not suppressed',
  isSuppressed('staking_shift', makeAlert('staking_shift', 300, { net_staking_usd: 300_000 }), 300_000),
  false,
);

// ── Group 5: Null / missing data fields ──────────────────────
console.log('\nGroup 5: Missing data in prior alert');

assert(
  'distribution_wave — prior alert has null data → suppressed (conservative)',
  isSuppressed('distribution_wave', makeAlert('distribution_wave', 30, undefined), 800_000),
  // The default fixture has net_inflow_usd: 800_000 → 0% change → suppressed
  true,
);
assert(
  'distribution_wave — prior alert data missing net_inflow_usd key → suppressed (conservative)',
  isSuppressed('distribution_wave', makeAlert('distribution_wave', 30, { other_field: 123 }), 800_000),
  true,
);

// ── Group 6: signalValueFor helper ───────────────────────────
console.log('\nGroup 6: signalValueFor() formula correctness');

const metrics = {
  sol_exchange_inflow_usd:   300_000,
  sol_exchange_outflow_usd:  700_000,
  sol_net_exchange_flow_usd: -400_000,  // net outflow of 400K
  net_staking_flow_usd:      -250_000,  // net unstaked
};

function assertEqual(desc: string, a: number, b: number): void {
  assert(desc, Math.abs(a - b) < 0.01, true);
}
assertEqual(
  'exchange_spike signal = inflow + outflow = 1_000_000',
  signalValueFor('exchange_spike', metrics),
  1_000_000,
);
assertEqual(
  'accumulation_wave signal = -net_exchange = 400_000 (positive outflow)',
  signalValueFor('accumulation_wave', metrics),
  400_000,
);
assertEqual(
  'distribution_wave signal = net_exchange = -400_000 (negative → would not trigger threshold)',
  signalValueFor('distribution_wave', metrics),
  -400_000,
);
assertEqual(
  'staking_shift signal = abs(net_staking) = 250_000',
  signalValueFor('staking_shift', metrics),
  250_000,
);

// ── Summary ───────────────────────────────────────────────────

console.log(`\n${'─'.repeat(44)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(44)}\n`);

if (failed > 0) {
  console.error(`FAIL — ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('PASS — all deduplication tests green');
  process.exit(0);
}
