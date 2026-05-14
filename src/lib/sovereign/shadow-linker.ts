// ============================================================
// SONAR — CEX-to-Shadow Linker v1
// ============================================================
// Builds exchange-origin shadow lineage records with confidence
// scoring. Detects wallets that received exchange funding and
// subsequently activated privacy-relevant or Token-2022 behavior.
//
// Architectural contract (Source of Truth §3, §8, §11):
//
//   adapter layer (loaders)
//     → loads exchange funding events, recipient activity, mint enrichments
//     → builds immutable ShadowDetectionContext
//   interpreter (detectShadowLinks)
//     → pure, deterministic, no fetches
//     → produces ShadowLinkRecord[] with confidence scoring
//   persistence (persistShadowLinkBatch)
//     → upserts to shadow_links table
//   joiner adapter (loadJoinerShadowMap)
//     → reads shadow_links, returns JoinerShadowMap for joiner injection
//
// Fog-piercing doctrine (Source of Truth §8):
//   We do NOT fabricate ownership.
//   We DO model relational continuity as confidence-weighted intelligence.
//   "We do not know the hidden amount, but we have strong evidence this wallet
//    belongs to exchange-origin shadow lineage funded by X, and we preserved
//    the provenance, timing, confidence, and downstream evidence."
//
// Evidence doctrine:
//   Every ShadowLinkRecord preserves:
//     - funding signature (on-chain proof)
//     - funding time + amount
//     - wallet novelty (prior movement count)
//     - privacy activation time and mints
//     - time gap between funding and first privacy use
//     - linkage reason string
//     - confidence score + tier
//     - methodology version
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type {
  JoinerShadowLink,
  JoinerShadowMap,
  ConfidenceTier,
} from './flow-joiner';

type Db = ReturnType<typeof createAdminClient>;

// ── Evidence types ────────────────────────────────────────────
// Ordered from strongest to weakest intelligence signal.

export type ShadowEvidenceType =
  | 'exchange_to_new_wallet_then_confidential'  // novel + confidential_transfer activation
  | 'exchange_to_new_wallet_then_token2022'     // novel + any Token-2022 activation
  | 'exchange_to_new_wallet'                   // novel wallet, no privacy activation yet
  | 'exchange_funding_then_privacy'            // existing wallet + privacy activation
  | 'exchange_funding_historical';             // exchange withdrawal, no additional signals

// ── Canonical shadow link record ─────────────────────────────

export interface ShadowLinkRecord {
  // ── Identity
  target_wallet:       string;   // recipient wallet (the shadow candidate)
  funding_signature:   string;   // tx signature of the funding event (on-chain proof)
  methodology_version: 'shadow_linker_v1';

  // ── Exchange origin
  source_exchange:     string;   // exchange name: 'Binance' | 'OKX' | etc.
  exchange_wallet:     string;   // exchange hot wallet address

  // ── Funding event
  funding_time:          string;        // ISO — when the exchange sent funds
  funding_amount_usd:    number | null;

  // ── Recipient novelty (wallet history signal)
  prior_movement_count:  number;   // movements before earliest funding in window
  is_novel_wallet:       boolean;  // derived: prior_movement_count < NOVELTY_THRESHOLD

  // ── Privacy / Token-2022 activation after funding
  privacy_activated:          boolean;
  privacy_activation_time:    string | null;  // first activation after funding
  time_gap_seconds:           number | null;  // gap: funding → first privacy activation
  activated_mints:            string[];       // mints that triggered the flag
  has_confidential_transfer:  boolean;        // highest-grade privacy signal

  // ── Evidence
  evidence_type:    ShadowEvidenceType;
  evidence:         string[];    // human-readable evidence list
  linkage_reason:   string;      // single-line summary
  entity_verified:  boolean;     // exchange address was in verified entity graph

  // ── Confidence (Source of Truth §16)
  confidence:       number;       // 0-100
  confidence_tier:  ConfidenceTier;

  // ── Timestamps
  first_detected_at: string;
  last_updated_at:   string;
}

// ── Detection context ─────────────────────────────────────────
// Pre-loaded, immutable. Injected into pure interpreter.

export interface ExchangeFundingEvent {
  signature:          string;
  exchange_wallet:    string;
  exchange_name:      string;
  recipient_wallet:   string;
  funding_time:       string;     // ISO
  funding_amount_usd: number | null;
  entity_verified:    boolean;    // from_address was in entity_addresses
}

export interface PostMintActivity {
  mint:                      string;
  block_time:                string;
  is_token_2022:             boolean;
  has_confidential_transfer: boolean;
  has_transfer_fee:          boolean;
  has_transfer_hook:         boolean;
  has_permanent_delegate:    boolean;
}

export interface ShadowDetectionContext {
  /** Exchange → recipient funding events from movements table. */
  fundingEvents:         ExchangeFundingEvent[];
  /** address → count of movements in DB before the analysis window. */
  priorCounts:           ReadonlyMap<string, number>;
  /** address → token mint activities after their earliest funding time. */
  postMints:             ReadonlyMap<string, PostMintActivity[]>;
  /** Exchange addresses confirmed in entity graph (verified = true). */
  verifiedExchangeAddrs: ReadonlySet<string>;
}

// ── Constants ─────────────────────────────────────────────────

const NOVELTY_THRESHOLD    = 10;    // prior movements < this → novel wallet
const SEMI_NOVEL_THRESHOLD = 30;    // prior movements < this → semi-novel

// ── Pure confidence scorer ────────────────────────────────────

interface ScoredEvidence {
  score:         number;
  tier:          ConfidenceTier;
  evidence_type: ShadowEvidenceType;
  evidence:      string[];
  linkage_reason: string;
}

function scoreShadowLink(
  event:         ExchangeFundingEvent,
  priorCount:    number,
  postActivities: PostMintActivity[],
): ScoredEvidence {
  let score = 15;  // base: any exchange_withdrawal is a signal
  const evidence: string[] = [];

  // ── Exchange verification bonus ───────────────────────────
  if (event.entity_verified) {
    score += 25;
    evidence.push(`exchange address verified in entity graph: ${event.exchange_wallet.slice(0, 12)}...`);
  } else {
    evidence.push(`exchange identified by known-address mapping: ${event.exchange_name}`);
  }

  // ── Wallet novelty ─────────────────────────────────────────
  const isNovel     = priorCount < NOVELTY_THRESHOLD;
  const isSemiNovel = priorCount < SEMI_NOVEL_THRESHOLD;
  if (isNovel) {
    score += 30;
    evidence.push(`novel wallet: only ${priorCount} prior movements`);
  } else if (isSemiNovel) {
    score += 15;
    evidence.push(`low-history wallet: ${priorCount} prior movements`);
  } else {
    score -= 10;
    evidence.push(`active wallet: ${priorCount} prior movements (weaker signal)`);
  }

  if (event.funding_amount_usd !== null && event.funding_amount_usd > 0) {
    evidence.push(`funded ${event.funding_amount_usd.toFixed(0)} USD from ${event.exchange_name}`);
  }

  // ── Privacy / Token-2022 activation analysis ───────────────
  const privacyActivities = postActivities.filter(
    a => a.is_token_2022 || a.has_confidential_transfer || a.has_transfer_fee,
  );
  const confTransferActivities = postActivities.filter(a => a.has_confidential_transfer);

  const privacyActivated       = privacyActivities.length > 0;
  const hasConfidentialTransfer = confTransferActivities.length > 0;

  let privacyActivationTime: string | null = null;
  let timeGapSeconds:        number | null = null;

  if (privacyActivated) {
    // Find earliest activation
    const sorted = [...privacyActivities].sort(
      (a, b) => new Date(a.block_time).getTime() - new Date(b.block_time).getTime(),
    );
    privacyActivationTime = sorted[0].block_time;

    const fundingMs    = new Date(event.funding_time).getTime();
    const activationMs = new Date(privacyActivationTime).getTime();
    timeGapSeconds = Math.round((activationMs - fundingMs) / 1000);

    if (hasConfidentialTransfer) {
      score += 20;
      evidence.push(
        `confidential-transfer token activated ${fmtGap(timeGapSeconds)} after funding ` +
        `(${confTransferActivities.length} CT mint(s))`,
      );
    } else {
      score += 15;
      evidence.push(
        `Token-2022 activity detected ${fmtGap(timeGapSeconds)} after funding ` +
        `(${privacyActivities.length} mint(s))`,
      );
    }

    // Timing bonus
    if (timeGapSeconds >= 0 && timeGapSeconds < 3_600) {
      score += 10;
      evidence.push('tight temporal correlation: funding → activation within 1 hour');
    } else if (timeGapSeconds >= 0 && timeGapSeconds < 86_400) {
      score += 5;
      evidence.push('close temporal correlation: funding → activation within 24 hours');
    }
  }

  // Cap at 95 — we never claim absolute certainty without additional verification
  score = Math.min(95, score);

  // ── Confidence tier ────────────────────────────────────────
  const tier: ConfidenceTier =
    score >= 70 ? 'direct_proof'     :
    score >= 55 ? 'strong_evidence'  :
    score >= 30 ? 'moderate_evidence':
    score >= 15 ? 'weak_association' : 'unknown';

  // ── Evidence type ──────────────────────────────────────────
  let evidence_type: ShadowEvidenceType;
  if (isNovel && hasConfidentialTransfer) {
    evidence_type = 'exchange_to_new_wallet_then_confidential';
  } else if (isNovel && privacyActivated) {
    evidence_type = 'exchange_to_new_wallet_then_token2022';
  } else if (isNovel) {
    evidence_type = 'exchange_to_new_wallet';
  } else if (privacyActivated) {
    evidence_type = 'exchange_funding_then_privacy';
  } else {
    evidence_type = 'exchange_funding_historical';
  }

  // ── Linkage reason ─────────────────────────────────────────
  const linkage_reason = buildLinkageReason(event, isNovel, privacyActivated, hasConfidentialTransfer, timeGapSeconds);

  return {
    score,
    tier,
    evidence_type,
    evidence,
    linkage_reason,
  };
}

function buildLinkageReason(
  event:                   ExchangeFundingEvent,
  isNovel:                 boolean,
  privacyActivated:        boolean,
  hasConfidentialTransfer: boolean,
  timeGapSeconds:          number | null,
): string {
  const ex       = event.exchange_name;
  const recipient = event.recipient_wallet;
  const short    = `${recipient.slice(0, 8)}...`;

  if (isNovel && hasConfidentialTransfer) {
    return `${ex}-funded novel wallet ${short} activated confidential-transfer Token-2022 architecture${timeGapSeconds !== null ? ` (${fmtGap(timeGapSeconds)} post-funding)` : ''}`;
  }
  if (isNovel && privacyActivated) {
    return `${ex}-funded novel wallet ${short} used Token-2022 token${timeGapSeconds !== null ? ` (${fmtGap(timeGapSeconds)} post-funding)` : ''}`;
  }
  if (isNovel) {
    return `${ex} funded novel wallet ${short} — no prior on-chain history`;
  }
  if (privacyActivated) {
    return `${ex}-funded wallet ${short} activated Token-2022 architecture${timeGapSeconds !== null ? ` (${fmtGap(timeGapSeconds)} post-funding)` : ''}`;
  }
  return `${ex} withdrawal to ${short} — exchange-origin funding recorded`;
}

function fmtGap(seconds: number | null): string {
  if (seconds === null || seconds < 0) return 'unknown time';
  if (seconds < 60)     return `${seconds}s`;
  if (seconds < 3_600)  return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ── Pure interpreter ──────────────────────────────────────────

/**
 * Detect shadow links from a pre-loaded detection context.
 * Pure and deterministic: same context → same output.
 * Safe for replay, testing, and backtesting without DB access.
 */
export function detectShadowLinks(
  ctx: ShadowDetectionContext,
): ShadowLinkRecord[] {
  const now    = new Date().toISOString();
  const results: ShadowLinkRecord[] = [];

  for (const event of ctx.fundingEvents) {
    const priorCount   = ctx.priorCounts.get(event.recipient_wallet) ?? 0;
    const postActs     = ctx.postMints.get(event.recipient_wallet)   ?? [];

    // Only post-funding activities count
    const fundingMs = new Date(event.funding_time).getTime();
    const postFundingActs = postActs.filter(
      a => new Date(a.block_time).getTime() > fundingMs,
    );

    const scored = scoreShadowLink(event, priorCount, postFundingActs);

    // Drop very low confidence signals unless novel wallet — too noisy
    if (scored.score < 15 && priorCount >= NOVELTY_THRESHOLD) continue;

    const privacyActs = postFundingActs.filter(
      a => a.is_token_2022 || a.has_confidential_transfer,
    );
    const sortedPrivacy = [...privacyActs].sort(
      (a, b) => new Date(a.block_time).getTime() - new Date(b.block_time).getTime(),
    );
    const activationTime = sortedPrivacy[0]?.block_time ?? null;
    const fundingMs2     = new Date(event.funding_time).getTime();
    const gapSec         = activationTime
      ? Math.round((new Date(activationTime).getTime() - fundingMs2) / 1000)
      : null;

    results.push({
      target_wallet:          event.recipient_wallet,
      funding_signature:      event.signature,
      methodology_version:    'shadow_linker_v1',
      source_exchange:        event.exchange_name,
      exchange_wallet:        event.exchange_wallet,
      funding_time:           event.funding_time,
      funding_amount_usd:     event.funding_amount_usd,
      prior_movement_count:   priorCount,
      is_novel_wallet:        priorCount < NOVELTY_THRESHOLD,
      privacy_activated:      privacyActs.length > 0,
      privacy_activation_time: activationTime,
      time_gap_seconds:       gapSec,
      activated_mints:        [...new Set(privacyActs.map(a => a.mint))],
      has_confidential_transfer: postFundingActs.some(a => a.has_confidential_transfer),
      evidence_type:          scored.evidence_type,
      evidence:               scored.evidence,
      linkage_reason:         scored.linkage_reason,
      entity_verified:        event.entity_verified,
      confidence:             scored.score,
      confidence_tier:        scored.tier,
      first_detected_at:      now,
      last_updated_at:        now,
    });
  }

  return results;
}

// ── Adapter: context loader ───────────────────────────────────

export interface ShadowDetectionOptions {
  /** How far back to look for exchange_withdrawal movements (days). Default: 30 */
  lookbackDays?: number;
  /** Max funding events to process per run. Default: 500 */
  maxFundingEvents?: number;
  /** Min confidence to persist (0-100). Default: 15 */
  minConfidenceToPersist?: number;
}

/**
 * Load all data needed for shadow link detection in parallel.
 * Returns an immutable ShadowDetectionContext for injection into detectShadowLinks().
 */
export async function loadShadowDetectionContext(
  db:      Db,
  options: ShadowDetectionOptions = {},
): Promise<ShadowDetectionContext> {
  const lookbackDays     = options.lookbackDays      ?? 30;
  const maxEvents        = options.maxFundingEvents  ?? 500;
  const cutoff           = new Date(Date.now() - lookbackDays * 86_400_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // ── Step 1: Load exchange_withdrawal movements ─────────────
  const { data: movRows } = await dba
    .from('movements')
    .select('signature, from_address, to_address, exchange, block_time, amount_usd, from_label')
    .eq('flow_type', 'exchange_withdrawal')
    .not('exchange', 'is', null)
    .gte('block_time', cutoff)
    .order('block_time', { ascending: false })
    .limit(maxEvents);

  const rawMovs = (movRows ?? []) as Array<{
    signature:    string;
    from_address: string;
    to_address:   string;
    exchange:     string | null;
    block_time:   string;
    amount_usd:   number | null;
    from_label:   string | null;
  }>;

  if (rawMovs.length === 0) {
    return {
      fundingEvents:         [],
      priorCounts:           new Map(),
      postMints:             new Map(),
      verifiedExchangeAddrs: new Set(),
    };
  }

  // ── Step 2: Collect unique addresses ──────────────────────
  const recipientAddrs  = [...new Set(rawMovs.map(m => m.to_address))];
  const exchangeAddrs   = [...new Set(rawMovs.map(m => m.from_address))];
  const earliestCutoff  = rawMovs[rawMovs.length - 1]?.block_time ?? cutoff;

  // ── Step 3: Parallel loads ─────────────────────────────────
  const [
    { data: priorMovRows },
    { data: verifiedExchRows },
    { data: whaleRows },
  ] = await Promise.all([
    // Count movements for recipient wallets before the lookback window
    // (approximation of total history — novelty signal)
    dba
      .from('movements')
      .select('from_address, to_address')
      .or(
        recipientAddrs.map(a => `from_address.eq.${a}`).join(',') + ',' +
        recipientAddrs.map(a => `to_address.eq.${a}`).join(','),
      )
      .lt('block_time', earliestCutoff)
      .limit(5000),

    // Check which exchange addresses are verified in entity graph
    dba
      .from('entity_addresses')
      .select('address')
      .in('address', exchangeAddrs)
      .eq('chain', 'solana')
      .eq('is_active', true),

    // Load whale records for recipient addresses (for token_movements lookup)
    dba
      .from('whales')
      .select('id, address')
      .in('address', recipientAddrs)
      .eq('is_active', true),
  ]);

  // ── Step 4: Build prior count map ─────────────────────────
  const priorCounts = new Map<string, number>();
  for (const row of (priorMovRows ?? []) as Array<{
    from_address: string; to_address: string;
  }>) {
    priorCounts.set(row.from_address, (priorCounts.get(row.from_address) ?? 0) + 1);
    priorCounts.set(row.to_address,   (priorCounts.get(row.to_address)   ?? 0) + 1);
  }

  // ── Step 5: Verified exchange address set ─────────────────
  const verifiedExchangeAddrs = new Set<string>(
    ((verifiedExchRows ?? []) as Array<{ address: string }>).map(r => r.address),
  );

  // ── Step 6: Load token movements + mint enrichments ───────
  const whaleIdToAddr = new Map<string, string>();
  const addrToWhaleId = new Map<string, string>();
  for (const w of (whaleRows ?? []) as Array<{ id: string; address: string }>) {
    whaleIdToAddr.set(w.id, w.address);
    addrToWhaleId.set(w.address, w.id);
  }

  const whaleIds = [...whaleIdToAddr.keys()];

  let postMints = new Map<string, PostMintActivity[]>();

  if (whaleIds.length > 0) {
    const [{ data: tokenMovRows }, { data: enrichmentRows }] = await Promise.all([
      // Token movements from whale IDs in our recipient set
      dba
        .from('token_movements')
        .select('whale_id, token_mint, block_time')
        .in('whale_id', whaleIds)
        .gte('block_time', cutoff)
        .order('block_time', { ascending: true })
        .limit(2000),
      // Mint enrichments for Token-2022 / privacy detection
      dba
        .from('sovereign_mint_enrichments')
        .select('mint, is_token_2022, has_confidential_transfer, has_transfer_fee, has_transfer_hook, has_permanent_delegate')
        .eq('is_token_2022', true)  // only Token-2022 mints matter for privacy detection
        .limit(2000),
    ]);

    // Build mint enrichment lookup
    const mintMap = new Map<string, Omit<PostMintActivity, 'mint' | 'block_time'>>();
    for (const r of (enrichmentRows ?? []) as Array<{
      mint: string;
      is_token_2022: boolean; has_confidential_transfer: boolean;
      has_transfer_fee: boolean; has_transfer_hook: boolean; has_permanent_delegate: boolean;
    }>) {
      mintMap.set(r.mint, {
        is_token_2022:             r.is_token_2022,
        has_confidential_transfer: r.has_confidential_transfer,
        has_transfer_fee:          r.has_transfer_fee,
        has_transfer_hook:         r.has_transfer_hook,
        has_permanent_delegate:    r.has_permanent_delegate,
      });
    }

    // Map token activities back to recipient wallet addresses
    for (const row of (tokenMovRows ?? []) as Array<{
      whale_id: string; token_mint: string; block_time: string;
    }>) {
      const walletAddr = whaleIdToAddr.get(row.whale_id);
      if (!walletAddr) continue;
      const enrichment = mintMap.get(row.token_mint);
      if (!enrichment) continue;  // not a Token-2022 mint — skip

      const existing = postMints.get(walletAddr) ?? [];
      existing.push({ mint: row.token_mint, block_time: row.block_time, ...enrichment });
      postMints.set(walletAddr, existing);
    }
  }

  // ── Step 7: Build funding events ──────────────────────────
  const fundingEvents: ExchangeFundingEvent[] = rawMovs.map(m => ({
    signature:          m.signature,
    exchange_wallet:    m.from_address,
    exchange_name:      m.exchange!,
    recipient_wallet:   m.to_address,
    funding_time:       m.block_time,
    funding_amount_usd: m.amount_usd,
    entity_verified:    verifiedExchangeAddrs.has(m.from_address),
  }));

  return {
    fundingEvents,
    priorCounts,
    postMints,
    verifiedExchangeAddrs,
  };
}

// ── Persistence ───────────────────────────────────────────────

/**
 * Upsert shadow link records to shadow_links table.
 * Idempotent: upsert on (target_wallet, funding_signature).
 * Silently no-ops on any error — detection results are in-memory.
 */
export async function persistShadowLinkBatch(
  links: ShadowLinkRecord[],
  db:    Db,
): Promise<{ persisted: number; errors: number }> {
  if (links.length === 0) return { persisted: 0, errors: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('shadow_links')
    .upsert(
      links.map(l => ({
        target_wallet:            l.target_wallet,
        funding_signature:        l.funding_signature,
        source_exchange:          l.source_exchange,
        exchange_wallet:          l.exchange_wallet,
        funding_time:             l.funding_time,
        funding_amount_usd:       l.funding_amount_usd,
        prior_movement_count:     l.prior_movement_count,
        is_novel_wallet:          l.is_novel_wallet,
        privacy_activated:        l.privacy_activated,
        privacy_activation_time:  l.privacy_activation_time,
        time_gap_seconds:         l.time_gap_seconds,
        activated_mints:          l.activated_mints,
        has_confidential_transfer:l.has_confidential_transfer,
        evidence_type:            l.evidence_type,
        evidence:                 l.evidence,
        linkage_reason:           l.linkage_reason,
        entity_verified:          l.entity_verified,
        confidence:               l.confidence,
        confidence_tier:          l.confidence_tier,
        methodology_version:      l.methodology_version,
        first_detected_at:        l.first_detected_at,
        last_updated_at:          l.last_updated_at,
      })),
      { onConflict: 'target_wallet,funding_signature' },
    );

  if (error) {
    console.error('[shadow-linker] persistShadowLinkBatch failed:', error.message);
    return { persisted: 0, errors: links.length };
  }

  return { persisted: links.length, errors: 0 };
}

// ── Top-level runner ──────────────────────────────────────────

export interface ShadowLinkRunResult {
  funding_events_scanned: number;
  links_detected:         number;
  links_persisted:        number;
  errors:                 number;
  confidence_breakdown:   Record<ConfidenceTier, number>;
  privacy_activated:      number;
  novel_wallets:          number;
  started_at:             string;
  completed_at:           string;
}

/**
 * Full pipeline: load context → detect → persist.
 * Returns a structured run receipt.
 */
export async function runShadowLinkDetection(
  db:      Db,
  options: ShadowDetectionOptions = {},
): Promise<ShadowLinkRunResult> {
  const started_at = new Date().toISOString();
  const minConf    = options.minConfidenceToPersist ?? 15;

  const ctx   = await loadShadowDetectionContext(db, options);
  const links = detectShadowLinks(ctx);

  // Filter below min confidence threshold before persisting
  const toWrite = links.filter(l => l.confidence >= minConf);

  const { persisted, errors } = await persistShadowLinkBatch(toWrite, db);

  const breakdown: Record<ConfidenceTier, number> = {
    direct_proof: 0, strong_evidence: 0, moderate_evidence: 0,
    weak_association: 0, unknown: 0,
  };
  for (const l of links) breakdown[l.confidence_tier]++;

  return {
    funding_events_scanned: ctx.fundingEvents.length,
    links_detected:         links.length,
    links_persisted:        persisted,
    errors,
    confidence_breakdown:   breakdown,
    privacy_activated:      links.filter(l => l.privacy_activated).length,
    novel_wallets:          links.filter(l => l.is_novel_wallet).length,
    started_at,
    completed_at:           new Date().toISOString(),
  };
}

// ── Joiner adapter ────────────────────────────────────────────

/**
 * Load persisted shadow links for a set of wallet addresses.
 * Returns a JoinerShadowMap ready to inject into joinSovereignFlow().
 *
 * Only returns links at or above minConfidence (default: 35 = moderate_evidence).
 * Addresses without shadow links are absent from the map.
 */
export async function loadJoinerShadowMap(
  addresses:     string[],
  db:            Db,
  minConfidence: number = 35,
): Promise<JoinerShadowMap> {
  const valid = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (valid.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('shadow_links')
    .select(
      'target_wallet, source_exchange, exchange_wallet, funding_time, ' +
      'time_gap_seconds, linkage_reason, confidence, privacy_activated',
    )
    .in('target_wallet', valid)
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false });

  const result = new Map<string, JoinerShadowLink[]>();

  for (const row of (data ?? []) as Array<{
    target_wallet:    string;
    source_exchange:  string;
    exchange_wallet:  string;
    funding_time:     string;
    time_gap_seconds: number | null;
    linkage_reason:   string;
    confidence:       number;
    privacy_activated:boolean;
  }>) {
    const link: JoinerShadowLink = {
      source_exchange:    row.source_exchange,
      exchange_address:   row.exchange_wallet,
      funding_time:       row.funding_time,
      time_gap_seconds:   row.time_gap_seconds,
      linkage_reason:     row.linkage_reason,
      confidence:         row.confidence,
      privacy_activation: row.privacy_activated,
    };
    const existing = result.get(row.target_wallet) ?? [];
    existing.push(link);
    result.set(row.target_wallet, existing);
  }

  return result;
}
