// ============================================================
// SONAR — Sovereign Token Registry
// ============================================================
// An immutable, injectable context map that the sovereign decoder
// reads at decode time.  The registry never fetches; it is built
// once from a DB snapshot and injected into the decoder as a pure
// parameter.
//
// Architectural contract (Source of Truth §3, §6):
//   adapter layer  → loads DB rows, calls loadRegistryFromDb()
//   registry       → pure Map, no network, deterministic
//   decoder        → reads registry, never fetches
//
// Token-2022 extension flags default to false = "not yet detected".
// The Sovereign Mint Enricher (future block) will update them via
// on-chain TLV inspection.  false ≠ "confirmed absent".
//
// Replayability: any caller can snapshot a registry and replay
// the same decode later to get bit-identical output.
// ============================================================

// ── Program addresses ─────────────────────────────────────────

export const TOKEN_PROGRAM_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_PROGRAM_2022   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export type TokenProgramType = 'spl_token' | 'token_2022' | 'unknown';

// ── Registry entry ────────────────────────────────────────────

export interface SovereignTokenRegistryEntry {
  mint:     string;
  symbol:   string | null;
  name:     string | null;
  decimals: number | null;
  /** Which token program owns token accounts for this mint. */
  token_program: TokenProgramType;
  is_pump_fun:   boolean;

  // ── Token-2022 extension presence ──────────────────────────
  // false = not yet enriched by Mint Enricher.
  // true  = confirmed present via on-chain TLV inspection.
  has_transfer_fee:          boolean;
  has_confidential_transfer: boolean;
  has_transfer_hook:         boolean;
  has_permanent_delegate:    boolean;
  /** Auditor key present in confidential-transfer extension. */
  has_auditor_key:           boolean;

  // ── Deeper extension intelligence (Block 31) ───────────────
  transfer_fee_bps:          number | null;
  transfer_hook_program:     string | null;
  has_native_metadata:       boolean;
  mint_authority:            string | null;
  freeze_authority:          string | null;
  metadata_source_mode:      'well_known' | 'db_token_metadata' | 'native_token_metadata' | 'unknown';
  enrichment_confidence:     'high' | 'medium' | 'low';
  enrichment_source:         'sovereign_rpc_jsonparsed' | 'not_found' | 'rpc_error' | 'bootstrap' | 'unknown';

  /** Extensible risk flags, e.g. 'freeze_authority', 'mint_authority_live'. */
  risk_flags: string[];
}

/** Immutable map: mint address → registry entry. */
export type SovereignTokenRegistry = ReadonlyMap<string, SovereignTokenRegistryEntry>;

// ── Well-known tokens ─────────────────────────────────────────
// Always injected into every registry instance regardless of DB state.

const WELL_KNOWN_ENTRIES: SovereignTokenRegistryEntry[] = [
  {
    mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL', name: 'Solana', decimals: 9,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC', name: 'USD Coin', decimals: 6,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT', name: 'Tether USD', decimals: 6,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
    symbol: 'mSOL', name: 'Marinade SOL', decimals: 9,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
    symbol: 'JitoSOL', name: 'Jito Staked SOL', decimals: 9,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',
    symbol: 'bSOL', name: 'BlazeStake SOL', decimals: 9,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    symbol: 'BONK', name: 'Bonk', decimals: 5,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
  {
    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    symbol: 'WIF', name: 'dogwifhat', decimals: 6,
    token_program: 'spl_token', is_pump_fun: false,
    has_transfer_fee: false, has_confidential_transfer: false,
    has_transfer_hook: false, has_permanent_delegate: false, has_auditor_key: false,
    transfer_fee_bps: null, transfer_hook_program: null, has_native_metadata: false,
    mint_authority: null, freeze_authority: null,
    metadata_source_mode: 'well_known', enrichment_confidence: 'medium', enrichment_source: 'bootstrap',
    risk_flags: [],
  },
];

// ── Pure helpers ──────────────────────────────────────────────

/**
 * Map a raw `programId` string from a token balance entry to a
 * `TokenProgramType`.  Called by the decoder when the registry
 * entry is absent or has `token_program === 'unknown'`.
 */
export function programIdToTokenProgram(programId: string | undefined): TokenProgramType {
  if (programId === TOKEN_PROGRAM_2022)   return 'token_2022';
  if (programId === TOKEN_PROGRAM_LEGACY) return 'spl_token';
  return 'unknown';
}

// ── Registry builders ─────────────────────────────────────────

/**
 * Build a registry from an optional array of DB rows.
 * Well-known entries always take precedence over DB rows.
 *
 * @param rows  rows from token_metadata table (or any shape with the same fields)
 */
export function buildSovereignRegistry(
  rows?: ReadonlyArray<{
    mint:        string;
    symbol:      string | null;
    name:        string | null;
    decimals:    number | null;
    is_pump_fun: boolean;
  }>,
): SovereignTokenRegistry {
  const m = new Map<string, SovereignTokenRegistryEntry>();

  for (const e of WELL_KNOWN_ENTRIES) {
    m.set(e.mint, e);
  }

  for (const row of rows ?? []) {
    if (m.has(row.mint)) continue; // well-known is authoritative
    m.set(row.mint, {
      mint:                      row.mint,
      symbol:                    row.symbol,
      name:                      row.name,
      decimals:                  row.decimals,
      token_program:             'unknown', // Mint Enricher will update
      is_pump_fun:               row.is_pump_fun,
      has_transfer_fee:          false,
      has_confidential_transfer: false,
      has_transfer_hook:         false,
      has_permanent_delegate:    false,
      has_auditor_key:           false,
      transfer_fee_bps:          null,
      transfer_hook_program:     null,
      has_native_metadata:       false,
      mint_authority:            null,
      freeze_authority:          null,
      metadata_source_mode:      'db_token_metadata',
      enrichment_confidence:     'low',
      enrichment_source:         'unknown',
      risk_flags:                [],
    });
  }

  return m;
}

/**
 * Well-known-only registry — safe for offline / test contexts where
 * no DB connection is available.
 */
export function buildEmptyRegistry(): SovereignTokenRegistry {
  return buildSovereignRegistry();
}

// ── Async DB loader ───────────────────────────────────────────
// Separated from pure builders so callers in the hot path can inject
// a pre-loaded snapshot rather than calling this per-decode.

/**
 * Load a full registry snapshot from Supabase.
 * Reads token_metadata (symbol/name/decimals) AND sovereign_mint_enrichments
 * (token_program, Token-2022 flags, risk_flags) and merges them.
 * Falls back to well-known-only on any error — never throws.
 *
 * Typical usage (adapter layer):
 *   const registry = await loadRegistryFromDb();
 *   // inject into NormalizationContext.tokenRegistry
 */
export async function loadRegistryFromDb(): Promise<SovereignTokenRegistry> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/server');
    const db = createAdminClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;

    // Parallel fetch of both tables
    const [metaResult, enrichResult] = await Promise.all([
      (db as ReturnType<typeof createAdminClient>)
        .from('token_metadata')
        .select('mint, symbol, name, decimals, is_pump_fun')
        .limit(10_000),
      anyDb
        .from('sovereign_mint_enrichments')
        .select(
          'mint, token_program, decimals, mint_authority, freeze_authority, ' +
          'has_transfer_fee, transfer_fee_bps, has_confidential_transfer, has_auditor_key, ' +
          'has_transfer_hook, transfer_hook_program, has_permanent_delegate, has_native_metadata, ' +
          'risk_flags, confidence, enrichment_source',
        )
        .limit(10_000),
    ]);

    // Build base registry from token_metadata rows
    const registry = buildSovereignRegistry(metaResult.data ?? []);
    const m = new Map(registry as Map<string, SovereignTokenRegistryEntry>);

    // Merge enrichment rows — they carry Token-2022 program/extension data
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of (enrichResult.data ?? []) as any[]) {
      const existing = m.get(row.mint);
      m.set(row.mint, {
        mint:          row.mint,
        symbol:        existing?.symbol   ?? null,
        name:          existing?.name     ?? null,
        decimals:      row.decimals       ?? existing?.decimals ?? null,
        token_program: (row.token_program as TokenProgramType) ?? 'unknown',
        is_pump_fun:   existing?.is_pump_fun ?? row.mint.endsWith('pump'),
        has_transfer_fee:          row.has_transfer_fee          || false,
        has_confidential_transfer: row.has_confidential_transfer || false,
        has_transfer_hook:         row.has_transfer_hook         || false,
        has_permanent_delegate:    row.has_permanent_delegate    || false,
        has_auditor_key:           row.has_auditor_key           || false,
        transfer_fee_bps:          row.transfer_fee_bps          ?? null,
        transfer_hook_program:     row.transfer_hook_program     ?? null,
        has_native_metadata:       row.has_native_metadata       || false,
        mint_authority:            row.mint_authority            ?? null,
        freeze_authority:          row.freeze_authority          ?? null,
        metadata_source_mode:      row.has_native_metadata ? 'native_token_metadata' : (existing?.metadata_source_mode ?? 'unknown'),
        enrichment_confidence:     (row.confidence as 'high' | 'medium' | 'low') ?? (existing?.enrichment_confidence ?? 'low'),
        enrichment_source:         (row.enrichment_source as 'sovereign_rpc_jsonparsed' | 'not_found' | 'rpc_error' | 'bootstrap' | 'unknown') ?? (existing?.enrichment_source ?? 'unknown'),
        risk_flags:    Array.isArray(row.risk_flags) ? row.risk_flags : [],
      });
    }

    // Well-known entries are always authoritative — restore any that may have been overwritten
    for (const wk of Array.from((buildEmptyRegistry() as Map<string, SovereignTokenRegistryEntry>).values())) {
      m.set(wk.mint, wk);
    }

    return m;
  } catch {
    return buildEmptyRegistry();
  }
}
