// ============================================================
// SONAR — Discovery Source: DEXScreener
// ============================================================
// Strategy: fetch boosted/trending Solana tokens, then extract
// top buyer addresses from their recent transactions.
//
// No API key required for public endpoints.
// Rate limit: be polite — 1 req/sec max (enforced by caller).

import type { CandidateMetrics } from '../types';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';

interface DexPair {
  chainId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  txns?: {
    h24?: { buys: number; sells: number };
  };
  volume?: { h24?: number };
}

interface DexTokenBoost {
  tokenAddress: string;
  chainId: string;
  amount?: number;
}

interface DexSearchResponse {
  pairs?: DexPair[];
}

interface DexBoostedResponse {
  // Array of boosted tokens
  [index: number]: DexTokenBoost;
  length: number;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fetch candidate wallet addresses from DEXScreener trending Solana tokens.
 *
 * Flow:
 *   1. GET /token-boosts/latest/v1 → trending/boosted Solana tokens
 *   2. For each token, GET /latest/dex/pairs/solana/{tokenAddr} → pair data
 *   3. Extract buyer wallet addresses from pair maker info (if available)
 *
 * Note: DEXScreener does not expose individual buyer addresses in its public API.
 * This adapter returns token-level signals; wallet extraction requires Helius
 * enrichment (done by the engine for top-volume pairs).
 * Returns empty array if no useful data found — engine handles gracefully.
 */
export async function fetchDexScreenerCandidates(
  maxTokens = 10,
): Promise<CandidateMetrics[]> {
  try {
    const boosted = await fetchBoostedTokens(maxTokens);
    if (boosted.length === 0) return [];

    console.log(`[discovery/dexscreener] Found ${boosted.length} boosted Solana token(s)`);

    // DEXScreener public API doesn't provide per-wallet metrics.
    // We surface the token addresses so the engine can query Helius
    // for top buyers. Return empty CandidateMetrics array here —
    // wallet extraction is delegated to the Helius enrichment step.
    return [];
  } catch (err) {
    console.error('[discovery/dexscreener] Error:', err);
    return [];
  }
}

/**
 * Fetch boosted/trending Solana token addresses.
 * Used by the engine to seed Helius buyer lookups.
 */
export async function fetchTrendingSolanaTokens(
  maxTokens = 20,
): Promise<string[]> {
  try {
    const boosted = await fetchBoostedTokens(maxTokens * 2);
    return boosted
      .filter((t) => t.chainId === 'solana')
      .slice(0, maxTokens)
      .map((t) => t.tokenAddress);
  } catch (err) {
    console.error('[discovery/dexscreener] fetchTrendingSolanaTokens error:', err);
    return [];
  }
}

// ── Internal helpers ──────────────────────────────────────────

async function fetchBoostedTokens(limit: number): Promise<DexTokenBoost[]> {
  const res = await fetch(`${DEXSCREENER_BASE}/token-boosts/latest/v1`, {
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    console.warn(`[discovery/dexscreener] Boost endpoint HTTP ${res.status}`);
    return [];
  }

  const json = await res.json() as DexTokenBoost[] | { data?: DexTokenBoost[] };

  const items: DexTokenBoost[] = Array.isArray(json)
    ? json
    : (json as { data?: DexTokenBoost[] }).data ?? [];

  return items
    .filter((t) => t.chainId === 'solana' && t.tokenAddress)
    .slice(0, limit);
}

/**
 * Fetch pair data for a token on Solana.
 * Returns null on failure.
 */
export async function fetchDexScreenerPairs(
  tokenAddress: string,
): Promise<DexPair[]> {
  try {
    const res = await fetch(
      `${DEXSCREENER_BASE}/latest/dex/pairs/solana/${tokenAddress}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return [];
    const json = await res.json() as DexSearchResponse;
    return json.pairs ?? [];
  } catch {
    return [];
  }
}
