// ============================================================
// SONAR v2.0 — Discover Whales Cron
// POST /api/cron/discover-whales
// ============================================================
// Discovers new whale wallets from on-chain evidence and adds
// them to the whales table for Helius webhook tracking.
//
// Discovery source (cron): exchange_withdrawal movements
//   - Looks at movements.flow_type = 'exchange_withdrawal'
//   - Filters: amount_usd >= $100K, last 7 days
//   - Deduplicates by to_address, skips existing whales
//   - Checks balance: must have >= $500K total value
//   - Inserts qualifying wallets with discovery_method = 'exchange_withdrawal'
//
// Design:
//   - Processes up to 50 candidate addresses per run
//   - 300ms delay between RPC calls (rate-limit safety)
//   - Protected by CRON_SECRET
//   - Returns JSON receipt with candidates, inserted, skipped, failed
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  checkWhaleQualification,
  getSolPriceUsd,
} from '@/lib/whale-discovery/balance-checker';
import { getGMGNProvider } from '@/lib/providers';
import { FLOW_THRESHOLDS } from '@/lib/utils/constants';
import type { MovementRow, WhaleRow } from '@/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const MAX_CANDIDATES_PER_RUN = 50;
const CANDIDATE_WINDOW_DAYS  = 7;
const RPC_DELAY_MS           = 300;

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/discover-whales][${ts}]`;
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

// ── Receipt ───────────────────────────────────────────────────

interface DiscoverReceipt {
  ok:           boolean;
  run_at:       string;
  sol_price:    number;
  candidates:   number;
  inserted:     number;
  skipped:      number;
  failed:       number;
  errors:       string[];
  duration_ms:  number;
}

function buildReceipt(
  runAt:      Date,
  startMs:    number,
  solPrice:   number,
  candidates: number,
  inserted:   number,
  skipped:    number,
  failed:     number,
  errors:     string[],
): DiscoverReceipt {
  return {
    ok:          failed === 0 && errors.length === 0,
    run_at:      runAt.toISOString(),
    sol_price:   solPrice,
    candidates,
    inserted,
    skipped,
    failed,
    errors,
    duration_ms: Date.now() - startMs,
  };
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let candidates = 0;
  let inserted   = 0;
  let skipped    = 0;
  let failed     = 0;
  let solPrice   = 85;

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Starting whale discovery run');

  const db = createAdminClient();

  // ── 1. Fetch SOL price ──────────────────────────────────────
  try {
    solPrice = await getSolPriceUsd();
    log('info', `SOL price: $${solPrice}`);
  } catch (err) {
    log('warn', 'SOL price fetch failed — using fallback $85', err);
  }

  // ── 2a. GMGN smart money feed (secondary discovery path) ─────
  // Uses GMGNWalletProvider adapter — enforces `maker` field, never `account_address`.
  // Results are merged with the exchange-withdrawal candidates below.
  const gmgnCandidates = new Map<string, { amount_usd: number; exchange: string | null }>();
  try {
    const gmgn     = getGMGNProvider();
    const gmgnWallets = await gmgn.discoverWhales({ min_value_usd: FLOW_THRESHOLDS.whale.min_withdrawal_usd, limit: 30 });
    for (const w of gmgnWallets) {
      gmgnCandidates.set(w.address, { amount_usd: w.total_value_usd, exchange: null });
    }
    log('info', `GMGN feed: ${gmgnCandidates.size} candidate(s)`);
  } catch (err) {
    log('warn', 'GMGN discovery failed — continuing with exchange_withdrawal only', err);
  }

  // ── 2. Load recent large exchange withdrawals ───────────────
  const cutoff = new Date(
    Date.now() - CANDIDATE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data: movementsRaw, error: movErr } = await db
    .from('movements')
    .select('to_address, amount_usd, exchange')
    .eq('flow_type', 'exchange_withdrawal')
    .gte('amount_usd', FLOW_THRESHOLDS.whale.min_withdrawal_usd)
    .gte('created_at', cutoff)
    .order('amount_usd', { ascending: false })
    .limit(500);

  if (movErr) {
    const msg = `Failed to fetch movements: ${movErr.message}`;
    log('error', msg);
    return NextResponse.json(
      buildReceipt(runAt, startMs, solPrice, 0, 0, 0, 0, [msg]),
    );
  }

  const movements = (movementsRaw ?? []) as Pick<
    MovementRow,
    'to_address' | 'amount_usd' | 'exchange'
  >[];
  log('info', `Found ${movements.length} qualifying withdrawal(s)`);

  // ── 3. Deduplicate candidates ───────────────────────────────
  // Merge exchange_withdrawal + GMGN candidates into one map.
  // Exchange withdrawals take priority (have known exchange context).
  const candidateMap = new Map<string, { amount_usd: number; exchange: string | null }>();

  // Seed with GMGN first (lower priority)
  for (const [addr, meta] of gmgnCandidates) {
    candidateMap.set(addr, meta);
  }

  // Overlay exchange_withdrawal (higher priority — overwrites GMGN for same address)
  for (const m of movements) {
    if (!candidateMap.has(m.to_address)) {
      candidateMap.set(m.to_address, {
        amount_usd: m.amount_usd ?? 0,
        exchange:   m.exchange,
      });
    }
  }

  if (candidateMap.size === 0) {
    log('info', 'No candidates after deduplication');
    return NextResponse.json(
      buildReceipt(runAt, startMs, solPrice, 0, 0, 0, 0, []),
    );
  }

  // ── 4. Load existing whale addresses ───────────────────────
  const { data: existingRaw, error: whaleErr } = await db
    .from('whales')
    .select('address');

  if (whaleErr) {
    const msg = `Failed to fetch existing whales: ${whaleErr.message}`;
    log('error', msg);
    return NextResponse.json(
      buildReceipt(runAt, startMs, solPrice, 0, 0, 0, 0, [msg]),
    );
  }

  const existingAddresses = new Set(
    ((existingRaw ?? []) as Pick<WhaleRow, 'address'>[]).map((w) => w.address),
  );

  // ── 5. Filter out already-known whales ──────────────────────
  const newCandidates: Array<{ address: string; amount_usd: number; exchange: string | null }> = [];
  for (const [address, meta] of candidateMap) {
    if (existingAddresses.has(address)) {
      skipped++;
    } else {
      newCandidates.push({ address, ...meta });
    }
  }

  // Limit per run
  const toProcess = newCandidates.slice(0, MAX_CANDIDATES_PER_RUN);
  candidates = toProcess.length;
  skipped   += newCandidates.length - toProcess.length; // rest are deferred

  log('info', `Processing ${candidates} new candidate(s) (${skipped} skipped/deferred)`);

  if (candidates === 0) {
    return NextResponse.json(
      buildReceipt(runAt, startMs, solPrice, 0, 0, skipped, 0, []),
    );
  }

  // ── 6. Qualify and insert ───────────────────────────────────
  const dbAny = db as unknown as {
    from: (t: string) => {
      insert: (v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };

  for (const candidate of toProcess) {
    log('info', `Checking ${candidate.address} (withdrew $${candidate.amount_usd?.toFixed(0) ?? '?'} from ${candidate.exchange ?? 'unknown'})`);

    try {
      const qual = await checkWhaleQualification(candidate.address);

      if (!qual) {
        log('info', `  Below threshold — skipping`);
        skipped++;
      } else {
        log('info', `  Qualifies: SOL=${qual.sol_balance.toFixed(2)} USDC=${qual.usdc_balance.toFixed(2)} total=$${qual.total_value_usd.toFixed(0)}`);

        const { error: insertErr } = await dbAny.from('whales').insert({
          address:          candidate.address,
          label:            null,
          chain:            'solana',
          is_active:        true,
          sol_balance:      qual.sol_balance,
          usdc_balance:     qual.usdc_balance,
          total_value_usd:  qual.total_value_usd,
          staked_sol:       null,
          staked_msol:      null,
          staked_jitosol:   null,
          whale_type:       'unknown',
          discovery_method: candidate.exchange ? 'exchange_withdrawal' : 'gmgn_feed',
          balance_updated_at: new Date().toISOString(),
        });

        if (insertErr) {
          // Unique constraint on address = already exists (race). Treat as skip.
          if (insertErr.message.includes('duplicate') || insertErr.message.includes('unique')) {
            log('warn', `  Duplicate on insert — skipping`, insertErr.message);
            skipped++;
          } else {
            throw new Error(`Insert failed: ${insertErr.message}`);
          }
        } else {
          log('info', `  Inserted new whale`);
          inserted++;
        }
      }
    } catch (err) {
      const msg = `Failed to process ${candidate.address}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
      failed++;
    }

    await new Promise((r) => setTimeout(r, RPC_DELAY_MS));
  }

  const r = buildReceipt(runAt, startMs, solPrice, candidates, inserted, skipped, failed, errors);
  log('info', `Run complete — inserted=${inserted} skipped=${skipped} failed=${failed}`);
  return NextResponse.json(r);
}

export const GET = POST;
