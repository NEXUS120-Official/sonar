// ============================================================
// SONAR v2.0 — Backfill Whale History Cron
// POST /api/cron/backfill-whale-history
// ============================================================
// Runs every 6 hours. For newly discovered whales (added within
// the last 7 days) that have no token_movements yet, fetches
// their last 90 days of SWAP/LP transactions via Helius Enhanced
// Transactions API and inserts them into token_movements.
//
// This gives new whales an immediate history so reputation
// scoring, copy signals, and DEX intelligence have data from day 1.
//
// Design:
//   - Max 5 whales per run (credit budget: ~500 Helius credits)
//   - Two API calls per whale: SWAP (100 txns) + LP types (100 txns)
//   - Deduplicates on signature — safe to run multiple times
//   - Protected by CRON_SECRET
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { parseTokenMovement } from '@/lib/helius/parse-token-movement';
import { resolveTokenMetadataBatch } from '@/lib/helius/token-metadata';
import { getSolPriceUsd } from '@/lib/whale-discovery/balance-checker';
import type { HeliusEnhancedTx } from '@/lib/helius/parse-movement';
import type { WhaleRow, TokenMovementRow } from '@/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const MAX_WHALES_PER_RUN  = 5;
const TXN_LIMIT_PER_CALL  = 100;
const LOOKBACK_DAYS       = 90;
const WHALE_WINDOW_DAYS   = 7;   // only backfill whales added in last N days
const CALL_DELAY_MS       = 500; // between Helius API calls

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/backfill-whale-history][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'CRON_SECRET not set — running unauthenticated (dev mode)');
    return true;
  }
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Helius Enhanced Transactions fetch ────────────────────────

function heliusApiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[backfill] Missing HELIUS_API_KEY');
  return key;
}

/**
 * Fetch enhanced transactions for an address from Helius.
 * type: 'SWAP' | 'ADD_LIQUIDITY' | 'WITHDRAW_LIQUIDITY' | undefined (all)
 */
async function fetchEnhancedTxns(
  address: string,
  type?: string,
  before?: string,
): Promise<HeliusEnhancedTx[]> {
  const key    = heliusApiKey();
  const params = new URLSearchParams({
    'api-key': key,
    limit:     String(TXN_LIMIT_PER_CALL),
  });
  if (type)   params.set('type', type);
  if (before) params.set('before', before);

  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?${params}`;
  const res  = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal:  AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Helius Enhanced TX HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return (await res.json()) as HeliusEnhancedTx[];
}

// ── Receipt ───────────────────────────────────────────────────

interface BackfillReceipt {
  ok:             boolean;
  run_at:         string;
  whales_scanned: number;
  whales_skipped: number;
  txns_fetched:   number;
  txns_inserted:  number;
  errors:         string[];
  duration_ms:    number;
}

function buildReceipt(
  runAt:         Date,
  startMs:       number,
  whalesScanned: number,
  whalesSkipped: number,
  txnsFetched:   number,
  txnsInserted:  number,
  errors:        string[],
): BackfillReceipt {
  return {
    ok:             errors.length === 0,
    run_at:         runAt.toISOString(),
    whales_scanned: whalesScanned,
    whales_skipped: whalesSkipped,
    txns_fetched:   txnsFetched,
    txns_inserted:  txnsInserted,
    errors,
    duration_ms:    Date.now() - startMs,
  };
}

// ── Main handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let whalesScanned = 0;
  let whalesSkipped = 0;
  let txnsFetched   = 0;
  let txnsInserted  = 0;

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Starting backfill run');

  const db = createAdminClient();

  // ── 1. Get SOL price ────────────────────────────────────────
  const solPriceUsd = await getSolPriceUsd().catch(() => 120);
  log('info', `SOL price: $${solPriceUsd}`);

  // ── 2. Find whales needing backfill ─────────────────────────
  // Whales added in last WHALE_WINDOW_DAYS with no token_movements
  const windowCutoff = new Date(Date.now() - WHALE_WINDOW_DAYS * 86_400_000).toISOString();

  const { data: whalesRaw, error: whaleErr } = await db
    .from('whales')
    .select('id, address, label')
    .eq('is_active', true)
    .gte('created_at', windowCutoff)
    .order('created_at', { ascending: false })
    .limit(50);

  if (whaleErr) {
    const msg = `Failed to load whales: ${whaleErr.message}`;
    log('error', msg);
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, 0, 0, [msg]));
  }

  const candidates = (whalesRaw ?? []) as Pick<WhaleRow, 'id' | 'address' | 'label'>[];
  log('info', `${candidates.length} whale(s) added in last ${WHALE_WINDOW_DAYS} days`);

  if (candidates.length === 0) {
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, 0, 0, []));
  }

  // ── 3. Filter: skip whales that already have movements ──────
  const { data: coveredRaw } = await (db as any)
    .from('token_movements')
    .select('whale_id')
    .in('whale_id', candidates.map(w => w.id));

  const coveredIds = new Set(
    ((coveredRaw ?? []) as { whale_id: string }[]).map(r => r.whale_id),
  );

  const toBackfill = candidates
    .filter(w => !coveredIds.has(w.id))
    .slice(0, MAX_WHALES_PER_RUN);

  whalesSkipped = candidates.length - toBackfill.length;
  log('info', `${toBackfill.length} whale(s) need backfill (${whalesSkipped} already have data)`);

  if (toBackfill.length === 0) {
    return NextResponse.json(buildReceipt(runAt, startMs, 0, whalesSkipped, 0, 0, []));
  }

  // Lookback cutoff
  const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  // ── 4. Backfill each whale ──────────────────────────────────
  for (const whale of toBackfill) {
    log('info', `Backfilling ${whale.address} (${whale.label ?? 'unlabeled'})`);
    whalesScanned++;

    try {
      const whaleSet = new Set([whale.address]);
      const allTxns: HeliusEnhancedTx[] = [];

      // Fetch SWAPs
      await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      const swaps = await fetchEnhancedTxns(whale.address, 'SWAP');
      allTxns.push(...swaps);

      // Fetch LP events (ADD + WITHDRAW come from same endpoint without type filter
      // since Helius type filter only supports one type at a time)
      await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      const lpAdd = await fetchEnhancedTxns(whale.address, 'ADD_LIQUIDITY');
      allTxns.push(...lpAdd);

      await new Promise(r => setTimeout(r, CALL_DELAY_MS));
      const lpWithdraw = await fetchEnhancedTxns(whale.address, 'WITHDRAW_LIQUIDITY');
      allTxns.push(...lpWithdraw);

      // Deduplicate by signature (API may return overlaps)
      const seenSigs  = new Set<string>();
      const dedupTxns = allTxns.filter(tx => {
        if (seenSigs.has(tx.signature)) return false;
        seenSigs.add(tx.signature);
        return true;
      });

      // Filter to lookback window
      const inWindow = dedupTxns.filter(
        tx => new Date(tx.timestamp * 1000) >= lookbackCutoff,
      );

      txnsFetched += inWindow.length;
      log('info', `  Fetched ${inWindow.length} txns (${dedupTxns.length} total, ${dedupTxns.length - inWindow.length} outside window)`);

      if (inWindow.length === 0) continue;

      // ── 5. Parse and build token_movement rows ─────────────
      const rows: Omit<TokenMovementRow, 'id' | 'created_at'>[] = [];

      for (const tx of inWindow) {
        try {
          const parsed = parseTokenMovement(tx, whaleSet, solPriceUsd);
          if (!parsed) continue;

          rows.push({
            movement_id:     null,
            whale_id:        whale.id,
            signature:       parsed.signature,
            block_time:      parsed.block_time,
            token_mint:      parsed.token_mint,
            token_symbol:    null,
            token_name:      null,
            action:          parsed.action,
            amount_token:    parsed.amount_token,
            amount_sol:      parsed.amount_sol,
            amount_usd:      parsed.amount_usd,
            price_per_token: parsed.price_per_token,
            protocol:        parsed.protocol,
            pool_address:    null,
            is_new_token:    false,
          });
        } catch { /* skip malformed tx */ }
      }

      if (rows.length === 0) {
        log('info', `  No parseable token movements found`);
        continue;
      }

      // ── 6. Upsert (dedup on signature) ─────────────────────
      const { error: upsertErr } = await (db as any)
        .from('token_movements')
        .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true });

      if (upsertErr) {
        throw new Error(`Upsert failed: ${upsertErr.message}`);
      }

      txnsInserted += rows.length;
      log('info', `  Inserted ${rows.length} token_movements`);

      // Enrich token symbols/names (fire-and-forget — same as webhook handler)
      const mints = [...new Set(rows.map(r => r.token_mint))];
      resolveTokenMetadataBatch(mints)
        .then(async (metaMap) => {
          const db2 = createAdminClient();
          for (const [mint, meta] of metaMap) {
            if (!meta.symbol && !meta.name) continue;
            await (db2 as any)
              .from('token_movements')
              .update({ token_symbol: meta.symbol, token_name: meta.name })
              .eq('token_mint', mint)
              .is('token_symbol', null);
          }
        })
        .catch(() => { /* non-critical */ });

    } catch (err) {
      const msg = `Backfill failed for ${whale.address}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
    }
  }

  const receipt = buildReceipt(runAt, startMs, whalesScanned, whalesSkipped, txnsFetched, txnsInserted, errors);
  log('info', `Run complete — ${whalesScanned} scanned, ${txnsInserted} inserted, ${errors.length} errors`);
  return NextResponse.json(receipt);
}

export const GET = POST;
