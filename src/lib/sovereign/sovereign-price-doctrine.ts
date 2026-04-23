// ============================================================
// SONAR — Sovereign Price Doctrine
// ============================================================
// Pure valuation doctrine:
// - price freshness
// - confidence decay
// - stale-price handling
// - effective price policy
// ============================================================

export type SovereignPriceConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface PriceDoctrineInput {
  asset_key: string;
  amount: number | null;
  price_usd: number | null;
  price_confidence: SovereignPriceConfidence;
  valuation_reason: string;
  last_price_at: string | null;
  price_source_mode: string;
}

export interface PriceDoctrineOutput {
  asset_key: string;
  amount: number | null;
  price_usd: number | null;
  effective_price_usd: number | null;
  value_usd: number | null;
  price_confidence: SovereignPriceConfidence;
  effective_confidence: SovereignPriceConfidence;
  valuation_reason: string;
  last_price_at: string | null;
  price_source_mode: string;
  price_age_seconds: number | null;
  is_stale_price: boolean;
}

function degradeConfidence(
  confidence: SovereignPriceConfidence,
): SovereignPriceConfidence {
  if (confidence === 'high') return 'medium';
  if (confidence === 'medium') return 'low';
  if (confidence === 'low') return 'unknown';
  return 'unknown';
}

export function getPriceStalenessPolicy(assetKey: string): {
  stale_after_seconds: number;
  hard_decay_after_seconds: number;
} {
  if (assetKey === 'SOL' || assetKey === 'USDC' || assetKey === 'USDT') {
    return {
      stale_after_seconds: 60 * 60,
      hard_decay_after_seconds: 6 * 60 * 60,
    };
  }

  return {
    stale_after_seconds: 2 * 60 * 60,
    hard_decay_after_seconds: 12 * 60 * 60,
  };
}

export function computePriceAgeSeconds(
  lastPriceAt: string | null,
  nowMs: number = Date.now(),
): number | null {
  if (!lastPriceAt) return null;
  const ts = new Date(lastPriceAt).getTime();
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.floor((nowMs - ts) / 1000));
}

export function applyPriceDoctrine(
  input: PriceDoctrineInput,
  nowMs: number = Date.now(),
): PriceDoctrineOutput {
  const policy = getPriceStalenessPolicy(input.asset_key);
  const age = computePriceAgeSeconds(input.last_price_at, nowMs);

  let effectiveConfidence = input.price_confidence;
  let effectivePrice = input.price_usd;
  let reason = input.valuation_reason;
  let isStale = false;

  if (age !== null && age >= policy.stale_after_seconds) {
    isStale = true;
    effectiveConfidence = degradeConfidence(effectiveConfidence);
    reason = `${reason}; stale_price`;
  }

  if (age !== null && age >= policy.hard_decay_after_seconds) {
    effectiveConfidence = degradeConfidence(effectiveConfidence);
    reason = `${reason}; hard_decay`;
  }

  if (effectiveConfidence === 'unknown') {
    effectivePrice = null;
  }

  const valueUsd =
    input.amount !== null &&
    effectivePrice !== null
      ? input.amount * effectivePrice
      : null;

  return {
    asset_key: input.asset_key,
    amount: input.amount,
    price_usd: input.price_usd,
    effective_price_usd: effectivePrice,
    value_usd: valueUsd,
    price_confidence: input.price_confidence,
    effective_confidence: effectiveConfidence,
    valuation_reason: reason,
    last_price_at: input.last_price_at,
    price_source_mode: input.price_source_mode,
    price_age_seconds: age,
    is_stale_price: isStale,
  };
}
