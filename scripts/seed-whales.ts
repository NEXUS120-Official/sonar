#!/usr/bin/env tsx
// ============================================================
// SONAR — Seed Whale Wallets
// ============================================================
// Usage:
//   npx tsx scripts/seed-whales.ts
//   npm run seed:whales
//
// Inserts initial whale wallet addresses into the `whales` table.
// Safe to re-run: uses upsert with ON CONFLICT DO NOTHING semantics.
//
// HOW TO FIND WHALE ADDRESSES (per PRD Section 9):
//   1. Birdeye → Top Traders leaderboard (https://birdeye.so/leaderboard)
//   2. DEXScreener → Trending tokens → look at top buyers
//   3. Arkham Intelligence entity search
//   4. Nansen Smart Money labels
//   5. Community signals in your Telegram
//
// INCLUSION CRITERIA (per PRD):
//   - Win rate > 55% on at least 50 trades
//   - Active in last 7 days
//   - Primarily operates on Solana
//   - NOT an arbitrage bot (bots show multiple trades per second)
//
// ⚠️  Replace the WHALE_SEED_LIST entries with real curated addresses.
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('[seed-whales] ❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Seed list ─────────────────────────────────────────────────
// FORMAT: { address: '<solana wallet>', label: '<optional name>' }
//
// ⚠️  These are PLACEHOLDER entries.
//     Replace with real whale addresses from Birdeye / DEXScreener.
//     Do NOT commit real addresses to version control if they are alpha signals.
//
// KNOWN PUBLIC SOURCES for Solana smart money (as of April 2026):
//   - Birdeye "Smart Money" tab on any token page
//   - Nansen "Smart Money Solana" dashboard
//   - DEXScreener token page → "Top Traders" section

interface WhaleSeed {
  address: string;
  label?: string;
  chain?: string;
}

const WHALE_SEED_LIST: WhaleSeed[] = [
  // Approved seed list — 2026-04-11
  { address: 'F6Fh9BjBXb1GyacHto4cwqcKF4K4xK8SwEyDv9Ayp8j9', chain: 'solana' },
  { address: 'GnjUARqXzrCecVG6fwZ3bc322TZN435tR8Erjz4oKDM7', chain: 'solana' },
  { address: '4EH92iYK8wua8MyqNExVeiXy5VJUAweXqJPuTWqCvNB8', chain: 'solana' },
  { address: 'DTvNZkuNatHiurJmJTX72JyHbiZhUJ4uywf3TEqHDgJv', chain: 'solana' },
  { address: 'HEq5VR1iu2cMC899q76BCQnFTTJrtay7NZPzmhCAWtrQ',  chain: 'solana' },
];

// ── Main ──────────────────────────────────────────────────────

async function seedWhales() {
  console.log('[seed-whales] Starting whale seed...');
  console.log(`[seed-whales] Total addresses to seed: ${WHALE_SEED_LIST.length}`);

  if (WHALE_SEED_LIST.length === 0) {
    console.warn('[seed-whales] ⚠️  WHALE_SEED_LIST is empty.');
    console.warn('[seed-whales]    Add real whale addresses before running.');
    console.warn('[seed-whales]    See instructions at the top of this file.');
    process.exit(0);
  }

  const rows = WHALE_SEED_LIST.map((w) => ({
    address:   w.address.trim(),
    label:     w.label ?? null,
    chain:     (w.chain ?? 'solana') as Database['public']['Tables']['whales']['Row']['chain'],
    is_active: true,
  }));

  // Validate addresses look like valid base58 Solana pubkeys (32–44 chars)
  const invalid = rows.filter((r) => r.address.length < 32 || r.address.length > 44);
  if (invalid.length > 0) {
    console.error('[seed-whales] ❌ Invalid addresses detected:');
    invalid.forEach((r) => console.error(`   - "${r.address}"`));
    process.exit(1);
  }

  // Upsert: insert new, skip existing (no overwrite of performance stats)
  const { data, error } = await db
    .from('whales')
    .upsert(rows, {
      onConflict: 'address',
      ignoreDuplicates: true,
    })
    .select('id, address, label');

  if (error) {
    console.error('[seed-whales] ❌ Supabase error:', error.message);
    process.exit(1);
  }

  const inserted = data?.length ?? 0;
  console.log(`[seed-whales] ✅ Done. Inserted/updated: ${inserted} whales.`);

  if (inserted < WHALE_SEED_LIST.length) {
    console.log(
      `[seed-whales]    ${WHALE_SEED_LIST.length - inserted} address(es) already existed — skipped.`,
    );
  }
}

// ── Run ───────────────────────────────────────────────────────

seedWhales().catch((err: unknown) => {
  console.error('[seed-whales] Unhandled error:', err);
  process.exit(1);
});
