// ============================================================
// SONAR — Safety Score Types
// ============================================================

import type { SafetyLevel } from '@/lib/supabase/types';

/**
 * Raw boolean/numeric inputs used to compute the safety score.
 * All fields are optional — missing data is treated as unknown (no points awarded).
 */
export interface SafetyFactors {
  liquidityLocked?: boolean;           // +20 pts
  liquidityLockDays?: number;          // +5 pts if > 180 days
  ownerRenounced?: boolean;            // +20 pts
  mintAuthorityRevoked?: boolean;      // +15 pts (Solana-specific)
  top10HolderPct?: number;             // +15 pts if < 40%
  holderCount?: number;                // +10 pts if > 100
  isHoneypot?: boolean;                // score = 0 (hard override)
  tokenAgeHours?: number;              // +10 pts if > 24h, +5 extra if > 168h
  hasWebsite?: boolean;                // +5 pts (bonus)
}

/**
 * Computed output of the safety scoring engine.
 * Maps directly to the token_safety DB row (plus tokenAddress).
 */
export interface SafetyReport {
  tokenAddress: string;
  safetyScore: number;                 // 0–100
  safetyLevel: SafetyLevel;           // 'safe' | 'caution' | 'danger'

  // Raw factors (stored for transparency)
  liquidityLocked: boolean | null;
  liquidityLockDurationDays: number | null;
  ownerRenounced: boolean | null;
  mintAuthorityRevoked: boolean | null;
  top10HolderPct: number | null;
  holderCount: number | null;
  isHoneypot: boolean | null;
  tokenAgeHours: number | null;
}

/**
 * Token data fetched from external APIs before scoring.
 * Used by the checker to populate SafetyFactors.
 */
export interface TokenOnChainData {
  tokenAddress: string;
  mintAuthorityRevoked: boolean | null;
  holderCount: number | null;
  top10HolderPct: number | null;
  tokenAgeHours: number | null;
  hasWebsite: boolean | null;
  // Liquidity and honeypot require specialized APIs; null = unknown
  liquidityLocked: boolean | null;
  liquidityLockDays: number | null;
  isHoneypot: boolean | null;
}
