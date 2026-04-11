// ============================================================
// SONAR — Safety Score Engine
// ============================================================
// Scores a token 0–100 based on on-chain safety factors.
// Caches results in the token_safety table (TTL: 1 hour).
//
// Data sources:
//   - Birdeye API  → holder count, top10 %, token age, website
//   - Helius RPC   → mint authority status (Solana-specific)
//   - Heuristics   → honeypot / liquidity (enriched in future phases)

import { createAdminClient } from '@/lib/supabase/server';
import { SAFETY_THRESHOLDS } from '@/lib/utils/constants';
import { checkRateLimit, RateLimiters } from '@/lib/utils/rate-limiter';
import type { SafetyFactors, SafetyReport, TokenOnChainData } from './types';
import type { SafetyLevel } from '@/lib/supabase/types';

// ── Scoring constants (per PRD 4.3) ──────────────────────────

const SCORE_LIQUIDITY_LOCKED      = 20;
const SCORE_LIQUIDITY_LOCK_LONG   = 5;   // extra if lockDays > 180
const SCORE_OWNER_RENOUNCED       = 20;
const SCORE_MINT_REVOKED          = 15;
const SCORE_TOP10_HOLDER_LOW      = 15;  // if top10HolderPct < 40
const SCORE_HOLDER_COUNT_OK       = 10;  // if holderCount > 100
const SCORE_TOKEN_AGE_24H         = 10;  // if tokenAgeHours > 24
const SCORE_TOKEN_AGE_168H        = 5;   // extra if > 168h (1 week)
const SCORE_HAS_WEBSITE           = 5;

// Safety cache TTL in milliseconds (1 hour)
const CACHE_TTL_MS = 60 * 60 * 1000;

// ── Scoring algorithm ─────────────────────────────────────────

/**
 * Compute a safety score from raw safety factors.
 * Pure function — no side effects, no I/O.
 */
export function computeSafetyScore(factors: SafetyFactors): number {
  // Hard override: honeypot = instant 0
  if (factors.isHoneypot === true) return 0;

  let score = 0;

  if (factors.liquidityLocked === true) {
    score += SCORE_LIQUIDITY_LOCKED;
    if ((factors.liquidityLockDays ?? 0) > 180) {
      score += SCORE_LIQUIDITY_LOCK_LONG;
    }
  }

  if (factors.ownerRenounced === true)      score += SCORE_OWNER_RENOUNCED;
  if (factors.mintAuthorityRevoked === true) score += SCORE_MINT_REVOKED;
  if ((factors.top10HolderPct ?? 100) < 40) score += SCORE_TOP10_HOLDER_LOW;
  if ((factors.holderCount ?? 0) > 100)      score += SCORE_HOLDER_COUNT_OK;

  const age = factors.tokenAgeHours ?? 0;
  if (age > 24)  score += SCORE_TOKEN_AGE_24H;
  if (age > 168) score += SCORE_TOKEN_AGE_168H;

  if (factors.hasWebsite === true) score += SCORE_HAS_WEBSITE;

  return Math.min(score, 100);
}

/**
 * Map a numeric score to a SafetyLevel label.
 */
export function scoreToLevel(score: number): SafetyLevel {
  if (score >= SAFETY_THRESHOLDS.safe)    return 'safe';
  if (score >= SAFETY_THRESHOLDS.caution) return 'caution';
  return 'danger';
}

// ── On-chain data fetching ────────────────────────────────────

/**
 * Fetch token data from Birdeye API.
 * Returns partial data — missing fields are null, not errors.
 */
async function fetchBirdeyeData(
  tokenAddress: string,
): Promise<Partial<TokenOnChainData>> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.warn('[safety/checker] BIRDEYE_API_KEY not set — skipping Birdeye fetch');
    return {};
  }

  if (!checkRateLimit('birdeye', RateLimiters.birdeye)) {
    console.warn('[safety/checker] Birdeye rate limit — skipping fetch');
    return {};
  }

  try {
    const res = await fetch(
      `https://public-api.birdeye.so/defi/token_overview?address=${tokenAddress}`,
      {
        headers: {
          'X-API-KEY': apiKey,
          'x-chain': 'solana',
        },
      },
    );

    if (!res.ok) return {};

    const json = await res.json() as {
      data?: {
        holder?: number;
        top10HolderPercent?: number;
        createdAt?: number;  // Unix seconds
        extensions?: { website?: string };
      };
    };

    const d = json.data ?? {};
    const createdAt = d.createdAt ? d.createdAt * 1000 : null;
    const ageHours = createdAt
      ? (Date.now() - createdAt) / (1000 * 60 * 60)
      : null;

    return {
      holderCount:    d.holder ?? null,
      top10HolderPct: d.top10HolderPercent != null
        ? d.top10HolderPercent * 100  // Birdeye returns as decimal (0–1)
        : null,
      tokenAgeHours:  ageHours,
      hasWebsite:     !!d.extensions?.website,
    };
  } catch (err) {
    console.error('[safety/checker] Birdeye fetch error:', err);
    return {};
  }
}

/**
 * Check if a Solana token's mint authority is revoked via Helius RPC.
 * Returns null on error (treated as unknown, no points deducted).
 */
async function fetchMintAuthorityRevoked(
  tokenAddress: string,
): Promise<boolean | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;

  try {
    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          tokenAddress,
          { encoding: 'jsonParsed' },
        ],
      }),
    });

    if (!res.ok) return null;

    const json = await res.json() as {
      result?: {
        value?: {
          data?: {
            parsed?: {
              info?: {
                mintAuthority?: string | null;
              };
            };
          };
        };
      };
    };

    const mintAuthority =
      json.result?.value?.data?.parsed?.info?.mintAuthority;

    // mintAuthority is null when revoked
    return mintAuthority === null || mintAuthority === undefined;
  } catch (err) {
    console.error('[safety/checker] Helius mint authority check error:', err);
    return null;
  }
}

// ── Cache layer ───────────────────────────────────────────────

/**
 * Read a cached safety report from the token_safety table.
 * Returns null if not cached or if the cache is stale (> 1 hour).
 */
async function getCachedReport(tokenAddress: string): Promise<SafetyReport | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from('token_safety')
    .select('*')
    .eq('token_address', tokenAddress)
    .single();

  if (error || !data) return null;

  const checkedAt = new Date(data.checked_at).getTime();
  if (Date.now() - checkedAt > CACHE_TTL_MS) return null;

  return {
    tokenAddress: data.token_address,
    safetyScore:  data.safety_score,
    safetyLevel:  data.safety_level,
    liquidityLocked:         data.liquidity_locked,
    liquidityLockDurationDays: data.liquidity_lock_duration_days,
    ownerRenounced:          data.owner_renounced,
    mintAuthorityRevoked:    data.mint_authority_revoked,
    top10HolderPct:          data.top10_holder_pct,
    holderCount:             data.holder_count,
    isHoneypot:              data.is_honeypot,
    tokenAgeHours:           data.token_age_hours,
  };
}

/**
 * Write a safety report to the token_safety cache table.
 */
async function cacheReport(report: SafetyReport): Promise<void> {
  const db = createAdminClient();
  const { error } = await db.from('token_safety').upsert(
    {
      token_address:              report.tokenAddress,
      safety_score:               report.safetyScore,
      safety_level:               report.safetyLevel,
      liquidity_locked:           report.liquidityLocked,
      liquidity_lock_duration_days: report.liquidityLockDurationDays,
      owner_renounced:            report.ownerRenounced,
      mint_authority_revoked:     report.mintAuthorityRevoked,
      top10_holder_pct:           report.top10HolderPct,
      holder_count:               report.holderCount,
      is_honeypot:                report.isHoneypot,
      token_age_hours:            report.tokenAgeHours,
      checked_at:                 new Date().toISOString(),
    },
    { onConflict: 'token_address' },
  );

  if (error) {
    console.error(
      `[safety/checker] Failed to cache safety report for ${report.tokenAddress}:`,
      error.message,
    );
  }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Compute and return the safety report for a token.
 *
 * Flow:
 *   1. Check token_safety cache (skip if stale > 1h)
 *   2. Fetch data from Birdeye + Helius RPC in parallel
 *   3. Score via computeSafetyScore()
 *   4. Write result to cache
 *   5. Return SafetyReport
 *
 * Never throws — returns a minimal report with score=0 on total failure.
 */
export async function getTokenSafetyReport(
  tokenAddress: string,
): Promise<SafetyReport> {
  const context = `[safety/checker] token=${tokenAddress.slice(0, 8)}`;

  // 1. Cache hit
  const cached = await getCachedReport(tokenAddress).catch(() => null);
  if (cached) {
    return cached;
  }

  // 2. Fetch data in parallel
  const [birdeyeData, mintRevoked] = await Promise.all([
    fetchBirdeyeData(tokenAddress),
    fetchMintAuthorityRevoked(tokenAddress),
  ]);

  // 3. Build factors (merge fetched data; liquidity/honeypot = null until enriched)
  const factors: SafetyFactors = {
    // liquidityLocked: not yet derivable without a liquidity-lock API; omit
    liquidityLockDays:    birdeyeData.liquidityLockDays ?? undefined,
    ownerRenounced:       undefined,          // EVM concept; not applicable on Solana
    mintAuthorityRevoked: mintRevoked ?? undefined,
    top10HolderPct:       birdeyeData.top10HolderPct ?? undefined,
    holderCount:          birdeyeData.holderCount ?? undefined,
    isHoneypot:           birdeyeData.isHoneypot ?? undefined,
    tokenAgeHours:        birdeyeData.tokenAgeHours ?? undefined,
    hasWebsite:           birdeyeData.hasWebsite ?? undefined,
  };

  const score = computeSafetyScore(factors);
  const level = scoreToLevel(score);

  const report: SafetyReport = {
    tokenAddress,
    safetyScore:  score,
    safetyLevel:  level,
    liquidityLocked:           factors.liquidityLocked ?? null,
    liquidityLockDurationDays: factors.liquidityLockDays ?? null,
    ownerRenounced:            factors.ownerRenounced ?? null,
    mintAuthorityRevoked:      factors.mintAuthorityRevoked ?? null,
    top10HolderPct:            factors.top10HolderPct ?? null,
    holderCount:               factors.holderCount ?? null,
    isHoneypot:                factors.isHoneypot ?? null,
    tokenAgeHours:             factors.tokenAgeHours ?? null,
  };

  // 4. Cache result (fire-and-forget — don't block the caller)
  cacheReport(report).catch((err) =>
    console.error(`${context} cache write failed:`, err),
  );

  return report;
}
