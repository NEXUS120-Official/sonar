#!/usr/bin/env tsx
// ============================================================
// SONAR v2.0 — Import Whale Seed
// ============================================================
// Takes a list of Solana addresses (from args or a file),
// checks each against the $500K qualification threshold,
// inserts qualifying wallets into the whales table,
// then optionally syncs the Helius webhook.
//
// Usage:
//   tsx scripts/import-whale-seed.ts <addr1> <addr2> ...
//   tsx scripts/import-whale-seed.ts --file addresses.txt
//   tsx scripts/import-whale-seed.ts --file addresses.txt --dry-run
//   tsx scripts/import-whale-seed.ts --file addresses.txt --method manual
//   tsx scripts/import-whale-seed.ts --file addresses.txt --sync-webhook
//
// Address file format: one Solana address per line, # for comments
// ============================================================

import { loadEnv } from './lib/load-env';
loadEnv();

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import {
  checkWhaleQualification,
  getSolPriceUsd,
} from '../src/lib/whale-discovery/balance-checker';
import type { WhaleDiscoveryMethod, KnownAddressRow } from '../src/lib/supabase/types';

// ── Args ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);

const dryRun       = argv.includes('--dry-run');
const syncWebhook  = argv.includes('--sync-webhook');
const fileIdx      = argv.indexOf('--file');
const methodIdx    = argv.indexOf('--method');
const methodArg    = methodIdx !== -1 ? argv[methodIdx + 1] : undefined;
const discoveryMethod: WhaleDiscoveryMethod = (
  methodArg === 'balance_scan' ? 'balance_scan' :
  methodArg === 'gmgn_feed'   ? 'gmgn_feed' :
  methodArg === 'exchange_withdrawal' ? 'exchange_withdrawal' : 'manual'
);

// Collect addresses from file and/or positional args
const addresses: string[] = [];

if (fileIdx !== -1) {
  const filePath = argv[fileIdx + 1];
  if (!filePath) { console.error('--file requires a path'); process.exit(1); }
  const lines = readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const addr = line.trim().replace(/#.*/, '').trim();
    if (addr.length >= 32 && addr.length <= 44) addresses.push(addr);
  }
}

// Positional args that look like Solana addresses (base58, 32-44 chars)
for (const arg of argv) {
  if (!arg.startsWith('--') && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(arg)) {
    addresses.push(arg);
  }
}

// Deduplicate
const uniqueAddresses = [...new Set(addresses)];

if (uniqueAddresses.length === 0) {
  console.log('No addresses provided.');
  console.log('Usage:');
  console.log('  tsx scripts/import-whale-seed.ts <addr1> <addr2>');
  console.log('  tsx scripts/import-whale-seed.ts --file addresses.txt [--dry-run] [--sync-webhook] [--method manual|balance_scan|gmgn_feed|exchange_withdrawal]');
  process.exit(0);
}

// ── DB ────────────────────────────────────────────────────────

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Helpers ───────────────────────────────────────────────────

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `$${(v/1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Webhook sync ──────────────────────────────────────────────

async function syncHeliusWebhook(newlyQualifiedAddresses: string[]) {
  const key       = process.env.HELIUS_API_KEY;
  const webhookId = process.env.HELIUS_WEBHOOK_ID ?? '6957eb4c-f9ce-4c77-bc53-4e3ed310e7e6';
  if (!key) { console.warn('  HELIUS_API_KEY not set — skipping webhook sync'); return; }

  // Infrastructure addresses (exchange + staking hot wallets)
  // Derived from KNOWN_EXCHANGE_ADDRESSES + KNOWN_STAKING_ADDRESSES — only valid base58
  const infra = [
    '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', // Binance 1
    '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  // Binance 2
    'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',  // Coinbase
    'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',  // Kraken
    'AC5RDfQFmDS1deWZos921JfqscXdByf6BKHAbfFi1bno',  // Bybit
    'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',   // Marinade
    'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',   // Jito
  ];

  // Pull ALL currently active whales from DB so the webhook stays complete
  // regardless of which import run added them
  let existingWhaleAddresses: string[] = [];
  try {
    const { data } = await (db as any)
      .from('whales')
      .select('address')
      .eq('is_active', true);
    existingWhaleAddresses = ((data ?? []) as Array<{ address: string }>).map(w => w.address);
  } catch {
    console.warn('  Could not fetch active whales from DB — using newly qualified only');
    existingWhaleAddresses = newlyQualifiedAddresses;
  }

  const combined = [...new Set([...infra, ...existingWhaleAddresses])].slice(0, 100);

  const whaleCount = combined.length - infra.filter(a => combined.includes(a)).length;
  console.log(`\n── Webhook Sync ──`);
  console.log(`  ${combined.length} addresses → Helius (${infra.length} infra + ${whaleCount} active whales)`);

  if (dryRun) {
    console.log('  DRY RUN — skipping PUT');
    return;
  }

  const res = await fetch(
    `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${key}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhookURL:       process.env.NEXT_PUBLIC_APP_URL + '/api/webhook/helius',
        transactionTypes: ['TRANSFER', 'SWAP'],
        accountAddresses: combined,
        webhookType:      'enhanced',
        encoding:         'jsonParsed',
        authHeader:       process.env.HELIUS_WEBHOOK_SECRET ?? '',
      }),
    },
  );

  const result = await res.json() as { webhookID?: string; accountAddresses?: string[] };
  if (result.webhookID) {
    console.log(`  ✅ Webhook updated — ${result.accountAddresses?.length} addresses, TRANSFER+SWAP`);
  } else {
    console.error('  ❌ Webhook update failed:', JSON.stringify(result));
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('\nSONAR v2.0 — Whale Seed Import');
  console.log('════════════════════════════════════════');
  if (dryRun) console.log('  DRY RUN — no DB writes');
  console.log(`  Addresses: ${uniqueAddresses.length}`);
  console.log(`  Method:    ${discoveryMethod}`);
  console.log();

  // SOL price
  const solPrice = await getSolPriceUsd();
  console.log(`  SOL price: $${solPrice.toFixed(2)}\n`);

  // Load known infrastructure addresses — never import these as whales
  const { data: knownRaw } = await (db as any)
    .from('known_addresses')
    .select('address, label, category');
  const knownInfra = new Map<string, Pick<KnownAddressRow, 'label' | 'category'>>(
    ((knownRaw ?? []) as Pick<KnownAddressRow, 'address' | 'label' | 'category'>[])
      .map(r => [r.address, { label: r.label, category: r.category }])
  );
  console.log(`  Known infra addresses: ${knownInfra.size}`);

  // Load existing whale addresses (skip duplicates)
  const { data: existing } = await (db as any).from('whales').select('address');
  const existingSet = new Set(((existing ?? []) as Array<{ address: string }>).map(w => w.address));
  console.log(`  Existing whales in DB: ${existingSet.size}\n`);

  // Results
  let qualified  = 0;
  let inserted   = 0;
  let skipped    = 0;
  let skippedInfra = 0;
  let below      = 0;
  let failed     = 0;
  const qualifiedAddresses: string[] = [];
  const failedList: string[] = [];

  for (let i = 0; i < uniqueAddresses.length; i++) {
    const addr = uniqueAddresses[i];
    const short = `${addr.slice(0, 10)}…${addr.slice(-4)}`;
    process.stdout.write(`  [${String(i+1).padStart(3)}/${uniqueAddresses.length}] ${short}  `);

    // ── Guard: never import known infrastructure addresses ────────
    const infra = knownInfra.get(addr);
    if (infra) {
      process.stdout.write(
        `SKIP_KNOWN_INFRA_ADDRESS  category=${infra.category}  label="${infra.label}"\n`
      );
      skippedInfra++;
      continue;
    }

    if (existingSet.has(addr)) {
      process.stdout.write('already in DB — skip\n');
      skipped++;
      qualifiedAddresses.push(addr); // still include in webhook sync
      continue;
    }

    try {
      const qual = await checkWhaleQualification(addr, solPrice);

      if (!qual) {
        process.stdout.write(`below $500K threshold\n`);
        below++;
      } else {
        process.stdout.write(
          `✅ ${fmtUsd(qual.total_value_usd)} (SOL=${qual.sol_balance.toFixed(0)}, USDC=${qual.usdc_balance.toFixed(0)})\n`
        );
        qualified++;
        qualifiedAddresses.push(addr);

        if (!dryRun) {
          const { error } = await (db as any).from('whales').insert({
            address:            addr,
            label:              null,
            chain:              'solana',
            is_active:          true,
            sol_balance:        qual.sol_balance,
            usdc_balance:       qual.usdc_balance,
            total_value_usd:    qual.total_value_usd,
            staked_sol:         null,
            staked_msol:        null,
            staked_jitosol:     null,
            whale_type:         'unknown',
            discovery_method:   discoveryMethod,
            balance_updated_at: new Date().toISOString(),
          });

          if (error) {
            if (error.message.includes('duplicate') || error.message.includes('unique')) {
              process.stdout.write(`          (duplicate — already inserted)\n`);
            } else {
              throw new Error(error.message);
            }
          } else {
            inserted++;
          }
        }
      }
    } catch (e) {
      process.stdout.write(`ERROR: ${String(e).slice(0, 80)}\n`);
      failed++;
      failedList.push(addr);
    }

    await delay(350); // rate-limit friendly
  }

  // Webhook sync
  if (syncWebhook && qualifiedAddresses.length > 0) {
    await syncHeliusWebhook(qualifiedAddresses);
  }

  // Receipt
  console.log('\n════════════════════════════════════════');
  console.log(`Addresses processed:  ${uniqueAddresses.length}`);
  console.log(`Skipped (infra):      ${skippedInfra}  ← exchange / staking / defi — never imported`);
  console.log(`Qualified (≥$500K):   ${qualified}${dryRun ? ' (dry run — not written)' : ''}`);
  console.log(`Inserted to DB:       ${dryRun ? 0 : inserted}`);
  console.log(`Already in DB:        ${skipped}`);
  console.log(`Below threshold:      ${below}`);
  console.log(`Failed (RPC):         ${failed}`);
  if (failedList.length > 0) {
    console.log('Failed:');
    failedList.forEach(a => console.log(`  ${a}`));
  }
  console.log();

  if (below === uniqueAddresses.length - skipped - failed) {
    console.log('ℹ  All new addresses are below $500K threshold.');
    console.log('   Provide addresses from Solscan richlist or known large wallets.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
