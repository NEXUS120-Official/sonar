// ============================================================
// SONAR — Sovereign Exchange Lineage Doctrine
// ============================================================
// Pure scoring doctrine for exchange-origin / cex-to-shadow lineage.
// ============================================================

export interface SovereignExchangeLineageInput {
  source_exchange: string | null;
  confidence_score: number;
  evidence_count: number;
  valuation_status: string;
  time_gap_minutes?: number | null;
  hop_count?: number | null;
  privacy_signal_seen?: boolean;
  token2022_signal_seen?: boolean;
  downstream_evidence_count?: number;
}

export interface SovereignExchangeLineageResult {
  lineage_confidence: number;
  lineage_band: 'strong' | 'moderate' | 'weak' | 'unknown';
  lineage_reason: string;
}

export function scoreExchangeLineage(
  input: SovereignExchangeLineageInput,
): SovereignExchangeLineageResult {
  let score = 0;
  const reasons: string[] = [];

  if (input.source_exchange) {
    score += 30;
    reasons.push('exchange provenance present');
  } else {
    score -= 20;
    reasons.push('no exchange provenance');
  }

  if (input.confidence_score >= 80) {
    score += 20;
    reasons.push('high candidate confidence');
  } else if (input.confidence_score >= 60) {
    score += 12;
    reasons.push('solid candidate confidence');
  } else if (input.confidence_score >= 40) {
    score += 6;
    reasons.push('moderate candidate confidence');
  }

  if (input.evidence_count >= 5) {
    score += 15;
    reasons.push('repeated evidence');
  } else if (input.evidence_count >= 3) {
    score += 8;
    reasons.push('multiple evidence hits');
  } else if (input.evidence_count >= 2) {
    score += 4;
    reasons.push('confirmed more than once');
  }

  if (input.valuation_status === 'complete') {
    score += 8;
    reasons.push('complete valuation context');
  } else if (input.valuation_status === 'partial') {
    score += 2;
    reasons.push('partial valuation context');
  } else {
    score -= 5;
    reasons.push('weak valuation context');
  }

  if (typeof input.time_gap_minutes === 'number') {
    if (input.time_gap_minutes <= 30) {
      score += 10;
      reasons.push('tight funding-to-activation gap');
    } else if (input.time_gap_minutes <= 180) {
      score += 5;
      reasons.push('reasonable temporal continuity');
    } else {
      score -= 3;
      reasons.push('loose temporal continuity');
    }
  }

  if (typeof input.hop_count === 'number') {
    if (input.hop_count <= 1) {
      score += 10;
      reasons.push('short path');
    } else if (input.hop_count <= 2) {
      score += 5;
      reasons.push('limited hop depth');
    } else {
      score -= 4;
      reasons.push('longer path depth');
    }
  }

  if (input.privacy_signal_seen) {
    score += 8;
    reasons.push('privacy-adjacent behavior seen');
  }

  if (input.token2022_signal_seen) {
    score += 6;
    reasons.push('token-2022 behavior seen');
  }

  const downstream = input.downstream_evidence_count ?? 0;
  if (downstream >= 3) {
    score += 10;
    reasons.push('strong downstream evidence');
  } else if (downstream >= 1) {
    score += 4;
    reasons.push('some downstream evidence');
  }

  score = Math.max(0, Math.min(100, score));

  let lineage_band: SovereignExchangeLineageResult['lineage_band'] = 'unknown';
  if (score >= 70) lineage_band = 'strong';
  else if (score >= 45) lineage_band = 'moderate';
  else if (score >= 20) lineage_band = 'weak';

  return {
    lineage_confidence: score,
    lineage_band,
    lineage_reason: reasons.join(' | '),
  };
}
