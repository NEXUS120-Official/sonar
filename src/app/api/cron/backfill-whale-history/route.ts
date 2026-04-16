// ============================================================
// SONAR v2.0 — Backfill Whale History Cron
// POST /api/cron/backfill-whale-history
// ============================================================
// Runs every 6 hours. For newly discovered whales (added within
// the last 7 days) that have no token_movements yet, fetches
// their last 90 days of SWAP/LP transactions and inserts them
// into token_movements.
//
// This gives new whales an immediate history so reputation
// scoring, copy signals, and DEX intelligence have data from day 1.
//
// Pipeline:
//   ingest-rpc        → fetches Helius history + archives raw_transactions
//   normalizer        → decodes raw payloads into typed movement records
//   product upsert    → writes token_movements with whale_id
//   metadata enrich   → back-fills token symbol/name (fire-and-forget)
//
// Design:
//   - Max 2 whales per run (3 ingest calls × 100 txns → ~600 Helius credits)
//   - Deduplicates on signature — safe to run multiple times
//   - Protected by CRON_SECRET
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { ingestAddressHistory, historyToRawRow } from '@/lib/ingest/ingest-rpc';
import { normalizeRawTxBatch } from '@/lib/normalizer';
import { resolveTokenMetadataBatch } from '@/lib/helius/token-metadata';
import { resolveSolPriceUsd } from '@/lib/price-engine';
import type { WhaleRow, TokenMovementRow } from '@/lib/supabase/types';
import type { AddressHistory } from '@/lib/providers/interfaces';

// ── Config ────────────────────────────────────────────────────

const MAX_WHALES_PER_RUN = 2;    // credit budget per run
const TXN_LIMIT_PER_CALL = 100;
const LOOKBACK_DAYS      = 90;
const WHALE_WINDOW_DAYS  = 7;    // only backfill whales added in last N days
const CALL_DELAY_MS      = 500;  // between ingest-rpc calls

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

// ── Helpers ───────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Merge AddressHistory arrays and deduplicate by signature. */
function deduplicateHistory(items: AddressHistory[]): AddressHistory[] {
  const seen = new Set<string>();
  return items.filter(item => {
    if (seen.has(item.signature)) return false;
    seen.add(item.signature);
    return true;
  });
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
  const solPriceUsd = await resolveSolPriceUsd(120);
  log('info', `SOL price: $${solPriceUsd}`);

  // ── 2. Find whales needing backfill ─────────────────────────
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

  const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);

  // ── 4. Backfill each whale ──────────────────────────────────
  for (const whale of toBackfill) {
    log('info', `Backfilling ${whale.address} (${whale.label ?? 'unlabeled'})`);
    whalesScanned++;

    try {
      // ── 4a. Ingest via ingest-rpc ─────────────────────────
      // Each call fetches from Helius AND archives to raw_transactions.
      // Returns items[] for downstream normalization.

      const swapReceipt = await ingestAddressHistory(db, whale.address, {
        type:  'SWAP',
        limit: TXN_LIMIT_PER_CALL,
      });
      await delay(CALL_DELAY_MS);

      const lpAddReceipt = await ingestAddressHistory(db, whale.address, {
        type:  'ADD_LIQUIDITY',
        limit: TXN_LIMIT_PER_CALL,
      });
      await delay(CALL_DELAY_MS);

      const lpWithdrawReceipt = await ingestAddressHistory(db, whale.address, {
        type:  'WITHDRAW_LIQUIDITY',
        limit: TXN_LIMIT_PER_CALL,
      });

      // Propagate any ingest errors as warnings (non-fatal — partial data is ok)
      for (const r of [swapReceipt, lpAddReceipt, lpWithdrawReceipt]) {
        for (const e of r.errors) log('warn', `  ingest-rpc: ${e}`);
      }

      log('info', `  Ingest: swap=${swapReceipt.fetched} lpAdd=${lpAddReceipt.fetched} lpWith=${lpWithdrawReceipt.fetched} (provider=${swapReceipt.provider})`);

      // ── 4b. Merge, deduplicate, and apply lookback window ─
      const allItems = deduplicateHistory([
        ...swapReceipt.items,
        ...lpAddReceipt.items,
        ...lpWithdrawReceipt.items,
      ]);

      const inWindow = allItems.filter(item => item.block_time >= lookbackCutoff);
      txnsFetched += inWindow.length;

      log('info', `  ${inWindow.length} txns in window (${allItems.length - inWindow.length} outside ${LOOKBACK_DAYS}d lookback)`);

      if (inWindow.length === 0) continue;

      // ── 4c. Normalize via normalizer ──────────────────────
      // Decodes raw payloads → typed movement records.
      // Uses the whale's own address as the whale set so the decoder
      // can identify which side of each trade belongs to this whale.

      const whaleSet  = new Set([whale.address]);
      const rawRows   = inWindow.map(historyToRawRow);
      const normalized = normalizeRawTxBatch(rawRows, {
        whaleAddressSet: whaleSet,
        solPriceUsd,
      });

      // ── 4d. Build token_movement rows ─────────────────────
      // Layer in whale_id (the normalizer is stateless — it doesn't
      // know DB UUIDs). movement_id is null for backfill; the
      // real-time webhook handler links movements at write time.

      const rows: Omit<TokenMovementRow, 'id' | 'created_at'>[] = normalized
        .filter(out => out.tokenMovement !== null)
        .map(out => ({
          ...out.tokenMovement!,
          whale_id:     whale.id,
          movement_id:  null,
          token_symbol: null,
          token_name:   null,
          pool_address: null,
          is_new_token: false,
        }));

      if (rows.length === 0) {
        log('info', `  No parseable token movements found after normalization`);
        continue;
      }

      // ── 4e. Upsert token_movements ────────────────────────
      const { error: upsertErr } = await (db as any)
        .from('token_movements')
        .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true });

      if (upsertErr) {
        throw new Error(`Upsert failed: ${upsertErr.message}`);
      }

      txnsInserted += rows.length;
      log('info', `  Inserted ${rows.length} token_movements`);

      // ── 4f. Enrich token symbols/names (fire-and-forget) ─
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
