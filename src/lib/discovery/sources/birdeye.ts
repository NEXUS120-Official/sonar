// ============================================================
// SONAR — Discovery Source: Birdeye
// ============================================================
// Fetches top traders from Birdeye's gainers/losers leaderboard.
// Endpoint: GET /trader/gainers-losers
//
// Requires: BIRDEYE_API_KEY env var
// Returns: up to `limit` CandidateMetrics for Solana wallets

import { checkRateLimit, RateLimiters } from '@/lib/utils/rate-limiter';
import type { CandidateMetrics } from '../types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// Response shapes (Birdeye public API — verified 2026-04-12)
// Endpoint returns: address, pnl, volume, trade_count, network
// win_count and unique_tokens NOT available on free tier
interface BirdeyeTrader {
  address:      string;
  pnl?:         number;
  trade_count?: number;    // actual field name (snake_case)
  volume?:      number;    // USD total volume
  network?:     string;
  // Fields below are NOT returned by the free-tier endpoint:
  // win_count, unique_tokens, last_tx_time — enrichment needed from Helius/Solscan
}

interface BirdeyeLeaderboardResponse {
  data?: {
    items?: BirdeyeTrader[];
  };
  success?: boolean;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Fetch top traders from Birdeye leaderboard (30-day window).
 * Returns an empty array if the API key is missing or the call fails.
 */
export async function fetchBirdeyeTopTraders(
  limit = 30,
): Promise<CandidateMetrics[]> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    console.warn('[discovery/birdeye] BIRDEYE_API_KEY not set — skipping');
    return [];
  }

  if (!checkRateLimit('birdeye', RateLimiters.birdeye)) {
    console.warn('[discovery/birdeye] Rate limit — skipping fetch');
    return [];
  }

  // Try 1W first (more data), fall back to today if rate-limited
  const types = ['1W', 'today'];

  const statusLog: string[] = [];

  for (const type of types) {
    const params = new URLSearchParams({
      type,
      sort_by:   'PnL',
      sort_type: 'desc',
      offset:    '0',
      limit:     String(Math.min(limit, 50)),
    });

    try {
      const res = await fetch(`${BIRDEYE_BASE}/trader/gainers-losers?${params.toString()}`, {
        headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      });

      if (res.status === 429) {
        statusLog.push(`${type}=429`);
        console.warn(`[discovery/birdeye] 429 on type=${type} — trying fallback`);
        continue;
      }

      if (!res.ok) {
        statusLog.push(`${type}=${res.status}`);
        console.warn(`[discovery/birdeye] HTTP ${res.status} on type=${type}`);
        continue;
      }

      const json = await res.json() as BirdeyeLeaderboardResponse;
      const items = json.data?.items ?? [];
      console.log(`[discovery/birdeye] type=${type} HTTP 200 → ${items.length} traders`);
      statusLog.push(`${type}=200(${items.length})`);

      const mapped = items
        .filter((t) => t.address && t.address.length >= 32)
        .map((t) => mapTrader(t));

      if (mapped.length === 0 && items.length > 0) {
        // All items filtered — log addresses for inspection
        console.warn(`[discovery/birdeye] All ${items.length} items filtered out. Sample address length: ${items[0]?.address?.length}`);
      }

      return mapped;
    } catch (err) {
      statusLog.push(`${type}=error`);
      console.error(`[discovery/birdeye] Fetch error type=${type}:`, err);
    }
  }

  // Throw so engine can capture this in debug output
  throw new Error(`[birdeye] All types failed. Status log: ${statusLog.join(', ')}`);

}

// ── Mapper ────────────────────────────────────────────────────

function mapTrader(t: BirdeyeTrader): CandidateMetrics {
  // Birdeye free tier does not return win_count, unique_tokens, or last_tx_time.
  // winRate30d / tokenDiversity30d / lastActiveAt will be null here and must be
  // enriched downstream (Solscan or Helius) before final scoring.
  return {
    address:          t.address,
    source:           'birdeye',
    winRate30d:       null,   // not available from this endpoint
    tradeCount30d:    t.trade_count ?? null,
    totalVolume30d:   t.volume ?? null,
    tokenDiversity30d: null,  // not available from this endpoint
    lastActiveAt:     null,   // not available from this endpoint
    rawData:          t as unknown as Record<string, unknown>,
  };
}
