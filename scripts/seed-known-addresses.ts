#!/usr/bin/env tsx
// ============================================================
// SONAR v2.0 — Seed Known Addresses
// ============================================================
// Usage:
//   npm run seed:known-addresses
//
// Seeds exchange hot wallets, staking protocols, and DeFi
// protocol addresses into the known_addresses table.
// Safe to re-run: uses upsert on address (unique constraint).
// ============================================================

import { loadEnv } from './lib/load-env';
loadEnv();

import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';
import {
  KNOWN_EXCHANGE_ADDRESSES,
  KNOWN_STAKING_ADDRESSES,
  KNOWN_DEFI_ADDRESSES,
} from '../src/lib/utils/constants';

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('[seed:known-addresses] ❌ Missing Supabase env vars');
  process.exit(1);
}

const db = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Build insert payload ──────────────────────────────────────

const rows = [
  ...KNOWN_EXCHANGE_ADDRESSES.map((a) => ({
    address:      a.address,
    label:        a.label,
    category:     'exchange' as const,
    sub_category: a.sub_category,
    chain:        'solana',
    is_active:    true,
  })),
  ...KNOWN_STAKING_ADDRESSES.map((a) => ({
    address:      a.address,
    label:        a.label,
    category:     'staking' as const,
    sub_category: a.sub_category,
    chain:        'solana',
    is_active:    true,
  })),
  ...KNOWN_DEFI_ADDRESSES.map((a) => ({
    address:      a.address,
    label:        a.label,
    category:     'defi' as const,
    sub_category: a.sub_category,
    chain:        'solana',
    is_active:    true,
  })),
];

// ── Run ───────────────────────────────────────────────────────

async function main() {
  console.log(`\n[seed:known-addresses] Upserting ${rows.length} known addresses...\n`);

  const { data, error } = await db
    .from('known_addresses')
    .upsert(rows, { onConflict: 'address', ignoreDuplicates: false })
    .select('address, label, category');

  if (error) {
    console.error('[seed:known-addresses] ❌ Upsert failed:', error.message);
    process.exit(1);
  }

  // ── Print summary ─────────────────────────────────────────
  const inserted = data ?? [];
  const byCategory = {
    exchange: inserted.filter((r) => r.category === 'exchange').length,
    staking:  inserted.filter((r) => r.category === 'staking').length,
    defi:     inserted.filter((r) => r.category === 'defi').length,
  };

  console.log('══════════════════════════════════════════════════════════');
  console.log('  SONAR — KNOWN ADDRESSES SEED COMPLETE');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`  Total upserted : ${inserted.length}`);
  console.log(`  ├─ Exchanges   : ${byCategory.exchange}`);
  console.log(`  ├─ Staking     : ${byCategory.staking}`);
  console.log(`  └─ DeFi        : ${byCategory.defi}`);
  console.log('');
  console.log('  Addresses:');
  for (const r of inserted) {
    console.log(`  [${r.category.padEnd(8)}] ${r.label} — ${r.address.slice(0, 12)}…`);
  }
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  ⚠️  IMPORTANT: Verify these addresses on Solscan before');
  console.log('  deploying to production. Exchange hot wallets rotate.');
  console.log('  Run: https://solscan.io/account/<address>');
  console.log('══════════════════════════════════════════════════════════\n');
}

main().catch((err: unknown) => {
  console.error('[seed:known-addresses] Unhandled error:', err);
  process.exit(1);
});
