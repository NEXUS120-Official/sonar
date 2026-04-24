// ============================================================
// SONAR — Valuation Cluster Analytics
// ============================================================
// Read-only analytics helpers for token-level and cluster-level
// valuation completeness intelligence.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

export interface TokenValuationGapRow {
  asset_key: string;
  sightings: number;
  priced_count: number;
  unpriced_count: number;
  priced_ratio: number;
}

export interface WhaleValuationCompletenessRow {
  address: string;
  estimated_balance_usd: number | null;
  priced_component_count: number;
  unpriced_component_count: number;
  valuation_completeness_ratio: number;
  valuation_status: string;
  discovery_method: string;
  source_exchange: string | null;
}

export interface ExchangeValuationCompletenessRow {
  source_exchange: string;
  wallets: number;
  avg_completeness_ratio: number;
  partial_wallets: number;
  unknown_wallets: number;
}

export async function getTokenValuationGapLeaderboard(
  db: Db,
  limit: number = 25,
): Promise<TokenValuationGapRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_account_state')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) throw error;

  const agg = new Map<string, TokenValuationGapRow>();

  for (const row of (data ?? []) as Array<{ raw_json: Record<string, unknown> | null }>) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;

    const tokenBalances = Array.isArray(raw['token_balances']) ? raw['token_balances'] : [];
    for (const tb of tokenBalances) {
      if (!tb || typeof tb !== 'object') continue;
      const r = tb as Record<string, unknown>;

      const asset_key =
        (typeof r['symbol'] === 'string' && r['symbol']) ||
        (typeof r['mint'] === 'string' && r['mint']) ||
        'unknown';

      const hasPriceSignal =
        typeof r['symbol'] === 'string' && ['SOL', 'USDC', 'USDT'].includes(r['symbol'].toUpperCase());

      const prev = agg.get(asset_key);
      if (prev) {
        prev.sightings += 1;
        if (hasPriceSignal) prev.priced_count += 1;
        else prev.unpriced_count += 1;
      } else {
        agg.set(asset_key, {
          asset_key,
          sightings: 1,
          priced_count: hasPriceSignal ? 1 : 0,
          unpriced_count: hasPriceSignal ? 0 : 1,
          priced_ratio: 0,
        });
      }
    }
  }

  const rows = [...agg.values()].map((r) => ({
    ...r,
    priced_ratio: r.sightings > 0 ? Math.round((r.priced_count / r.sightings) * 100) / 100 : 0,
  }));

  return rows
    .sort((a, b) => (b.unpriced_count - a.unpriced_count) || (b.sightings - a.sightings))
    .slice(0, limit);
}

export async function getWhaleValuationCompletenessRows(
  db: Db,
  limit: number = 100,
): Promise<WhaleValuationCompletenessRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('sovereign_whale_candidates')
      .select('address, estimated_balance_usd, priced_component_count, unpriced_component_count, valuation_completeness_ratio, valuation_status, discovery_method, source_exchange')
      .order('first_seen_at', { ascending: false })
      .limit(limit);

    if (error) {
      const msg = String(error.message ?? '');
      const code = String(error.code ?? '');
      if (code === 'PGRST205' || msg.includes('schema cache') || msg.includes('Could not find the table')) {
        return [];
      }
      throw error;
    }

    return (data ?? []) as WhaleValuationCompletenessRow[];
  } catch {
    return [];
  }
}

export async function getExchangeValuationCompletenessRows(
  db: Db,
  limit: number = 25,
): Promise<ExchangeValuationCompletenessRow[]> {
  const whales = await getWhaleValuationCompletenessRows(db, 500);

  const agg = new Map<string, ExchangeValuationCompletenessRow>();

  for (const row of whales) {
    const ex = row.source_exchange ?? 'unknown';
    const prev = agg.get(ex);
    if (prev) {
      prev.wallets += 1;
      prev.avg_completeness_ratio += row.valuation_completeness_ratio ?? 0;
      if (row.valuation_status === 'partial') prev.partial_wallets += 1;
      if (row.valuation_status === 'unknown') prev.unknown_wallets += 1;
    } else {
      agg.set(ex, {
        source_exchange: ex,
        wallets: 1,
        avg_completeness_ratio: row.valuation_completeness_ratio ?? 0,
        partial_wallets: row.valuation_status === 'partial' ? 1 : 0,
        unknown_wallets: row.valuation_status === 'unknown' ? 1 : 0,
      });
    }
  }

  return [...agg.values()]
    .map((r) => ({
      ...r,
      avg_completeness_ratio: r.wallets > 0 ? Math.round((r.avg_completeness_ratio / r.wallets) * 100) / 100 : 0,
    }))
    .sort((a, b) => a.avg_completeness_ratio - b.avg_completeness_ratio)
    .slice(0, limit);
}
