// ============================================================
// SONAR — Discovery Scoring Engine
// ============================================================
// Pure scoring function — no I/O, no side effects.
// Implements the Whale Curation Playbook non-negotiable gates
// and a 100-point additive score for routing decisions.

import type { CandidateMetrics, ScoringResult, ScoreBreakdown } from './types';

// ── Non-negotiable thresholds (PRD Whale Curation Playbook) ──

const MIN_TRADES_30D   = 50;
const MIN_WIN_RATE     = 55;    // %
const MAX_INACTIVE_MS  = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MIN_TOKEN_DIVERSITY = 5;

// ── Score routing thresholds ──────────────────────────────────

const SCORE_AUTO_APPROVE  = 78;  // score >= this + no flags → auto_approve
const SCORE_MANUAL_REVIEW = 55;  // score >= this → manual_review
// score < 55 or gate failure → auto_reject

// ── Score component weights ───────────────────────────────────

function scoreWinRate(wr: number): number {
  if (wr >= 80) return 30;
  if (wr >= 70) return 25;
  if (wr >= 65) return 20;
  if (wr >= 60) return 15;
  if (wr >= 55) return 10;
  return 0;
}

function scoreTradeCount(count: number): number {
  if (count >= 200) return 20;
  if (count >= 100) return 15;
  if (count >= 75)  return 12;
  if (count >= 50)  return 8;
  return 0;
}

function scoreActivity(lastActiveAt: Date | null | undefined): number {
  if (!lastActiveAt) return 0;
  const msSince = Date.now() - lastActiveAt.getTime();
  const daysSince = msSince / (24 * 60 * 60 * 1000);
  if (daysSince <= 1)  return 15;
  if (daysSince <= 3)  return 12;
  if (daysSince <= 7)  return 8;
  return 0;
}

function scoreDiversity(tokens: number): number {
  if (tokens >= 20) return 20;
  if (tokens >= 15) return 16;
  if (tokens >= 10) return 12;
  if (tokens >= 5)  return 8;
  return 0;
}

function scoreVolume(volumeUsd: number | null | undefined): number {
  if (volumeUsd == null) return 0;
  if (volumeUsd >= 500_000) return 15;
  if (volumeUsd >= 200_000) return 12;
  if (volumeUsd >= 100_000) return 8;
  if (volumeUsd >= 50_000)  return 4;
  return 0;
}

function scoreCleanProfile(metrics: CandidateMetrics): number {
  if (metrics.isBotFlagged || metrics.isRugFlagged || metrics.isInsiderFlagged) return 0;
  let pts = 10;  // base for clean profile
  const instantSell = metrics.instantSellPct ?? null;
  if (instantSell !== null) {
    if (instantSell < 10) pts += 5;   // very patient holder
    else if (instantSell < 20) pts += 2;
    else if (instantSell > 50) pts -= 5;  // dump-heavy pattern
  }
  return Math.max(0, pts);
}

// ── Public API ────────────────────────────────────────────────

/**
 * Score a candidate and determine routing status.
 * Pure function — safe to call in any context.
 */
export function scoreCandidate(metrics: CandidateMetrics): ScoringResult {
  const gateFailures: string[] = [];

  // ── Non-negotiable gate checks ───────────────────────────────
  const tradeCount = metrics.tradeCount30d ?? 0;
  if (tradeCount < MIN_TRADES_30D) {
    gateFailures.push(`trade_count ${tradeCount} < ${MIN_TRADES_30D}`);
  }

  const winRate = metrics.winRate30d ?? 0;
  if (winRate <= MIN_WIN_RATE) {
    gateFailures.push(`win_rate ${winRate.toFixed(1)}% ≤ ${MIN_WIN_RATE}%`);
  }

  const diversity = metrics.tokenDiversity30d ?? 0;
  if (diversity < MIN_TOKEN_DIVERSITY) {
    gateFailures.push(`token_diversity ${diversity} < ${MIN_TOKEN_DIVERSITY}`);
  }

  if (metrics.lastActiveAt) {
    const msSince = Date.now() - metrics.lastActiveAt.getTime();
    if (msSince > MAX_INACTIVE_MS) {
      const days = Math.floor(msSince / (24 * 60 * 60 * 1000));
      gateFailures.push(`inactive ${days}d > 7d`);
    }
  } else {
    gateFailures.push('last_active_at unknown');
  }

  if (metrics.isBotFlagged)     gateFailures.push('bot_flagged');
  if (metrics.isInsiderFlagged) gateFailures.push('insider_flagged');

  // ── Score breakdown ──────────────────────────────────────────
  const breakdown: ScoreBreakdown = {
    winRatePts:      scoreWinRate(winRate),
    tradeCountPts:   scoreTradeCount(tradeCount),
    activityPts:     scoreActivity(metrics.lastActiveAt),
    diversityPts:    scoreDiversity(diversity),
    volumePts:       scoreVolume(metrics.totalVolume30d),
    cleanProfilePts: scoreCleanProfile(metrics),
  };

  const score = Math.min(
    100,
    breakdown.winRatePts +
    breakdown.tradeCountPts +
    breakdown.activityPts +
    breakdown.diversityPts +
    breakdown.volumePts +
    breakdown.cleanProfilePts,
  );

  // ── Route decision ───────────────────────────────────────────
  let status: ScoringResult['status'];

  if (gateFailures.length > 0) {
    status = 'auto_reject';
  } else if (score >= SCORE_AUTO_APPROVE && !metrics.isRugFlagged) {
    status = 'auto_approve';
  } else if (score >= SCORE_MANUAL_REVIEW) {
    status = 'manual_review';
  } else {
    status = 'auto_reject';
  }

  return { score, status, gateFailures, breakdown };
}
