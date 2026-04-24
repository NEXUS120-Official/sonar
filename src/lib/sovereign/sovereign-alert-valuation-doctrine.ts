// ============================================================
// SONAR — Sovereign Alert Valuation Doctrine
// ============================================================
// Pure severity modulation layer for alert inserts.
// Uses valuation result + price freshness/confidence doctrine.
// ============================================================

import type { AlertSeverity } from '@/lib/supabase/types';
import type { ValuationResult } from '@/lib/sovereign/sovereign-price-runtime';

export interface AlertValuationDoctrineInput {
  base_severity: AlertSeverity;
  valuation: ValuationResult | null;
  additional_context?: {
    confidence_score?: number | null;
    has_privacy_context?: boolean;
    has_token_risk_context?: boolean;
  };
}

export interface AlertValuationDoctrineOutput {
  severity: AlertSeverity;
  doctrine_reason: string;
  value_usd: number | null;
  effective_confidence: string | null;
  is_stale_price: boolean;
}

function severityRank(sev: AlertSeverity): number {
  if (sev === 'info') return 0;
  if (sev === 'notable') return 1;
  if (sev === 'significant') return 2;
  return 3;
}

function rankToSeverity(rank: number): AlertSeverity {
  if (rank <= 0) return 'info';
  if (rank === 1) return 'notable';
  if (rank === 2) return 'significant';
  return 'major';
}

export function applyAlertValuationDoctrine(
  input: AlertValuationDoctrineInput,
): AlertValuationDoctrineOutput {
  const baseRank = severityRank(input.base_severity);
  const valuation = input.valuation;

  if (!valuation) {
    return {
      severity: input.base_severity,
      doctrine_reason: 'no_valuation_context',
      value_usd: null,
      effective_confidence: null,
      is_stale_price: false,
    };
  }

  let rank = baseRank;
  const reasons: string[] = [];

  const value = valuation.value_usd ?? 0;
  const conf = valuation.effective_confidence;
  const stale = valuation.is_stale_price;

  if (value >= 1_000_000 && conf === 'high') {
    rank += 1;
    reasons.push('high_value_high_confidence_upgrade');
  } else if (value >= 250_000 && (conf === 'high' || conf === 'medium')) {
    rank += 1;
    reasons.push('mid_value_upgrade');
  }

  if (stale) {
    rank -= 1;
    reasons.push('stale_price_downgrade');
  }

  if (conf === 'unknown') {
    rank -= 1;
    reasons.push('unknown_confidence_downgrade');
  } else if (conf === 'low') {
    rank -= 1;
    reasons.push('low_confidence_downgrade');
  }

  if (input.additional_context?.has_privacy_context) {
    rank += 1;
    reasons.push('privacy_context_upgrade');
  }

  if (input.additional_context?.has_token_risk_context) {
    rank += 1;
    reasons.push('token_risk_context_upgrade');
  }

  const score = input.additional_context?.confidence_score ?? null;
  if (typeof score === 'number' && score < 50) {
    rank -= 1;
    reasons.push('low_signal_score_downgrade');
  } else if (typeof score === 'number' && score >= 85) {
    rank += 1;
    reasons.push('high_signal_score_upgrade');
  }

  rank = Math.max(0, Math.min(3, rank));

  return {
    severity: rankToSeverity(rank),
    doctrine_reason: reasons.length > 0 ? reasons.join('|') : 'base_severity_retained',
    value_usd: valuation.value_usd,
    effective_confidence: valuation.effective_confidence,
    is_stale_price: valuation.is_stale_price,
  };
}
