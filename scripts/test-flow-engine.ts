#!/usr/bin/env tsx
// ============================================================
// SONAR v2.0 — Flow Engine Test / Simulation
// ============================================================
// Simulates various movement patterns and verifies that:
//   - Snapshots aggregate correctly
//   - Bias score changes coherently with market conditions
//   - Anomaly detection fires at the right thresholds
//
// Usage:
//   npx tsx --tsconfig tsconfig.scripts.json scripts/test-flow-engine.ts
// ============================================================

import { aggregateMovements, calculateBiasScore, filterToWindow } from '../src/lib/flow-engine/aggregator';
import { detectAnomalies } from '../src/lib/flow-engine/anomaly-detector';
import type { MovementRow } from '../src/lib/supabase/types';

// ── Test helpers ──────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ PASS: ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function assertClose(actual: number, expected: number, label: string, tolerance = 0.01): void {
  assert(Math.abs(actual - expected) <= tolerance, `${label} (got ${actual}, expected ${expected})`);
}

// ── Movement factory ──────────────────────────────────────────

let idCounter = 0;

function mkMovement(
  overrides: Partial<MovementRow> & {
    flow_type: MovementRow['flow_type'];
    amount_usd: number;
  },
): MovementRow {
  return {
    id:             String(++idCounter),
    signature:      `sig_${idCounter}`,
    from_address:   overrides.from_address ?? 'whale_A',
    to_address:     overrides.to_address   ?? 'exchange_binance',
    from_label:     overrides.from_label   ?? null,
    to_label:       overrides.to_label     ?? null,
    whale_id:       overrides.whale_id !== undefined ? overrides.whale_id : 'whale_id_A',
    token:          overrides.token        ?? 'SOL',
    amount_token:   overrides.amount_token ?? (overrides.amount_usd / 130),
    amount_usd:     overrides.amount_usd,
    flow_type:      overrides.flow_type,
    flow_direction: overrides.flow_direction ?? 'inflow',
    exchange:       overrides.exchange      ?? null,
    protocol:       overrides.protocol      ?? null,
    block_time:     overrides.block_time    ?? new Date().toISOString(),
    processed_at:   new Date().toISOString(),
    created_at:     new Date().toISOString(),
  };
}

// ── Tests ─────────────────────────────────────────────────────

console.log('\n========================================');
console.log('SONAR v2.0 — Flow Engine Simulation Tests');
console.log('========================================\n');

// ── Test 1: Empty movements → zero metrics ────────────────────
console.log('Test 1: Empty movements');
{
  const snapshot = aggregateMovements([], 24);
  assert(snapshot.sol_exchange_inflow_usd  === 0, 'exchange inflow = 0');
  assert(snapshot.sol_exchange_outflow_usd === 0, 'exchange outflow = 0');
  assert(snapshot.bias_score               === 0, 'bias score = 0');
  assert(snapshot.market_bias              === 'neutral', 'bias = neutral');
}

// ── Test 2: Pure accumulation (withdrawals only) ──────────────
console.log('\nTest 2: Accumulation (withdrawals only)');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 300_000, flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 300_000, flow_direction: 'outflow' }),
  ];
  const snapshot = aggregateMovements(movements, 24);
  assert(snapshot.sol_exchange_outflow_usd === 600_000, 'outflow = $600K');
  assert(snapshot.sol_exchange_inflow_usd  === 0, 'inflow = 0');
  assert(snapshot.sol_net_exchange_flow_usd < 0, 'net exchange flow negative (outflow dominant)');
  assert(snapshot.bias_score > 0, 'bias score positive (bullish)');
  assert(snapshot.market_bias === 'bullish', 'market bias = bullish');
}

// ── Test 3: Pure distribution (deposits only) ─────────────────
console.log('\nTest 3: Distribution (deposits only)');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_deposit', amount_usd: 600_000, flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'exchange_deposit', amount_usd: 200_000, flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 24);
  assert(snapshot.sol_exchange_inflow_usd === 800_000, 'inflow = $800K');
  assert(snapshot.sol_net_exchange_flow_usd > 0, 'net exchange flow positive (inflow dominant)');
  assert(snapshot.bias_score < 0, 'bias score negative (bearish)');
  assert(snapshot.market_bias === 'bearish', 'market bias = bearish');
}

// ── Test 4: Net staking positive → bullish boost ──────────────
console.log('\nTest 4: Staking shift (bullish)');
{
  const movements = [
    mkMovement({ flow_type: 'stake',   amount_usd: 250_000, protocol: 'marinade', flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'stake',   amount_usd: 150_000, protocol: 'jito',     flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'unstake', amount_usd:  50_000, protocol: 'marinade', flow_direction: 'outflow' }),
  ];
  const snapshot = aggregateMovements(movements, 24);
  assert(snapshot.sol_staked_usd       === 400_000, 'staked = $400K');
  assert(snapshot.sol_unstaked_usd     ===  50_000, 'unstaked = $50K');
  assert(snapshot.net_staking_flow_usd === 350_000, 'net staking = $350K');
  assert(snapshot.bias_score > 0, 'bias positive from staking');
}

// ── Test 5: Bias score clamping ───────────────────────────────
console.log('\nTest 5: Bias score clamping');
{
  const { bias_score } = calculateBiasScore({
    sol_net_exchange_flow_usd: -10_000_000, // massive outflow → max bullish pts
    net_staking_flow_usd:       5_000_000,  // massive staking
    net_usdc_flow_usd:          2_000_000,  // massive USDC inflow
  });
  assert(bias_score <= 100, `bias clamped at 100 (got ${bias_score})`);
  assert(bias_score >= -100, `bias clamped at -100 (got ${bias_score})`);
}

{
  const { bias_score } = calculateBiasScore({
    sol_net_exchange_flow_usd: 10_000_000,  // massive inflow → max bearish
    net_staking_flow_usd:     -5_000_000,
    net_usdc_flow_usd:        -2_000_000,
  });
  assert(bias_score >= -100, `bearish clamped at -100 (got ${bias_score})`);
}

// ── Test 6: Large movement count ─────────────────────────────
console.log('\nTest 6: Large movement counting');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd:  49_000, flow_direction: 'outflow' }), // below threshold
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd:  50_000, flow_direction: 'outflow' }), // at threshold
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 100_000, flow_direction: 'outflow' }), // above
    mkMovement({ flow_type: 'exchange_deposit',    amount_usd: 200_000, flow_direction: 'inflow' }),  // above
  ];
  const snapshot = aggregateMovements(movements, 24);
  assert(snapshot.large_movements_count === 3, `large count = 3 (got ${snapshot.large_movements_count})`);
}

// ── Test 7: Unique whale tracking ────────────────────────────
console.log('\nTest 7: Unique whale tracking');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 100_000, whale_id: 'w1', flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 100_000, whale_id: 'w1', flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_deposit',    amount_usd: 100_000, whale_id: 'w2', flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'stake',               amount_usd: 100_000, whale_id: null, flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 24);
  assert(snapshot.unique_whales_active === 2, `unique whales = 2 (got ${snapshot.unique_whales_active})`);
}

// ── Test 8: Window filtering ──────────────────────────────────
console.log('\nTest 8: Window filtering');
{
  const now   = new Date();
  const old   = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago
  const recent = new Date(now.getTime() - 30 * 60 * 1000).toISOString();    // 30m ago

  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 200_000, block_time: old,    flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 100_000, block_time: recent, flow_direction: 'outflow' }),
  ];

  const filtered1h = filterToWindow(movements, 1);
  const filtered4h = filterToWindow(movements, 4);

  assert(filtered1h.length === 1, `1h window: 1 movement (got ${filtered1h.length})`);
  assert(filtered4h.length === 1, `4h window: 1 movement (got ${filtered4h.length})`);  // 5h > 4h cutoff
}

// ── Test 9: Anomaly detection — accumulation wave ─────────────
console.log('\nTest 9: Anomaly detection — accumulation wave');
{
  // $600K net outflow → should trigger accumulation_wave alert
  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd: 600_000, flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_deposit',    amount_usd:  50_000, flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 4);
  const metrics  = {
    sol_exchange_inflow_usd:  snapshot.sol_exchange_inflow_usd,
    sol_exchange_outflow_usd: snapshot.sol_exchange_outflow_usd,
    sol_net_exchange_flow_usd: snapshot.sol_net_exchange_flow_usd,
    sol_staked_usd:       snapshot.sol_staked_usd,
    sol_unstaked_usd:     snapshot.sol_unstaked_usd,
    net_staking_flow_usd: snapshot.net_staking_flow_usd,
    usdc_inflow_usd:    snapshot.usdc_inflow_usd,
    usdc_outflow_usd:   snapshot.usdc_outflow_usd,
    net_usdc_flow_usd:  snapshot.net_usdc_flow_usd,
    defi_deposit_usd:    snapshot.defi_deposit_usd,
    defi_withdrawal_usd: snapshot.defi_withdrawal_usd,
    net_defi_flow_usd:   snapshot.net_defi_flow_usd,
    large_movements_count: snapshot.large_movements_count,
    unique_whales_active:  snapshot.unique_whales_active,
    bias_score:  snapshot.bias_score ?? 0,
    market_bias: snapshot.market_bias ?? 'neutral',
  };
  const alerts = detectAnomalies({ current: metrics, baseline: null, windowHours: 4 });
  const types  = alerts.map((a) => a.alert_type);
  assert(types.includes('accumulation_wave'), `accumulation_wave alert fired (got: ${types.join(', ')})`);
}

// ── Test 10: Anomaly detection — distribution wave ────────────
console.log('\nTest 10: Anomaly detection — distribution wave');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_deposit', amount_usd: 600_000, flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'exchange_deposit', amount_usd: 200_000, flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 4);
  const metrics  = {
    ...snapshot,
    bias_score:  snapshot.bias_score  ?? 0,
    market_bias: snapshot.market_bias ?? 'neutral' as const,
  };
  const alerts = detectAnomalies({ current: metrics, baseline: null, windowHours: 4 });
  const types  = alerts.map((a) => a.alert_type);
  assert(types.includes('distribution_wave'), `distribution_wave alert fired (got: ${types.join(', ')})`);
}

// ── Test 11: Staking shift alert ─────────────────────────────
console.log('\nTest 11: Anomaly detection — staking shift');
{
  const movements = [
    mkMovement({ flow_type: 'stake', amount_usd: 250_000, protocol: 'marinade', flow_direction: 'inflow' }),
    mkMovement({ flow_type: 'stake', amount_usd: 150_000, protocol: 'jito',     flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 4);
  const metrics  = {
    ...snapshot,
    bias_score:  snapshot.bias_score  ?? 0,
    market_bias: snapshot.market_bias ?? 'neutral' as const,
  };
  const alerts = detectAnomalies({ current: metrics, baseline: null, windowHours: 4 });
  const types  = alerts.map((a) => a.alert_type);
  assert(types.includes('staking_shift'), `staking_shift alert fired (got: ${types.join(', ')})`);
}

// ── Test 12: No false positives below threshold ───────────────
console.log('\nTest 12: No false positives below threshold');
{
  const movements = [
    mkMovement({ flow_type: 'exchange_withdrawal', amount_usd:  20_000, flow_direction: 'outflow' }),
    mkMovement({ flow_type: 'exchange_deposit',    amount_usd:  30_000, flow_direction: 'inflow' }),
  ];
  const snapshot = aggregateMovements(movements, 4);
  const metrics  = {
    ...snapshot,
    bias_score:  snapshot.bias_score  ?? 0,
    market_bias: snapshot.market_bias ?? 'neutral' as const,
  };
  const alerts = detectAnomalies({ current: metrics, baseline: null, windowHours: 4 });
  assert(alerts.length === 0, `No alerts for small movements (got ${alerts.length})`);
}

// ── Summary ───────────────────────────────────────────────────
console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

if (failed > 0) process.exit(1);
