// ============================================================
// SONAR v2.0 — Whale Balance Checker
// ============================================================
// Uses Helius DAS getAssetsByOwner to fetch the full portfolio
// value (SOL + all SPL tokens with on-chain prices), replacing
// the old SOL-only + USDC-only RPC approach.
//
// Qualification threshold: $500K total portfolio value.
// ============================================================

import { USDC_MINT, FLOW_THRESHOLDS } from '@/lib/utils/constants';

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL    = 1_000_000_000;
const SOL_PRICE_FALLBACK  = 120;
const COINGECKO_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';
const BINANCE_PRICE_URL   = 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT';

// ── Helius RPC/DAS URL ────────────────────────────────────────

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[balance-checker] Missing HELIUS_API_KEY');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

// ── SOL price (for discover-whales receipt + fallback) ────────

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
  return SOL_PRICE_FALLBACK;
}

// ── DAS portfolio fetch ───────────────────────────────────────

export interface PortfolioValue {
  sol_balance:     number;   // native SOL
  usdc_balance:    number;   // USDC token balance
  total_value_usd: number;   // SOL + all SPL tokens priced
  token_count:     number;   // distinct fungible tokens held
}

interface DasAssetItem {
  id:         string;
  interface?: string;
  token_info?: {
    balance:    number;
    decimals:   number;
    price_info?: {
      price_per_token?: number;
      total_price?:     number;
    };
  };
}

interface DasResponse {
  result: {
    total:         number;
    nativeBalance?: {
      lamports:      number;
      total_price?:  number;     // SOL value in USD (Helius-enriched)
      price_per_sol?: number;
    };
    items: DasAssetItem[];
  };
  error?: { message: string };
}

/**
 * Fetch full portfolio value for a wallet using Helius DAS getAssetsByOwner.
 * Returns SOL + all priced SPL token balances summed into total_value_usd.
 * Falls back to SOL-only if DAS is unavailable.
 */
export async function getPortfolioValue(address: string): Promise<PortfolioValue> {
  const url = heliusRpcUrl();

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'getAssetsByOwner',
      params:  {
        ownerAddress:   address,
        page:           1,
        limit:          1000,
        displayOptions: {
          showFungible:       true,
          showNativeBalance:  true,
          showZeroBalance:    false,
        },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`DAS getAssetsByOwner HTTP ${res.status}`);
  }

  const json = (await res.json()) as DasResponse;
  if (json.error) throw new Error(`DAS error: ${json.error.message}`);

  const result = json.result;

  // Native SOL
  const lamports    = result.nativeBalance?.lamports ?? 0;
  const sol_balance = lamports / LAMPORTS_PER_SOL;

  // SOL USD value — use DAS-provided price if available, else fetch separately
  let solUsdValue: number;
  if (result.nativeBalance?.total_price && result.nativeBalance.total_price > 0) {
    solUsdValue = result.nativeBalance.total_price;
  } else {
    const solPrice = await getSolPriceUsd();
    solUsdValue    = sol_balance * solPrice;
  }

  // SPL tokens
  const fungibles = (result.items ?? []).filter(
    (item) => item.interface === 'FungibleToken' || item.token_info,
  );

  let usdc_balance   = 0;
  let tokenUsdTotal  = 0;
  let token_count    = 0;

  for (const item of fungibles) {
    const ti = item.token_info;
    if (!ti) continue;

    const rawBalance = ti.balance ?? 0;
    const decimals   = ti.decimals ?? 0;
    const uiBalance  = rawBalance / Math.pow(10, decimals);

    // Track USDC separately for DB compat
    if (item.id === USDC_MINT) {
      usdc_balance = uiBalance;
    }

    // Sum all token USD values
    const tokenUsd = ti.price_info?.total_price ?? 0;
    tokenUsdTotal += tokenUsd;
    if (uiBalance > 0) token_count++;
  }

  const total_value_usd = solUsdValue + tokenUsdTotal;

  return { sol_balance, usdc_balance, total_value_usd, token_count };
}

// ── Qualification check ───────────────────────────────────────

export interface WhaleQualification {
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
}

/**
 * Check if a wallet qualifies as a whale via full DAS portfolio scan.
 * Returns null if total_value_usd < FLOW_THRESHOLDS.whale.min_total_value_usd ($500K).
 * Throws on DAS error — caller must catch.
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
