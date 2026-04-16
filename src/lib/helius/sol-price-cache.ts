// ============================================================
// SONAR v2.0 — SOL Price Cache
// ============================================================
// Module-level cache for the SOL/USD price used in threshold
// calculations inside parse-movement.ts.
//
// TTL: 15 minutes — balances freshness vs. API call volume.
// Fallback: returns SOL_PRICE_FALLBACK_USD if the Jupiter API
//           is unreachable or returns an invalid value.
//
// Note on serverless: module state is best-effort in serverless
// (fresh cold start = empty cache). The cache still eliminates
// redundant fetches within a single warm lambda invocation and
// across requests within the same container lifetime.
// ============================================================

// Price sources — tried in order until one succeeds
const PRICE_SOURCES = [
  // Binance public spot price — no key required, reliable
  async (): Promise<number> => {
    const res = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
    const j = (await res.json()) as { price: string };
    const p = parseFloat(j.price);
    if (p <= 0) throw new Error('Binance returned zero price');
    return p;
  },
  // Jupiter Price API v6 (legacy public endpoint)
  async (): Promise<number> => {
    const addr = 'So11111111111111111111111111111111111111112';
    const res  = await fetch(
      `https://price.jup.ag/v6/price?ids=${addr}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!res.ok) throw new Error(`Jupiter HTTP ${res.status}`);
    const j = (await res.json()) as { data: Record<string, { price: number }> };
    const p = j.data[addr]?.price ?? 0;
    if (p <= 0) throw new Error('Jupiter returned zero price');
    return p;
  },
];

// ── Fallback / config ─────────────────────────────────────────

/** Hardcoded fallback used when the live price API is unavailable. */
export const SOL_PRICE_FALLBACK_USD = 85;

/** Cache entry is considered fresh for this many ms. */
const CACHE_TTL_MS = 15 * 60 * 1000;  // 15 min

// ── Module-level cache ────────────────────────────────────────

let _cachedPrice: number = SOL_PRICE_FALLBACK_USD;
let _fetchedAt:   number = 0;  // 0 = never fetched

// ── Internal fetch ────────────────────────────────────────────

/** Try each price source in order; throws if all fail. */
async function fetchSolPrice(): Promise<number> {
  const errors: string[] = [];
  for (const source of PRICE_SOURCES) {
    try {
      return await source();
    } catch (err) {
      errors.push(String(err));
    }
  }
  throw new Error(`All price sources failed: ${errors.join(' | ')}`);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Return a recent SOL/USD price.
 * - Uses the cached value if it is less than CACHE_TTL_MS old.
 * - Re-fetches otherwise, updating the cache on success.
 * - Falls back to SOL_PRICE_FALLBACK_USD on any fetch error.
 * Never throws.
 */
export async function getCachedSolPrice(): Promise<number> {
  const now     = Date.now();
  const ageMs   = now - _fetchedAt;

  if (_fetchedAt > 0 && ageMs < CACHE_TTL_MS) {
    return _cachedPrice;
  }

  try {
    const fresh = await fetchSolPrice();
    _cachedPrice = fresh;
    _fetchedAt   = now;
    return fresh;
  } catch {
    // Keep serving the stale cache value rather than crashing.
    // If cache was never populated, returns the compile-time fallback.
    return _cachedPrice;
  }
}

/**
 * Return the last successfully fetched price synchronously, without
 * triggering a new fetch. Useful when an async call has already been
 * made earlier in the same request cycle and you just need the value.
 * Returns SOL_PRICE_FALLBACK_USD if the cache has never been populated.
 */
export function getLastKnownSolPrice(): number {
  return _cachedPrice;
}

/**
 * How old (in ms) the cached price is. Returns Infinity if never fetched.
 */
export function cacheStalenessMs(): number {
  return _fetchedAt === 0 ? Infinity : Date.now() - _fetchedAt;
}
