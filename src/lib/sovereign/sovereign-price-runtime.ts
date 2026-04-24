// ============================================================
// SONAR — Sovereign Price Runtime
// ============================================================
// Provider-agnostic valuation kernel.
// No decoder hot-path fetches. Uses deferred raw price snapshots
// + registry compounding loop.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;
import { applyPriceDoctrine, type SovereignPriceConfidence } from './sovereign-price-doctrine';

export interface SovereignPriceInspection {
  asset_key: string;
  symbol: string | null;
  price_usd: number | null;
  price_confidence: SovereignPriceConfidence;
  price_source_mode: 'sovereign_price_runtime_v1';
  valuation_reason: string | null;
  raw_snapshot: Record<string, unknown> | null;
}

export interface ValuationResult {
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

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function inspectRawPriceSnapshot(
  assetKey: string,
  raw: Record<string, unknown>,
): SovereignPriceInspection {
  const price = asNum(raw['price_usd']);
  const symbol = asStr(raw['symbol']);

  let confidence: 'high' | 'medium' | 'low' | 'unknown' = 'unknown';
  if (price !== null && price > 0) confidence = 'medium';
  if (assetKey === 'SOL' || assetKey === 'USDC' || assetKey === 'USDT') confidence = 'high';

  return {
    asset_key: assetKey,
    symbol,
    price_usd: price,
    price_confidence: confidence,
    price_source_mode: 'sovereign_price_runtime_v1',
    valuation_reason: price !== null
      ? 'archived sovereign price snapshot available'
      : 'no usable sovereign price found',
    raw_snapshot: raw,
  };
}

export async function enqueueUnknownPriceAsset(
  db: Db,
  assetKey: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_price_enrichment_queue')
    .upsert({
      asset_key: assetKey,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      sighting_count: 1,
      status: 'pending',
      last_error: null,
    }, { onConflict: 'asset_key' });
}

export async function loadPendingPriceQueue(
  db: Db,
  limit: number = 100,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_price_enrichment_queue')
    .select('asset_key')
    .eq('status', 'pending')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as Array<{ asset_key: string }>).map((r) => r.asset_key);
}

export async function loadRawPriceSnapshot(
  db: Db,
  assetKey: string,
): Promise<Record<string, unknown> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_price_state')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ raw_json: Record<string, unknown> | null }>) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;
    if (raw['asset_key'] === assetKey) return raw;
  }

  return null;
}

export async function upsertPriceInspection(
  db: Db,
  inspection: SovereignPriceInspection,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_price_registry')
    .upsert({
      asset_key: inspection.asset_key,
      symbol: inspection.symbol,
      price_usd: inspection.price_usd,
      price_confidence: inspection.price_confidence,
      price_source_mode: inspection.price_source_mode,
      valuation_reason: inspection.valuation_reason,
      raw_snapshot: inspection.raw_snapshot,
      last_price_at: new Date().toISOString(),
    }, { onConflict: 'asset_key' });
}

export async function markPriceQueueStatus(
  db: Db,
  assetKey: string,
  status: 'done' | 'pending' | 'error',
  lastError: string | null = null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_price_enrichment_queue')
    .update({
      status,
      last_error: lastError,
      last_seen_at: new Date().toISOString(),
    })
    .eq('asset_key', assetKey);
}

export async function loadLatestPriceRow(
  db: Db,
  assetKey: string,
): Promise<{
  asset_key: string;
  price_usd: number | null;
  price_confidence: SovereignPriceConfidence;
  valuation_reason: string | null;
  last_price_at: string;
  price_source_mode: string;
} | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_price_registry')
    .select('asset_key, price_usd, price_confidence, valuation_reason, last_price_at, price_source_mode')
    .eq('asset_key', assetKey)
    .order('last_price_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function deriveUsdValue(
  db: Db,
  assetKey: string,
  amount: number | null,
): Promise<ValuationResult> {
  const priceRow = await loadLatestPriceRow(db, assetKey);

  return applyPriceDoctrine({
    asset_key: assetKey,
    amount,
    price_usd: priceRow?.price_usd ?? null,
    price_confidence: priceRow?.price_confidence ?? 'unknown',
    valuation_reason: priceRow?.valuation_reason ?? 'missing sovereign price context',
    last_price_at: priceRow?.last_price_at ?? null,
    price_source_mode: priceRow?.price_source_mode ?? 'sovereign_price_runtime_v1',
  });
}
