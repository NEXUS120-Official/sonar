// ============================================================
// SONAR — Consensus Detection Types
// ============================================================

import type { ConsensusLabel, SafetyLevel } from '@/lib/supabase/types';

export interface ConsensusConfig {
  timeWindowHours: number;     // How far back to look (default: 4h)
  minWhales: number;           // Min unique whale buyers to trigger (default: 2)
  minVolumeUsd: number;        // Min total USD volume (default: $5,000)
  dedupWindowHours: number;    // Don't re-alert same token within this window (default: 6h)
  minSafetyScore: number;      // Skip alert if safety below this (default: 50)
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  timeWindowHours:  4,
  minWhales:        2,
  minVolumeUsd:     5_000,
  dedupWindowHours: 6,
  minSafetyScore:   50,
};

/**
 * One whale's buy record for a given token, enriched with the wallet address.
 */
export interface WhaleTokenBuy {
  whaleId:      string;
  whaleAddress: string;
  winRate7d:    number | null;
  amountUsd:    number | null;   // null = paid in SOL, not yet enriched
  signature:    string;
  blockTime:    string;
}

/**
 * A token that has enough whale activity to be a consensus candidate.
 * Produced by the grouping step before safety/dedup checks.
 */
export interface ConsensusCandidate {
  tokenAddress:      string;
  tokenSymbol:       string | null;
  tokenName:         string | null;
  whaleCount:        number;
  totalVolumeUsd:    number | null;  // null = all amounts unknown
  volumeIsKnown:     boolean;        // false = all amount_usd were null
  whaleBuys:         WhaleTokenBuy[];
  consensusLabel:    ConsensusLabel;
  consensusEmoji:    string;
}

/**
 * A fully resolved consensus alert ready to be written to the alerts table.
 */
export interface ResolvedConsensusAlert {
  tokenAddress:       string;
  tokenSymbol:        string | null;
  tokenName:          string | null;
  tokenMarketCap:     number | null;
  tokenAgeHours:      number | null;
  tokenHolders:       number | null;
  consensusLevel:     number;
  consensusLabel:     ConsensusLabel;
  safetyScore:        number;
  safetyLevel:        SafetyLevel;
  totalWhaleVolumeUsd: number | null;
  whaleBuys:          WhaleTokenBuy[];
  alertText:          string;
  jupiterSwapUrl:     string;
  birdeyeUrl:         string;
}

/**
 * Summary of one detectConsensus() run, returned alongside alerts.
 */
export interface ConsensusRunSummary {
  transactionsScanned:  number;
  candidateTokens:      number;
  alertsGenerated:      number;
  alertsSkipped:        number;   // failed safety or dedup
  skipReasons:          Array<{ tokenAddress: string; reason: string }>;
}
