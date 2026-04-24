// ============================================================
// SONAR — Sovereign Valuation Completeness
// ============================================================
// Pure helpers for priced/unpriced component accounting.
// ============================================================

import type {
  SovereignValuationCompleteness,
  SovereignValuedTokenComponentRow,
} from '@/lib/supabase/types';

export function computeValuationCompleteness(
  components: ReadonlyArray<SovereignValuedTokenComponentRow>,
): SovereignValuationCompleteness {
  const priced_asset_count = components.filter((c) => c.value_usd !== null).length;
  const unpriced_asset_count = components.length - priced_asset_count;

  const total = components.length;
  const ratio = total > 0 ? priced_asset_count / total : 0;

  let valuation_status: 'complete' | 'partial' | 'unknown' = 'unknown';
  if (total === 0) valuation_status = 'unknown';
  else if (unpriced_asset_count === 0) valuation_status = 'complete';
  else if (priced_asset_count > 0) valuation_status = 'partial';
  else valuation_status = 'unknown';

  return {
    priced_asset_count,
    unpriced_asset_count,
    valuation_completeness_ratio: total > 0 ? Math.round(ratio * 100) / 100 : 0,
    valuation_status,
  };
}

export function deriveComponentValuationStatus(
  component: Pick<SovereignValuedTokenComponentRow, 'value_usd'>,
): 'priced' | 'unpriced' {
  return component.value_usd !== null ? 'priced' : 'unpriced';
}
