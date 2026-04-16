// ============================================================
// SONAR v2.0 — Whale Balance Checker
// ============================================================
// Uses the PUBLIC Solana RPC (zero Helius credits) for balance
// checks — getAccountInfo for SOL, getTokenAccountsByOwner for USDC.
// total_value_usd = sol_balance * sol_price + usdc_balance.
//
// This replaces the previous DAS getAssetsByOwner approach which
// cost 10 Helius credits per call (94 whales/hour = 676K credits/month).
//
// Qualification threshold: $500K total value.
// ============================================================

import { USDC_MINT, FLOW_THRESHOLDS } from '@/lib/utils/constants';
import { SOL_PRICE_FALLBACK_USD } from '@/lib/helius/sol-price-cache';

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL    = 1_000_000_000;
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const BINANCE_PRICE_URL   = 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT';

// Public Solana RPC — free, no credits, rate-limited to ~10 req/s
const PUBLIC_RPC_URLS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-mainnet.g.alchemy.com/v2/demo', // Alchemy public demo
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
        signal:  AbortSignal.timeout(10_000),
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

// ── SOL balance ───────────────────────────────────────────────

async function getSolBalance(address: string): Promise<number> {
  const result = await rpcCall('getAccountInfo', [
    address,
    { encoding: 'base64' },
  ]) as { value: { lamports: number } | null } | null;

  const lamports = result?.value?.lamports ?? 0;
  return lamports / LAMPORTS_PER_SOL;
}

// ── USDC balance ──────────────────────────────────────────────

async function getUsdcBalance(address: string): Promise<number> {
  const result = await rpcCall('getTokenAccountsByOwner', [
    address,
    { mint: USDC_MINT },
    { encoding: 'jsonParsed' },
  ]) as { value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }> } | null;

  const accounts = result?.value ?? [];
  let total = 0;
  for (const acc of accounts) {
    const ui = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
    total += ui;
  }
  return total;
}

// ── Portfolio value ───────────────────────────────────────────

export interface PortfolioValue {
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
  token_count:     number; // always 0 — kept for API compat with update-balances
}

/**
 * Fetch SOL + USDC balances using the public Solana RPC (zero Helius credits).
 * total_value_usd = sol * sol_price + usdc.
 */
export async function getPortfolioValue(address: string): Promise<PortfolioValue> {
  const solPrice = await getSolPriceUsd();

  const [sol_balance, usdc_balance] = await Promise.all([
    getSolBalance(address),
    getUsdcBalance(address),
  ]);

  const total_value_usd = sol_balance * solPrice + usdc_balance;

  return { sol_balance, usdc_balance, total_value_usd, token_count: 0 };
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
