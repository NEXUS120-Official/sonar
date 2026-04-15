// ============================================================
// SONAR — Token Metadata Resolver
// ============================================================
// Fetches symbol/name/decimals for SPL token mints.
// Strategy:
//   1. In-process cache (1h TTL)
//   2. Supabase token_metadata table (persistent)
//   3. Helius getTokenMetadata API (network fetch)
//
// Batch-aware: resolveTokenMetadataBatch() groups multiple
// mint lookups into a single API call.
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';

// ── Types ─────────────────────────────────────────────────────

export interface TokenMeta {
  mint:         string;
  symbol:       string | null;
  name:         string | null;
  decimals:     number | null;
  is_pump_fun:  boolean;
  logo_uri:     string | null;
}

// ── Constants ─────────────────────────────────────────────────

const PUMP_FUN_SUFFIX = 'pump';

// Hardcoded well-known tokens — skip API for these
const WELL_KNOWN: Record<string, TokenMeta> = {
  'So11111111111111111111111111111111111111112': { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL',  name: 'Solana',          decimals: 9,  is_pump_fun: false, logo_uri: null },
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin',        decimals: 6,  is_pump_fun: false, logo_uri: null },
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', name: 'Tether USD',       decimals: 6,  is_pump_fun: false, logo_uri: null },
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', name: 'Marinade SOL',     decimals: 9,  is_pump_fun: false, logo_uri: null },
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9, is_pump_fun: false, logo_uri: null },
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1': { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', name: 'BlazeStake SOL',   decimals: 9,  is_pump_fun: false, logo_uri: null },
};

// ── In-process cache ──────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface CacheEntry {
  meta:       TokenMeta;
  expires_at: number;
}

const _cache = new Map<string, CacheEntry>();

function fromCache(mint: string): TokenMeta | null {
  const e = _cache.get(mint);
  if (!e || e.expires_at < Date.now()) return null;
  return e.meta;
}

function toCache(meta: TokenMeta): void {
  _cache.set(meta.mint, { meta, expires_at: Date.now() + CACHE_TTL_MS });
}

// ── Helius getTokenMetadata API ───────────────────────────────

interface HeliusTokenMeta {
  account:    string;
  onChainMetadata?: {
    metadata?: {
      data?: {
        name?:   string;
        symbol?: string;
      };
    };
  };
  offChainMetadata?: {
    metadata?: {
      name?:       string;
      symbol?:     string;
      image?:      string;
    };
  };
  legacyMetadata?: {
    name?:       string;
    symbol?:     string;
    logoURI?:    string;
    decimals?:   number;
  };
}

async function fetchHeliusTokenMetadata(mints: string[]): Promise<Map<string, TokenMeta>> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey || mints.length === 0) return new Map();

  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/token-metadata?api-key=${apiKey}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ mintAccounts: mints, includeOffChain: false, disableCache: false }),
        signal:  AbortSignal.timeout(8_000),
      },
    );

    if (!res.ok) return new Map();

    const raw: HeliusTokenMeta[] = await res.json();
    const result = new Map<string, TokenMeta>();

    for (const item of raw) {
      const mint   = item.account;
      const on     = item.onChainMetadata?.metadata?.data;
      const off    = item.offChainMetadata?.metadata;
      const legacy = item.legacyMetadata;

      const symbol   = on?.symbol?.trim() || off?.symbol?.trim() || legacy?.symbol?.trim() || null;
      const name     = on?.name?.trim()   || off?.name?.trim()   || legacy?.name?.trim()   || null;
      const decimals = legacy?.decimals ?? null;
      const logo_uri = off?.image ?? legacy?.logoURI ?? null;
      const is_pump_fun = mint.endsWith(PUMP_FUN_SUFFIX);

      result.set(mint, { mint, symbol, name, decimals, is_pump_fun, logo_uri });
    }

    return result;
  } catch {
    return new Map();
  }
}

// ── Supabase persistence ──────────────────────────────────────

async function loadFromDb(mints: string[]): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  try {
    const db = createAdminClient();
    const { data } = await (db as any)
      .from('token_metadata')
      .select('mint, symbol, name, decimals, is_pump_fun, logo_uri')
      .in('mint', mints);

    for (const row of data ?? []) {
      result.set(row.mint, row as TokenMeta);
      toCache(row as TokenMeta);
    }
  } catch { /* ignore */ }
  return result;
}

async function saveToDb(metas: TokenMeta[]): Promise<void> {
  if (metas.length === 0) return;
  try {
    const db = createAdminClient();
    await (db as any)
      .from('token_metadata')
      .upsert(
        metas.map(m => ({ ...m, updated_at: new Date().toISOString() })),
        { onConflict: 'mint', ignoreDuplicates: false },
      );
  } catch { /* ignore */ }
}

// ── Public API ────────────────────────────────────────────────

/**
 * Resolve metadata for a batch of mints.
 * Returns a map of mint → TokenMeta (missing mints get a fallback stub).
 */
export async function resolveTokenMetadataBatch(
  mints: string[],
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const needed: string[] = [];

  // 1. Check well-known + in-process cache
  for (const mint of mints) {
    if (WELL_KNOWN[mint]) {
      result.set(mint, WELL_KNOWN[mint]);
      continue;
    }
    const cached = fromCache(mint);
    if (cached) {
      result.set(mint, cached);
      continue;
    }
    needed.push(mint);
  }

  if (needed.length === 0) return result;

  // 2. Check Supabase
  const dbMetas = await loadFromDb(needed);
  const stillNeeded: string[] = [];

  for (const mint of needed) {
    if (dbMetas.has(mint)) {
      result.set(mint, dbMetas.get(mint)!);
    } else {
      stillNeeded.push(mint);
    }
  }

  if (stillNeeded.length === 0) return result;

  // 3. Fetch from Helius (batch, max 100 per call)
  const BATCH = 100;
  const fetched = new Map<string, TokenMeta>();

  for (let i = 0; i < stillNeeded.length; i += BATCH) {
    const chunk   = stillNeeded.slice(i, i + BATCH);
    const partial = await fetchHeliusTokenMetadata(chunk);
    for (const [k, v] of partial) fetched.set(k, v);
  }

  // Fill stubs for any mints not returned by Helius
  for (const mint of stillNeeded) {
    if (!fetched.has(mint)) {
      fetched.set(mint, {
        mint,
        symbol:      null,
        name:        null,
        decimals:    null,
        is_pump_fun: mint.endsWith(PUMP_FUN_SUFFIX),
        logo_uri:    null,
      });
    }
  }

  // 4. Cache + persist
  const toSave: TokenMeta[] = [];
  for (const [mint, meta] of fetched) {
    toCache(meta);
    result.set(mint, meta);
    toSave.push(meta);
  }
  saveToDb(toSave).catch(() => {}); // fire-and-forget

  return result;
}

/** Convenience: resolve a single mint. */
export async function resolveTokenMetadata(mint: string): Promise<TokenMeta> {
  const map = await resolveTokenMetadataBatch([mint]);
  return map.get(mint) ?? { mint, symbol: null, name: null, decimals: null, is_pump_fun: false, logo_uri: null };
}
