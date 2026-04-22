// ============================================================
// SONAR — Sovereign Flow Joiner v1
// ============================================================
// Transforms a NormalizedOutput into an EnrichedSovereignSignal
// by joining with preloaded immutable context maps.
//
// Architectural contract (Source of Truth §3, §12):
//
//   adapter layer    → loads DB → builds immutable context maps
//   joiner (this)    → pure, deterministic, no fetches, no DB
//   output           → EnrichedSovereignSignal — replay-safe,
//                      confidence-scored, audit-ready
//
// Call pattern:
//   const normalized  = normalizeRawTx(row, ctx);
//   const entityMap   = await loadJoinerEntityMap(addresses, db);
//   const clusterMap  = await loadJoinerClusterMap(addresses, db);
//   const signal      = joinSovereignFlow(
//                         normalized, registry,
//                         entityMap, clusterMap, EMPTY_SHADOW_MAP,
//                       );
//
// Confidence tiers (Source of Truth §16):
//   direct_proof      — verified entity, on-chain certainty        (score ≥ 75)
//   strong_evidence   — high-conf entity or strong pattern match   (score ≥ 55)
//   moderate_evidence — unverified entity or partial signals       (score ≥ 35)
//   weak_association  — behavioral guess, low confidence           (score ≥ 15)
//   unknown           — no context available                       (score < 15)
//
// Fog-piercing doctrine (Source of Truth §8):
//   Never fabricate hidden amounts or certainty.
//   Detect and surface structural signals honestly:
//   "We do not know the hidden amount, but we do know this asset
//    has architecture that changes the intelligence surface."
//
// Shadow context is scaffolded for Block 23 (CEX-to-Shadow Linker).
// When no shadow link is available, returns clean null/false values.
// ============================================================

import type { NormalizedOutput, TokenDeltaAnalysis } from '@/lib/normalizer';
import type { MovementRow, TokenMovementRow } from '@/lib/supabase/types';
import type { SovereignTokenRegistry }         from './token-registry';
import type { ResolvedEntity }                 from '@/lib/entity-graph/index';

// ── Confidence tiers ──────────────────────────────────────────

export type ConfidenceTier =
  | 'direct_proof'       // verified entity, on-chain certainty
  | 'strong_evidence'    // high-confidence entity, consistent patterns
  | 'moderate_evidence'  // unverified entity or partial signals
  | 'weak_association'   // behavioral guess, low confidence
  | 'unknown';           // no context available

// ── Context map types ─────────────────────────────────────────
// Injected as preloaded immutable snapshots from the adapter layer.

/** address → resolved entity (from entity graph) */
export type JoinerEntityMap = ReadonlyMap<string, ResolvedEntity>;

/** address → cluster context (from wallet_cluster_members + wallet_clusters) */
export interface JoinerClusterContext {
  cluster_id:   string;
  cluster_type: string;
  cluster_name: string | null;
  member_count: number;
  tags:         string[];
}
export type JoinerClusterMap = ReadonlyMap<string, JoinerClusterContext>;

/**
 * Shadow link entry — produced by CEX-to-Shadow Linker (Block 23).
 * Scaffolded here as a seam: JoinerShadowMap is accepted by the joiner
 * but will be empty until Block 23 populates it.
 */
export interface JoinerShadowLink {
  source_exchange:   string;          // e.g. 'OKX', 'Binance'
  exchange_address:  string;
  funding_time:      string;          // ISO timestamp of funding event
  time_gap_seconds:  number | null;   // gap between funding and target tx
  linkage_reason:    string;          // human-readable evidence string
  confidence:        number;          // 0-100
  privacy_activation: boolean;        // wallet later activated Token-2022 / privacy
}
/** address → shadow links for that address */
export type JoinerShadowMap = ReadonlyMap<string, JoinerShadowLink[]>;

/** Empty shadow map — use as default until Block 23. */
export const EMPTY_SHADOW_MAP: JoinerShadowMap = new Map();

/**
 * Shadow family entry — produced by Multi-Hop Shadow Continuity (Block 25).
 * A wallet is a member of a family when it appears in shadow_families.member_wallets.
 * Injected via familyMap parameter into joinSovereignFlow().
 */
export interface JoinerShadowFamilyEntry {
  family_id:                string;
  root_wallet:              string;
  source_exchange:          string | null;
  source_exchange_wallet:   string | null;
  total_members:            number;
  hop_depth:                number;
  confidence:               number;
  confidence_tier:          ConfidenceTier;
  patterns:                 string[];
  continuity_reasons:       string[];
  has_privacy_activation:   boolean;
  has_token2022_activity:   boolean;
  has_gas_funding:          boolean;
  has_fan_out:              boolean;
  has_fan_in:               boolean;
  has_temporal_correlation: boolean;
}
/** address → shadow family that contains this wallet as a member */
export type JoinerShadowFamilyMap = ReadonlyMap<string, JoinerShadowFamilyEntry>;

/** Empty family map — use as default until Block 26. */
export const EMPTY_SHADOW_FAMILY_MAP: JoinerShadowFamilyMap = new Map();

// ── Output component types ────────────────────────────────────

export interface TokenContextResult {
  mint:          string;
  symbol:        string | null;
  name:          string | null;
  decimals:      number | null;
  token_program: string;      // 'spl_token' | 'token_2022' | 'unknown'
  is_pump_fun:   boolean;
  is_known:      boolean;     // present in registry
}

export interface TokenSecurityPosture {
  token_program_type:        string;   // 'spl_token' | 'token_2022' | 'unknown'
  is_token_2022:             boolean;
  has_transfer_fee:          boolean;
  has_confidential_transfer: boolean;
  has_transfer_hook:         boolean;
  has_permanent_delegate:    boolean;
  has_auditor_key:           boolean;
  risk_flags:                string[];
  /** One-line human-readable security posture summary. */
  security_summary:          string;
  /** Fog-piercing structural signals (honest, not fabricated). */
  fog_piercing_notes:        string[];
  /** Confidence in this posture: 'high'=enriched, 'medium'=partial, 'low'=unknown */
  confidence:                'high' | 'medium' | 'low';
}

export interface EntityAttribution {
  address:         string | null;
  entity_type:     string | null;     // 'exchange' | 'whale' | 'protocol' | ...
  canonical_name:  string | null;
  label:           string | null;
  confidence:      number;            // 0-100
  confidence_tier: ConfidenceTier;
  verified:        boolean;
  tags:            string[];
  source:          string;            // 'entity_graph' | 'unknown'
}

export interface ClusterAttribution {
  cluster_id:   string;
  cluster_type: string;
  cluster_name: string | null;
  member_count: number;
  tags:         string[];
  confidence:   number;   // 0-100 (inherited from entity mapping)
}

export interface ShadowLineageContext {
  has_shadow_link:             boolean;
  source_exchange:             string | null;
  exchange_origin_confidence:  number | null;   // 0-100
  linkage_reason:              string | null;
  time_gap_seconds:            number | null;
  privacy_activation:          boolean;
  lineage_evidence:            string[];
}

/**
 * Multi-hop shadow family context (Block 26).
 * Populated when the signal's from/to/whale address is a member of
 * a detected shadow family in shadow_families table.
 * family_id === null means no family context — graceful degradation.
 */
export interface ShadowFamilyContext {
  family_id:                string | null;
  root_wallet:              string | null;
  source_exchange:          string | null;
  source_exchange_wallet:   string | null;
  total_members:            number | null;
  hop_depth:                number | null;
  confidence:               number | null;
  confidence_tier:          ConfidenceTier | null;
  patterns:                 string[];
  continuity_reasons:       string[];
  has_privacy_activation:   boolean;
  has_token2022_activity:   boolean;
  has_gas_funding:          boolean;
  has_fan_out:              boolean;
  has_fan_in:               boolean;
  has_temporal_correlation: boolean;
}

// Slices of raw decoded data — carried for replay without full row re-fetch.
type MovementSlice = Pick<
  Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>,
  | 'from_address' | 'to_address' | 'from_label' | 'to_label'
  | 'token' | 'amount_token' | 'amount_usd'
  | 'flow_type' | 'flow_direction' | 'exchange' | 'protocol' | 'block_time'
>;

type TokenMovementSlice = Pick<
  Omit<TokenMovementRow, 'id' | 'created_at'>,
  | 'token_mint' | 'token_symbol' | 'token_name' | 'action'
  | 'amount_token' | 'amount_sol' | 'amount_usd' | 'price_per_token'
  | 'protocol' | 'pool_address' | 'is_new_token'
>;

// ── Canonical enriched output ─────────────────────────────────

export interface EnrichedSovereignSignal {
  // ── Identity
  signature:           string;
  enriched_at:         string;          // ISO timestamp of enrichment
  methodology_version: 'flow_joiner_v1';

  // ── Raw decoded data (pass-through for replay / persistence)
  raw_movement:        MovementSlice        | null;
  raw_token_movement:  TokenMovementSlice   | null;

  // ── Token intelligence
  token_context:       TokenContextResult   | null;   // null if no token movement
  token_security:      TokenSecurityPosture;

  // ── Entity attribution
  from_entity:         EntityAttribution;
  to_entity:           EntityAttribution;
  /** For token movements: the whale-side entity. May overlap with from/to. */
  whale_entity:        EntityAttribution;

  // ── Cluster context
  cluster_context:     ClusterAttribution   | null;

  // ── Shadow / CEX-origin lineage (Block 23)
  shadow_context:        ShadowLineageContext;

  // ── Shadow family / multi-hop lineage (Block 26)
  // null family_id = no family membership detected — always present, never missing
  shadow_family_context: ShadowFamilyContext;

  // ── Token delta analysis (Block 28)
  // null = no token movement decoded, or Helius path (sovereign_rpc only).
  // Carries first-class token_program_type, asymmetry detection, and Token-2022 flags.
  token_delta_analysis: TokenDeltaAnalysis | null;

  // ── Signal confidence (Source of Truth §16)
  signal_confidence:   ConfidenceTier;
  signal_score:        number;           // 0-100 composite
  evidence:            string[];         // human-readable evidence list
  attribution_reason:  string;           // primary one-line attribution
}

// ── Pure helper: entity attribution ──────────────────────────

function UNKNOWN_ATTRIBUTION(address: string | null): EntityAttribution {
  return {
    address,
    entity_type:     null,
    canonical_name:  null,
    label:           null,
    confidence:      0,
    confidence_tier: 'unknown',
    verified:        false,
    tags:            [],
    source:          'unknown',
  };
}

function buildEntityAttribution(
  address:   string | null,
  entityMap: JoinerEntityMap,
): EntityAttribution {
  if (!address) return UNKNOWN_ATTRIBUTION(null);

  const entity = entityMap.get(address);
  if (!entity) return UNKNOWN_ATTRIBUTION(address);

  const tier = entity.verified
    ? entity.confidence >= 80 ? 'direct_proof'     : 'strong_evidence'
    : entity.confidence >= 60 ? 'strong_evidence'  :
      entity.confidence >= 40 ? 'moderate_evidence' : 'weak_association';

  return {
    address,
    entity_type:     entity.entity_type,
    canonical_name:  entity.canonical_name,
    label:           entity.label,
    confidence:      entity.confidence,
    confidence_tier: tier,
    verified:        entity.verified,
    tags:            entity.tags,
    source:          entity.source ?? 'entity_graph',
  };
}

// ── Pure helper: token context ────────────────────────────────

function buildTokenContext(
  mint:     string,
  registry: SovereignTokenRegistry,
): TokenContextResult {
  const entry = registry.get(mint);
  if (!entry) {
    return {
      mint,
      symbol:        null,
      name:          null,
      decimals:      null,
      token_program: 'unknown',
      is_pump_fun:   mint.endsWith('pump'),
      is_known:      false,
    };
  }
  return {
    mint,
    symbol:        entry.symbol,
    name:          entry.name,
    decimals:      entry.decimals,
    token_program: entry.token_program,
    is_pump_fun:   entry.is_pump_fun,
    is_known:      true,
  };
}

// ── Pure helper: token security posture ──────────────────────

function buildTokenSecurityPosture(
  mint:          string | null,
  registry:      SovereignTokenRegistry,
  deltaAnalysis: TokenDeltaAnalysis | null = null,
): TokenSecurityPosture {
  if (!mint) {
    return {
      token_program_type:        'unknown',
      is_token_2022:             false,
      has_transfer_fee:          false,
      has_confidential_transfer: false,
      has_transfer_hook:         false,
      has_permanent_delegate:    false,
      has_auditor_key:           false,
      risk_flags:                [],
      security_summary:          'No token — SOL/USDC flow',
      fog_piercing_notes:        [],
      confidence:                'low',
    };
  }

  const entry = registry.get(mint);

  if (!entry) {
    // Even with no registry entry, delta analysis may have detected Token-2022 on-chain
    const detectedProgram = deltaAnalysis?.token_program_type ?? 'unknown';
    const detectedIs2022  = detectedProgram === 'token_2022';
    const fogNotes = ['Token architecture unknown — sovereign inspection pending'];
    if (detectedIs2022) {
      fogNotes.push('Token-2022 program detected via on-chain balance entry (not yet enriched)');
    }
    if (deltaAnalysis) {
      for (const note of deltaAnalysis.evidence) fogNotes.push(note);
    }
    return {
      token_program_type:        detectedProgram,
      is_token_2022:             detectedIs2022,
      has_transfer_fee:          false,
      has_confidential_transfer: false,
      has_transfer_hook:         false,
      has_permanent_delegate:    false,
      has_auditor_key:           false,
      risk_flags:                deltaAnalysis?.possible_transfer_fee ? ['possible_transfer_fee'] : [],
      security_summary:          detectedIs2022
        ? 'Token-2022 program (on-chain) — not yet enriched by Mint Enricher'
        : 'Unknown token — not yet enriched by Mint Enricher',
      fog_piercing_notes:        fogNotes,
      confidence:                'low',
    };
  }

  const is_token_2022 = entry.token_program === 'token_2022';
  const fog_piercing_notes: string[] = [];
  const risk_flags = [...entry.risk_flags];

  if (entry.has_confidential_transfer) {
    fog_piercing_notes.push(
      'Token-2022 confidential transfer: amounts may be shielded — transfer structure is detectable, amounts are not',
    );
  }
  if (entry.has_auditor_key) {
    fog_piercing_notes.push(
      'Auditor key present: institutional-grade privacy architecture with designated oversight capability',
    );
  }
  if (entry.has_transfer_hook) {
    fog_piercing_notes.push(
      'Transfer hook active: custom program logic executes on every transfer — behavior not fully predictable from balance deltas alone',
    );
  }
  if (entry.has_permanent_delegate) {
    fog_piercing_notes.push(
      'Permanent delegate: a third party can transfer tokens from any holder without approval',
    );
  }
  if (entry.has_transfer_fee) {
    fog_piercing_notes.push(
      'Transfer fee applies: receiver nets less than sender sends — delta asymmetry expected',
    );
  }
  // ── 28C: Supplement from delta analysis ──────────────────────
  // Delta analysis carries on-chain detected token_program_type (from balance
  // entry programId), which may be more current than registry for new mints.
  // Upgrade unknown → detected without downgrading a confirmed registry value.
  let effectiveProgramType = entry.token_program;
  if (effectiveProgramType === 'unknown' && deltaAnalysis?.token_program_type !== 'unknown') {
    effectiveProgramType = deltaAnalysis!.token_program_type;
  }
  const effectiveIsToken2022 = effectiveProgramType === 'token_2022' || is_token_2022;

  if (effectiveIsToken2022 && !is_token_2022) {
    // On-chain detection upgraded program type — note it
    fog_piercing_notes.push(
      'Token-2022 program detected via on-chain balance entry programId (registry not yet enriched)',
    );
  } else if (is_token_2022 && fog_piercing_notes.length === 0) {
    fog_piercing_notes.push(
      'Token-2022 program confirmed — extension details not yet enriched by Mint Enricher',
    );
  }

  // Delta analysis fog-piercing notes (asymmetry, fee-sink, multi-leg)
  if (deltaAnalysis) {
    for (const note of deltaAnalysis.evidence) {
      if (!fog_piercing_notes.includes(note)) fog_piercing_notes.push(note);
    }
    if (deltaAnalysis.possible_transfer_fee && !entry.has_transfer_fee) {
      // On-chain delta suggests fee behavior but registry doesn't confirm it yet
      if (!risk_flags.includes('possible_transfer_fee')) {
        risk_flags.push('possible_transfer_fee');
      }
    }
    if (deltaAnalysis.delta_pattern === 'multi_leg') {
      if (!risk_flags.includes('multi_leg_token_movement')) {
        risk_flags.push('multi_leg_token_movement');
      }
    }
  }

  // Security summary — uses effective program type
  let security_summary: string;
  if (!effectiveIsToken2022) {
    security_summary = effectiveProgramType === 'spl_token'
      ? 'Legacy SPL token — standard transfer semantics'
      : 'Legacy SPL token — program type unconfirmed';
  } else if (entry.has_confidential_transfer && entry.has_auditor_key) {
    security_summary = 'Token-2022 privacy token with auditor key — shielded amounts, institutional oversight';
  } else if (entry.has_confidential_transfer) {
    security_summary = 'Token-2022 privacy token — confidential transfer architecture, amounts may be hidden';
  } else if (entry.has_transfer_fee || deltaAnalysis?.possible_transfer_fee) {
    const confirmed = entry.has_transfer_fee ? 'confirmed' : 'possible (on-chain delta signal)';
    security_summary = `Token-2022 with transfer fee (${confirmed}) — asymmetric sender/receiver deltas`;
  } else if (entry.has_transfer_hook) {
    security_summary = 'Token-2022 with transfer hook — custom program logic on transfer';
  } else if (entry.has_permanent_delegate) {
    security_summary = 'Token-2022 with permanent delegate — third-party control risk';
  } else {
    security_summary = 'Token-2022 asset — standard Token-2022 semantics, no privacy extensions detected';
  }

  // Confidence: was the entry actually enriched by the Mint Enricher?
  const enrichmentConfidence: 'high' | 'medium' | 'low' =
    (effectiveIsToken2022 && (entry.has_transfer_fee || entry.has_confidential_transfer ||
     entry.has_transfer_hook || entry.has_permanent_delegate || entry.has_auditor_key ||
     effectiveProgramType !== 'unknown'))
      ? 'high'
      : effectiveProgramType !== 'unknown'
        ? 'medium'
        : 'low';

  return {
    token_program_type:        effectiveProgramType,
    is_token_2022:             effectiveIsToken2022,
    has_transfer_fee:          entry.has_transfer_fee,
    has_confidential_transfer: entry.has_confidential_transfer,
    has_transfer_hook:         entry.has_transfer_hook,
    has_permanent_delegate:    entry.has_permanent_delegate,
    has_auditor_key:           entry.has_auditor_key,
    risk_flags,
    security_summary,
    fog_piercing_notes,
    confidence:                enrichmentConfidence,
  };
}

// ── Pure helper: cluster attribution ─────────────────────────

function buildClusterAttribution(
  address:    string,
  clusterMap: JoinerClusterMap,
): ClusterAttribution | null {
  const ctx = clusterMap.get(address);
  if (!ctx) return null;
  return {
    cluster_id:   ctx.cluster_id,
    cluster_type: ctx.cluster_type,
    cluster_name: ctx.cluster_name,
    member_count: ctx.member_count,
    tags:         ctx.tags,
    confidence:   70, // cluster membership is behavioral evidence, not identity proof
  };
}

// ── Pure helper: shadow lineage context ───────────────────────

function buildShadowContext(
  fromAddr:  string | null,
  toAddr:    string | null,
  whaleAddr: string | null,
  shadowMap: JoinerShadowMap,
): ShadowLineageContext {
  const empty: ShadowLineageContext = {
    has_shadow_link:            false,
    source_exchange:            null,
    exchange_origin_confidence: null,
    linkage_reason:             null,
    time_gap_seconds:           null,
    privacy_activation:         false,
    lineage_evidence:           [],
  };

  const candidates = [whaleAddr, fromAddr, toAddr].filter(Boolean) as string[];
  for (const addr of candidates) {
    const links = shadowMap.get(addr);
    if (!links || links.length === 0) continue;
    // Use the highest-confidence link
    const best = links.reduce((a, b) => b.confidence > a.confidence ? b : a);
    const evidence: string[] = [best.linkage_reason];
    if (best.privacy_activation) evidence.push('wallet subsequently activated Token-2022 privacy architecture');
    return {
      has_shadow_link:            true,
      source_exchange:            best.source_exchange,
      exchange_origin_confidence: best.confidence,
      linkage_reason:             best.linkage_reason,
      time_gap_seconds:           best.time_gap_seconds,
      privacy_activation:         best.privacy_activation,
      lineage_evidence:           evidence,
    };
  }
  return empty;
}

// ── Pure helper: shadow family context ───────────────────────

const EMPTY_SHADOW_FAMILY_CONTEXT: ShadowFamilyContext = {
  family_id: null, root_wallet: null, source_exchange: null,
  source_exchange_wallet: null, total_members: null, hop_depth: null,
  confidence: null, confidence_tier: null, patterns: [],
  continuity_reasons: [], has_privacy_activation: false,
  has_token2022_activity: false, has_gas_funding: false,
  has_fan_out: false, has_fan_in: false, has_temporal_correlation: false,
};

function buildShadowFamilyContext(
  fromAddr:  string | null,
  toAddr:    string | null,
  whaleAddr: string | null,
  familyMap: JoinerShadowFamilyMap,
): ShadowFamilyContext {
  // Try each address — return the highest-confidence family found
  const candidates: JoinerShadowFamilyEntry[] = [];
  for (const addr of [fromAddr, toAddr, whaleAddr]) {
    if (!addr) continue;
    const entry = familyMap.get(addr);
    if (entry) candidates.push(entry);
  }
  if (candidates.length === 0) return EMPTY_SHADOW_FAMILY_CONTEXT;

  const best = candidates.reduce((a, b) => a.confidence >= b.confidence ? a : b);
  return {
    family_id:                best.family_id,
    root_wallet:              best.root_wallet,
    source_exchange:          best.source_exchange,
    source_exchange_wallet:   best.source_exchange_wallet,
    total_members:            best.total_members,
    hop_depth:                best.hop_depth,
    confidence:               best.confidence,
    confidence_tier:          best.confidence_tier,
    patterns:                 best.patterns,
    continuity_reasons:       best.continuity_reasons,
    has_privacy_activation:   best.has_privacy_activation,
    has_token2022_activity:   best.has_token2022_activity,
    has_gas_funding:          best.has_gas_funding,
    has_fan_out:              best.has_fan_out,
    has_fan_in:               best.has_fan_in,
    has_temporal_correlation: best.has_temporal_correlation,
  };
}

// ── Pure helper: signal scoring ───────────────────────────────

function computeSignalScore(
  entityAttribs:  EntityAttribution[],
  tokenSecurity:  TokenSecurityPosture,
  shadowContext:  ShadowLineageContext,
  familyContext:  ShadowFamilyContext,
): number {
  // Entity component: max 40 pts
  const bestEntityConf = Math.max(...entityAttribs.map(e => e.confidence), 0);
  const bestVerified   = entityAttribs.some(e => e.verified);
  const entityScore = bestVerified
    ? Math.round(bestEntityConf * 0.4)    // max 40 pts
    : Math.round(bestEntityConf * 0.2);   // unverified: half credit

  // Token knowledge component: max 20 pts
  const tokenScore =
    tokenSecurity.confidence === 'high'   ? 20 :
    tokenSecurity.confidence === 'medium' ? 10 :
    tokenSecurity.is_token_2022           ?  5 : 3;

  // Fog-piercing intelligence component: max 10 pts
  // Points for having actual structural signals (not just unknowns)
  const fogScore =
    tokenSecurity.fog_piercing_notes.length >= 2 ? 10 :
    tokenSecurity.fog_piercing_notes.length === 1 ?  5 : 0;

  // Shadow / CEX-origin component: max 30 pts
  const shadowScore = !shadowContext.has_shadow_link ? 0 :
    (shadowContext.exchange_origin_confidence ?? 0) >= 70 ? 30 :
    (shadowContext.exchange_origin_confidence ?? 0) >= 40 ? 20 : 10;

  // Shadow family / multi-hop lineage component: max 15 pts
  // Additive — family context adds depth beyond the first-hop shadow link.
  const familyScore = !familyContext.family_id ? 0 :
    (familyContext.confidence ?? 0) >= 55 ? 15 :
    (familyContext.confidence ?? 0) >= 35 ? 10 : 5;

  return Math.min(100, entityScore + tokenScore + fogScore + shadowScore + familyScore);
}

function scoreToTier(score: number): ConfidenceTier {
  if (score >= 75) return 'direct_proof';
  if (score >= 55) return 'strong_evidence';
  if (score >= 35) return 'moderate_evidence';
  if (score >= 15) return 'weak_association';
  return 'unknown';
}

// ── Pure helper: evidence builder ────────────────────────────

function buildEvidence(
  fromEntity:    EntityAttribution,
  toEntity:      EntityAttribution,
  whaleEntity:   EntityAttribution,
  tokenCtx:      TokenContextResult | null,
  tokenSecurity: TokenSecurityPosture,
  shadowContext: ShadowLineageContext,
  familyContext: ShadowFamilyContext,
): string[] {
  const ev: string[] = [];

  if (fromEntity.canonical_name) {
    ev.push(`sender identified: ${fromEntity.canonical_name} (${fromEntity.entity_type}, conf=${fromEntity.confidence})`);
  }
  if (toEntity.canonical_name) {
    ev.push(`receiver identified: ${toEntity.canonical_name} (${toEntity.entity_type}, conf=${toEntity.confidence})`);
  }
  if (whaleEntity.canonical_name && whaleEntity.address !== fromEntity.address && whaleEntity.address !== toEntity.address) {
    ev.push(`whale actor: ${whaleEntity.canonical_name} (conf=${whaleEntity.confidence})`);
  }
  if (tokenCtx?.is_known) {
    ev.push(`token known: ${tokenCtx.symbol ?? tokenCtx.mint.slice(0, 12) + '...'} (${tokenCtx.token_program})`);
  }
  if (tokenCtx && !tokenCtx.is_known) {
    ev.push('token unknown — queued for sovereign mint enrichment');
  }
  for (const note of tokenSecurity.fog_piercing_notes) {
    ev.push(note);
  }
  if (shadowContext.has_shadow_link) {
    ev.push(`exchange-origin shadow link: ${shadowContext.source_exchange} (conf=${shadowContext.exchange_origin_confidence})`);
    if (shadowContext.privacy_activation) {
      ev.push('wallet activated Token-2022 privacy after exchange funding');
    }
  }

  if (familyContext.family_id) {
    ev.push(
      `shadow family member: ${familyContext.total_members}-wallet family ` +
      `(${familyContext.source_exchange ?? 'unknown exchange'}, ` +
      `family conf=${familyContext.confidence}, tier=${familyContext.confidence_tier})`,
    );
    if (familyContext.has_gas_funding) {
      ev.push('gas-funding chain detected: root wallet funded child wallets with small SOL topups');
    }
    if (familyContext.has_fan_out) {
      ev.push(`fan-out: family root funds multiple child wallets (coordinated management signal)`);
    }
    if (familyContext.has_temporal_correlation) {
      ev.push('temporal correlation: sibling transfers within tight time window (machine-like timing)');
    }
  }

  return ev;
}

function buildAttributionReason(
  fromEntity:    EntityAttribution,
  toEntity:      EntityAttribution,
  whaleEntity:   EntityAttribution,
  tokenCtx:      TokenContextResult | null,
  tokenSecurity: TokenSecurityPosture,
): string {
  if (tokenCtx) {
    const actor  = whaleEntity.canonical_name ?? whaleEntity.entity_type ?? 'unknown actor';
    const token  = tokenCtx.symbol ?? `${tokenCtx.mint.slice(0, 8)}...`;
    const suffix = tokenSecurity.is_token_2022 ? ' [Token-2022]' : '';
    return `${actor}: token ${tokenCtx.is_known ? token : 'unknown'} movement${suffix}`;
  }
  const from = fromEntity.canonical_name ?? fromEntity.entity_type ?? 'unknown';
  const to   = toEntity.canonical_name   ?? toEntity.entity_type   ?? 'unknown';
  return `${from} → ${to}`;
}

// ── Main joiner ───────────────────────────────────────────────

/**
 * Join a normalized movement with immutable context maps to produce
 * an EnrichedSovereignSignal.
 *
 * Pure function — no fetches, no DB calls, fully deterministic.
 * Same inputs → same output. Replay-safe.
 *
 * @param normalized   output of normalizeRawTx()
 * @param registry     immutable token registry snapshot
 * @param entityMap    preloaded entity context for relevant addresses
 * @param clusterMap   preloaded cluster context for relevant addresses
 * @param shadowMap    preloaded shadow link context (empty until Block 23)
 */
export function joinSovereignFlow(
  normalized:  NormalizedOutput,
  registry:    SovereignTokenRegistry,
  entityMap:   JoinerEntityMap,
  clusterMap:  JoinerClusterMap,
  shadowMap:   JoinerShadowMap        = EMPTY_SHADOW_MAP,
  familyMap:   JoinerShadowFamilyMap  = EMPTY_SHADOW_FAMILY_MAP,
): EnrichedSovereignSignal {
  const enriched_at = new Date().toISOString();

  // ── Addresses of interest ─────────────────────────────────────
  const fromAddr  = normalized.movement?.from_address   ?? null;
  const toAddr    = normalized.movement?.to_address     ?? null;
  const whaleAddr = normalized.whaleAddressHint         ?? null;

  // ── Token context ─────────────────────────────────────────────
  const tokenMint       = normalized.tokenMovement?.token_mint ?? null;
  const tokenContext    = tokenMint ? buildTokenContext(tokenMint, registry) : null;
  const tokenDeltaAnalysis = normalized.tokenDeltaAnalysis ?? null;
  const tokenSecurity   = buildTokenSecurityPosture(tokenMint, registry, tokenDeltaAnalysis);

  // ── Entity attribution ────────────────────────────────────────
  const fromEntity  = buildEntityAttribution(fromAddr,  entityMap);
  const toEntity    = buildEntityAttribution(toAddr,    entityMap);
  const whaleEntity = buildEntityAttribution(whaleAddr, entityMap);

  // ── Cluster attribution ───────────────────────────────────────
  // Try whale address first, then from address
  const clusterContext =
    (whaleAddr ? buildClusterAttribution(whaleAddr, clusterMap) : null) ??
    (fromAddr  ? buildClusterAttribution(fromAddr,  clusterMap) : null);

  // ── Shadow lineage ────────────────────────────────────────────
  const shadowContext = buildShadowContext(fromAddr, toAddr, whaleAddr, shadowMap);

  // ── Shadow family / multi-hop lineage (Block 26) ──────────────
  const shadowFamilyContext = buildShadowFamilyContext(fromAddr, toAddr, whaleAddr, familyMap);

  // ── Signal scoring ────────────────────────────────────────────
  const score = computeSignalScore(
    [fromEntity, toEntity, whaleEntity],
    tokenSecurity,
    shadowContext,
    shadowFamilyContext,
  );
  const signal_confidence = scoreToTier(score);

  // ── Evidence + attribution ────────────────────────────────────
  const evidence           = buildEvidence(fromEntity, toEntity, whaleEntity, tokenContext, tokenSecurity, shadowContext, shadowFamilyContext);
  const attribution_reason = buildAttributionReason(fromEntity, toEntity, whaleEntity, tokenContext, tokenSecurity);

  // ── Raw slices ────────────────────────────────────────────────
  const raw_movement: MovementSlice | null = normalized.movement ? {
    from_address:   normalized.movement.from_address,
    to_address:     normalized.movement.to_address,
    from_label:     normalized.movement.from_label,
    to_label:       normalized.movement.to_label,
    token:          normalized.movement.token,
    amount_token:   normalized.movement.amount_token,
    amount_usd:     normalized.movement.amount_usd,
    flow_type:      normalized.movement.flow_type,
    flow_direction: normalized.movement.flow_direction,
    exchange:       normalized.movement.exchange,
    protocol:       normalized.movement.protocol,
    block_time:     normalized.movement.block_time,
  } : null;

  const raw_token_movement: TokenMovementSlice | null = normalized.tokenMovement ? {
    token_mint:      normalized.tokenMovement.token_mint,
    token_symbol:    normalized.tokenMovement.token_symbol,
    token_name:      normalized.tokenMovement.token_name,
    action:          normalized.tokenMovement.action,
    amount_token:    normalized.tokenMovement.amount_token,
    amount_sol:      normalized.tokenMovement.amount_sol,
    amount_usd:      normalized.tokenMovement.amount_usd,
    price_per_token: normalized.tokenMovement.price_per_token,
    protocol:        normalized.tokenMovement.protocol,
    pool_address:    normalized.tokenMovement.pool_address,
    is_new_token:    normalized.tokenMovement.is_new_token,
  } : null;

  return {
    signature:           normalized.signature,
    enriched_at,
    methodology_version: 'flow_joiner_v1',
    raw_movement,
    raw_token_movement,
    token_context:       tokenContext,
    token_security:      tokenSecurity,
    from_entity:         fromEntity,
    to_entity:           toEntity,
    whale_entity:        whaleEntity,
    cluster_context:       clusterContext,
    shadow_context:        shadowContext,
    shadow_family_context: shadowFamilyContext,
    token_delta_analysis:  tokenDeltaAnalysis,
    signal_confidence,
    signal_score:        score,
    evidence,
    attribution_reason,
  };
}

// ── Adapter loaders ───────────────────────────────────────────
// These have DB access. Callers use them to build context maps,
// then inject the maps into the pure joinSovereignFlow().

import type { createAdminClient } from '@/lib/supabase/server';
import { resolveAddressBatch }    from '@/lib/entity-graph/index';

type Db = ReturnType<typeof createAdminClient>;

/**
 * Load entity context for a set of addresses.
 * Returns a JoinerEntityMap (immutable snapshot).
 * Unknown addresses are absent from the map — never fabricated.
 */
export async function loadJoinerEntityMap(
  addresses: string[],
  db:        Db,
): Promise<JoinerEntityMap> {
  const valid = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (valid.length === 0) return new Map();
  return resolveAddressBatch(valid, db);
}

/**
 * Load cluster context for a set of addresses.
 * Returns a JoinerClusterMap (immutable snapshot).
 * Addresses without cluster membership are absent from the map.
 */
export async function loadJoinerClusterMap(
  addresses: string[],
  db:        Db,
): Promise<JoinerClusterMap> {
  const valid = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (valid.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data } = await dba
    .from('wallet_cluster_members')
    .select(`
      address,
      weight,
      cluster_id,
      wallet_clusters ( cluster_type, cluster_name, member_count )
    `)
    .in('address', valid);

  const result = new Map<string, JoinerClusterContext>();

  for (const row of (data ?? []) as Array<{
    address:        string;
    cluster_id:     string;
    wallet_clusters: { cluster_type: string; cluster_name: string | null; member_count: number } | null;
  }>) {
    if (!row.wallet_clusters) continue;
    const wc = row.wallet_clusters;
    result.set(row.address, {
      cluster_id:   row.cluster_id,
      cluster_type: wc.cluster_type,
      cluster_name: wc.cluster_name,
      member_count: wc.member_count,
      tags:         [`cluster:${wc.cluster_type}`],
    });
  }

  return result;
}

/**
 * Convenience: load all context maps for a NormalizedOutput in one call.
 * Returns { entityMap, clusterMap } ready to pass to joinSovereignFlow().
 */
export async function loadJoinerContext(
  normalized: NormalizedOutput,
  db:         Db,
): Promise<{ entityMap: JoinerEntityMap; clusterMap: JoinerClusterMap }> {
  const addresses = [
    normalized.movement?.from_address,
    normalized.movement?.to_address,
    normalized.whaleAddressHint,
  ].filter(Boolean) as string[];

  const [entityMap, clusterMap] = await Promise.all([
    loadJoinerEntityMap(addresses, db),
    loadJoinerClusterMap(addresses, db),
  ]);

  return { entityMap, clusterMap };
}

/**
 * Load shadow family context for a set of addresses.
 * Returns a JoinerShadowFamilyMap (address → family entry).
 *
 * Uses the GIN-indexed member_wallets array overlap query for efficiency.
 * Addresses with no family membership are absent from the map.
 * Only returns families at or above minConfidence (default: 20 = moderate_evidence).
 */
export async function loadJoinerShadowFamilyMap(
  addresses:     string[],
  db:            Db,
  minConfidence: number = 20,
): Promise<JoinerShadowFamilyMap> {
  const valid = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (valid.length === 0) return new Map();

  // PostgREST array overlap: member_wallets && ARRAY[...addresses]
  const arrLiteral = `{${valid.join(',')}}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('shadow_families')
    .select(
      'family_id, root_wallet, source_exchange, source_exchange_wallet, ' +
      'total_members, hop_depth, confidence, confidence_tier, ' +
      'patterns, continuity_reasons, ' +
      'has_privacy_activation, has_token2022_activity, has_gas_funding, ' +
      'has_fan_out, has_fan_in, has_temporal_correlation, member_wallets',
    )
    .gte('confidence', minConfidence)
    .filter('member_wallets', 'ov', arrLiteral);

  const result = new Map<string, JoinerShadowFamilyEntry>();
  const validSet = new Set(valid);

  for (const row of (data ?? []) as Array<{
    family_id:                string;
    root_wallet:              string;
    source_exchange:          string | null;
    source_exchange_wallet:   string | null;
    total_members:            number;
    hop_depth:                number;
    confidence:               number;
    confidence_tier:          string;
    patterns:                 string[];
    continuity_reasons:       string[];
    has_privacy_activation:   boolean;
    has_token2022_activity:   boolean;
    has_gas_funding:          boolean;
    has_fan_out:              boolean;
    has_fan_in:               boolean;
    has_temporal_correlation: boolean;
    member_wallets:           string[];
  }>) {
    const entry: JoinerShadowFamilyEntry = {
      family_id:                row.family_id,
      root_wallet:              row.root_wallet,
      source_exchange:          row.source_exchange,
      source_exchange_wallet:   row.source_exchange_wallet,
      total_members:            row.total_members,
      hop_depth:                row.hop_depth,
      confidence:               row.confidence,
      confidence_tier:          row.confidence_tier as ConfidenceTier,
      patterns:                 row.patterns,
      continuity_reasons:       row.continuity_reasons,
      has_privacy_activation:   row.has_privacy_activation,
      has_token2022_activity:   row.has_token2022_activity,
      has_gas_funding:          row.has_gas_funding,
      has_fan_out:              row.has_fan_out,
      has_fan_in:               row.has_fan_in,
      has_temporal_correlation: row.has_temporal_correlation,
    };

    // Map each member wallet that matches our request set
    for (const member of row.member_wallets) {
      if (!validSet.has(member)) continue;
      const existing = result.get(member);
      if (!existing || entry.confidence > existing.confidence) {
        result.set(member, entry);
      }
    }
  }

  return result;
}
