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

  const params = new URLSearchParams({
    type:      '1W',          // valid values: today | 1W (1M not available on free tier)
    sort_by:   'PnL',
    sort_type: 'desc',
    offset:    '0',
    limit:     String(Math.min(limit, 50)),
  });

  const url = `${BIRDEYE_BASE}/trader/gainers-losers?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        'X-API-KEY': apiKey,
        'x-chain':   'solana',
      },
    });

    if (!res.ok) {
      console.warn(`[discovery/birdeye] HTTP ${res.status} — ${await res.text().catch(() => '')}`);
      return [];
    }

    const json = await res.json() as BirdeyeLeaderboardResponse;
    const items = json.data?.items ?? [];

    return items
      .filter((t) => t.address && t.address.length >= 32)
      .map((t) => mapTrader(t));
  } catch (err) {
    console.error('[discovery/birdeye] Fetch error:', err);
    return [];
  }
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
