// ============================================================
// SONAR — Token Bucket Rate Limiter
// ============================================================
// Simple in-process rate limiter for external API calls.
// For distributed environments, replace with Redis-backed implementation.

interface RateLimiterOptions {
  maxRequests: number;  // Max requests per window
  windowMs: number;     // Time window in milliseconds
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, TokenBucket>();

/**
 * Check if a request is allowed under the rate limit.
 * Uses a token bucket algorithm.
 *
 * @param key       Unique identifier for the rate limit (e.g. 'helius', 'jupiter')
 * @param options   Rate limit config
 * @returns         true if allowed, false if rate limited
 */
export function checkRateLimit(key: string, options: RateLimiterOptions): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: options.maxRequests, lastRefill: now };
    buckets.set(key, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const refillAmount = (elapsed / options.windowMs) * options.maxRequests;
  bucket.tokens = Math.min(options.maxRequests, bucket.tokens + refillAmount);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

/**
 * Wait until a request slot is available, then consume it.
 * Use this for sequential flows where you can afford to wait.
 *
 * @param key     Rate limit key
 * @param options Rate limit config
 */
export async function waitForRateLimit(
  key: string,
  options: RateLimiterOptions
): Promise<void> {
  const maxWaitMs = options.windowMs * 2;
  const startTime = Date.now();

  while (!checkRateLimit(key, options)) {
    if (Date.now() - startTime > maxWaitMs) {
      throw new Error(`[rate-limiter] Timeout waiting for rate limit key="${key}"`);
    }
    await sleep(100);
  }
}

/**
 * Pre-built limiters for known external APIs.
 * Rates based on free/standard tiers — adjust as needed.
 */
export const RateLimiters = {
  helius: { maxRequests: 50, windowMs: 60_000 },
  jupiter: { maxRequests: 100, windowMs: 60_000 },
  birdeye: { maxRequests: 30, windowMs: 60_000 },
  anthropic: { maxRequests: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimiterOptions>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
