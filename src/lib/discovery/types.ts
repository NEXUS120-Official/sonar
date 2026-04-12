// ============================================================
// SONAR — Discovery Pipeline Types
// ============================================================

import type { DiscoveryStatus } from '@/lib/supabase/types';

export type DiscoverySource =
  | 'birdeye'
  | 'dexscreener'
  | 'solscan'
  | 'community'
  | 'arkham'
  | 'unknown';

/**
 * Raw metrics extracted from a discovery source for a wallet.
 * All fields are optional — sources provide different data subsets.
 */
export interface CandidateMetrics {
  address:           string;
  source:            DiscoverySource;

  // Performance metrics
  winRate30d?:       number | null;   // percentage (0-100)
  tradeCount30d?:    number | null;
  totalVolume30d?:   number | null;   // USD
  avgTradeSizeUsd?:  number | null;   // USD
  tokenDiversity30d?: number | null;  // unique tokens traded
  lastActiveAt?:     Date   | null;

  // Risk signals
  instantSellPct?:   number | null;   // % of buys sold <1h after purchase
  isBotFlagged?:     boolean;
  isRugFlagged?:     boolean;
  isInsiderFlagged?: boolean;

  // Raw API payload (stored for audit)
  rawData?:          Record<string, unknown>;
}

/**
 * Result of scoring a CandidateMetrics object.
 */
export interface ScoringResult {
  score:       number;         // 0-100
  status:      DiscoveryStatus;
  gateFailures: string[];      // which non-negotiable criteria failed
  breakdown:   ScoreBreakdown;
}

export interface ScoreBreakdown {
  winRatePts:       number;
  tradeCountPts:    number;
  activityPts:      number;
  diversityPts:     number;
  volumePts:        number;
  cleanProfilePts:  number;
}

/**
 * Summary of one full discovery cron run.
 */
export interface DiscoveryRunSummary {
  runAt:            string;
  walletsAnalyzed:  number;
  sourceBreakdown:  Record<DiscoverySource, number>;
  autoRejected:     number;
  manualReview:     number;
  autoApproved:     number;
  promoted:         number;      // inserted into whales table this run
  webhookSynced:    boolean;
  webhookAddresses: number;
  skipReasons:      Array<{ address: string; reason: string }>;
}
