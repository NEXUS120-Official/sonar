#!/usr/bin/env tsx
// ============================================================
// SONAR — Historical Transaction Backfill
// ============================================================
// Usage:
//   npm run backfill
//   npm run backfill -- --limit 100    # override per-wallet fetch limit
//
// For each active whale in the DB:
//   1. Fetch recent SWAP transactions via Helius
//   2. Parse each with parseHeliusTransactions()
//   3. Insert valid rows into transactions table
//   4. Skip duplicates safely via signature UNIQUE constraint
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';
import { getTransactionHistory } from '../src/lib/helius/client';
import { parseHeliusTransactions } from '../src/lib/helius/parse-transaction';

// ── Config ────────────────────────────────────────────────────

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('[backfill] ❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

if (!process.env.HELIUS_API_KEY) {
  console.error('[backfill] ❌ Missing HELIUS_API_KEY');
  process.exit(1);
}

// Default: fetch 50 txs per wallet. Override with --limit N
const LIMIT_ARG = process.argv.indexOf('--limit');
const PER_WALLET_LIMIT = LIMIT_ARG !== -1 ? parseInt(process.argv[LIMIT_ARG + 1], 10) : 50;

const db = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Per-wallet counters ───────────────────────────────────────

interface WalletResult {
  address: string;
  fetched: number;
  parsed: number;
  inserted: number;
  skipped: number;
  error: string | null;
}

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function processWallet(
  whaleId: string,
  address: string,
): Promise<WalletResult> {
  const result: WalletResult = {
    address,
    fetched: 0,
    parsed: 0,
    inserted: 0,
    skipped: 0,
    error: null,
  };

  // 1. Fetch transaction history from Helius (SWAP type only)
  let rawTxs;
  try {
    rawTxs = await getTransactionHistory(address, {
      type:  'SWAP',
      limit: PER_WALLET_LIMIT,
    });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`  [${address.slice(0, 8)}] ❌ Helius fetch failed: ${result.error}`);
    return result;
  }

  result.fetched = rawTxs.length;
  console.log(`  [${address.slice(0, 8)}] fetched ${rawTxs.length} raw tx(s)`);

  if (rawTxs.length === 0) return result;

  // 2. Parse into our internal format
  const parsed = parseHeliusTransactions(rawTxs, address);
  result.parsed = parsed.length;
  console.log(`  [${address.slice(0, 8)}] parsed  ${parsed.length} SWAP(s)`);

  if (parsed.length === 0) return result;

  // 3. Upsert into transactions table — ignore duplicate signatures
  for (const tx of parsed) {
    const { error: insertError } = await db.from('transactions').upsert(
      {
        whale_id:      whaleId,
        signature:     tx.signature,
        type:          tx.type,
        token_address: tx.tokenAddress,
        token_symbol:  tx.tokenSymbol,
        token_name:    tx.tokenName,
        amount_token:  tx.amountToken,
        amount_usd:    tx.amountUsd,
        price_at_tx:   tx.priceAtTx,
        dex:           tx.dex,
        block_time:    tx.blockTime.toISOString(),
      },
      { onConflict: 'signature', ignoreDuplicates: true },
    );

    if (insertError) {
      // Treat constraint violations as skips; anything else as a real error
      if (insertError.code === '23505') {
        result.skipped++;
      } else {
        console.error(`  [${address.slice(0, 8)}] insert error sig=${tx.signature.slice(0, 12)}: ${insertError.message}`);
        result.error = insertError.message;
      }
    } else {
      result.inserted++;
    }
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────

async function backfill() {
  console.log(`[backfill] Starting historical backfill (limit=${PER_WALLET_LIMIT} per wallet)`);
  console.log('');

  // Load active whales
  const { data: whales, error: whaleError } = await db
    .from('whales')
    .select('id, address, label')
    .eq('is_active', true);

  if (whaleError) {
    console.error('[backfill] ❌ Failed to load whales:', whaleError.message);
    process.exit(1);
  }

  if (!whales || whales.length === 0) {
    console.error('[backfill] ❌ No active whales found. Run seed:whales first.');
    process.exit(1);
  }

  console.log(`[backfill] Processing ${whales.length} active whale(s):`);
  console.log('');

  const results: WalletResult[] = [];

  for (const whale of whales) {
    const label = whale.label ? ` (${whale.label})` : '';
    console.log(`▶ ${whale.address}${label}`);

    const result = await processWallet(whale.id, whale.address);
    results.push(result);

    // Polite pause between wallets to stay well inside Helius rate limits
    if (whales.indexOf(whale) < whales.length - 1) {
      await sleep(1200);
    }
  }

  // ── Final report ──────────────────────────────────────────

  const totalFetched  = results.reduce((s, r) => s + r.fetched,  0);
  const totalParsed   = results.reduce((s, r) => s + r.parsed,   0);
  const totalInserted = results.reduce((s, r) => s + r.inserted, 0);
  const totalSkipped  = results.reduce((s, r) => s + r.skipped,  0);
  const failures      = results.filter((r) => r.error !== null);

  console.log('');
  console.log('══════════════════════════════════════════');
  console.log('  BACKFILL REPORT');
  console.log('══════════════════════════════════════════');
  console.log(`  Wallets processed : ${whales.length}`);
  console.log(`  Raw txs fetched   : ${totalFetched}`);
  console.log(`  Parsed SWAPs      : ${totalParsed}`);
  console.log(`  Inserted rows     : ${totalInserted}`);
  console.log(`  Duplicates skipped: ${totalSkipped}`);
  console.log(`  Wallet failures   : ${failures.length}`);

  if (failures.length > 0) {
    console.log('');
    console.log('  Failed wallets:');
    failures.forEach((r) => {
      console.log(`    ${r.address} → ${r.error}`);
    });
  }

  console.log('══════════════════════════════════════════');

  if (totalInserted === 0 && totalParsed === 0 && totalFetched > 0) {
    console.log('');
    console.log('[backfill] ℹ️  Transactions were fetched but none parsed as SWAPs.');
    console.log('[backfill]    The wallets may have non-SWAP or stablecoin-only activity.');
  }

  if (totalFetched === 0) {
    console.log('');
    console.log('[backfill] ℹ️  No transactions returned by Helius for any wallet.');
    console.log('[backfill]    These wallets may be inactive or the Helius type filter');
    console.log('[backfill]    may not match. Try re-running without type filter.');
  }
}

// ── Run ───────────────────────────────────────────────────────

backfill().catch((err: unknown) => {
  console.error('[backfill] Unhandled error:', err);
  process.exit(1);
});
