#!/usr/bin/env tsx
// ============================================================
// SONAR v2.0 — Autonomous Whale Discovery
// ============================================================
// Production-grade discovery pipeline. Sources in priority order:
//   1. Helius live withdrawal scanner (primary) — scans all exchange
//      hot wallets from KNOWN_EXCHANGE_ADDRESSES for large outgoing
//      SOL/USDC transfers.
//   2. DB movements (secondary) — exchange_withdrawal rows captured
//      by the Helius webhook since deployment.
//   3. Token top holder scan (PRD Method 4) — getTokenLargestAccounts
//      for JUP/JTO/RAY, resolves owner wallets, checks qualification.
//   4. GMGN smart money / KOL (supplementary) — annotates candidates
//      already found; never the sole qualification source.
//
// Qualification gates (all must pass):
//   - Not in known_addresses (exchange / staking / defi infra)
//   - Not already in whales table
//   - Native SOL + USDC balance >= $500K
//   - Recent on-chain activity (within 90 days)
//   - Not pump.fun noise (GMGN source only)
//
// Rejection reasons:
//   KNOWN_INFRA | BELOW_BALANCE_THRESHOLD | INACTIVE |
//   PUMP_FUN_NOISE | ALREADY_TRACKED | INVALID_OWNER_SOURCE |
//   EXCHANGE_LIKE_PATTERN
//
// Output:
//   artifacts/discovery/latest_candidates.json
//   artifacts/discovery/latest_candidates.csv
//   artifacts/discovery/latest_receipt.json
//   artifacts/discovery/addresses.txt  (qualified only, import-ready)
//
// Usage:
//   tsx scripts/discover-whales.ts                        # hybrid (default)
//   tsx scripts/discover-whales.ts --source withdrawals
//   tsx scripts/discover-whales.ts --source tokens
//   tsx scripts/discover-whales.ts --source gmgn
//   tsx scripts/discover-whales.ts --source hybrid
//   tsx scripts/discover-whales.ts --dry-run              # no DB insert
//   tsx scripts/discover-whales.ts --output-only          # no DB insert
// ============================================================

import { loadEnv } from './lib/load-env';
loadEnv();

import { execSync }                    from 'child_process';
import { mkdirSync, writeFileSync }    from 'fs';
import { createClient }                from '@supabase/supabase-js';
import {
  checkWhaleQualification,
  getSolPriceUsd,
}                                      from '../src/lib/whale-discovery/balance-checker';
import {
  KNOWN_EXCHANGE_ADDRESSES,
  KNOWN_STAKING_ADDRESSES,
  KNOWN_DEFI_ADDRESSES,
  USDC_MINT,
  FLOW_THRESHOLDS,
}                                      from '../src/lib/utils/constants';
import type { WhaleDiscoveryMethod }   from '../src/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const HELIUS_SIGS_PER_EXCHANGE  = 500;    // signatures to fetch per exchange address
const HELIUS_TX_BATCH           = 10;     // enhanced API batch size
const HELIUS_MIN_SOL_WD         = 200;    // min SOL on a single withdrawal to track dest (lowered R3)
const HELIUS_MIN_USDC_WD        = 50_000; // min USDC on a single withdrawal (lowered R3)
const DB_WITHDRAWAL_WINDOW_DAYS = 30;     // how far back to query DB movements
const GMGN_FEED_LIMIT           = 200;
const GMGN_MIN_TRADE_USD        = FLOW_THRESHOLDS.whale.gmgn_min_trade_usd;
const TOKEN_HOLDER_MIN_USD      = 200_000;// min token holding USD to flag as candidate
const RPC_DELAY_MS              = 350;    // delay between qualification RPC calls
const MAX_CANDIDATES            = 300;    // safety cap before balance checks

// Protocol token mints for top-holder discovery (PRD Method 4)
// JUP: Helius DAS "account index service overloaded" — retried each run
// All others validated: getTokenLargestAccounts OK + meaningful $200K+ top holders
const TOKEN_SOURCES = [
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP',    decimals: 6 },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  symbol: 'JTO',    decimals: 9 },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY',    decimals: 6 },
  { mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', symbol: 'W',      decimals: 6 },
  { mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',  symbol: 'MNDE',   decimals: 9 },
  { mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', symbol: 'DRIFT',  decimals: 6 },
  // R5 additions — all validated: 20/20 above $200K threshold
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA',   decimals: 6 },
  { mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',  symbol: 'KMNO',   decimals: 6 },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  symbol: 'RENDER', decimals: 8 },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  symbol: 'BSOL',   decimals: 9 },
  { mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', symbol: 'WETH',   decimals: 8 },
  { mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', symbol: 'WBTC',   decimals: 8 },
  // R6 additions — liquid staked SOL (mints from constants.ts, already verified)
  // Large holders = institutional stakers; Marinade + Jito program addrs already in INFRA_SET
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'MSOL',    decimals: 9 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JITOSOL', decimals: 9 },
  // R7 additions — validated via getTokenLargestAccounts: 10/10 real wallet owners, 0 program accounts
  // HNT: Helium IoT network — 10 top holders all real wallets, $2.4M–$13.7M each, zero DB overlap
  { mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux', symbol: 'HNT',    decimals: 8 },
  // INF: Sanctum Infinity LST pool — institutional stakers up to $73M, 10/10 real wallets
  { mint: '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm', symbol: 'INF',    decimals: 9 },
  // JLP: Jupiter Perps LP token — 10/10 real wallets, top 2 already tracked (validation), 8 new candidates
  { mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', symbol: 'JLP',    decimals: 6 },
] as const;

const ARTIFACT_DIR = 'artifacts/discovery';

// ── CLI args ──────────────────────────────────────────────────

const args       = process.argv.slice(2);
const dryRun     = args.includes('--dry-run');
const outputOnly = args.includes('--output-only');
const skipInsert = dryRun || outputOnly;

const srcArg = args.find(a => a.startsWith('--source='))?.split('=')[1]
  ?? (() => { const i = args.indexOf('--source'); return i !== -1 ? args[i + 1] : undefined; })();

const useWithdrawals = !srcArg || srcArg === 'withdrawals' || srcArg === 'hybrid';
const useTokens      = !srcArg || srcArg === 'tokens'      || srcArg === 'hybrid';
const useGmgn        = !srcArg || srcArg === 'gmgn'        || srcArg === 'hybrid';
const sourceLabel    = srcArg ?? 'hybrid';

// ── Types ─────────────────────────────────────────────────────

type RejectionReason =
  | 'KNOWN_INFRA'
  | 'BELOW_BALANCE_THRESHOLD'
  | 'INACTIVE'
  | 'PUMP_FUN_NOISE'
  | 'ALREADY_TRACKED'
  | 'INVALID_OWNER_SOURCE'
  | 'EXCHANGE_LIKE_PATTERN';

interface Candidate {
  address:              string;
  sources:              string[];
  max_withdrawal_sol:   number;
  max_withdrawal_usd:   number;
  recurrence_count:     number;
  recurrence_exchanges: string[];
  gmgn_max_trade_usd:   number;
  confidence_score:     number;
  rejection_reason?:    RejectionReason;
  sol_balance?:         number;
  usdc_balance?:        number;
  total_value_usd?:     number;
  last_active_ts?:      number;
  discovery_method?:    WhaleDiscoveryMethod;
}

type RejectionCounts = Record<RejectionReason, number>;

// ── DB client ─────────────────────────────────────────────────

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Known infra set (runtime, expanded from DB) ───────────────

const INFRA_SET = new Set<string>([
  ...KNOWN_EXCHANGE_ADDRESSES.map(e => e.address),
  ...KNOWN_STAKING_ADDRESSES.map(e => e.address),
  ...KNOWN_DEFI_ADDRESSES.map(e => e.address),
  // Solana system programs
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bRS',
  'ComputeBudget111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Vote111111111111111111111111111111111111111h',
  'Stake11111111111111111111111111111111111111',
  // Wormhole / Portal bridge programs — own large WETH/WBTC ATA positions
  'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth',
  'B6RHG3mfcckmrYN1UhmJzyS1XX3fZKbkeUcpJe9Sy3HE',
  'WormT3McKhFJ2RkiGpdw9GKvNCrB2aB54gb2uV9MfQC',
  // BlazeStake BSOL staking program
  'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi',
]);

// ── Helpers ───────────────────────────────────────────────────

const T    = () => new Date().toISOString().slice(11, 23);
const log  = (m: string) => console.log(`  ${T()} ${m}`);
const warn = (m: string) => console.warn(`  ${T()} ⚠  ${m}`);
const ok$  = (m: string) => console.log(`  ${T()} ✓  ${m}`);
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Helius RPC ────────────────────────────────────────────────

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('Missing HELIUS_API_KEY');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}
function heliusApiUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('Missing HELIUS_API_KEY');
  return `https://api.helius.xyz/v0/transactions?api-key=${key}`;
}

async function heliusRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(heliusRpcUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json() as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

async function getSignaturesForAddress(address: string, limit: number): Promise<Array<{ signature: string; blockTime?: number }>> {
  try {
    return await heliusRpc('getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }]);
  } catch (e) {
    warn(`getSignatures(${address.slice(0, 8)}…): ${String(e).slice(0, 60)}`);
    return [];
  }
}

interface HeliusTx {
  signature: string;
  timestamp?: number;
  nativeTransfers?: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }>;
  tokenTransfers?:  Array<{ fromUserAccount: string; toUserAccount: string; mint: string; tokenAmount: number }>;
}

async function getTransactionsBatch(sigs: string[]): Promise<HeliusTx[]> {
  if (sigs.length === 0) return [];
  try {
    const res = await fetch(heliusApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: sigs }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    return await res.json() as HeliusTx[];
  } catch {
    return [];
  }
}

// ── Confidence scoring ────────────────────────────────────────

function withdrawalScore(usd: number): number {
  if (usd >= 2_000_000) return 40;
  if (usd >= 1_000_000) return 35;
  if (usd >= 500_000)   return 28;
  if (usd >= 200_000)   return 20;
  if (usd >= 100_000)   return 12;
  if (usd >= 50_000)    return 6;
  return 2;
}

function computeConfidence(c: Candidate): number {
  const wdScore   = withdrawalScore(c.max_withdrawal_usd);
  const recScore  = Math.min(20, (c.recurrence_count - 1) * 10);
  const balScore  = c.total_value_usd
    ? Math.min(25, Math.round((c.total_value_usd / FLOW_THRESHOLDS.whale.min_total_value_usd) * 12.5))
    : 0;
  const gmgnScore = c.gmgn_max_trade_usd >= GMGN_MIN_TRADE_USD ? 15 : 0;
  return Math.min(100, wdScore + recScore + balScore + gmgnScore);
}

// ── SOURCE 1: Helius live exchange withdrawal scanner ─────────

async function scanExchangeWithdrawals(solPrice: number): Promise<Map<string, Candidate>> {
  console.log('\n── Source 1: Helius Live Withdrawal Scanner ──');
  const map = new Map<string, Candidate>();

  log(`Scanning ${KNOWN_EXCHANGE_ADDRESSES.length} exchange address(es) · ${HELIUS_SIGS_PER_EXCHANGE} sigs each`);

  for (const ex of KNOWN_EXCHANGE_ADDRESSES) {
    process.stdout.write(`  ${ex.label.padEnd(25)} `);

    // Guard: skip addresses that fail base58 validation (catches corrupt constants entries)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ex.address)) {
      console.log(`SKIP_INVALID_ADDRESS (not valid base58)`);
      continue;
    }

    const sigRecords = await getSignaturesForAddress(ex.address, HELIUS_SIGS_PER_EXCHANGE);
    const sigs       = sigRecords.map(s => s.signature);
    process.stdout.write(`${String(sigs.length).padStart(3)} sigs `);

    let found = 0;

    for (let i = 0; i < sigs.length; i += HELIUS_TX_BATCH) {
      const txs = await getTransactionsBatch(sigs.slice(i, i + HELIUS_TX_BATCH));

      for (const tx of txs) {
        // Native SOL transfers from this exchange
        for (const t of (tx.nativeTransfers ?? [])) {
          const sol = t.amount / 1e9;
          const usd = sol * solPrice;
          if (
            t.fromUserAccount === ex.address &&
            sol >= HELIUS_MIN_SOL_WD &&
            !INFRA_SET.has(t.toUserAccount) &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.toUserAccount)
          ) {
            const existing = map.get(t.toUserAccount);
            if (!existing) {
              map.set(t.toUserAccount, {
                address:              t.toUserAccount,
                sources:              ['helius_withdrawal'],
                max_withdrawal_sol:   sol,
                max_withdrawal_usd:   usd,
                recurrence_count:     1,
                recurrence_exchanges: [ex.sub_category],
                gmgn_max_trade_usd:   0,
                confidence_score:     0,
              });
              found++;
            } else {
              if (usd > existing.max_withdrawal_usd) {
                existing.max_withdrawal_sol = sol;
                existing.max_withdrawal_usd = usd;
              }
              if (!existing.recurrence_exchanges.includes(ex.sub_category)) {
                existing.recurrence_count++;
                existing.recurrence_exchanges.push(ex.sub_category);
              }
            }
          }
        }

        // USDC transfers from this exchange
        for (const t of (tx.tokenTransfers ?? [])) {
          if (
            t.mint === USDC_MINT &&
            t.fromUserAccount === ex.address &&
            t.tokenAmount >= HELIUS_MIN_USDC_WD &&
            !INFRA_SET.has(t.toUserAccount) &&
            /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.toUserAccount)
          ) {
            if (!map.has(t.toUserAccount)) {
              map.set(t.toUserAccount, {
                address:              t.toUserAccount,
                sources:              ['helius_withdrawal_usdc'],
                max_withdrawal_sol:   0,
                max_withdrawal_usd:   t.tokenAmount,
                recurrence_count:     1,
                recurrence_exchanges: [ex.sub_category],
                gmgn_max_trade_usd:   0,
                confidence_score:     0,
              });
              found++;
            }
          }
        }
      }

      await delay(200);
    }

    console.log(`→ ${found} new destination(s)`);
    await delay(400);
  }

  log(`Helius scan complete: ${map.size} unique candidate(s)`);
  return map;
}

// ── SOURCE 2: DB movements (existing webhook captures) ────────

async function scanDbMovements(): Promise<Map<string, Candidate>> {
  console.log('\n── Source 2: DB Movements ──');
  const map    = new Map<string, Candidate>();
  const cutoff = new Date(Date.now() - DB_WITHDRAWAL_WINDOW_DAYS * 86_400_000).toISOString();

  const { data, error } = await (db as any)
    .from('movements')
    .select('to_address, amount_usd, exchange')
    .eq('flow_type', 'exchange_withdrawal')
    .gte('amount_usd', 50_000)
    .gte('created_at', cutoff)
    .not('signature', 'like', 'TEST_%')
    .order('amount_usd', { ascending: false })
    .limit(500);

  if (error) { warn(`DB query failed: ${error.message}`); return map; }

  const rows = (data ?? []) as Array<{ to_address: string; amount_usd: number; exchange: string }>;
  log(`${rows.length} movement record(s) in last ${DB_WITHDRAWAL_WINDOW_DAYS} days`);

  for (const row of rows) {
    if (!row.to_address || INFRA_SET.has(row.to_address)) continue;
    const existing = map.get(row.to_address);
    if (!existing) {
      map.set(row.to_address, {
        address:              row.to_address,
        sources:              ['db_withdrawal'],
        max_withdrawal_sol:   0,
        max_withdrawal_usd:   row.amount_usd,
        recurrence_count:     1,
        recurrence_exchanges: [row.exchange ?? 'unknown'],
        gmgn_max_trade_usd:   0,
        confidence_score:     0,
      });
    } else if (row.amount_usd > existing.max_withdrawal_usd) {
      existing.max_withdrawal_usd = row.amount_usd;
    }
  }

  log(`${map.size} unique candidate(s) from DB`);
  return map;
}

// ── SOURCE 3: Protocol top holders (PRD Method 4) ────────────

async function getTokenPriceUsd(mint: string): Promise<number> {
  // Use Helius DAS getAsset — price_per_token is populated for major tokens
  try {
    const result = await heliusRpc<{
      token_info?: { price_info?: { price_per_token?: number } };
    }>('getAsset', [mint]);
    const price = result?.token_info?.price_info?.price_per_token ?? 0;
    if (price > 0) return price;
  } catch { /* fall through */ }
  return 0;
}

interface TokenLargestAccount { address: string; amount: string; uiAmount: number | null }
interface TokenAccountInfo {
  value: {
    data: {
      parsed: {
        info: { owner: string; mint: string; tokenAmount: { uiAmount: number | null } };
      };
      program: string;
    };
  } | null;
}

async function scanTokenTopHolders(): Promise<Map<string, Candidate>> {
  console.log('\n── Source 3: Protocol Top Holders (JUP / JTO / RAY) ──');
  const map = new Map<string, Candidate>();

  for (const token of TOKEN_SOURCES) {
    // Fetch token price from Jupiter
    const price = await getTokenPriceUsd(token.mint);
    if (price === 0) { log(`${token.symbol}: price unavailable, skipping`); continue; }
    log(`${token.symbol} @ $${price.toFixed(4)}  (need >$${(TOKEN_HOLDER_MIN_USD/1000).toFixed(0)}K holding)`);

    // getTokenLargestAccounts — returns up to 20 largest token accounts
    let accounts: TokenLargestAccount[] = [];
    try {
      const result = await heliusRpc<{ value: TokenLargestAccount[] }>(
        'getTokenLargestAccounts', [token.mint, { commitment: 'confirmed' }],
      );
      accounts = result.value ?? [];
    } catch (e) {
      warn(`getTokenLargestAccounts(${token.symbol}): ${String(e).slice(0, 60)}`);
      continue;
    }
    log(`  ${token.symbol}: ${accounts.length} token accounts returned`);

    let found = 0;
    for (const acct of accounts) {
      const uiAmt = acct.uiAmount ?? (Number(acct.amount) / Math.pow(10, token.decimals));
      const holdingUsd = uiAmt * price;
      if (holdingUsd < TOKEN_HOLDER_MIN_USD) continue;

      // Resolve owner of this token account
      let owner: string | null = null;
      try {
        const info = await heliusRpc<TokenAccountInfo>(
          'getAccountInfo', [acct.address, { encoding: 'jsonParsed', commitment: 'confirmed' }],
        );
        owner = info.value?.data?.parsed?.info?.owner ?? null;
      } catch { /* skip */ }
      await delay(150);

      if (!owner) continue;
      if (INFRA_SET.has(owner)) continue;
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) continue;

      if (!map.has(owner)) {
        map.set(owner, {
          address:              owner,
          sources:              [`token_${token.symbol.toLowerCase()}`],
          max_withdrawal_sol:   0,
          max_withdrawal_usd:   holdingUsd, // use as proxy signal
          recurrence_count:     0,
          recurrence_exchanges: [],
          gmgn_max_trade_usd:   0,
          confidence_score:     0,
        });
        found++;
      } else {
        const ex = map.get(owner)!;
        if (!ex.sources.includes(`token_${token.symbol.toLowerCase()}`)) {
          ex.sources.push(`token_${token.symbol.toLowerCase()}`);
          ex.recurrence_count++;     // seen across multiple tokens = stronger signal
        }
        ex.max_withdrawal_usd = Math.max(ex.max_withdrawal_usd, holdingUsd);
      }
    }

    log(`  ${token.symbol}: ${found} new owner(s) above $${(TOKEN_HOLDER_MIN_USD/1000).toFixed(0)}K threshold`);
    await delay(500);
  }

  log(`Token holder scan: ${map.size} unique candidate(s)`);
  return map;
}

// ── SOURCE 4: GMGN smart money + KOL ─────────────────────────

interface GmgnTrade {
  maker:      string;
  amount_usd: number;
  base_token: { symbol?: string; launchpad?: string };
  timestamp:  number;
}

function fetchGmgn(subcmd: 'smartmoney' | 'kol'): GmgnTrade[] {
  try {
    const raw = execSync(
      `gmgn-cli track ${subcmd} --chain sol --limit ${GMGN_FEED_LIMIT} --raw`,
      { encoding: 'utf8', timeout: 30_000 },
    );
    const parsed = JSON.parse(raw.trim()) as { list: GmgnTrade[] };
    return parsed.list ?? [];
  } catch (e) {
    warn(`gmgn-cli track ${subcmd}: ${String(e).slice(0, 60)}`);
    return [];
  }
}

function extractGmgnMakers(trades: GmgnTrade[], label: string): Map<string, number> {
  const out = new Map<string, number>();
  let pump = 0, small = 0;
  for (const t of trades) {
    const lp = t.base_token?.launchpad ?? '';
    if (lp === 'pump' || lp === 'pump_agent') { pump++;  continue; }
    if (t.amount_usd < GMGN_MIN_TRADE_USD)    { small++; continue; }
    if (!t.maker || INFRA_SET.has(t.maker))   continue;
    const prev = out.get(t.maker) ?? 0;
    if (t.amount_usd > prev) out.set(t.maker, t.amount_usd);
  }
  log(`GMGN ${label}: ${trades.length} raw → -${pump} pump -${small} small → ${out.size} maker(s)`);
  return out;
}

async function scanGmgn(): Promise<Map<string, number>> {
  console.log('\n── Source 4: GMGN Smart Money + KOL ──');
  const smMakers  = extractGmgnMakers(fetchGmgn('smartmoney'), 'smartmoney');
  const kolMakers = extractGmgnMakers(fetchGmgn('kol'),        'kol');
  const combined  = new Map<string, number>(smMakers);
  for (const [addr, usd] of kolMakers) {
    const prev = combined.get(addr) ?? 0;
    if (usd > prev) combined.set(addr, usd);
  }
  log(`GMGN combined unique makers: ${combined.size}`);
  return combined;
}

// ── Merge all sources into one candidate map ──────────────────

function mergeSources(
  withdrawalMap: Map<string, Candidate>,
  dbMap:         Map<string, Candidate>,
  tokenMap:      Map<string, Candidate>,
  gmgnMap:       Map<string, number>,
): Map<string, Candidate> {
  const merged = new Map<string, Candidate>(withdrawalMap);

  for (const [addr, c] of dbMap) {
    const ex = merged.get(addr);
    if (ex) {
      if (c.max_withdrawal_usd > ex.max_withdrawal_usd) ex.max_withdrawal_usd = c.max_withdrawal_usd;
      if (!ex.sources.includes('db_withdrawal')) ex.sources.push('db_withdrawal');
    } else {
      merged.set(addr, c);
    }
  }

  for (const [addr, c] of tokenMap) {
    const ex = merged.get(addr);
    if (ex) {
      // Seen by withdrawal scanner too — add token source tags
      for (const src of c.sources) {
        if (!ex.sources.includes(src)) ex.sources.push(src);
      }
      ex.max_withdrawal_usd = Math.max(ex.max_withdrawal_usd, c.max_withdrawal_usd);
      if (c.recurrence_count > 0) ex.recurrence_count++;
    } else {
      merged.set(addr, c);
    }
  }

  for (const [addr, usd] of gmgnMap) {
    const ex = merged.get(addr);
    if (ex) {
      ex.gmgn_max_trade_usd = Math.max(ex.gmgn_max_trade_usd, usd);
      if (!ex.sources.includes('gmgn')) ex.sources.push('gmgn');
    } else {
      // GMGN-only candidate — lower a priori confidence, still qualifiable
      merged.set(addr, {
        address:              addr,
        sources:              ['gmgn'],
        max_withdrawal_sol:   0,
        max_withdrawal_usd:   0,
        recurrence_count:     0,
        recurrence_exchanges: [],
        gmgn_max_trade_usd:   usd,
        confidence_score:     0,
      });
    }
  }

  return merged;
}

// ── Load DB sets ──────────────────────────────────────────────

async function loadKnownInfra(): Promise<Set<string>> {
  const { data } = await (db as any).from('known_addresses').select('address');
  return new Set(((data ?? []) as Array<{ address: string }>).map(r => r.address));
}

async function loadExistingWhales(): Promise<Set<string>> {
  const { data } = await (db as any).from('whales').select('address');
  return new Set(((data ?? []) as Array<{ address: string }>).map(w => w.address));
}

// ── Activity check ────────────────────────────────────────────

async function checkActivity(address: string): Promise<{ active: boolean; lastTs: number }> {
  try {
    const sigs = await heliusRpc<Array<{ blockTime?: number }>>('getSignaturesForAddress', [
      address, { limit: 5, commitment: 'confirmed' },
    ]);
    if (sigs.length === 0) return { active: false, lastTs: 0 };
    const lastTs  = sigs[0].blockTime ?? 0;
    const ageDays = (Date.now() / 1000 - lastTs) / 86400;
    return { active: ageDays <= 90, lastTs };
  } catch {
    return { active: true, lastTs: 0 }; // assume active on RPC error
  }
}

// ── Artifact writer ───────────────────────────────────────────

function writeArtifacts(
  all:       Candidate[],
  qualified: Candidate[],
  rejects:   RejectionCounts,
  source:    string,
  solPrice:  number,
  startTs:   number,
): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const ts = new Date().toISOString();

  // Full candidate JSON
  writeFileSync(`${ARTIFACT_DIR}/latest_candidates.json`,
    JSON.stringify({ generated_at: ts, source, sol_price_usd: solPrice, candidates: all }, null, 2));

  // CSV
  const header = 'address,sources,confidence_score,max_withdrawal_usd,recurrence_count,gmgn_trade_usd,sol_balance,usdc_balance,total_value_usd,rejection_reason\n';
  const rows   = all.map(c => [
    c.address, c.sources.join('|'), c.confidence_score,
    c.max_withdrawal_usd.toFixed(0), c.recurrence_count,
    c.gmgn_max_trade_usd.toFixed(0),
    c.sol_balance ?? '', c.usdc_balance ?? '', c.total_value_usd ?? '',
    c.rejection_reason ?? '',
  ].join(',')).join('\n');
  writeFileSync(`${ARTIFACT_DIR}/latest_candidates.csv`, header + rows);

  // Receipt JSON
  writeFileSync(`${ARTIFACT_DIR}/latest_receipt.json`, JSON.stringify({
    generated_at:          ts,
    run_duration_ms:       Date.now() - startTs,
    source,
    sol_price_usd:         solPrice,
    total_raw_candidates:  all.length + rejects.KNOWN_INFRA + rejects.ALREADY_TRACKED,
    pre_filtered:          { KNOWN_INFRA: rejects.KNOWN_INFRA, ALREADY_TRACKED: rejects.ALREADY_TRACKED },
    checked:               all.length,
    qualified:             qualified.length,
    rejections:            rejects,
    top_qualified:         qualified
      .sort((a, b) => b.confidence_score - a.confidence_score)
      .slice(0, 10)
      .map(c => ({ address: c.address, confidence_score: c.confidence_score, total_value_usd: c.total_value_usd, sources: c.sources })),
    webhook_sync_recommended: qualified.length > 0,
    import_command:        qualified.length > 0
      ? `tsx scripts/import-whale-seed.ts --file ${ARTIFACT_DIR}/addresses.txt --method exchange_withdrawal --dry-run`
      : null,
  }, null, 2));

  // Import-ready address list
  if (qualified.length > 0) {
    const lines = qualified
      .sort((a, b) => b.confidence_score - a.confidence_score)
      .map(c => `${c.address}  # conf=${c.confidence_score} total=$${Math.round((c.total_value_usd ?? 0) / 1000)}K src=${c.sources.join('|')}`)
      .join('\n');
    writeFileSync(`${ARTIFACT_DIR}/addresses.txt`, lines + '\n');
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const startTs = Date.now();

  console.log('\nSONAR v2.0 — Autonomous Whale Discovery');
  console.log('══════════════════════════════════════════════');
  if (skipInsert) console.log(`  MODE: ${dryRun ? 'dry-run' : 'output-only'} — no DB writes`);
  console.log(`  Source: ${sourceLabel}`);
  console.log();

  log('Fetching SOL price…');
  const solPrice = await getSolPriceUsd();
  log(`SOL price: $${solPrice.toFixed(2)}`);

  log('Loading known infra + existing whales from DB…');
  const [dbInfra, existingWhales] = await Promise.all([loadKnownInfra(), loadExistingWhales()]);
  for (const addr of dbInfra) INFRA_SET.add(addr);
  log(`Known infra: ${INFRA_SET.size}  |  Existing whales: ${existingWhales.size}`);

  // Collect from sources
  let withdrawalMap = new Map<string, Candidate>();
  let dbMap         = new Map<string, Candidate>();
  let tokenMap      = new Map<string, Candidate>();
  let gmgnMap       = new Map<string, number>();

  if (useWithdrawals) {
    withdrawalMap = await scanExchangeWithdrawals(solPrice);
    dbMap         = await scanDbMovements();
  }
  if (useTokens) {
    tokenMap = await scanTokenTopHolders();
  }
  if (useGmgn) {
    gmgnMap = await scanGmgn();
  }

  const merged = mergeSources(withdrawalMap, dbMap, tokenMap, gmgnMap);

  // Pre-filter: infra + duplicates
  const toCheck: Candidate[]  = [];
  const rejects: RejectionCounts = {
    KNOWN_INFRA: 0, BELOW_BALANCE_THRESHOLD: 0, INACTIVE: 0,
    PUMP_FUN_NOISE: 0, ALREADY_TRACKED: 0, INVALID_OWNER_SOURCE: 0, EXCHANGE_LIKE_PATTERN: 0,
  };

  for (const [addr, c] of merged) {
    if (INFRA_SET.has(addr)) { rejects.KNOWN_INFRA++;    continue; }
    if (existingWhales.has(addr)) { rejects.ALREADY_TRACKED++; continue; }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) { rejects.INVALID_OWNER_SOURCE++; continue; }
    toCheck.push(c);
  }

  // Sort by withdrawal USD descending, cap
  const sorted = toCheck
    .sort((a, b) => b.max_withdrawal_usd - a.max_withdrawal_usd)
    .slice(0, MAX_CANDIDATES);

  console.log(`\n── Qualification Check (${sorted.length} candidate(s)) ──`);
  if (sorted.length === 0) console.log('  No new candidates after pre-filtering.');

  const qualified:     Candidate[] = [];
  const checkedAll:    Candidate[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i];
    const sh = `${c.address.slice(0, 8)}…${c.address.slice(-4)}`;
    process.stdout.write(`  [${String(i + 1).padStart(3)}/${sorted.length}] ${sh}  `);

    // Activity gate
    const act = await checkActivity(c.address);
    c.last_active_ts = act.lastTs;
    if (!act.active) {
      process.stdout.write(`INACTIVE\n`);
      c.rejection_reason = 'INACTIVE';
      rejects.INACTIVE++;
      checkedAll.push(c);
      await delay(RPC_DELAY_MS);
      continue;
    }

    // Balance qualification
    try {
      const qual = await checkWhaleQualification(c.address, solPrice);
      if (!qual) {
        process.stdout.write(`BELOW_BALANCE_THRESHOLD\n`);
        c.rejection_reason = 'BELOW_BALANCE_THRESHOLD';
        rejects.BELOW_BALANCE_THRESHOLD++;
        checkedAll.push(c);
        await delay(RPC_DELAY_MS);
        continue;
      }

      c.sol_balance     = qual.sol_balance;
      c.usdc_balance    = qual.usdc_balance;
      c.total_value_usd = qual.total_value_usd;
      c.confidence_score = computeConfidence(c);
      c.discovery_method = c.sources.some(s => s.includes('withdrawal'))
        ? 'exchange_withdrawal'
        : c.sources.some(s => s.startsWith('token_'))
          ? 'balance_scan'
          : 'gmgn_feed';

      const fmt = qual.total_value_usd >= 1e6
        ? `$${(qual.total_value_usd / 1e6).toFixed(2)}M`
        : `$${(qual.total_value_usd / 1000).toFixed(0)}K`;
      process.stdout.write(`QUALIFIED ${fmt} SOL=${qual.sol_balance.toFixed(0)} USDC=${qual.usdc_balance.toFixed(0)} conf=${c.confidence_score}\n`);

      qualified.push(c);
      checkedAll.push(c);
    } catch (e) {
      process.stdout.write(`RPC_ERR: ${String(e).slice(0, 50)}\n`);
      checkedAll.push(c);
    }

    await delay(RPC_DELAY_MS);
  }

  // Write artifacts
  writeArtifacts(checkedAll, qualified, rejects, sourceLabel, solPrice, startTs);

  // ── Final receipt ──────────────────────────────────────────
  const totalRaw = merged.size + rejects.KNOWN_INFRA + rejects.ALREADY_TRACKED;
  console.log('\n══════════════════════════════════════════════');
  console.log(`Source:                       ${sourceLabel}`);
  console.log(`Raw candidates collected:     ${merged.size}`);
  console.log(`  Pre-filtered (infra):       ${rejects.KNOWN_INFRA}`);
  console.log(`  Pre-filtered (duplicate):   ${rejects.ALREADY_TRACKED}`);
  console.log(`Sent to qualification:        ${sorted.length}`);
  console.log(`  INACTIVE (>90d):            ${rejects.INACTIVE}`);
  console.log(`  BELOW_BALANCE_THRESHOLD:    ${rejects.BELOW_BALANCE_THRESHOLD}`);
  console.log(`  INVALID_OWNER:              ${rejects.INVALID_OWNER_SOURCE}`);
  console.log(`  QUALIFIED:                  ${qualified.length}`);
  console.log();

  if (qualified.length > 0) {
    console.log('Qualified wallets (by confidence):');
    for (const c of qualified.sort((a, b) => b.confidence_score - a.confidence_score)) {
      const fmt = (c.total_value_usd ?? 0) >= 1e6
        ? `$${((c.total_value_usd ?? 0) / 1e6).toFixed(2)}M`
        : `$${((c.total_value_usd ?? 0) / 1000).toFixed(0)}K`;
      console.log(`  [conf=${c.confidence_score}] ${c.address}  ${fmt}  src=${c.sources.join('|')}`);
    }

    console.log();
    console.log(`Artifacts → ${ARTIFACT_DIR}/`);
    console.log(`  latest_candidates.json  latest_candidates.csv`);
    console.log(`  latest_receipt.json     addresses.txt`);
    console.log();
    console.log('Next — dry run:');
    console.log(`  tsx scripts/import-whale-seed.ts --file ${ARTIFACT_DIR}/addresses.txt --method exchange_withdrawal --dry-run`);

    // Optional DB insert
    if (!skipInsert) {
      console.log('\n── Inserting to DB ──────────────────────────');
      let inserted = 0;
      for (const c of qualified) {
        const { error } = await (db as any).from('whales').insert({
          address:            c.address,
          label:              null,
          chain:              'solana',
          is_active:          true,
          sol_balance:        c.sol_balance,
          usdc_balance:       c.usdc_balance,
          total_value_usd:    c.total_value_usd,
          staked_sol:         null,
          staked_msol:        null,
          staked_jitosol:     null,
          whale_type:         'unknown',
          discovery_method:   c.discovery_method,
          balance_updated_at: new Date().toISOString(),
        });
        if (!error || error.message.includes('duplicate') || error.message.includes('unique')) {
          inserted++;
          ok$(`Inserted ${c.address.slice(0, 8)}…`);
        } else {
          warn(`Insert failed ${c.address.slice(0, 8)}…: ${error.message}`);
        }
      }
      console.log(`  DB inserts: ${inserted}`);
    }
  } else {
    console.log('RESULT: 0 qualified wallets found.');
    console.log();
    console.log('Autonomous next expansion path:');
    console.log('  1. Increase HELIUS_SIGS_PER_EXCHANGE → 500 for wider lookback window');
    console.log('  2. Add more exchange hot wallet addresses to KNOWN_EXCHANGE_ADDRESSES');
    console.log('     and seed-known-addresses.ts (binance sub-wallets, gate.io, kucoin)');
    console.log('  3. Lower HELIUS_MIN_SOL_WD 500 → 200 SOL for broader withdrawal net');
    console.log('  4. Let Helius webhook run 24-48h to accumulate real withdrawal records in DB');
    console.log('  5. GMGN: wait for non-pump.fun trades above $5K threshold to appear');
    console.log();
    console.log(`Artifacts → ${ARTIFACT_DIR}/latest_receipt.json`);
  }

  console.log(`\nDuration: ${((Date.now() - startTs) / 1000).toFixed(1)}s\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
