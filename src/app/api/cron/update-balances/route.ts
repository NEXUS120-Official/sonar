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
import { USDC_MINT, HELIUS_API_REST } from '@/lib/utils/constants';

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

// ── Helius RPC helpers ────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[update-balances] Missing HELIUS_API_KEY');
  return `${HELIUS_API_REST}/v0/addresses?api-key=${key}`;
}

function heliusRpc(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[update-balances] Missing HELIUS_API_KEY');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const url = heliusRpc();
  log('info', `RPC call: ${method}`);
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RPC ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

/**
 * Get SOL balance in SOL (not lamports).
 */
async function getSolBalance(address: string): Promise<number> {
  const result = await rpcCall<{ value: number }>('getBalance', [
    address,
    { commitment: 'confirmed' },
  ]);
  return result.value / LAMPORTS_PER_SOL;
}

/**
 * Get USDC balance for a wallet (sum of all USDC token accounts).
 */
async function getUsdcBalance(address: string): Promise<number> {
  interface TokenAccountValue {
    account: {
      data: {
        parsed: {
          info: {
            tokenAmount: { uiAmount: number | null };
          };
        };
      };
    };
  }
  const result = await rpcCall<{ value: TokenAccountValue[] }>(
    'getTokenAccountsByOwner',
    [
      address,
      { mint: USDC_MINT },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ],
  );
  const accounts = result.value ?? [];
  return accounts.reduce((sum, acct) => {
    const ui = acct.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    return sum + ui;
  }, 0);
}

/**
 * Fetch SOL price in USD via Jupiter price API.
 * Falls back to $130 if unavailable.
 */
async function getSolPriceUsd(): Promise<number> {
  try {
    log('info', 'Fetching SOL price from Jupiter');
    // Jupiter Price API v2
    const res = await fetch(
      'https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112',
      { headers: { 'Accept': 'application/json' } },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data: Record<string, { price: string }>;
    };
    const priceStr = json.data['So11111111111111111111111111111111111111112']?.price;
    const price    = priceStr ? parseFloat(priceStr) : 0;
    if (price > 0) {
      log('info', `SOL price: $${price}`);
      return price;
    }
    throw new Error('Zero price returned');
  } catch (err) {
    log('warn', `SOL price fetch failed — using fallback $130`, err);
    return 130;
  }
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
  const DELAY_MS = 200; // ~5 req/s to stay within free tier

  for (const whale of whales) {
    try {
      log('info', `Updating ${whale.address} (${whale.label ?? 'unlabeled'})`);

      const [sol_balance, usdc_balance] = await Promise.all([
        getSolBalance(whale.address),
        getUsdcBalance(whale.address),
      ]);

      const total_value_usd = sol_balance * sol_price_usd + usdc_balance;

      const dbAny = db as unknown as {
        from: (t: string) => {
          update: (v: unknown) => { eq: (col: string, val: string) => Promise<{ error: { message: string } | null }> };
        };
      };

      const { error: updateErr } = await dbAny
        .from('whales')
        .update({ sol_balance, usdc_balance, total_value_usd, balance_updated_at: new Date().toISOString() })
        .eq('id', whale.id);

      if (updateErr) {
        throw new Error(`DB update failed: ${updateErr.message}`);
      }

      log('info', `  SOL: ${sol_balance.toFixed(2)} | USDC: ${usdc_balance.toFixed(2)} | Total: $${total_value_usd.toFixed(0)}`);
      whales_updated++;

      // Deactivate whales that have fallen below threshold ($500K)
      if (total_value_usd < 500_000) {
        log('warn', `  Whale ${whale.address} below $500K threshold — deactivating`);
        await dbAny.from('whales').update({ is_active: false }).eq('id', whale.id);
      }
    } catch (err) {
      const msg = `Failed to update whale ${whale.address}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
      whales_failed++;
    }

    // Small delay between wallets to avoid hammering RPC
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
