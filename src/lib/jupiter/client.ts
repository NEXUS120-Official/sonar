// ============================================================
// SONAR — Jupiter API Client (Solana)
// ============================================================
// Handles:
//   - Token price lookup via Jupiter Price API v6
//   - Token metadata via Jupiter Token API
//   - Swap URL generation
//
// Jupiter is Solana-only. For EVM chains (Ethereum, Arbitrum, Base),
// a separate client (e.g. 1inch or Uniswap SDK) will be added in Phase B+.

import { checkRateLimit, RateLimiters } from '@/lib/utils/rate-limiter';

// ── Constants ─────────────────────────────────────────────────

const JUPITER_PRICE_API = 'https://price.jup.ag/v6';
const JUPITER_TOKEN_API  = 'https://token.jup.ag/v1';

// USDC mint — used as the default quote currency for prices
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Response types ────────────────────────────────────────────

interface JupiterPriceEntry {
  id: string;
  mintSymbol: string;
  vsToken: string;
  vsTokenSymbol: string;
  price: number;
}

interface JupiterPriceResponse {
  data: Record<string, JupiterPriceEntry>;
  timeTaken: number;
}

export interface JupiterTokenInfo {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
  extensions?: Record<string, unknown>;
}

export interface TokenPriceResult {
  mint: string;
  priceUsd: number;
  symbol: string | null;
}

// ── Helpers ───────────────────────────────────────────────────

async function jupiterFetch<T>(
  baseUrl: string,
  path: string,
): Promise<T> {
  if (!checkRateLimit('jupiter', RateLimiters.jupiter)) {
    throw new Error('[jupiter/client] Rate limit exceeded — retry after backoff');
  }

  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json' },
    // Next.js extended fetch cache — cast needed because RequestInit doesn't
    // include `next` in non-Next.js TypeScript contexts (e.g. scripts tsconfig).
    ...({ next: { revalidate: 30 } } as Record<string, unknown>),
  } as RequestInit);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[jupiter/client] HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`,
    );
  }

  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fetch USD prices for up to 100 token mints in a single call.
 * Returns a map of { mint → priceUsd }.
 *
 * Tokens not found in Jupiter price feed are omitted from the result.
 */
export async function getTokenPrices(
  mints: string[],
): Promise<Map<string, TokenPriceResult>> {
  if (mints.length === 0) return new Map();

  const uniqueMints = [...new Set(mints)];
  const batches: string[][] = [];

  // Jupiter allows up to 100 ids per request
  for (let i = 0; i < uniqueMints.length; i += 100) {
    batches.push(uniqueMints.slice(i, i + 100));
  }

  const results = new Map<string, TokenPriceResult>();

  for (const batch of batches) {
    const ids = batch.join(',');
    const data = await jupiterFetch<JupiterPriceResponse>(
      JUPITER_PRICE_API,
      `/price?ids=${ids}&vsToken=USDC`,
    );

    for (const [mint, entry] of Object.entries(data.data)) {
      results.set(mint, {
        mint,
        priceUsd: entry.price,
        symbol: entry.mintSymbol || null,
      });
    }
  }

  return results;
}

/**
 * Fetch the USD price for a single token mint.
 * Returns null if the token is not found in Jupiter's price feed.
 */
export async function getTokenPrice(mint: string): Promise<number | null> {
  const prices = await getTokenPrices([mint]);
  return prices.get(mint)?.priceUsd ?? null;
}

/**
 * Fetch token metadata (name, symbol, decimals) from Jupiter Token API.
 * Returns null for unknown tokens.
 */
export async function getTokenInfo(mint: string): Promise<JupiterTokenInfo | null> {
  try {
    return await jupiterFetch<JupiterTokenInfo>(JUPITER_TOKEN_API, `/token/${mint}`);
  } catch {
    return null; // Token not in Jupiter's token list (new/unknown)
  }
}

/**
 * Fetch metadata for multiple tokens. Tokens not found are omitted.
 */
export async function getTokenInfoBatch(
  mints: string[],
): Promise<Map<string, JupiterTokenInfo>> {
  const results = new Map<string, JupiterTokenInfo>();
  // Jupiter Token API does not support batch lookup — parallel individual calls
  await Promise.allSettled(
    mints.map(async (mint) => {
      const info = await getTokenInfo(mint);
      if (info) results.set(mint, info);
    }),
  );
  return results;
}

/**
 * Generate a pre-filled Jupiter swap deep link.
 * Format: https://jup.ag/swap/SOL-{TOKEN_ADDRESS}
 */
export function getJupiterSwapUrl(tokenAddress: string): string {
  return `https://jup.ag/swap/SOL-${tokenAddress}`;
}

/**
 * Alias for getJupiterSwapUrl — PRD documented name.
 */
export const getSwapUrl = getJupiterSwapUrl;

/**
 * Estimate USD value of a SOL amount using current Jupiter SOL price.
 * Used to enrich ParsedTransactions where the whale paid in SOL.
 */
export async function solToUsd(solAmount: number): Promise<number | null> {
  const price = await getTokenPrice(WSOL_MINT);
  if (price === null) return null;
  return solAmount * price;
}

/**
 * Enrich a parsed transaction's amountUsd when it was paid in SOL.
 * Returns the USD value, or null if SOL price is unavailable.
 *
 * @param solLamports  Amount in lamports (from nativeInput.amount)
 */
export async function enrichSolAmountUsd(solLamports: number): Promise<number | null> {
  const solAmount = solLamports / 1_000_000_000;
  return solToUsd(solAmount);
}
