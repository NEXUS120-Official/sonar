// ============================================================
// SONAR v2.0 — Update Whale Balances Cron
// POST /api/cron/update-balances
// ============================================================
// Runs every hour. Fetches SOL and USDC balances for all active
// whales and updates the whales table.
//
// Uses Helius getAccountInfo (RPC) for SOL balance.
// Uses Helius getTokenAccountsByOwner for USDC balance.
// Computes total_value_usd = sol_balance * sol_price + usdc_balance.
//
// Protected by CRON_SECRET header.
// Returns JSON receipt.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { WhaleRow } from '@/lib/supabase/types';
import { getPortfolioValue, getSolPriceUsd } from '@/lib/whale-discovery/balance-checker';

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
  const token  = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

// (balance fetching delegated to balance-checker via getPortfolioValue + getSolPriceUsd)

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

// ── Main handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let whales_updated = 0;
  let whales_failed  = 0;
  let sol_price_usd  = 130;

  if (!verifyCronSecret(req)) {
    log('warn', 'Unauthorized cron request');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Starting balance update run');

  const db = createAdminClient();

  // ── 1. Fetch SOL price ──────────────────────────────────────
  try {
    sol_price_usd = await getSolPriceUsd();
  } catch (err) {
    log('warn', 'SOL price fetch failed', err);
    sol_price_usd = 130;
  }

  // ── 2. Load active whales ───────────────────────────────────
  const { data: whalesRaw, error: whaleErr } = await db
    .from('whales')
    .select('id, address, label')
    .eq('is_active', true)
    .limit(200);

  if (whaleErr) {
    log('error', 'Failed to load whales', whaleErr);
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, sol_price_usd, [whaleErr.message]));
  }

  const whales = (whalesRaw ?? []) as Pick<WhaleRow, 'id' | 'address' | 'label'>[];
  log('info', `Loaded ${whales.length} active whale(s)`);

  if (whales.length === 0) {
    log('warn', 'No active whales — nothing to update');
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, sol_price_usd, []));
  }

  // ── 3. Update balances sequentially (rate-limit friendly) ───
  // DAS getAssetsByOwner: one call per whale, returns full portfolio value.
  const DELAY_MS = 400; // DAS costs more credits — slightly longer delay

  const dbAny = db as unknown as {
    from: (t: string) => {
      update: (v: unknown) => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
    };
  };

  for (const whale of whales) {
    try {
      log('info', `Updating ${whale.address} (${whale.label ?? 'unlabeled'})`);

      const portfolio = await getPortfolioValue(whale.address);
      const { sol_balance, usdc_balance, total_value_usd } = portfolio;

      const { error: updateErr } = await dbAny
        .from('whales')
        .update({ sol_balance, usdc_balance, total_value_usd, balance_updated_at: new Date().toISOString() })
        .eq('id', whale.id);

      if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

      log('info', `  SOL: ${sol_balance.toFixed(2)} | USDC: ${usdc_balance.toFixed(2)} | Total: $${total_value_usd.toFixed(0)} (${portfolio.token_count} tokens)`);
      whales_updated++;

      // Deactivate whales that have fallen below threshold ($500K)
      if (total_value_usd < 500_000) {
        log('warn', `  Below $500K threshold — deactivating`);
        await dbAny.from('whales').update({ is_active: false }).eq('id', whale.id);
      }
    } catch (err) {
      const msg = `Failed to update whale ${whale.address}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
      whales_failed++;
    }

    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const r = buildReceipt(runAt, startMs, whales_updated, whales_failed, sol_price_usd, errors);
  log('info', `Run complete — ${whales_updated} updated, ${whales_failed} failed`);
  return NextResponse.json(r);
}

export const GET = POST;

// ── Receipt ───────────────────────────────────────────────────

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
