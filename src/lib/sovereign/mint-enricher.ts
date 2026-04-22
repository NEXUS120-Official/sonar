// ============================================================
// SONAR — Sovereign Mint Enricher
// ============================================================
// Interpreter + queue + persistence for unknown-mint discovery.
//
// Architecture (Source of Truth §3, §11):
//
//   adapter (mint-inspection.ts)
//     ↓ RawMintInspection
//   interpreter (this file — interpretMintInspection)
//     ↓ SovereignMintEnrichmentResult
//   registry builder (registryEntryFromEnrichment)
//     ↓ SovereignTokenRegistryEntry
//   persistence (persistEnrichmentToDb)
//     ↓ sovereign_mint_enrichments table
//
// Hot-path safety:
//   The decoder sets is_new_token=true for unknown mints.
//   The normalizer calls GLOBAL_MINT_ENRICHMENT_QUEUE.enqueue().
//   This is O(1) — no network, no block.
//   The cron /api/cron/enrich-unknown-mints drains the queue.
//
// Fog-piercing doctrine (Source of Truth §8):
//   We detect structural signals — program type, extension
//   presence, authority state — without fabricating hidden amounts.
//   "We do not know the hidden amount, but we do know this asset
//   has architecture that changes the intelligence surface."
//
// Confidence scoring (Source of Truth §16):
//   'high'   — full jsonParsed response, account found, data parsed
//   'medium' — account found but data shape unexpected
//   'low'    — account not found or RPC error
// ============================================================

import {
  TOKEN_PROGRAM_LEGACY,
  TOKEN_PROGRAM_2022,
  programIdToTokenProgram,
  type TokenProgramType,
  type SovereignTokenRegistryEntry,
  type SovereignTokenRegistry,
} from './token-registry';
import type { RawMintInspection }   from './mint-inspection';
import type { SovereignRpcClient }  from './rpc-client';
import { inspectMintAccountBatch }  from './mint-inspection';

const PUMP_FUN_SUFFIX = 'pump';

// ── Enrichment result type ────────────────────────────────────

export interface SovereignMintEnrichmentResult {
  mint:             string;
  inspected_at:     string;
  token_program:    TokenProgramType;

  decimals:         number | null;
  mint_authority:   string | null;
  freeze_authority: string | null;

  /** Extracted from native tokenMetadata extension (Token-2022). */
  symbol: string | null;
  name:   string | null;
  is_pump_fun: boolean;

  // ── Token-2022 extension signals ─────────────────────────────
  has_transfer_fee:          boolean;
  /** Basis points (0–10000) if extractable. */
  transfer_fee_bps:          number | null;
  has_confidential_transfer: boolean;
  /** Non-null = auditor key exists (fog-piercing: architecture signal). */
  has_auditor_key:           boolean;
  auditor_elgamal_pubkey:    string | null;
  has_transfer_hook:         boolean;
  transfer_hook_program:     string | null;
  has_permanent_delegate:    boolean;
  /** tokenMetadata native extension — symbol/name extractable without Metaplex. */
  has_native_metadata:       boolean;

  /** Extensible risk context — e.g. 'freeze_authority', 'mint_authority_live'. */
  risk_flags:         string[];

  // ── Enrichment quality metadata ───────────────────────────────
  confidence:         'high' | 'medium' | 'low';
  /**
   * true when symbol/name require a follow-up Metaplex lookup (legacy SPL)
   * or when the RPC inspection was incomplete.
   */
  needs_followup:     boolean;
  enrichment_source:  'sovereign_rpc_jsonparsed' | 'not_found' | 'rpc_error';
  methodology_version: 'mint_enricher_v1';
}

// ── Pure interpreter ──────────────────────────────────────────

/**
 * Interpret a raw mint inspection into a normalized enrichment result.
 * Pure and deterministic: same RawMintInspection → same output.
 */
export function interpretMintInspection(
  raw: RawMintInspection,
): SovereignMintEnrichmentResult {
  const base: SovereignMintEnrichmentResult = {
    mint:             raw.mint,
    inspected_at:     raw.inspected_at,
    token_program:    'unknown',
    decimals:         null,
    mint_authority:   null,
    freeze_authority: null,
    symbol:           null,
    name:             null,
    is_pump_fun:      raw.mint.endsWith(PUMP_FUN_SUFFIX),
    has_transfer_fee:          false,
    transfer_fee_bps:          null,
    has_confidential_transfer: false,
    has_auditor_key:           false,
    auditor_elgamal_pubkey:    null,
    has_transfer_hook:         false,
    transfer_hook_program:     null,
    has_permanent_delegate:    false,
    has_native_metadata:       false,
    risk_flags:       [],
    confidence:       'low',
    needs_followup:   true,
    enrichment_source:   raw.rpc_error ? 'rpc_error' : (raw.account ? 'sovereign_rpc_jsonparsed' : 'not_found'),
    methodology_version: 'mint_enricher_v1',
  };

  if (!raw.account) return base;

  // ── Program distinction — account.owner is definitive ─────────
  const ownerProgram = raw.account.owner;
  base.token_program = programIdToTokenProgram(ownerProgram);

  // Cross-check with data.program field ('spl-token' | 'spl-token-2022')
  const dataProgram = raw.account.data?.program ?? '';
  if (base.token_program === 'unknown') {
    if (dataProgram === 'spl-token-2022') base.token_program = 'token_2022';
    else if (dataProgram === 'spl-token')   base.token_program = 'spl_token';
  }

  // ── Parsed mint info ──────────────────────────────────────────
  const info = raw.account.data?.parsed?.info;
  if (!info) {
    base.confidence = 'medium'; // account exists, but data shape unexpected
    return base;
  }

  base.decimals         = typeof info.decimals === 'number' ? info.decimals : null;
  base.mint_authority   = info.mintAuthority   ?? null;
  base.freeze_authority = info.freezeAuthority ?? null;

  if (base.freeze_authority !== null) {
    base.risk_flags = [...base.risk_flags, 'freeze_authority'];
  }
  if (base.mint_authority !== null) {
    base.risk_flags = [...base.risk_flags, 'mint_authority_live'];
  }

  // ── Token-2022 extension parsing ──────────────────────────────
  for (const ext of info.extensions ?? []) {
    const extName  = ext.extension;
    const extState = ext.state ?? {};

    switch (extName) {
      case 'transferFeeConfig': {
        base.has_transfer_fee = true;
        const newer = extState['newerTransferFee'] as Record<string, unknown> | undefined;
        if (newer && typeof newer['transferFeeBasisPoints'] === 'number') {
          base.transfer_fee_bps = newer['transferFeeBasisPoints'];
        }
        break;
      }

      case 'confidentialTransferMint': {
        base.has_confidential_transfer = true;
        const auditorKey = extState['auditorElgamalPubkey'];
        if (auditorKey && typeof auditorKey === 'string' && auditorKey !== '0'.repeat(auditorKey.length)) {
          base.has_auditor_key        = true;
          base.auditor_elgamal_pubkey = auditorKey;
          // Auditor key is a fog-piercing structural signal — flag it.
          base.risk_flags = [...base.risk_flags, 'auditor_key_present'];
        }
        break;
      }

      case 'transferHook': {
        base.has_transfer_hook = true;
        const hookProgramId = extState['programId'];
        if (hookProgramId && typeof hookProgramId === 'string') {
          base.transfer_hook_program = hookProgramId;
        }
        break;
      }

      case 'permanentDelegate': {
        base.has_permanent_delegate = true;
        base.risk_flags = [...base.risk_flags, 'permanent_delegate'];
        break;
      }

      case 'tokenMetadata': {
        base.has_native_metadata = true;
        const rawSymbol = extState['symbol'];
        const rawName   = extState['name'];
        if (typeof rawSymbol === 'string' && rawSymbol.trim()) {
          base.symbol = rawSymbol.trim();
        }
        if (typeof rawName === 'string' && rawName.trim()) {
          base.name = rawName.trim();
        }
        break;
      }

      // metadataPointer, interestBearingConfig, cpiGuard, etc. — note presence only
      default:
        // No action needed for unrecognised extensions —
        // their presence is captured in has_transfer_fee/etc where relevant.
        break;
    }
  }

  // ── Confidence & needs_followup ───────────────────────────────
  base.confidence = 'high';

  // Legacy SPL without symbol/name → metadata requires Metaplex lookup (deferred).
  // Token-2022 with native tokenMetadata extension → self-describing, no followup needed.
  const hasSymbol = base.symbol !== null;
  if (base.token_program === 'token_2022') {
    base.needs_followup = !hasSymbol && !base.has_native_metadata;
  } else {
    // Legacy SPL: needs Metaplex lookup if symbol not already known
    base.needs_followup = !hasSymbol;
  }

  return base;
}

// ── Registry entry builder ────────────────────────────────────

/**
 * Build a SovereignTokenRegistryEntry from an enrichment result.
 * Merges with an existing entry when provided — enrichment wins for
 * program/extension fields; existing wins for symbol/name if already known.
 *
 * Pure function — no side effects.
 */
export function registryEntryFromEnrichment(
  result:   SovereignMintEnrichmentResult,
  existing?: SovereignTokenRegistryEntry,
): SovereignTokenRegistryEntry {
  return {
    mint:          result.mint,
    // Prefer existing symbol/name when already populated (Metaplex quality > native ext)
    symbol:        existing?.symbol   ?? result.symbol,
    name:          existing?.name     ?? result.name,
    decimals:      result.decimals    ?? existing?.decimals ?? null,
    token_program: result.token_program !== 'unknown'
                     ? result.token_program
                     : (existing?.token_program ?? 'unknown'),
    is_pump_fun:   result.is_pump_fun || (existing?.is_pump_fun ?? false),
    has_transfer_fee:          result.has_transfer_fee          || (existing?.has_transfer_fee ?? false),
    has_confidential_transfer: result.has_confidential_transfer || (existing?.has_confidential_transfer ?? false),
    has_transfer_hook:         result.has_transfer_hook         || (existing?.has_transfer_hook ?? false),
    has_permanent_delegate:    result.has_permanent_delegate    || (existing?.has_permanent_delegate ?? false),
    has_auditor_key:           result.has_auditor_key           || (existing?.has_auditor_key ?? false),
    transfer_fee_bps:          result.transfer_fee_bps          ?? existing?.transfer_fee_bps ?? null,
    transfer_hook_program:     result.transfer_hook_program     ?? existing?.transfer_hook_program ?? null,
    has_native_metadata:       result.has_native_metadata       || (existing?.has_native_metadata ?? false),
    mint_authority:            result.mint_authority            ?? existing?.mint_authority ?? null,
    freeze_authority:          result.freeze_authority          ?? existing?.freeze_authority ?? null,
    metadata_source_mode:      result.has_native_metadata
                                 ? 'native_token_metadata'
                                 : (existing?.symbol || existing?.name)
                                   ? (existing?.metadata_source_mode ?? 'db_token_metadata')
                                   : 'unknown',
    enrichment_confidence:     result.confidence,
    enrichment_source:         result.enrichment_source,
    // Merge risk flags (union, deduplicated)
    risk_flags: [...new Set([...result.risk_flags, ...(existing?.risk_flags ?? [])])],
  };
}

/**
 * Merge a batch of enrichment results into an existing registry.
 * Returns a new registry (immutable — does not mutate the input).
 */
export function mergeEnrichmentsIntoRegistry(
  base:        SovereignTokenRegistry,
  enrichments: readonly SovereignMintEnrichmentResult[],
): SovereignTokenRegistry {
  const m = new Map(base as Map<string, SovereignTokenRegistryEntry>);
  for (const e of enrichments) {
    m.set(e.mint, registryEntryFromEnrichment(e, m.get(e.mint)));
  }
  return m;
}

// ── Unknown-mint enrichment queue ─────────────────────────────

export class SovereignMintEnrichmentQueue {
  private readonly pending: Set<string> = new Set();

  /** Enqueue a mint for background enrichment. O(1), never throws. */
  enqueue(mint: string): void {
    this.pending.add(mint);
  }

  /** Number of mints pending enrichment. */
  size(): number {
    return this.pending.size;
  }

  /** Peek at pending mints without draining. */
  peek(): string[] {
    return [...this.pending];
  }

  /**
   * Drain the queue and enrich each pending mint.
   * Fetches account info, interprets, optionally persists to DB.
   *
   * @param client  Sovereign RPC client
   * @param delayMs Per-call delay to avoid rate limits (default 200ms)
   * @returns enriched results + error count
   */
  async drainAndEnrich(
    client:  SovereignRpcClient,
    delayMs: number = 200,
  ): Promise<{ enriched: SovereignMintEnrichmentResult[]; errors: number }> {
    if (this.pending.size === 0) return { enriched: [], errors: 0 };

    // Snapshot + clear before async work to avoid re-entrancy double-processing
    const mints = [...this.pending];
    this.pending.clear();

    const rawInspections = await inspectMintAccountBatch(client, mints, delayMs);

    const enriched: SovereignMintEnrichmentResult[] = rawInspections.map(interpretMintInspection);
    const errors = enriched.filter(e => e.enrichment_source === 'rpc_error').length;

    return { enriched, errors };
  }
}

/** Module-level singleton queue — populated by normalizer, drained by cron. */
export const GLOBAL_MINT_ENRICHMENT_QUEUE = new SovereignMintEnrichmentQueue();

// ── DB persistence ────────────────────────────────────────────

/**
 * Persist an enrichment result to Supabase.
 * Silently no-ops if the table does not exist yet (pre-migration).
 * Also upserts token_metadata with symbol/name/decimals where available.
 */
export async function persistEnrichmentToDb(
  result: SovereignMintEnrichmentResult,
): Promise<void> {
  try {
    const { createAdminClient } = await import('@/lib/supabase/server');
    const db = createAdminClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyDb = db as any;

    // ── Write full enrichment to sovereign_mint_enrichments ─────
    await anyDb
      .from('sovereign_mint_enrichments')
      .upsert(
        {
          mint:                      result.mint,
          token_program:             result.token_program,
          decimals:                  result.decimals,
          mint_authority:            result.mint_authority,
          freeze_authority:          result.freeze_authority,
          has_transfer_fee:          result.has_transfer_fee,
          transfer_fee_bps:          result.transfer_fee_bps,
          has_confidential_transfer: result.has_confidential_transfer,
          has_auditor_key:           result.has_auditor_key,
          auditor_elgamal_pubkey:    result.auditor_elgamal_pubkey,
          has_transfer_hook:         result.has_transfer_hook,
          transfer_hook_program:     result.transfer_hook_program,
          has_permanent_delegate:    result.has_permanent_delegate,
          has_native_metadata:       result.has_native_metadata,
          risk_flags:                result.risk_flags,
          confidence:                result.confidence,
          needs_followup:            result.needs_followup,
          enrichment_source:         result.enrichment_source,
          methodology_version:       result.methodology_version,
          inspected_at:              result.inspected_at,
          updated_at:                new Date().toISOString(),
        },
        { onConflict: 'mint' },
      );

    // ── Also upsert token_metadata (symbol/name/decimals) ────────
    // Only if we have meaningful data to contribute
    if (result.symbol || result.name || result.decimals !== null) {
      await anyDb
        .from('token_metadata')
        .upsert(
          {
            mint:        result.mint,
            symbol:      result.symbol,
            name:        result.name,
            decimals:    result.decimals,
            is_pump_fun: result.is_pump_fun,
            logo_uri:    null,
            updated_at:  new Date().toISOString(),
          },
          { onConflict: 'mint', ignoreDuplicates: false },
        );
    }
  } catch {
    // Intentionally swallowed: pre-migration table absence, network failure, etc.
    // The enrichment result is still in-memory; the next cron pass will retry.
  }
}

/**
 * Persist a batch of enrichment results.
 * Fire-and-forget compatible — returns void, never throws.
 */
export async function persistEnrichmentBatchToDb(
  results: SovereignMintEnrichmentResult[],
): Promise<void> {
  for (const r of results) {
    await persistEnrichmentToDb(r);
  }
}
