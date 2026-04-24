// ============================================================
// SONAR — Sovereign Price Merge Policy
// ============================================================
// Pure candidate ranking + effective price selection.
// Deterministic, source-agnostic, replayable.
// ============================================================

export type MergeConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface SovereignPriceCandidate {
  asset_key: string;
  symbol: string | null;
  price_usd: number | null;
  price_confidence: MergeConfidence;
  price_source_mode: string;
  valuation_reason: string | null;
  last_price_at: string | null;
  raw_snapshot: Record<string, unknown> | null;
}

export interface RankedSovereignPriceCandidate extends SovereignPriceCandidate {
  merge_score: number;
  merge_reason: string;
}

export interface EffectiveSovereignPriceSelection {
  effective: RankedSovereignPriceCandidate | null;
  ranked_candidates: RankedSovereignPriceCandidate[];
}

function confidenceScore(conf: MergeConfidence): number {
  if (conf === 'high') return 100;
  if (conf === 'medium') return 70;
  if (conf === 'low') return 40;
  return 10;
}

function freshnessScore(lastPriceAt: string | null, nowMs: number): number {
  if (!lastPriceAt) return 0;
  const ts = new Date(lastPriceAt).getTime();
  if (!Number.isFinite(ts)) return 0;

  const ageSec = Math.max(0, Math.floor((nowMs - ts) / 1000));

  if (ageSec <= 15 * 60) return 100;
  if (ageSec <= 60 * 60) return 80;
  if (ageSec <= 6 * 60 * 60) return 50;
  if (ageSec <= 24 * 60 * 60) return 20;
  return 0;
}

function sourceModeScore(mode: string): number {
  if (mode === 'sovereign_price_runtime_v1') return 30;
  if (mode.includes('sovereign')) return 20;
  return 5;
}

export function rankPriceCandidate(
  candidate: SovereignPriceCandidate,
  nowMs: number = Date.now(),
): RankedSovereignPriceCandidate {
  const reasons: string[] = [];

  const conf = confidenceScore(candidate.price_confidence);
  const fresh = freshnessScore(candidate.last_price_at, nowMs);
  const source = sourceModeScore(candidate.price_source_mode);
  const hasPrice = candidate.price_usd !== null ? 25 : 0;

  if (conf > 0) reasons.push(`conf=${conf}`);
  if (fresh > 0) reasons.push(`fresh=${fresh}`);
  if (source > 0) reasons.push(`source=${source}`);
  if (hasPrice > 0) reasons.push('has_price');

  const mergeScore = conf + fresh + source + hasPrice;

  return {
    ...candidate,
    merge_score: mergeScore,
    merge_reason: reasons.join('|') || 'no_signal',
  };
}

export function selectEffectiveSovereignPrice(
  candidates: ReadonlyArray<SovereignPriceCandidate>,
  nowMs: number = Date.now(),
): EffectiveSovereignPriceSelection {
  const ranked_candidates = candidates
    .map((c) => rankPriceCandidate(c, nowMs))
    .sort((a, b) => {
      if (b.merge_score !== a.merge_score) return b.merge_score - a.merge_score;
      const at = a.last_price_at ? new Date(a.last_price_at).getTime() : 0;
      const bt = b.last_price_at ? new Date(b.last_price_at).getTime() : 0;
      return bt - at;
    });

  return {
    effective: ranked_candidates[0] ?? null,
    ranked_candidates,
  };
}
