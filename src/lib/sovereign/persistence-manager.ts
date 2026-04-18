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

  // ── Shadow / CEX-origin lineage (Block 23 will populate)
  has_shadow_link:        boolean;
  shadow_source_exchange: string | null;
  shadow_confidence:      number | null;
  shadow_linkage_reason:  string | null;

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

  return {
    signature:           signal.signature,
    persisted_at:        persistedAt,
    enriched_at:         signal.enriched_at,
    methodology_version: signal.methodology_version,

    block_time: (rm?.block_time as string | null) ?? null,

    from_address:   (rm?.from_address   as string | null) ?? null,
    to_address:     (rm?.to_address     as string | null) ?? null,
    amount_token:   (rm?.amount_token   as number | null) ?? (rt?.amount_token   as number | null) ?? null,
    amount_usd:     (rm?.amount_usd     as number | null) ?? (rt?.amount_usd     as number | null) ?? null,
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
  type JoinerEntityMap,
  type JoinerClusterMap,
  type JoinerShadowMap,
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
  let accepted = 0;
  let skipped  = 0;

  for (const n of normalized) {
    if (n.skipped || (!n.movement && !n.tokenMovement)) {
      skipped++;
      continue;
    }
    try {
      const signal = joinSovereignFlow(n, registry, entityMap, clusterMap, shadowMap);
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
