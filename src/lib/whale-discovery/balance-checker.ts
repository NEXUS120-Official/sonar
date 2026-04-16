// ============================================================
// SONAR v2.0 — Whale Balance Checker
// ============================================================
// Uses the PUBLIC Solana RPC (zero Helius credits) for balance checks.
//
// SOL balances: getMultipleAccounts — batches all addresses in 1-2 calls.
// USDC balances: getTokenAccountsByOwner — sequential with 1s delay.
//
// This replaces DAS getAssetsByOwner (10 credits/call = 676K credits/month).
// Now: 0 Helius credits, stays within public RPC rate limits.
//
// Qualification threshold: $500K total value.
// ============================================================

import { USDC_MINT, FLOW_THRESHOLDS } from '@/lib/utils/constants';
import { SOL_PRICE_FALLBACK_USD } from '@/lib/helius/sol-price-cache';

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL    = 1_000_000_000;
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const BINANCE_PRICE_URL   = 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT';

// Public Solana mainnet — free, zero credits, rate-limited to ~10 req/s
const PUBLIC_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo',
];

// ── SOL price ─────────────────────────────────────────────────

export async function getSolPriceUsd(): Promise<number> {
  // Primary: CoinGecko
  try {
    const res = await fetch(COINGECKO_PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const json = (await res.json()) as { solana: { usd: number } };
    const price = json?.solana?.usd;
    if (price && price > 0) return price;
    throw new Error('CoinGecko: bad response');
  } catch {
    // Fallback: Binance
    try {
      const res = await fetch(BINANCE_PRICE_URL, {
        headers: { Accept: 'application/json' },
        signal:  AbortSignal.timeout(6_000),
      });
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
      const json = (await res.json()) as { price: string };
      const price = parseFloat(json?.price ?? '0');
      if (price > 0) return price;
    } catch { /* fall through */ }
  }
  return SOL_PRICE_FALLBACK_USD;
}

// ── Public RPC JSON-RPC helper ────────────────────────────────

async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  const errors: string[] = [];
  for (const url of PUBLIC_RPC_URLS) {
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { result: unknown; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result;
    } catch (err) {
      errors.push(`${url}: ${String(err)}`);
    }
  }
  throw new Error(`All RPC endpoints failed: ${errors.join(' | ')}`);
}

// ── Batch SOL balances (getMultipleAccounts) ──────────────────

const SOL_BATCH_SIZE = 100;

/**
 * Fetch SOL balances for many addresses in a single RPC call.
 * Returns a map of address → SOL balance.
 */
export async function getBatchSolBalances(
  addresses: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < addresses.length; i += SOL_BATCH_SIZE) {
    const batch  = addresses.slice(i, i + SOL_BATCH_SIZE);
    const result = await rpcCall('getMultipleAccounts', [
      batch,
      { encoding: 'base64' },
    ]) as { value: Array<{ lamports: number } | null> } | null;

    const accounts = result?.value ?? [];
    for (let j = 0; j < batch.length; j++) {
      const acc = accounts[j];
      map.set(batch[j], (acc?.lamports ?? 0) / LAMPORTS_PER_SOL);
    }

    if (i + SOL_BATCH_SIZE < addresses.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return map;
}

// ── Single SOL balance ────────────────────────────────────────

async function getSolBalance(address: string): Promise<number> {
  const result = await rpcCall('getAccountInfo', [
    address,
    { encoding: 'base64' },
  ]) as { value: { lamports: number } | null } | null;
  return (result?.value?.lamports ?? 0) / LAMPORTS_PER_SOL;
}

// ── USDC balance ──────────────────────────────────────────────

export async function getUsdcBalance(address: string): Promise<number> {
  const result = await rpcCall('getTokenAccountsByOwner', [
    address,
    { mint: USDC_MINT },
    { encoding: 'jsonParsed' },
  ]) as { value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }> } | null;

  const accounts = result?.value ?? [];
  let total = 0;
  for (const acc of accounts) {
    total += acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
  }
  return total;
}

// ── Portfolio value (single address) ─────────────────────────

export interface PortfolioValue {
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
  token_count:     number; // always 0 — kept for API compat
}

/**
 * Fetch SOL + USDC balance for a single address.
 * Pass solPriceUsd to skip the price fetch when called in a loop.
 */
export async function getPortfolioValue(
  address: string,
  solPriceUsd?: number,
): Promise<PortfolioValue> {
  const solPrice    = solPriceUsd ?? await getSolPriceUsd();
  const sol_balance = await getSolBalance(address);
  const usdc_balance = await getUsdcBalance(address);
  return {
    sol_balance,
    usdc_balance,
    total_value_usd: sol_balance * solPrice + usdc_balance,
    token_count: 0,
  };
}

// ── Qualification check ───────────────────────────────────────

export interface WhaleQualification {
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
}

/**
 * Check if a wallet qualifies as a whale (>= $500K SOL+USDC value).
 * Returns null if below threshold. Throws on RPC error.
 */
export async function checkWhaleQualification(
  address: string,
): Promise<WhaleQualification | null> {
  const portfolio = await getPortfolioValue(address);
  if (portfolio.total_value_usd < FLOW_THRESHOLDS.whale.min_total_value_usd) {
    return null;
  }
  return {
    sol_balance:     portfolio.sol_balance,
    usdc_balance:    portfolio.usdc_balance,
    total_value_usd: portfolio.total_value_usd,
  };
}
