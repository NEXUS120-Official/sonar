// ============================================================
// SONAR — Valuation Analytics
// ============================================================
// Query helpers for valuation coverage, freshness, and doctrine
// observability. Read-only, replay-safe, DB-backed.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import { applyPriceDoctrine } from '@/lib/sovereign/sovereign-price-doctrine';

type Db = ReturnType<typeof createAdminClient>;

export interface ValuationCoverageStats {
  total_price_assets: number;
  fresh_assets: number;
  stale_assets: number;
  unknown_confidence_assets: number;
}

export interface ValuationCoverageRow {
  asset_key: string;
  price_usd: number | null;
  effective_price_usd: number | null;
  price_confidence: string;
  effective_confidence: string;
  price_age_seconds: number | null;
  is_stale_price: boolean;
  valuation_reason: string;
  last_price_at: string | null;
  price_source_mode: string;
}

export interface AlertDoctrineStats {
  total_alerts: number;
  doctrine_tagged: number;
  stale_tagged: number;
}

export interface PartialAccountValuationRow {
  address: string;
  sol_balance: number;
  usdc_balance: number;
  total_value_usd: number | null;
  fetched_at: string;
  source_mode: string;
}

export async function getValuationCoverageRows(
  db: Db,
  limit: number = 200,
): Promise<ValuationCoverageRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_price_registry')
    .select('asset_key, price_usd, price_confidence, valuation_reason, last_price_at, price_source_mode')
    .order('last_price_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return ((data ?? []) as Array<{
    asset_key: string;
    price_usd: number | null;
    price_confidence: 'high' | 'medium' | 'low' | 'unknown';
    valuation_reason: string | null;
    last_price_at: string | null;
    price_source_mode: string;
  }>).map((row) => {
    const doctrined = applyPriceDoctrine({
      asset_key: row.asset_key,
      amount: 1,
      price_usd: row.price_usd,
      price_confidence: row.price_confidence,
      valuation_reason: row.valuation_reason ?? 'valuation_analytics_surface',
      last_price_at: row.last_price_at,
      price_source_mode: row.price_source_mode,
    });

    return {
      asset_key: doctrined.asset_key,
      price_usd: doctrined.price_usd,
      effective_price_usd: doctrined.effective_price_usd,
      price_confidence: doctrined.price_confidence,
      effective_confidence: doctrined.effective_confidence,
      price_age_seconds: doctrined.price_age_seconds,
      is_stale_price: doctrined.is_stale_price,
      valuation_reason: doctrined.valuation_reason,
      last_price_at: doctrined.last_price_at,
      price_source_mode: doctrined.price_source_mode,
    };
  });
}

export async function getValuationCoverageStats(
  db: Db,
): Promise<ValuationCoverageStats> {
  const rows = await getValuationCoverageRows(db, 1000);

  return {
    total_price_assets: rows.length,
    fresh_assets: rows.filter((r) => !r.is_stale_price).length,
    stale_assets: rows.filter((r) => r.is_stale_price).length,
    unknown_confidence_assets: rows.filter((r) => r.effective_confidence === 'unknown').length,
  };
}

export async function getTopStaleAssets(
  db: Db,
  limit: number = 25,
): Promise<ValuationCoverageRow[]> {
  const rows = await getValuationCoverageRows(db, 1000);

  return rows
    .filter((r) => r.is_stale_price)
    .sort((a, b) => (b.price_age_seconds ?? 0) - (a.price_age_seconds ?? 0))
    .slice(0, limit);
}

export async function getUnknownPriceAssets(
  db: Db,
  limit: number = 25,
): Promise<Array<{ asset_key: string; last_seen_at: string; status: string; sighting_count: number }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_price_enrichment_queue')
    .select('asset_key, last_seen_at, status, sighting_count')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Array<{ asset_key: string; last_seen_at: string; status: string; sighting_count: number }>;
}

export async function getAlertDoctrineStats(
  db: Db,
): Promise<AlertDoctrineStats> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('alerts')
    .select('data')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  const rows = (data ?? []) as Array<{ data: Record<string, unknown> | null }>;

  const doctrineTagged = rows.filter((r) =>
    !!r.data && typeof r.data['valuation_doctrine_reason'] === 'string'
  );

  const staleTagged = doctrineTagged.filter((r) =>
    !!r.data && r.data['valuation_is_stale_price'] === true
  );

  return {
    total_alerts: rows.length,
    doctrine_tagged: doctrineTagged.length,
    stale_tagged: staleTagged.length,
  };
}

export async function getPartialAccountValuations(
  db: Db,
  limit: number = 50,
): Promise<PartialAccountValuationRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_account_state')
    .order('created_at', { ascending: false })
    .limit(1000);

  if (error) throw error;

  const out: PartialAccountValuationRow[] = [];

  for (const row of (data ?? []) as Array<{ raw_json: Record<string, unknown> | null; created_at: string }>) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;

    const address = typeof raw['address'] === 'string' ? raw['address'] : null;
    if (!address) continue;

    const sol_balance = typeof raw['native_sol_balance'] === 'number' ? raw['native_sol_balance'] : 0;
    const usdc_balance = typeof raw['usdc_balance'] === 'number' ? raw['usdc_balance'] : 0;
    const total_value_usd =
      typeof raw['total_value_usd'] === 'number' ? raw['total_value_usd'] : null;
    const source_mode =
      typeof raw['source_mode'] === 'string' ? raw['source_mode'] : 'sovereign_account_state';

    if (total_value_usd !== null) continue;

    out.push({
      address,
      sol_balance,
      usdc_balance,
      total_value_usd,
      fetched_at: row.created_at,
      source_mode,
    });
  }

  return out.slice(0, limit);
}
