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

// Response shapes (Birdeye API — fields may vary by plan tier)
interface BirdeyeTrader {
  address:      string;
  pnl?:         number;
  tradeCount?:  number;
  winCount?:    number;
  volume?:      number;    // USD total
  uniqueTokens?: number;
  lastTxTime?:  number;    // Unix seconds
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
    type:      '1M',          // 30-day window
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
  const winRate =
    t.tradeCount && t.winCount != null && t.tradeCount > 0
      ? (t.winCount / t.tradeCount) * 100
      : null;

  const lastActiveAt =
    t.lastTxTime ? new Date(t.lastTxTime * 1000) : null;

  return {
    address:          t.address,
    source:           'birdeye',
    winRate30d:       winRate,
    tradeCount30d:    t.tradeCount ?? null,
    totalVolume30d:   t.volume ?? null,
    tokenDiversity30d: t.uniqueTokens ?? null,
    lastActiveAt,
    rawData:          t as unknown as Record<string, unknown>,
  };
}
