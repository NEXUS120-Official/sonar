// ============================================================
// SONAR — Internal Price Engine
// ============================================================
// Composite price resolution layer.  All product code that needs
// token or SOL prices should import from here, not from
// individual provider adapters.
//
// Resolution chain (today):
//   1. Birdeye (primary — real-time, high confidence)
//   2. Jupiter (fallback — DEX aggregator, slightly lower confidence)
//
// Future chain (sovereign):
//   1. Internal pool TWAP (on-chain pool data from sovereign RPC)
//   2. Pyth / Switchboard oracle composite
//   3. Birdeye / Jupiter as tertiary fallback only
//
// The internal tables (token_prices_internal) are written here
// when prices are successfully resolved, building a historical
// record for backtesting and future model training.
// ============================================================

import { getPriceProvider, getFallbackPriceProvider } from '@/lib/providers';
import type { PriceQuote } from '@/lib/providers/interfaces';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Hardcoded SOL fallback used when all providers fail. */
const SOL_PRICE_FALLBACK_USD = 85;

// ── Primary composite resolver ────────────────────────────────

/**
 * Resolve the current price for a token mint.
 * Tries primary provider first; falls back to secondary on failure.
 * Returns null if neither provider has a price.
 */
export async function resolveTokenPrice(mint: string, at?: Date): Promise<PriceQuote | null> {
  const primary  = getPriceProvider();
  const fallback = getFallbackPriceProvider();

  try {
    const quote = await primary.getTokenPrice(mint, at);
    if (quote && quote.price_usd > 0) return quote;
  } catch { /* fall through */ }

  try {
    return await fallback.getTokenPrice(mint, at);
  } catch {
    return null;
  }
}

/**
 * Resolve the current SOL/USD price.
 * Same fallback chain as resolveTokenPrice.
 */
export async function resolveSolPrice(at?: Date): Promise<PriceQuote | null> {
  const primary  = getPriceProvider();
  const fallback = getFallbackPriceProvider();

  try {
    const quote = await primary.getSolPrice(at);
    if (quote && quote.price_usd > 0) return quote;
  } catch { /* fall through */ }

  try {
    return await fallback.getSolPrice(at);
  } catch {
    return null;
  }
}

/**
 * Batch-resolve prices for multiple mints.
 * Tries primary first; falls back per-mint.
 */
export async function resolveMultipleTokenPrices(
  mints: string[],
): Promise<Map<string, PriceQuote>> {
  if (mints.length === 0) return new Map();

  const primary  = getPriceProvider();
  const fallback = getFallbackPriceProvider();
  const result   = new Map<string, PriceQuote>();

  try {
    const quotes = await primary.getMultipleTokenPrices(mints);
    for (const [mint, quote] of quotes) {
      if (quote.price_usd > 0) result.set(mint, quote);
    }
  } catch { /* fall through */ }

  // For mints the primary missed, try fallback
  const missing = mints.filter(m => !result.has(m));
  if (missing.length > 0) {
    try {
      const quotes = await fallback.getMultipleTokenPrices(missing);
      for (const [mint, quote] of quotes) {
        if (quote.price_usd > 0) result.set(mint, quote);
      }
    } catch { /* best-effort */ }
  }

  return result;
}

/**
 * Resolve the SOL/USD price as a plain number.
 * Returns `fallback` if all providers fail — never throws.
 */
export async function resolveSolPriceUsd(fallback = SOL_PRICE_FALLBACK_USD): Promise<number> {
  const quote = await resolveSolPrice();
  return quote && quote.price_usd > 0 ? quote.price_usd : fallback;
}

/**
 * Resolve SOL price, archive it, and return as a plain number.
 * Use in crons that already hold a DB client.
 */
export async function resolveSolPriceUsdWithArchive(
  db:       SupabaseClient,
  fallback = SOL_PRICE_FALLBACK_USD,
): Promise<number> {
  const quote = await resolveSolPrice();
  if (quote && quote.price_usd > 0) {
    await archivePriceQuote(db, quote, 'SOL');
    return quote.price_usd;
  }
  return fallback;
}

// ── Archive to internal price store ──────────────────────────
// Writes resolved prices to token_prices_internal so we build
// a historical record independent of external APIs.

export async function archivePriceQuote(
  db:    SupabaseClient,
  quote: PriceQuote,
  symbol?: string,
): Promise<void> {
  try {
    await (db as any).from('token_prices_internal').insert({
      mint:        quote.mint,
      symbol:      symbol ?? null,
      price_usd:   quote.price_usd,
      source:      quote.source,
      confidence:  quote.confidence,
      observed_at: quote.observed_at.toISOString(),
    });
  } catch { /* non-critical — archive is best-effort */ }
}

/**
 * Resolve + archive a token price in one call.
 * Use this in crons that already have a DB client.
 */
export async function resolveAndArchivePrice(
  db:     SupabaseClient,
  mint:   string,
  symbol?: string,
): Promise<PriceQuote | null> {
  const quote = await resolveTokenPrice(mint);
  if (quote) await archivePriceQuote(db, quote, symbol);
  return quote;
}
