// ============================================================
// SONAR — Sovereign Persistence Manager v1
// ============================================================
// The persistence spine of the sovereign intelligence machine.
//
// Architectural contract (Source of Truth §3, §17):
//
//   joiner (pure)           → EnrichedSovereignSignal
//   convertSignalToPayload  → PersistableSovereignSignal (flat, canonical)
//   SovereignPersistenceManager.accept()  → O(1) enqueue, never blocks
//   SovereignPersistenceManager.flush()   → batched write + retry + dead letter
//   sovereign_signals table → durable, queryable, replay-safe
//
// Design principles:
//   - accept() is O(1) and never throws — hot paths call it safely
//   - flush() is async, batched, retried with exponential backoff
//   - On exhausted retries: dead-letter ring buffer captures signals
//   - drainDeadLetter() enables cron-based recovery of failed writes
//   - Auto-flush timer optional for long-running / streaming processes
//   - FlushFn is injected — manager is fully testable without DB
//   - GLOBAL_PERSISTENCE_MANAGER is a singleton for in-process accumulation
//
// Future-ready for:
//   - Yellowstone/Geyser stream (accept() per event, flush() on interval)
//   - Jito-aware / pre-confirmation paths (accept on optimistic, tombstone on miss)
//   - ClickHouse migration (PersistableSovereignSignal maps 1:1 to column schema)
//   - Institutional API (replay any signal by signature)
// ============================================================

import type { EnrichedSovereignSignal } from './flow-joiner';

// ── Canonical persistence payload ─────────────────────────────
// Bridge between semantic intelligence output and storage.
// Intentionally flat (vs nested EnrichedSovereignSignal) so that:
//   - every analytics query is a simple column scan
//   - ClickHouse import requires zero reshaping
//   - replay is trivial: SELECT * WHERE signature = ?
//
// Array columns (evidence, fog_piercing_notes, token_risk_flags)
// are TEXT[] in Postgres — GIN-indexable for containment queries.

export interface PersistableSovereignSignal {
  // ── Identity
  signature:            string;
  persisted_at:         string;   // ISO — set at accept() time
  enriched_at:          string;   // ISO — from joiner
  methodology_version:  string;   // 'flow_joiner_v1'

  // ── Temporal
  block_time:           string | null;

  // ── Core movement identity
  from_address:         string | null;
  to_address:           string | null;
  amount_token:         number | null;
  amount_usd:           number | null;
  token_mint:           string | null;
  token_symbol:         string | null;
  flow_type:            string | null;
  flow_direction:       string | null;
  exchange:             string | null;
  protocol:             string | null;

  // ── Entity attribution (flat for SQL queryability)
  from_entity_name:        string | null;
  from_entity_type:        string | null;
  from_entity_confidence:  number;
  from_entity_verified:    boolean;
  to_entity_name:          string | null;
  to_entity_type:          string | null;
  to_entity_confidence:    number;
  to_entity_verified:      boolean;
  whale_entity_name:       string | null;
  whale_entity_type:       string | null;
  whale_entity_confidence: number;
  whale_entity_verified:   boolean;

  // ── Token security posture
  token_program_type:           string;    // 'spl_token' | 'token_2022' | 'unknown'
  is_token_2022:                boolean;
  has_transfer_fee:             boolean;
  has_confidential_transfer:    boolean;
  has_transfer_hook:            boolean;
  has_permanent_delegate:       boolean;
  has_auditor_key:              boolean;
  token_security_confidence:    string;    // 'high' | 'medium' | 'low'
  token_risk_flags:             string[];
  fog_piercing_notes:           string[];

  // ── Cluster context
  cluster_id:           string | null;
  cluster_type:         string | null;
  cluster_name:         string | null;

  // ── Shadow / CEX-origin lineage (Block 23)
  has_shadow_link:        boolean;
  shadow_source_exchange: string | null;
  shadow_confidence:      number | null;
  shadow_linkage_reason:  string | null;

  // ── Shadow family / multi-hop lineage (Block 26)
  // All null when no family membership detected — graceful degradation.
  shadow_family_id:                     string | null;
  shadow_family_root_wallet:            string | null;
  shadow_family_source_exchange:        string | null;
  shadow_family_source_exchange_wallet: string | null;
  shadow_family_total_members:          number | null;
  shadow_family_hop_depth:              number | null;
  shadow_family_confidence:             number | null;
  shadow_family_confidence_tier:        string | null;
  shadow_family_patterns:               string[];
  shadow_family_continuity_reasons:     string[];
  shadow_family_has_privacy_activation: boolean;
  shadow_family_has_token2022_activity: boolean;
  shadow_family_has_gas_funding:        boolean;
  shadow_family_has_fan_out:            boolean;
  shadow_family_has_fan_in:             boolean;
  shadow_family_has_temporal_correlation: boolean;

  // ── Deeper family semantics (Block 35)
  family_member_role:          string;
  family_coordination_posture: string;
  family_structure_strength:   number;
  family_pattern_count:        number;
  family_reason_count:         number;

  // ── Token delta analysis (Block 28)
  // null = no token movement in this signal (SOL/USDC flow, or Helius path).
  // When present: classifies the on-chain delta pattern and flags asymmetry / fee behavior.
  token_delta_pattern:            string | null;  // TokenDeltaPattern | null
  has_asymmetric_token_delta:     boolean;
  possible_transfer_fee_behavior: boolean;

  // ── Privacy lifecycle persistence (Block 33)
  privacy_lifecycle_stage:            string;   // none | bridgehead_birth | privacy_staging | privacy_active | public_reemergence | downstream_after_reemergence | family_privacy_reemergence
  privacy_lifecycle_confidence:       number;   // 0-100
  privacy_lifecycle_reason:           string | null;
  privacy_public_side:                boolean;
  privacy_reemergence_family_context: boolean;

  // ── Signal quality (Source of Truth §16)
  signal_score:        number;
  signal_confidence:   string;    // ConfidenceTier
  evidence:            string[];
  attribution_reason:  string;

  // ── Replay traceability
  // Persisted as JSONB so any future replay job can reconstruct
  // enrichment inputs without re-fetching from RPC / Helius archive.
  raw_movement:       Record<string, unknown> | null;
  raw_token_movement: Record<string, unknown> | null;
}

// ── Flush function contract ────────────────────────────────────

/** Async function that writes a batch to durable storage. Never called with empty batch. */
export type FlushFn = (batch: PersistableSovereignSignal[]) => Promise<void>;

// ── Manager options ───────────────────────────────────────────

export interface ManagerOptions {
  /** Auto-flush when buffer reaches this size. Default: 50. */
  batchSizeThreshold?: number;
  /** Max retry attempts per flush. Default: 3. */
  maxRetryAttempts?: number;
  /** Base delay between retries ms — doubles each attempt. Default: 800. */
  retryBaseDelayMs?: number;
  /** Dead-letter ring buffer max size. Default: 500. */
  deadLetterMaxSize?: number;
}

// ── Flush result ──────────────────────────────────────────────

export interface FlushResult {
  written:  number;
  failed:   number;
  deferred: number;  // count currently in dead letter after this flush
  attempts: number;
}

// ── Signal converter ──────────────────────────────────────────

type PrivacyLifecycleStage =
  | 'none'
  | 'bridgehead_birth'
  | 'privacy_staging'
  | 'privacy_active'
  | 'public_reemergence'
  | 'downstream_after_reemergence'
  | 'family_privacy_reemergence';

function derivePrivacyLifecycle(
  signal: EnrichedSovereignSignal,
  amountUsd: number | null,
): {
  stage: PrivacyLifecycleStage;
  confidence: number;
  reason: string | null;
  public_side: boolean;
  family_reemergence_context: boolean;
} {
  const usd = amountUsd ?? 0;
  const ts  = signal.token_security;
  const sh  = signal.shadow_context;
  const fam = signal.shadow_family_context;

  if (
    fam.family_id &&
    fam.has_privacy_activation &&
    !ts.has_confidential_transfer &&
    usd >= 10_000
  ) {
    return {
      stage: 'family_privacy_reemergence',
      confidence: fam.confidence ?? 60,
      reason: 'privacy-activated family shows visible public-side continuation',
      public_side: true,
      family_reemergence_context: true,
    };
  }

  if (
    ts.is_token_2022 &&
    !ts.has_confidential_transfer &&
    usd >= 10_000 &&
    (
      signal.token_delta_analysis?.has_asymmetric_delta ||
      signal.token_delta_analysis?.possible_transfer_fee ||
      ts.has_transfer_hook
    )
  ) {
    return {
      stage: 'downstream_after_reemergence',
      confidence: 60,
      reason: 'public-side downstream continuation after privacy-capable context',
      public_side: true,
      family_reemergence_context: false,
    };
  }

  if (
    ts.is_token_2022 &&
    !ts.has_confidential_transfer &&
    usd >= 10_000 &&
    (ts.has_auditor_key || sh.has_shadow_link)
  ) {
    return {
      stage: 'public_reemergence',
      confidence: sh.exchange_origin_confidence ?? (ts.has_auditor_key ? 55 : 45),
      reason: 'privacy-capable asset re-emerged in visible public flow',
      public_side: true,
      family_reemergence_context: false,
    };
  }

  if (
    sh.has_shadow_link &&
    ts.is_token_2022 &&
    usd >= 10_000 &&
    (
      ts.has_transfer_hook ||
      ts.has_permanent_delegate ||
      ts.has_transfer_fee ||
      signal.token_delta_analysis?.possible_transfer_fee
    )
  ) {
    return {
      stage: 'privacy_staging',
      confidence: sh.exchange_origin_confidence ?? 55,
      reason: 'exchange-linked Token-2022 wallet shows extension-sensitive privacy staging posture',
      public_side: false,
      family_reemergence_context: false,
    };
  }

  if (
    sh.has_shadow_link &&
    ts.is_token_2022 &&
    usd >= 10_000 &&
    (ts.has_confidential_transfer || ts.has_auditor_key)
  ) {
    return {
      stage: 'bridgehead_birth',
      confidence: sh.exchange_origin_confidence ?? 60,
      reason: 'shadow-linked Token-2022 wallet entered privacy-adjacent posture',
      public_side: false,
      family_reemergence_context: false,
    };
  }

  if (ts.has_confidential_transfer) {
    return {
      stage: 'privacy_active',
      confidence: 50,
      reason: 'confidential transfer architecture active on this movement',
      public_side: false,
      family_reemergence_context: false,
    };
  }

  return {
    stage: 'none',
    confidence: 0,
    reason: null,
    public_side: false,
    family_reemergence_context: false,
  };
}

/**
 * Convert an EnrichedSovereignSignal to a flat PersistableSovereignSignal.
 * Pure, deterministic, no side effects.
 */
export function convertSignalToPayload(
  signal:      EnrichedSovereignSignal,
  persistedAt: string = new Date().toISOString(),
): PersistableSovereignSignal {
  const rm = signal.raw_movement;
  const rt = signal.raw_token_movement;
  const amountUsd =
    (rm?.amount_usd as number | null) ??
    (rt?.amount_usd as number | null) ??
    null;

  const privacyLifecycle = derivePrivacyLifecycle(signal, amountUsd);

  return {
    signature:           signal.signature,
    persisted_at:        persistedAt,
    enriched_at:         signal.enriched_at,
    methodology_version: signal.methodology_version,

    block_time: (rm?.block_time as string | null) ?? null,

    from_address:   (rm?.from_address   as string | null) ?? null,
    to_address:     (rm?.to_address     as string | null) ?? null,
    amount_token:   (rm?.amount_token   as number | null) ?? (rt?.amount_token   as number | null) ?? null,
    amount_usd:     amountUsd,
    token_mint:     signal.token_context?.mint            ?? (rt?.token_mint     as string | null) ?? null,
    token_symbol:   signal.token_context?.symbol          ?? (rt?.token_symbol   as string | null) ?? null,
    flow_type:      (rm?.flow_type      as string | null) ?? null,
    flow_direction: (rm?.flow_direction as string | null) ?? null,
    exchange:       (rm?.exchange       as string | null) ?? null,
    protocol:       (rm?.protocol       as string | null) ?? (rt?.protocol       as string | null) ?? null,

    from_entity_name:        signal.from_entity.canonical_name,
    from_entity_type:        signal.from_entity.entity_type,
    from_entity_confidence:  signal.from_entity.confidence,
    from_entity_verified:    signal.from_entity.verified,
    to_entity_name:          signal.to_entity.canonical_name,
    to_entity_type:          signal.to_entity.entity_type,
    to_entity_confidence:    signal.to_entity.confidence,
    to_entity_verified:      signal.to_entity.verified,
    whale_entity_name:       signal.whale_entity.canonical_name,
    whale_entity_type:       signal.whale_entity.entity_type,
    whale_entity_confidence: signal.whale_entity.confidence,
    whale_entity_verified:   signal.whale_entity.verified,

    token_program_type:        signal.token_security.token_program_type,
    is_token_2022:             signal.token_security.is_token_2022,
    has_transfer_fee:          signal.token_security.has_transfer_fee,
    has_confidential_transfer: signal.token_security.has_confidential_transfer,
    has_transfer_hook:         signal.token_security.has_transfer_hook,
    has_permanent_delegate:    signal.token_security.has_permanent_delegate,
    has_auditor_key:           signal.token_security.has_auditor_key,
    token_security_confidence: signal.token_security.confidence,
    token_risk_flags:          signal.token_security.risk_flags,
    fog_piercing_notes:        signal.token_security.fog_piercing_notes,

    cluster_id:   signal.cluster_context?.cluster_id   ?? null,
    cluster_type: signal.cluster_context?.cluster_type ?? null,
    cluster_name: signal.cluster_context?.cluster_name ?? null,

    has_shadow_link:        signal.shadow_context.has_shadow_link,
    shadow_source_exchange: signal.shadow_context.source_exchange,
    shadow_confidence:      signal.shadow_context.exchange_origin_confidence,
    shadow_linkage_reason:  signal.shadow_context.linkage_reason,

    token_delta_pattern:            signal.token_delta_analysis?.delta_pattern      ?? null,
    has_asymmetric_token_delta:     signal.token_delta_analysis?.has_asymmetric_delta ?? false,
    possible_transfer_fee_behavior: signal.token_delta_analysis?.possible_transfer_fee ?? false,

    shadow_family_id:                     signal.shadow_family_context.family_id,
    shadow_family_root_wallet:            signal.shadow_family_context.root_wallet,
    shadow_family_source_exchange:        signal.shadow_family_context.source_exchange,
    shadow_family_source_exchange_wallet: signal.shadow_family_context.source_exchange_wallet,
    shadow_family_total_members:          signal.shadow_family_context.total_members,
    shadow_family_hop_depth:              signal.shadow_family_context.hop_depth,
    shadow_family_confidence:             signal.shadow_family_context.confidence,
    shadow_family_confidence_tier:        signal.shadow_family_context.confidence_tier,
    shadow_family_patterns:               signal.shadow_family_context.patterns,
    shadow_family_continuity_reasons:     signal.shadow_family_context.continuity_reasons,
    shadow_family_has_privacy_activation: signal.shadow_family_context.has_privacy_activation,
    shadow_family_has_token2022_activity: signal.shadow_family_context.has_token2022_activity,
    shadow_family_has_gas_funding:        signal.shadow_family_context.has_gas_funding,
    shadow_family_has_fan_out:            signal.shadow_family_context.has_fan_out,
    shadow_family_has_fan_in:             signal.shadow_family_context.has_fan_in,
    shadow_family_has_temporal_correlation: signal.shadow_family_context.has_temporal_correlation,

    family_member_role:          signal.shadow_family_context.family_member_role,
    family_coordination_posture: signal.shadow_family_context.family_coordination_posture,
    family_structure_strength:   signal.shadow_family_context.family_structure_strength,
    family_pattern_count:        signal.shadow_family_context.family_pattern_count,
    family_reason_count:         signal.shadow_family_context.family_reason_count,

    privacy_lifecycle_stage:            privacyLifecycle.stage,
    privacy_lifecycle_confidence:       privacyLifecycle.confidence,
    privacy_lifecycle_reason:           privacyLifecycle.reason,
    privacy_public_side:                privacyLifecycle.public_side,
    privacy_reemergence_family_context: privacyLifecycle.family_reemergence_context,

    signal_score:       signal.signal_score,
    signal_confidence:  signal.signal_confidence,
    evidence:           signal.evidence,
    attribution_reason: signal.attribution_reason,

    raw_movement:       rm ? (rm as Record<string, unknown>) : null,
    raw_token_movement: rt ? (rt as Record<string, unknown>) : null,
  };
}

// ── Persistence Manager ───────────────────────────────────────

const DEFAULT_BATCH_SIZE      = 50;
const DEFAULT_MAX_RETRIES     = 3;
const DEFAULT_RETRY_BASE_MS   = 800;
const DEFAULT_DEAD_LETTER_MAX = 500;
const DEFAULT_AUTO_FLUSH_MS   = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class SovereignPersistenceManager {
  private buffer:      PersistableSovereignSignal[] = [];
  private deadLetter:  PersistableSovereignSignal[] = [];
  private flushTimer:  ReturnType<typeof setInterval> | null = null;

  private readonly flushFn:            FlushFn;
  private readonly batchSizeThreshold: number;
  private readonly maxRetryAttempts:   number;
  private readonly retryBaseDelayMs:   number;
  private readonly deadLetterMaxSize:  number;

  constructor(flushFn: FlushFn, options: ManagerOptions = {}) {
    this.flushFn            = flushFn;
    this.batchSizeThreshold = options.batchSizeThreshold ?? DEFAULT_BATCH_SIZE;
    this.maxRetryAttempts   = options.maxRetryAttempts   ?? DEFAULT_MAX_RETRIES;
    this.retryBaseDelayMs   = options.retryBaseDelayMs   ?? DEFAULT_RETRY_BASE_MS;
    this.deadLetterMaxSize  = options.deadLetterMaxSize  ?? DEFAULT_DEAD_LETTER_MAX;
  }

  // ── Core ingestion ──────────────────────────────────────────

  /**
   * Accept an enriched signal for deferred persistence.
   * O(1) — never throws, never blocks. Safe to call from hot paths.
   * Triggers fire-and-forget flush when buffer hits batchSizeThreshold.
   */
  accept(signal: EnrichedSovereignSignal): void {
    this.buffer.push(convertSignalToPayload(signal));
    if (this.buffer.length >= this.batchSizeThreshold) {
      void this.flush();
    }
  }

  /**
   * Accept a pre-converted payload directly.
   * Useful when callers have already run convertSignalToPayload().
   */
  acceptPayload(payload: PersistableSovereignSignal): void {
    this.buffer.push(payload);
    if (this.buffer.length >= this.batchSizeThreshold) {
      void this.flush();
    }
  }

  // ── Flush ────────────────────────────────────────────────────

  /**
   * Flush the current buffer to durable storage.
   * Retries on transient failure with exponential backoff.
   * On exhausted retries, moves the batch to the dead-letter buffer.
   *
   * Safe to call at any time — no-ops cleanly on empty buffer.
   */
  async flush(): Promise<FlushResult> {
    if (this.buffer.length === 0) {
      return { written: 0, failed: 0, deferred: this.deadLetter.length, attempts: 0 };
    }

    // Snapshot and drain before async work to prevent re-entrancy double-writes
    const batch = this.buffer.splice(0, this.buffer.length);
    return this.flushBatch(batch);
  }

  /**
   * Flush a specific batch.
   * Exposed for external retry orchestration (cron, recovery job, dead-letter drain).
   */
  async flushBatch(batch: PersistableSovereignSignal[]): Promise<FlushResult> {
    if (batch.length === 0) {
      return { written: 0, failed: 0, deferred: this.deadLetter.length, attempts: 0 };
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt++) {
      try {
        await this.flushFn(batch);
        return {
          written:  batch.length,
          failed:   0,
          deferred: this.deadLetter.length,
          attempts: attempt,
        };
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetryAttempts) {
          await sleep(this.retryBaseDelayMs * attempt);  // 800ms, 1600ms, 2400ms
        }
      }
    }

    // All retries exhausted — route to dead letter
    this.addToDeadLetter(batch);
    console.error(
      `[SovereignPersistenceManager] Dead-letter: ${batch.length} signals after ${this.maxRetryAttempts} attempts.`,
      lastError,
    );
    return {
      written:  0,
      failed:   batch.length,
      deferred: this.deadLetter.length,
      attempts: this.maxRetryAttempts,
    };
  }

  // ── Dead letter ──────────────────────────────────────────────

  private addToDeadLetter(items: PersistableSovereignSignal[]): void {
    this.deadLetter.push(...items);
    // Ring buffer: evict oldest when over capacity — oldest signals sacrificed to protect newest
    if (this.deadLetter.length > this.deadLetterMaxSize) {
      const excess = this.deadLetter.length - this.deadLetterMaxSize;
      this.deadLetter.splice(0, excess);
    }
  }

  /**
   * Drain dead-letter buffer and return its contents.
   * Call from a recovery cron to retry previously-failed signals.
   * Items are removed from the dead-letter buffer on return.
   */
  drainDeadLetter(): PersistableSovereignSignal[] {
    const items = [...this.deadLetter];
    this.deadLetter.length = 0;
    return items;
  }

  /**
   * Re-attempt flush of all dead-letter signals.
   * Returns combined result across all retried batches.
   */
  async retryDeadLetter(): Promise<FlushResult> {
    const dead = this.drainDeadLetter();
    if (dead.length === 0) return { written: 0, failed: 0, deferred: 0, attempts: 0 };
    return this.flushBatch(dead);
  }

  // ── Introspection ────────────────────────────────────────────

  get bufferSize(): number     { return this.buffer.length; }
  get deadLetterSize(): number { return this.deadLetter.length; }

  /** Peek buffer without draining (for audit/testing). */
  peekBuffer(): readonly PersistableSovereignSignal[] { return this.buffer; }

  /** Peek dead letter without draining (for audit/testing). */
  peekDeadLetter(): readonly PersistableSovereignSignal[] { return this.deadLetter; }

  // ── Auto-flush timer ─────────────────────────────────────────
  // Useful in long-running processes (Geyser stream, validator node).
  // In Next.js serverless: flush explicitly at end of each handler.

  startAutoFlush(intervalMs: number = DEFAULT_AUTO_FLUSH_MS): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => { void this.flush(); }, intervalMs);
  }

  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ── Flush function factory (Supabase) ─────────────────────────

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

/**
 * Create a FlushFn backed by the Supabase sovereign_signals table.
 * Uses upsert on signature — idempotent, safe to retry.
 *
 * (db as any) cast follows the codebase-consistent pattern for tables
 * added after the generated types were last regenerated.
 */
export function createSupabaseFlushFn(db: Db): FlushFn {
  return async (batch: PersistableSovereignSignal[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (db as any)
      .from('sovereign_signals')
      .upsert(batch, { onConflict: 'signature' });

    if (error) {
      throw new Error(`sovereign_signals upsert failed: ${error.message}`);
    }
  };
}

// ── Global singleton ──────────────────────────────────────────
// Module-level singleton for in-process accumulation.
// Starts with a no-op flush — safe to import without DB access.
// Call createBoundPersistenceManager(db) to get a real-flush instance.
//
// Usage in a cron handler:
//   const manager = createBoundPersistenceManager(db);
//   for (const n of normalized) {
//     const signal = joinSovereignFlow(n, registry, entityMap, clusterMap);
//     manager.accept(signal);
//   }
//   const result = await manager.flush();

const _noop: FlushFn = async () => { /* no-op — configure before expecting writes */ };

export const GLOBAL_PERSISTENCE_MANAGER = new SovereignPersistenceManager(_noop);

/**
 * Create a persistence manager bound to a specific DB connection.
 * Creates a fresh instance — does not share buffer with the global singleton.
 */
export function createBoundPersistenceManager(db: Db, options?: ManagerOptions): SovereignPersistenceManager {
  return new SovereignPersistenceManager(createSupabaseFlushFn(db), options);
}

// ── Batch join + persist adapter ──────────────────────────────
// Convenience wrapper used by cron handlers that want both
// the join step and the accept step in a single call.
// No DB calls inside the join — context is pre-loaded once per batch.

import {
  joinSovereignFlow,
  loadJoinerEntityMap,
  loadJoinerClusterMap,
  EMPTY_SHADOW_MAP,
  EMPTY_SHADOW_FAMILY_MAP,
  type JoinerEntityMap,
  type JoinerClusterMap,
  type JoinerShadowMap,
  type JoinerShadowFamilyMap,
} from './flow-joiner';
import { loadRegistryFromDb } from './token-registry';
import type { NormalizedOutput } from '@/lib/normalizer';

export interface JoinAndAcceptResult {
  accepted:       number;
  skipped:        number;
  flush_result:   FlushResult | null;  // null if flush was not called
}

/**
 * Join a batch of NormalizedOutputs with sovereign context and accept
 * resulting signals into the given persistence manager.
 *
 * Context (registry, entity map, cluster map) is loaded once per batch —
 * not per signal. Shadow map is optional (empty until Block 23).
 *
 * Set `flushAfter: true` to flush the manager after accepting all signals.
 * Otherwise, callers are responsible for calling manager.flush() when ready.
 */
export async function joinAndAcceptBatch(
  normalized:  NormalizedOutput[],
  manager:     SovereignPersistenceManager,
  db:          Db,
  options: {
    shadowMap?:  JoinerShadowMap;
    familyMap?:  JoinerShadowFamilyMap;
    flushAfter?: boolean;
  } = {},
): Promise<JoinAndAcceptResult> {
  if (normalized.length === 0) return { accepted: 0, skipped: 0, flush_result: null };

  // Collect all unique addresses across the batch
  const allAddresses: string[] = [];
  for (const n of normalized) {
    if (n.movement?.from_address) allAddresses.push(n.movement.from_address);
    if (n.movement?.to_address)   allAddresses.push(n.movement.to_address);
    if (n.whaleAddressHint)       allAddresses.push(n.whaleAddressHint);
  }
  const uniqueAddresses = [...new Set(allAddresses)];

  // Load registry + entity/cluster context in parallel — one DB round-trip per batch
  let registry = await loadRegistryFromDb().catch(() => new Map() as ReturnType<typeof loadRegistryFromDb> extends Promise<infer T> ? T : never);
  let entityMap:  JoinerEntityMap  = new Map();
  let clusterMap: JoinerClusterMap = new Map();

  try {
    [entityMap, clusterMap] = await Promise.all([
      loadJoinerEntityMap(uniqueAddresses, db),
      loadJoinerClusterMap(uniqueAddresses, db),
    ]);
  } catch {
    // Graceful degradation: join proceeds with empty context maps
  }

  const shadowMap = options.shadowMap ?? EMPTY_SHADOW_MAP;
  const familyMap = options.familyMap ?? EMPTY_SHADOW_FAMILY_MAP;
  let accepted = 0;
  let skipped  = 0;

  for (const n of normalized) {
    if (n.skipped || (!n.movement && !n.tokenMovement)) {
      skipped++;
      continue;
    }
    try {
      const signal = joinSovereignFlow(n, registry, entityMap, clusterMap, shadowMap, familyMap);
      manager.accept(signal);
      accepted++;
    } catch {
      skipped++;
    }
  }

  let flush_result: FlushResult | null = null;
  if (options.flushAfter) {
    flush_result = await manager.flush();
  }

  return { accepted, skipped, flush_result };
}
