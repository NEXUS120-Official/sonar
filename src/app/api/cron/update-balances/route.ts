// ============================================================
// SONAR v2.0 — Update Whale Balances Cron
// POST /api/cron/update-balances
// ============================================================
// Runs every hour. Updates SOL and USDC balances for all active whales.
//
// Strategy (zero Helius credits):
//   Phase 1 — SOL: one getMultipleAccounts call for all 94 whales (batched)
//   Phase 2 — USDC: sequential getTokenAccountsByOwner, 1 call/whale, 800ms delay
//
// Total: ~2 public RPC calls for SOL + 94 sequential USDC calls ≈ 80s
// Well within maxDuration:300.
//
// Protected by CRON_SECRET header.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { WhaleRow } from '@/lib/supabase/types';
import {
  getBatchSolBalances,
  getUsdcBalance,
} from '@/lib/whale-discovery/balance-checker';
import { resolveSolPriceUsdWithArchive } from '@/lib/price-engine';

// ── Config ────────────────────────────────────────────────────

const USDC_DELAY_MS      = 800;  // between USDC calls — ~1.25 req/s
const WHALE_LIMIT        = 100;  // max whales per run

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/update-balances][${ts}]`;
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

// ── Receipt type ──────────────────────────────────────────────

interface BalanceReceipt {
  ok:              boolean;
  run_at:          string;
  whales_updated:  number;
  whales_failed:   number;
  errors_count:    number;
  errors:          string[];
  sol_price_usd:   number;
  duration_ms:     number;
}

function buildReceipt(
  runAt: Date,
  startMs: number,
  whales_updated: number,
  whales_failed: number,
  sol_price_usd: number,
  errors: string[],
): BalanceReceipt {
  return {
    ok:             errors.length === 0,
    run_at:         runAt.toISOString(),
    whales_updated,
    whales_failed,
    errors_count:   errors.length,
    errors,
    sol_price_usd,
    duration_ms:    Date.now() - startMs,
  };
}

// ── Main handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let whales_updated = 0;
  let whales_failed  = 0;
  let sol_price_usd  = 85;

  if (!verifyCronSecret(req)) {
    log('warn', 'Unauthorized cron request');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Starting balance update run');

  const db    = createAdminClient();
  const dbAny = db as any;

  // ── 1. Fetch SOL price ──────────────────────────────────────
  sol_price_usd = await resolveSolPriceUsdWithArchive(db);
  log('info', `SOL price: $${sol_price_usd}`);

  // ── 2. Load active whales ───────────────────────────────────
  const { data: whalesRaw, error: whaleErr } = await db
    .from('whales')
    .select('id, address, label')
    .eq('is_active', true)
    .limit(WHALE_LIMIT);

  if (whaleErr) {
    log('error', 'Failed to load whales', whaleErr);
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, sol_price_usd, [whaleErr.message]));
  }

  const whales = (whalesRaw ?? []) as Pick<WhaleRow, 'id' | 'address' | 'label'>[];
  log('info', `Loaded ${whales.length} active whale(s)`);

  if (whales.length === 0) {
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, sol_price_usd, []));
  }

  // ── 3. Phase 1: Batch SOL balances (1-2 RPC calls) ─────────
  log('info', 'Phase 1: fetching all SOL balances (batched)');
  let solBalances = new Map<string, number>();
  try {
    solBalances = await getBatchSolBalances(whales.map(w => w.address));
    log('info', `  Got SOL balances for ${solBalances.size} whale(s)`);
  } catch (err) {
    log('error', 'Batch SOL fetch failed — skipping run', err);
    errors.push(`Batch SOL fetch failed: ${String(err)}`);
    return NextResponse.json(buildReceipt(runAt, startMs, 0, whales.length, sol_price_usd, errors));
  }

  // ── 4. Phase 2: Sequential USDC balances + DB update ───────
  log('info', 'Phase 2: fetching USDC balances (sequential) + updating DB');

  for (const whale of whales) {
    const sol_balance = solBalances.get(whale.address) ?? 0;

    let usdc_balance = 0;
    try {
      usdc_balance = await getUsdcBalance(whale.address);
    } catch (err) {
      log('warn', `  USDC fetch failed for ${whale.address} — using 0`, err);
    }

    const total_value_usd = sol_balance * sol_price_usd + usdc_balance;

    try {
      // Note: no deactivation here — SOL+USDC only is incomplete. Whales may hold
      // $500K+ in other SPL tokens not checked here. Deactivation is handled by the
      // discover-whales cron which uses full DAS portfolio data.
      const { error: updateErr } = await dbAny
        .from('whales')
        .update({
          sol_balance,
          usdc_balance,
          total_value_usd,
          balance_updated_at: new Date().toISOString(),
        })
        .eq('id', whale.id);

      if (updateErr) throw new Error(`DB update: ${updateErr.message}`);

      log('info', `  ${whale.address} — SOL: ${sol_balance.toFixed(1)} | USDC: ${usdc_balance.toFixed(0)} | $${total_value_usd.toFixed(0)}`);
      whales_updated++;
    } catch (err) {
      const msg = `DB update failed for ${whale.address}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
      whales_failed++;
    }

    await new Promise(r => setTimeout(r, USDC_DELAY_MS));
  }

  const receipt = buildReceipt(runAt, startMs, whales_updated, whales_failed, sol_price_usd, errors);
  log('info', `Run complete — ${whales_updated} updated, ${whales_failed} failed, ${errors.length} errors`);
  return NextResponse.json(receipt);
}

export const GET = POST;
