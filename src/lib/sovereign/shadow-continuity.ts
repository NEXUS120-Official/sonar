// ============================================================
// SONAR — Multi-Hop Shadow Continuity v1
// ============================================================
// Builds multi-hop shadow lineage families on top of the
// first-hop shadow_links layer (Block 23).
//
// Architectural contract (Source of Truth §3, §8, §11):
//
//   adapter / loader layer
//     → loads shadow_links as seed anchors (confirmed first-hop wallets)
//     → loads outgoing movements from seed wallets (fan-out candidates)
//     → loads child wallet novelty counts + downstream privacy activations
//     → returns immutable ContinuityContext
//   interpreter (detectContinuity)
//     → pure, deterministic, no DB access inside
//     → builds ShadowContinuityRecord[] (per hop) + ShadowFamilyRecord[]
//     → confidence-scored lineage hypotheses with full evidence provenance
//   persistence layer
//     → upserts shadow_families (on root_wallet UNIQUE)
//     → upserts shadow_continuity (on parent_wallet,child_wallet UNIQUE)
//
// Behavioral signals modeled (Source of Truth §8):
//   gas_funding             — small SOL topups from shadow wallet to new wallet
//   fan_out                 — one shadow wallet funds ≥3 child wallets
//   temporal_correlation    — sibling child wallets funded within 5 minutes
//   downstream_privacy      — child wallet activates confidential transfer
//   downstream_token2022    — child wallet uses Token-2022 token post-receipt
//   exchange_anchored_chain — root has confirmed shadow_link from Block 23
//   repeated_destination    — same child wallet receives from root multiple times
//
// Family ID doctrine:
//   family_id is deterministically derived from root_wallet via SHA-256 hash,
//   formatted as UUID-like string. This makes family_id stable and consistent
//   across all detection runs without DB round-trips.
//
// Conservative confidence doctrine (Source of Truth §8):
//   Never fabricate ownership. Model operational continuity honestly.
//   Prefer lower confidence with explicit evidence over stronger claims.
//   A single outgoing transfer from a shadow wallet is not sufficient
//   for a high-confidence family claim — it requires corroborating signals.
// ============================================================

import { createHash }              from 'crypto';
import type { createAdminClient }  from '@/lib/supabase/server';
import type { ConfidenceTier }     from './flow-joiner';

type Db = ReturnType<typeof createAdminClient>;

// ── Continuity pattern taxonomy ───────────────────────────────

export type ContinuityPattern =
  | 'gas_funding'            // small SOL topup to child wallet (deliberate operational funding)
  | 'fan_out'                // shadow root funds ≥3 child wallets (coordinated management)
  | 'temporal_correlation'   // sibling wallets funded within tight time window (machine-like)
  | 'downstream_privacy'     // child wallet activates confidential transfer post-receipt
  | 'downstream_token2022'   // child wallet uses Token-2022 post-receipt
  | 'exchange_anchored_chain'// root wallet has confirmed shadow_link (exchange-funded)
  | 'repeated_destination';  // root → same child wallet multiple times

// ── Seed type (from shadow_links table) ──────────────────────

export interface ShadowLinkSeed {
  target_wallet:     string;
  source_exchange:   string;
  exchange_wallet:   string;
  funding_time:      string;    // ISO — when exchange funded the root
  confidence:        number;    // 0-100 — from shadow_linker
  confidence_tier:   ConfidenceTier;
  privacy_activated: boolean;
}

// ── Context types (immutable, injected into interpreter) ──────

export interface OutgoingTransfer {
  signature:    string;
  to_address:   string;
  token:        string;          // 'SOL' | wSOL mint | spl mint
  amount_token: number;
  amount_usd:   number | null;
  block_time:   string;
}

export interface ChildActivationRecord {
  block_time:                string;
  is_token_2022:             boolean;
  has_confidential_transfer: boolean;
}

export interface ContinuityContext {
  /** Seed: confirmed exchange-funded wallets from shadow_links. */
  shadowLinks:      ReadonlyArray<ShadowLinkSeed>;
  /** shadow wallet address → outgoing transfers (potential child funding). */
  outgoingMap:      ReadonlyMap<string, OutgoingTransfer[]>;
  /** child wallet → prior movement count before funding window (novelty). */
  childPriorCounts: ReadonlyMap<string, number>;
  /** child wallet → Token-2022 / privacy activations after cutoff. */
  childActivations: ReadonlyMap<string, ChildActivationRecord[]>;
}

// ── Persistence types ─────────────────────────────────────────

/** Per-hop lineage record: one row per (parent_wallet, child_wallet) pair. */
export interface ShadowContinuityRecord {
  family_id:                string;   // derived from root_wallet — stable across runs
  parent_wallet:            string;
  child_wallet:             string;
  hop_depth:                number;   // 1 = direct child of exchange-funded root
  pattern:                  ContinuityPattern;
  transfer_signature:       string | null;
  transfer_time:            string | null;
  transfer_amount_sol:      number | null;
  transfer_amount_usd:      number | null;
  is_gas_topup:             boolean;
  parent_has_shadow_link:   boolean;
  parent_shadow_exchange:   string | null;
  parent_shadow_confidence: number | null;
  child_privacy_activated:  boolean;
  child_token2022_active:   boolean;
  evidence:                 string[];
  linkage_reason:           string;
  confidence:               number;
  confidence_tier:          ConfidenceTier;
  methodology_version:      'shadow_continuity_v1';
  first_detected_at:        string;
  last_updated_at:          string;
}

/** Shadow lineage family: one row per root_wallet (unique exchange-funded anchor). */
export interface ShadowFamilyRecord {
  family_id:                string;
  root_wallet:              string;   // UNIQUE — the exchange-funded anchor
  source_exchange:          string | null;
  source_exchange_wallet:   string | null;
  member_wallets:           string[];
  total_members:            number;
  hop_depth:                number;   // max depth from root (1 for this block)
  patterns:                 ContinuityPattern[];
  continuity_reasons:       string[];
  evidence:                 string[];
  confidence:               number;
  confidence_tier:          ConfidenceTier;
  has_privacy_activation:   boolean;
  has_token2022_activity:   boolean;
  has_gas_funding:          boolean;
  has_fan_out:              boolean;
  has_fan_in:               boolean;    // deferred to a later block (cross-family analysis)
  has_temporal_correlation: boolean;
  earliest_activity:        string | null;
  latest_activity:          string | null;
  methodology_version:      'shadow_continuity_v1';
  first_detected_at:        string;
  last_updated_at:          string;
}

// ── Options ───────────────────────────────────────────────────

export interface ContinuityOptions {
  /** How far back to load shadow_links and movements (days). Default: 30 */
  lookbackDays?: number;
  /** Max shadow_link seeds to process per run. Default: 200 */
  maxSeeds?: number;
  /** Max total outgoing movements to load. Default: 5000 */
  maxOutgoing?: number;
  /** Min shadow_link confidence to use as seed. Default: 25 */
  minSeedConfidence?: number;
  /** Min continuity confidence to persist. Default: 20 */
  minConfidenceToPersist?: number;
}

// ── Run result ────────────────────────────────────────────────

export interface ContinuityRunResult {
  seeds_processed:       number;
  families_detected:     number;
  hops_detected:         number;
  families_persisted:    number;
  hops_persisted:        number;
  errors:                number;
  confidence_breakdown:  Record<ConfidenceTier, number>;
  has_gas_funding:       number;
  has_privacy:           number;
  has_fan_out:           number;
  has_temporal_corr:     number;
  started_at:            string;
  completed_at:          string;
}

// ── Detection result (from interpreter) ──────────────────────

interface ContinuityDetectionResult {
  families: ShadowFamilyRecord[];
  hops:     ShadowContinuityRecord[];
}

// ── Constants ─────────────────────────────────────────────────

const GAS_TOPUP_SOL         = 0.1;          // SOL amount below this = gas-topup
const GAS_TOPUP_USD         = 15;           // USD fallback for gas-topup detection
const FAN_OUT_THRESHOLD     = 3;            // ≥ this many children = fan-out
const TEMPORAL_WINDOW_MS    = 5 * 60_000;   // 5 minutes — tight timing = machine-like
const NOVELTY_THRESHOLD     = 10;           // prior movements < this = novel wallet

// SOL mint addresses (native SOL or wrapped SOL)
const SOL_TOKENS = new Set([
  'SOL',
  'So11111111111111111111111111111111111111112',
]);

// ── Pure helpers ──────────────────────────────────────────────

/**
 * Derive a deterministic family_id from root_wallet.
 * Stable across all detection runs — no DB round-trip needed.
 * Formatted as UUID-like hex string for DB compatibility.
 */
function deriveFamilyId(root_wallet: string): string {
  const h = createHash('sha256')
    .update(`shadow_family:v1:${root_wallet}`)
    .digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

function isGasTopup(t: OutgoingTransfer): boolean {
  if (SOL_TOKENS.has(t.token) && t.amount_token <= GAS_TOPUP_SOL) return true;
  if (t.amount_usd !== null && t.amount_usd <= GAS_TOPUP_USD)      return true;
  return false;
}

function toTier(score: number): ConfidenceTier {
  if (score >= 75) return 'direct_proof';
  if (score >= 55) return 'strong_evidence';
  if (score >= 35) return 'moderate_evidence';
  if (score >= 15) return 'weak_association';
  return 'unknown';
}

function detectTemporalCorrelation(hops: ShadowContinuityRecord[]): boolean {
  const times = hops
    .map(h => h.transfer_time)
    .filter((t): t is string => t !== null)
    .map(t => new Date(t).getTime())
    .sort((a, b) => a - b);

  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] <= TEMPORAL_WINDOW_MS) return true;
  }
  return false;
}

function buildHopReason(
  seed:        ShadowLinkSeed,
  transfer:    OutgoingTransfer,
  gasTopup:    boolean,
  childCT:     boolean,
  childT2022:  boolean,
  childNovel:  boolean,
): string {
  const ex    = seed.source_exchange;
  const p     = seed.target_wallet.slice(0, 8) + '…';
  const c     = transfer.to_address.slice(0, 8) + '…';

  if (gasTopup && childCT)    return `${ex}-shadow ${p} gas-funded novel wallet ${c}, which activated confidential transfer`;
  if (gasTopup && childT2022) return `${ex}-shadow ${p} gas-funded wallet ${c}, which later used Token-2022`;
  if (gasTopup && childNovel) return `${ex}-shadow ${p} gas-funded novel wallet ${c} (no prior on-chain history)`;
  if (gasTopup)               return `${ex}-shadow ${p} gas-funded wallet ${c}`;
  if (childCT)                return `${ex}-shadow ${p} funded wallet ${c}, which later activated confidential transfer`;
  if (childT2022)             return `${ex}-shadow ${p} funded wallet ${c}, which later used Token-2022`;
  return `${ex}-shadow ${p} outgoing transfer to ${c}`;
}

// ── Per-hop scoring ───────────────────────────────────────────

interface ScoredHop {
  score:       number;
  evidence:    string[];
  pattern:     ContinuityPattern;
}

function scoreHop(
  seed:          ShadowLinkSeed,
  transfer:      OutgoingTransfer,
  priorCount:    number,
  childActs:     ChildActivationRecord[],
): ScoredHop {
  let score = 10;
  const evidence: string[] = [];
  let pattern: ContinuityPattern = 'exchange_anchored_chain';

  // Exchange anchor — root has confirmed shadow_link
  score += 25;
  evidence.push(
    `root wallet confirmed ${seed.source_exchange} shadow link (confidence: ${seed.confidence})`,
  );

  // Gas-topup detection
  const gasTopup = isGasTopup(transfer);
  if (gasTopup) {
    score += 20;
    pattern = 'gas_funding';
    evidence.push(
      `gas-topup: ${transfer.amount_token.toFixed(6)} ${transfer.token} → ${transfer.to_address.slice(0, 8)}…`,
    );
  }

  // Child novelty
  const childNovel = priorCount < NOVELTY_THRESHOLD;
  if (childNovel) {
    score += 10;
    evidence.push(`child wallet is novel: ${priorCount} prior movements`);
  }

  // Child downstream privacy
  const childCT    = childActs.some(a => a.has_confidential_transfer);
  const childT2022 = childActs.some(a => a.is_token_2022);

  if (childCT) {
    score += 20;
    if (pattern !== 'gas_funding') pattern = 'downstream_privacy';
    evidence.push(`child wallet activated confidential transfer (Token-2022)`);
  } else if (childT2022) {
    score += 10;
    if (pattern !== 'gas_funding') pattern = 'downstream_token2022';
    evidence.push(`child wallet used Token-2022 token post-receipt`);
  }

  // Root privacy already activated — strengthens chain signal
  if (seed.privacy_activated) {
    score += 5;
    evidence.push(`root wallet itself previously activated Token-2022`);
  }

  // Timing: transfer relative to root funding
  const rootMs     = new Date(seed.funding_time).getTime();
  const transferMs = new Date(transfer.block_time).getTime();
  const gapMs      = transferMs - rootMs;

  if (gapMs >= 0 && gapMs < 3_600_000) {
    score += 10;
    evidence.push(`fast follow: transfer ${Math.round(gapMs / 60_000)}m after root funding`);
  } else if (gapMs >= 0 && gapMs < 86_400_000) {
    score += 5;
    evidence.push(`same-day transfer after root funding`);
  }

  score = Math.min(85, score);
  return { score, evidence, pattern };
}

// ── Interpreter ───────────────────────────────────────────────

/**
 * Pure continuity detector. Same context → same output.
 * No DB access, no side effects.
 */
export function detectContinuity(ctx: ContinuityContext): ContinuityDetectionResult {
  const now      = new Date().toISOString();
  const families: ShadowFamilyRecord[]     = [];
  const allHops:  ShadowContinuityRecord[] = [];

  for (const seed of ctx.shadowLinks) {
    const outgoing = ctx.outgoingMap.get(seed.target_wallet) ?? [];
    if (outgoing.length === 0) continue;

    const familyId = deriveFamilyId(seed.target_wallet);

    // Detect repeated destinations (same child wallet appears multiple times)
    const destCount = new Map<string, number>();
    for (const t of outgoing) destCount.set(t.to_address, (destCount.get(t.to_address) ?? 0) + 1);

    const hops: ShadowContinuityRecord[] = [];

    // One hop record per unique child wallet (best transfer if multiple)
    const seenChildren = new Set<string>();

    for (const transfer of outgoing) {
      const childAddr = transfer.to_address;

      // Skip self-transfers (shouldn't happen, but guard it)
      if (childAddr === seed.target_wallet) continue;

      // Use only first occurrence per child for the hop record
      // (repeated destination is captured as a pattern, not separate hops)
      const isFirst = !seenChildren.has(childAddr);
      seenChildren.add(childAddr);
      if (!isFirst) continue;

      const priorCount = ctx.childPriorCounts.get(childAddr) ?? 0;
      const childActs  = ctx.childActivations.get(childAddr) ?? [];
      const { score, evidence, pattern } = scoreHop(seed, transfer, priorCount, childActs);

      const childNovel   = priorCount < NOVELTY_THRESHOLD;
      const childCT      = childActs.some(a => a.has_confidential_transfer);
      const childT2022   = childActs.some(a => a.is_token_2022);
      const childPrivacy = childCT || childT2022;

      // Mark repeated destinations
      const effectivePattern: ContinuityPattern =
        (destCount.get(childAddr) ?? 1) > 1 ? 'repeated_destination' : pattern;

      const linkage_reason = buildHopReason(
        seed, transfer, isGasTopup(transfer), childCT, childT2022, childNovel,
      );

      hops.push({
        family_id:                familyId,
        parent_wallet:            seed.target_wallet,
        child_wallet:             childAddr,
        hop_depth:                1,
        pattern:                  effectivePattern,
        transfer_signature:       transfer.signature,
        transfer_time:            transfer.block_time,
        transfer_amount_sol:      SOL_TOKENS.has(transfer.token) ? transfer.amount_token : null,
        transfer_amount_usd:      transfer.amount_usd,
        is_gas_topup:             isGasTopup(transfer),
        parent_has_shadow_link:   true,
        parent_shadow_exchange:   seed.source_exchange,
        parent_shadow_confidence: seed.confidence,
        child_privacy_activated:  childPrivacy,
        child_token2022_active:   childT2022,
        evidence,
        linkage_reason,
        confidence:               score,
        confidence_tier:          toTier(score),
        methodology_version:      'shadow_continuity_v1',
        first_detected_at:        now,
        last_updated_at:          now,
      });
    }

    if (hops.length === 0) continue;

    // ── Family-level signals ──────────────────────────────────

    const hasFanOut             = hops.length >= FAN_OUT_THRESHOLD;
    const hasTemporalCorrelation = detectTemporalCorrelation(hops);
    const hasGasFunding         = hops.some(h => h.is_gas_topup);
    const hasPrivacy            = hops.some(h => h.child_privacy_activated);
    const hasToken2022          = hops.some(h => h.child_token2022_active);
    const hasRepeatedDest       = hops.some(h => h.pattern === 'repeated_destination');

    const patterns = [...new Set(hops.map(h => h.pattern))] as ContinuityPattern[];
    if (hasFanOut)              patterns.push('fan_out');
    if (hasTemporalCorrelation) patterns.push('temporal_correlation');

    // Family score: max hop score + family-level boosts
    let familyScore = Math.max(...hops.map(h => h.confidence));
    if (hasFanOut)              familyScore += 15;
    if (hasTemporalCorrelation) familyScore += 10;
    if (hasRepeatedDest)        familyScore +=  5;
    familyScore = Math.min(95, familyScore);

    const childWallets   = hops.map(h => h.child_wallet);
    const memberWallets  = [seed.target_wallet, ...childWallets];
    const continuityReasons = hops.map(h => h.linkage_reason);
    const allEvidence    = [...new Set(hops.flatMap(h => h.evidence))].slice(0, 20);

    // Timestamp range
    const allTimesMs = hops
      .map(h => h.transfer_time)
      .filter((t): t is string => t !== null)
      .map(t => new Date(t).getTime());
    allTimesMs.push(new Date(seed.funding_time).getTime());

    const earliest_activity = new Date(Math.min(...allTimesMs)).toISOString();
    const latest_activity   = new Date(Math.max(...allTimesMs)).toISOString();

    families.push({
      family_id:                familyId,
      root_wallet:              seed.target_wallet,
      source_exchange:          seed.source_exchange,
      source_exchange_wallet:   seed.exchange_wallet,
      member_wallets:           memberWallets,
      total_members:            memberWallets.length,
      hop_depth:                1,
      patterns:                 [...new Set(patterns)],
      continuity_reasons:       continuityReasons.slice(0, 20),
      evidence:                 allEvidence,
      confidence:               familyScore,
      confidence_tier:          toTier(familyScore),
      has_privacy_activation:   hasPrivacy,
      has_token2022_activity:   hasToken2022,
      has_gas_funding:          hasGasFunding,
      has_fan_out:              hasFanOut,
      has_fan_in:               false,   // cross-family fan-in deferred to a later block
      has_temporal_correlation: hasTemporalCorrelation,
      earliest_activity,
      latest_activity,
      methodology_version:      'shadow_continuity_v1',
      first_detected_at:        now,
      last_updated_at:          now,
    });

    allHops.push(...hops);
  }

  return { families, hops: allHops };
}

// ── Adapter: loaders ──────────────────────────────────────────

async function loadShadowSeeds(
  db:               Db,
  minConfidence:    number,
  maxSeeds:         number,
): Promise<ShadowLinkSeed[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('shadow_links')
    .select(
      'target_wallet, source_exchange, exchange_wallet, ' +
      'funding_time, confidence, confidence_tier, privacy_activated',
    )
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false })
    .limit(maxSeeds);

  return ((data ?? []) as Array<{
    target_wallet:     string;
    source_exchange:   string;
    exchange_wallet:   string;
    funding_time:      string;
    confidence:        number;
    confidence_tier:   string;
    privacy_activated: boolean;
  }>).map(r => ({
    target_wallet:     r.target_wallet,
    source_exchange:   r.source_exchange,
    exchange_wallet:   r.exchange_wallet,
    funding_time:      r.funding_time,
    confidence:        r.confidence,
    confidence_tier:   r.confidence_tier as ConfidenceTier,
    privacy_activated: r.privacy_activated,
  }));
}

async function loadOutgoingMovements(
  db:          Db,
  seedAddrs:   string[],
  cutoff:      string,
  maxRows:     number,
): Promise<ReadonlyMap<string, OutgoingTransfer[]>> {
  if (seedAddrs.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('movements')
    .select('signature, from_address, to_address, token, amount_token, amount_usd, block_time')
    .in('from_address', seedAddrs)
    .gte('block_time', cutoff)
    .order('block_time', { ascending: true })
    .limit(maxRows);

  const result = new Map<string, OutgoingTransfer[]>();

  for (const row of (data ?? []) as Array<{
    signature:    string;
    from_address: string;
    to_address:   string;
    token:        string;
    amount_token: number;
    amount_usd:   number | null;
    block_time:   string;
  }>) {
    const list = result.get(row.from_address) ?? [];
    list.push({
      signature:    row.signature,
      to_address:   row.to_address,
      token:        row.token,
      amount_token: row.amount_token,
      amount_usd:   row.amount_usd,
      block_time:   row.block_time,
    });
    result.set(row.from_address, list);
  }

  return result;
}

async function loadChildPriorCounts(
  db:          Db,
  childAddrs:  string[],
  cutoff:      string,
): Promise<ReadonlyMap<string, number>> {
  if (childAddrs.length === 0) return new Map();

  // Two passes to avoid giant OR clauses — merge into one count map
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [{ data: fromRows }, { data: toRows }] = await Promise.all([
    dba
      .from('movements')
      .select('from_address')
      .in('from_address', childAddrs)
      .lt('block_time', cutoff)
      .limit(10_000),
    dba
      .from('movements')
      .select('to_address')
      .in('to_address', childAddrs)
      .lt('block_time', cutoff)
      .limit(10_000),
  ]);

  const counts = new Map<string, number>();

  for (const r of (fromRows ?? []) as Array<{ from_address: string }>) {
    counts.set(r.from_address, (counts.get(r.from_address) ?? 0) + 1);
  }
  for (const r of (toRows ?? []) as Array<{ to_address: string }>) {
    counts.set(r.to_address, (counts.get(r.to_address) ?? 0) + 1);
  }

  return counts;
}

async function loadChildActivations(
  db:          Db,
  childAddrs:  string[],
  cutoff:      string,
): Promise<ReadonlyMap<string, ChildActivationRecord[]>> {
  if (childAddrs.length === 0) return new Map();

  // Prefer sovereign_signals (already enriched) — fallback gracefully if empty
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('sovereign_signals')
    .select('from_address, to_address, is_token_2022, has_confidential_transfer, block_time')
    .in('to_address', childAddrs)
    .eq('is_token_2022', true)
    .gte('block_time', cutoff)
    .limit(2_000);

  const result = new Map<string, ChildActivationRecord[]>();

  for (const row of (data ?? []) as Array<{
    from_address:              string | null;
    to_address:                string | null;
    is_token_2022:             boolean;
    has_confidential_transfer: boolean;
    block_time:                string | null;
  }>) {
    if (!row.to_address || !row.block_time) continue;

    const rec: ChildActivationRecord = {
      block_time:                row.block_time,
      is_token_2022:             row.is_token_2022,
      has_confidential_transfer: row.has_confidential_transfer,
    };

    const list = result.get(row.to_address) ?? [];
    list.push(rec);
    result.set(row.to_address, list);
  }

  return result;
}

/**
 * Load all data needed for continuity detection in two parallel phases.
 * Returns an immutable ContinuityContext for injection into detectContinuity().
 */
export async function loadContinuityContext(
  db:      Db,
  options: ContinuityOptions = {},
): Promise<ContinuityContext> {
  const lookbackDays     = options.lookbackDays      ?? 30;
  const maxSeeds         = options.maxSeeds          ?? 200;
  const maxOutgoing      = options.maxOutgoing       ?? 5_000;
  const minSeedConf      = options.minSeedConfidence ?? 25;

  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();

  // ── Phase 1: seeds + outgoing ─────────────────────────────────
  const shadowLinks = await loadShadowSeeds(db, minSeedConf, maxSeeds);

  if (shadowLinks.length === 0) {
    return { shadowLinks: [], outgoingMap: new Map(), childPriorCounts: new Map(), childActivations: new Map() };
  }

  const seedAddrs  = shadowLinks.map(s => s.target_wallet);
  const outgoingMap = await loadOutgoingMovements(db, seedAddrs, cutoff, maxOutgoing);

  // Collect unique child addresses across all outgoing maps
  const childAddrSet = new Set<string>();
  for (const transfers of outgoingMap.values()) {
    for (const t of transfers) {
      if (!seedAddrs.includes(t.to_address)) childAddrSet.add(t.to_address);
    }
  }
  const childAddrs = [...childAddrSet];

  if (childAddrs.length === 0) {
    return { shadowLinks, outgoingMap, childPriorCounts: new Map(), childActivations: new Map() };
  }

  // ── Phase 2: child context (parallel) ────────────────────────
  const [childPriorCounts, childActivations] = await Promise.all([
    loadChildPriorCounts(db, childAddrs, cutoff),
    loadChildActivations(db, childAddrs, cutoff),
  ]);

  return { shadowLinks, outgoingMap, childPriorCounts, childActivations };
}

// ── Persistence ───────────────────────────────────────────────

interface PersistResult {
  families_persisted: number;
  hops_persisted:     number;
  errors:             number;
}

/**
 * Upsert shadow families and continuity hops.
 * Families upserted on root_wallet (UNIQUE).
 * Hops upserted on (parent_wallet, child_wallet) (UNIQUE).
 */
export async function persistContinuityBatch(
  families: ShadowFamilyRecord[],
  hops:     ShadowContinuityRecord[],
  db:       Db,
): Promise<PersistResult> {
  if (families.length === 0) return { families_persisted: 0, hops_persisted: 0, errors: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;
  let errors = 0;

  // ── Upsert families first (hops reference family_id) ─────────
  const { error: famErr } = await dba
    .from('shadow_families')
    .upsert(
      families.map(f => ({
        family_id:                f.family_id,
        root_wallet:              f.root_wallet,
        source_exchange:          f.source_exchange,
        source_exchange_wallet:   f.source_exchange_wallet,
        member_wallets:           f.member_wallets,
        total_members:            f.total_members,
        hop_depth:                f.hop_depth,
        patterns:                 f.patterns,
        continuity_reasons:       f.continuity_reasons,
        evidence:                 f.evidence,
        confidence:               f.confidence,
        confidence_tier:          f.confidence_tier,
        has_privacy_activation:   f.has_privacy_activation,
        has_token2022_activity:   f.has_token2022_activity,
        has_gas_funding:          f.has_gas_funding,
        has_fan_out:              f.has_fan_out,
        has_fan_in:               f.has_fan_in,
        has_temporal_correlation: f.has_temporal_correlation,
        earliest_activity:        f.earliest_activity,
        latest_activity:          f.latest_activity,
        methodology_version:      f.methodology_version,
      })),
      { onConflict: 'root_wallet' },
    );

  if (famErr) {
    console.error('[shadow-continuity] persistContinuityBatch families failed:', famErr.message);
    errors += families.length;
    return { families_persisted: 0, hops_persisted: 0, errors };
  }

  // ── Upsert hops ───────────────────────────────────────────────
  if (hops.length === 0) {
    return { families_persisted: families.length, hops_persisted: 0, errors };
  }

  const { error: hopErr } = await dba
    .from('shadow_continuity')
    .upsert(
      hops.map(h => ({
        family_id:                h.family_id,
        parent_wallet:            h.parent_wallet,
        child_wallet:             h.child_wallet,
        hop_depth:                h.hop_depth,
        pattern:                  h.pattern,
        transfer_signature:       h.transfer_signature,
        transfer_time:            h.transfer_time,
        transfer_amount_sol:      h.transfer_amount_sol,
        transfer_amount_usd:      h.transfer_amount_usd,
        is_gas_topup:             h.is_gas_topup,
        parent_has_shadow_link:   h.parent_has_shadow_link,
        parent_shadow_exchange:   h.parent_shadow_exchange,
        parent_shadow_confidence: h.parent_shadow_confidence,
        child_privacy_activated:  h.child_privacy_activated,
        child_token2022_active:   h.child_token2022_active,
        evidence:                 h.evidence,
        linkage_reason:           h.linkage_reason,
        confidence:               h.confidence,
        confidence_tier:          h.confidence_tier,
        methodology_version:      h.methodology_version,
      })),
      { onConflict: 'parent_wallet,child_wallet' },
    );

  if (hopErr) {
    console.error('[shadow-continuity] persistContinuityBatch hops failed:', hopErr.message);
    errors += hops.length;
    return { families_persisted: families.length, hops_persisted: 0, errors };
  }

  return { families_persisted: families.length, hops_persisted: hops.length, errors };
}

// ── Top-level runner ──────────────────────────────────────────

/**
 * Full pipeline: load context → detect continuity → persist → return receipt.
 * Safe to run on a schedule; all upserts are idempotent.
 */
export async function runShadowContinuityDetection(
  db:      Db,
  options: ContinuityOptions = {},
): Promise<ContinuityRunResult> {
  const started_at          = new Date().toISOString();
  const minConfToPersist    = options.minConfidenceToPersist ?? 20;

  const ctx                 = await loadContinuityContext(db, options);
  const { families, hops }  = detectContinuity(ctx);

  // Filter below threshold before persisting
  const familiesToWrite  = families.filter(f => f.confidence >= minConfToPersist);
  const familyIds        = new Set(familiesToWrite.map(f => f.family_id));
  const hopsToWrite      = hops.filter(
    h => h.confidence >= minConfToPersist && familyIds.has(h.family_id),
  );

  const { families_persisted, hops_persisted, errors } =
    await persistContinuityBatch(familiesToWrite, hopsToWrite, db);

  const breakdown: Record<ConfidenceTier, number> = {
    direct_proof: 0, strong_evidence: 0, moderate_evidence: 0, weak_association: 0, unknown: 0,
  };
  for (const f of families) breakdown[f.confidence_tier]++;

  return {
    seeds_processed:    ctx.shadowLinks.length,
    families_detected:  families.length,
    hops_detected:      hops.length,
    families_persisted,
    hops_persisted,
    errors,
    confidence_breakdown: breakdown,
    has_gas_funding:   families.filter(f => f.has_gas_funding).length,
    has_privacy:       families.filter(f => f.has_privacy_activation).length,
    has_fan_out:       families.filter(f => f.has_fan_out).length,
    has_temporal_corr: families.filter(f => f.has_temporal_correlation).length,
    started_at,
    completed_at: new Date().toISOString(),
  };
}
