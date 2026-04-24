// ============================================================
// SONAR — Sovereign Whale Ranking Doctrine
// ============================================================
// Pure scoring doctrine for sovereign whale candidates.
// ============================================================

export interface SovereignWhaleRankingInput {
  estimated_balance_usd: number | null;
  confidence_score: number;
  valuation_completeness_ratio: number;
  valuation_status: string;
  evidence_count: number;
  source_exchange: string | null;
  first_seen_at: string;
}

export interface SovereignWhaleRankingResult {
  ranking_score: number;
  ranking_band: 'elite' | 'strong' | 'watch' | 'weak';
  ranking_reason: string;
}

function hoursSince(ts: string): number | null {
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / 3_600_000;
}

export function scoreSovereignWhaleCandidate(
  input: SovereignWhaleRankingInput,
): SovereignWhaleRankingResult {
  let score = 0;
  const reasons: string[] = [];

  const bal = input.estimated_balance_usd ?? 0;
  if (bal >= 5_000_000) {
    score += 35;
    reasons.push('very large balance');
  } else if (bal >= 1_000_000) {
    score += 25;
    reasons.push('large balance');
  } else if (bal >= 500_000) {
    score += 15;
    reasons.push('meaningful balance');
  } else if (bal > 0) {
    score += 5;
    reasons.push('non-trivial balance');
  }

  score += Math.max(0, Math.min(25, Math.round(input.confidence_score / 4)));
  if (input.confidence_score >= 80) reasons.push('high confidence');
  else if (input.confidence_score >= 60) reasons.push('solid confidence');

  const completeness = input.valuation_completeness_ratio ?? 0;
  if (input.valuation_status === 'complete') {
    score += 20;
    reasons.push('complete valuation');
  } else if (input.valuation_status === 'partial') {
    if (completeness >= 0.7) {
      score += 10;
      reasons.push('mostly priced');
    } else if (completeness >= 0.4) {
      score += 3;
      reasons.push('partially priced');
    } else {
      score -= 8;
      reasons.push('weak valuation coverage');
    }
  } else {
    score -= 15;
    reasons.push('valuation unknown');
  }

  if (input.evidence_count >= 5) {
    score += 10;
    reasons.push('repeated evidence');
  } else if (input.evidence_count >= 3) {
    score += 6;
    reasons.push('multiple evidence hits');
  } else if (input.evidence_count >= 2) {
    score += 3;
    reasons.push('confirmed more than once');
  }

  if (input.source_exchange) {
    score += 8;
    reasons.push('exchange-origin context');
  }

  const ageH = hoursSince(input.first_seen_at);
  if (ageH !== null) {
    if (ageH <= 24) {
      score += 8;
      reasons.push('fresh candidate');
    } else if (ageH <= 24 * 3) {
      score += 4;
      reasons.push('recent candidate');
    } else if (ageH > 24 * 14) {
      score -= 6;
      reasons.push('stale candidate');
    }
  }

  score = Math.max(0, Math.min(100, score));

  let ranking_band: SovereignWhaleRankingResult['ranking_band'] = 'weak';
  if (score >= 75) ranking_band = 'elite';
  else if (score >= 55) ranking_band = 'strong';
  else if (score >= 35) ranking_band = 'watch';

  return {
    ranking_score: score,
    ranking_band,
    ranking_reason: reasons.join(' | '),
  };
}
