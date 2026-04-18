// ============================================================
// SONAR — Sovereign Alert Engine v1
// ============================================================
// Intelligence-grade alert evaluation operating on
// PersistableSovereignSignal[] from the persistence manager buffer.
//
// Architectural contract (Source of Truth §8, §16):
//
//   persistence-manager.peekBuffer()  → PersistableSovereignSignal[]
//   evaluateSignalsForAlerts()        → SovereignAlertCandidate[] (pure)
//   consolidateAlerts()               → SovereignAlertDecision[]  (pure)
//   decisionToAlertInsert()           → AlertInsert (mapped to DB schema)
//
// This engine is intelligence-first — NOT volume-only.
// Confidence scoring weighs lineage + cluster + privacy + entity
// attribution, not just raw USD thresholds. Volume is a tie-breaker.
//
// Priority archetypes:
//   shadow_whale_inflow         — shadow-linked wallet receives large inflow
//   exchange_shadow_birth       — exchange-funded wallet activates privacy
//   privacy_token_activity      — Token-2022 confidential transfer activity
//   cluster_synchronized_flow   — cluster member coordinated positioning
//   sovereign_high_confidence   — joiner direct_proof / strong_evidence
//
// Consolidation: candidates sharing a consolidation_key within the
// same evaluation window are merged into one decision (highest
// intel_score leads; all evidence pooled).
//
// Dedup: callers pass recentKeys (consolidation keys fired in the
// cooldown window) — matched candidates are suppressed.
// ============================================================

import type { PersistableSovereignSignal } from './persistence-manager';
import type { AlertInsert }                from '@/lib/flow-engine/anomaly-detector';
import type { AlertType, AlertSeverity }   from '@/lib/supabase/types';

// ── Alert archetypes ──────────────────────────────────────────

export type AlertArchetype =
  | 'shadow_whale_inflow'         // shadow-linked wallet receives large inflow
  | 'exchange_shadow_birth'       // exchange-funded → privacy activation birth event
  | 'privacy_token_activity'      // confidential transfer / Token-2022 fog activity
  | 'cluster_synchronized_flow'   // cluster members acting in coordination
  | 'sovereign_high_confidence'   // joiner-scored direct_proof or strong_evidence
  | 'shadow_family_fan_out'       // family root funded ≥3 child wallets (Block 26)
  | 'shadow_gas_funding_chain';   // gas-funding lineage chain detected (Block 26)

export type AlertPriority = 'critical' | 'high' | 'medium' | 'low';

// ── Candidate ─────────────────────────────────────────────────

export interface SovereignAlertCandidate {
  archetype:         AlertArchetype;
  priority:          AlertPriority;
  signal:            PersistableSovereignSignal;
  intel_score:       number;          // 0-100 composite intelligence score
  evidence:          string[];
  title:             string;
  body:              string;
  consolidation_key: string;          // group key for dedup/merge
}

// ── Decision ─────────────────────────────────────────────────

export interface SovereignAlertDecision {
  archetype:         AlertArchetype;
  priority:          AlertPriority;
  intel_score:       number;
  evidence:          string[];
  title:             string;
  body:              string;
  consolidation_key: string;
  signal_count:      number;
  signals:           PersistableSovereignSignal[];
}

// ── Engine options ────────────────────────────────────────────

export interface AlertEngineOptions {
  /** Minimum intel score to emit a candidate (default: 20). */
  minIntelScore?:      number;
  /** Minimum USD to consider significant for volume bonuses (default: 10_000). */
  minSignificantUsd?:  number;
}

// ── Intelligence scoring constants ───────────────────────────

const SHADOW_BONUS    = 30;
const CLUSTER_BONUS   = 20;
const PRIVACY_BONUS   = 15;
const TOKEN2022_BONUS =  5;
const ENTITY_BONUS    = 10;
const VOLUME_BONUS_LG = 10;  // >= $1M
const VOLUME_BONUS_SM =  5;  // >= $100K

// ── Family archetype promotion thresholds ─────────────────────
// Conservative: family archetypes must clear these gates before
// classification. Keeps shadow_family_fan_out and
// shadow_gas_funding_chain rare and meaningful.
//
// Why conservative? Without runtime data we can't tune yet.
// These prevent noise while Block 27 validates actual coverage.

/** Minimum family confidence to promote to any family-specific archetype. */
const MIN_FAMILY_CONF_FOR_ARCHETYPE = 30;

/** Minimum member count for shadow_family_fan_out alert.
 *  Mirrors the FAN_OUT_THRESHOLD in shadow-continuity.ts (≥3 children).
 *  Set here explicitly so archetype is decoupled from the detector constant. */
const MIN_FAN_OUT_MEMBERS_FOR_ALERT = 3;

/** Minimum family confidence specifically for shadow_gas_funding_chain.
 *  Lower than fan-out threshold — gas topup is a single direct signal
 *  (less ambiguous than fan-out which could be benign multi-wallet use). */
const MIN_GAS_CHAIN_CONF_FOR_ALERT = 25;

// ── Helpers ───────────────────────────────────────────────────

function formatUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

function walletShort(addr: string | null): string {
  if (!addr) return 'unknown';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Intelligence scoring ──────────────────────────────────────

const FAMILY_BONUS_HIGH = 15;  // family confidence >= 55
const FAMILY_BONUS_MED  = 10;  // family confidence >= 35
const FAMILY_BONUS_LOW  =  5;  // any family membership

function scoreSignal(sig: PersistableSovereignSignal): number {
  let score = sig.signal_score;

  if (sig.has_shadow_link)           score += SHADOW_BONUS;
  if (sig.cluster_type)              score += CLUSTER_BONUS;
  if (sig.has_confidential_transfer) score += PRIVACY_BONUS;
  else if (sig.is_token_2022)        score += TOKEN2022_BONUS;

  if (sig.from_entity_verified || sig.to_entity_verified || sig.whale_entity_verified) {
    score += ENTITY_BONUS;
  }

  const usd = sig.amount_usd ?? 0;
  if (usd >= 1_000_000)    score += VOLUME_BONUS_LG;
  else if (usd >= 100_000) score += VOLUME_BONUS_SM;

  // Family lineage bonus — caps inside min(100, ...) below
  if (sig.shadow_family_id !== null) {
    const fc = sig.shadow_family_confidence ?? 0;
    if (fc >= 55)      score += FAMILY_BONUS_HIGH;
    else if (fc >= 35) score += FAMILY_BONUS_MED;
    else               score += FAMILY_BONUS_LOW;
  }

  return Math.min(100, score);
}

// ── Archetype classification ──────────────────────────────────
// Priority order: most specific / highest-moat first.

function classifyArchetype(
  sig: PersistableSovereignSignal,
  minSignificantUsd: number,
): AlertArchetype | null {
  // shadow_whale_inflow: shadow-linked + significant inflow
  if (
    sig.has_shadow_link &&
    sig.flow_direction === 'inflow' &&
    (sig.amount_usd ?? 0) >= minSignificantUsd
  ) return 'shadow_whale_inflow';

  // exchange_shadow_birth: shadow link + privacy architecture activated
  if (sig.has_shadow_link && sig.has_confidential_transfer) {
    return 'exchange_shadow_birth';
  }

  // privacy_token_activity: Token-2022 with confidential transfer or auditor key
  if (sig.has_confidential_transfer || (sig.is_token_2022 && sig.has_auditor_key)) {
    return 'privacy_token_activity';
  }

  // cluster_synchronized_flow: cluster member + significant flow
  if (sig.cluster_type && (sig.amount_usd ?? 0) >= minSignificantUsd) {
    return 'cluster_synchronized_flow';
  }

  // shadow_family_fan_out: family with ≥3 children, confidence gate, member count gate
  if (
    sig.shadow_family_id !== null &&
    sig.shadow_family_has_fan_out &&
    (sig.shadow_family_confidence ?? 0) >= MIN_FAMILY_CONF_FOR_ARCHETYPE &&
    (sig.shadow_family_total_members ?? 0) >= MIN_FAN_OUT_MEMBERS_FOR_ALERT
  ) {
    return 'shadow_family_fan_out';
  }

  // shadow_gas_funding_chain: gas-funding lineage with confidence gate
  if (
    sig.shadow_family_id !== null &&
    sig.shadow_family_has_gas_funding &&
    (sig.shadow_family_confidence ?? 0) >= MIN_GAS_CHAIN_CONF_FOR_ALERT
  ) {
    return 'shadow_gas_funding_chain';
  }

  // sovereign_high_confidence: joiner-scored top tiers
  if (sig.signal_confidence === 'direct_proof' || sig.signal_confidence === 'strong_evidence') {
    return 'sovereign_high_confidence';
  }

  return null;
}

// ── Priority mapping ──────────────────────────────────────────

function toPriority(intel_score: number): AlertPriority {
  if (intel_score >= 80) return 'critical';
  if (intel_score >= 60) return 'high';
  if (intel_score >= 40) return 'medium';
  return 'low';
}

// ── Consolidation key ─────────────────────────────────────────

function toConsolidationKey(archetype: AlertArchetype, sig: PersistableSovereignSignal): string {
  switch (archetype) {
    case 'shadow_whale_inflow':
    case 'exchange_shadow_birth':
      return `${archetype}::${sig.shadow_source_exchange ?? 'unknown'}`;
    case 'privacy_token_activity':
      return `${archetype}::${sig.token_mint ?? 'unknown'}`;
    case 'cluster_synchronized_flow':
      return `${archetype}::${sig.cluster_type ?? 'unknown'}`;
    case 'shadow_family_fan_out':
    case 'shadow_gas_funding_chain':
      return `${archetype}::${sig.shadow_family_id ?? 'unknown'}`;
    case 'sovereign_high_confidence':
      return `${archetype}::${sig.signal_confidence}`;
  }
}

// ── Family narrative formatter ────────────────────────────────
// Generates intelligence-grade, hedged family context paragraph.
// Does NOT overclaim — confidence tier drives the certainty phrase.

function formatFamilyNarrative(sig: PersistableSovereignSignal): string {
  const tier     = sig.shadow_family_confidence_tier ?? 'unknown';
  const exchange = sig.shadow_family_source_exchange ?? 'unknown exchange';
  const members  = sig.shadow_family_total_members   ?? 0;
  const hopDepth = sig.shadow_family_hop_depth       ?? 1;
  const conf     = sig.shadow_family_confidence      ?? 0;

  // First continuity reason (most informative single-line context)
  const topReason = sig.shadow_family_continuity_reasons[0] ?? null;

  // Behavioral facets observed in the family
  const facets: string[] = [];
  if (sig.shadow_family_has_gas_funding)          facets.push('gas-funding');
  if (sig.shadow_family_has_fan_out)              facets.push('fan-out');
  if (sig.shadow_family_has_fan_in)               facets.push('fan-in convergence');
  if (sig.shadow_family_has_temporal_correlation) facets.push('machine-like timing');
  if (sig.shadow_family_has_privacy_activation)   facets.push('downstream privacy activation');
  if (sig.shadow_family_has_token2022_activity)   facets.push('Token-2022 activity');

  // Certainty phrasing — never overclaims below strong_evidence
  const certainty =
    tier === 'direct_proof'      ? 'confirmed'                         :
    tier === 'strong_evidence'   ? 'strong evidence of'                :
    tier === 'moderate_evidence' ? 'behavioral indicators consistent with' :
    'weak association with';  // weak_association or unknown

  const memberStr  = `${members} wallet${members !== 1 ? 's' : ''}`;
  const facetStr   = facets.length > 0 ? ` Behavioral signals: ${facets.join(', ')}.` : '';
  const reasonStr  = topReason ? ` Continuity: ${topReason}.` : '';

  return (
    `Family lineage: ${certainty} ${exchange}-anchored shadow family ` +
    `(${memberStr}, hop depth ${hopDepth}, conf=${conf}, tier=${tier}).` +
    reasonStr + facetStr
  );
}

// ── Alert content builder ─────────────────────────────────────

function buildAlertContent(
  archetype: AlertArchetype,
  sig:       PersistableSovereignSignal,
  evidence:  string[],
): { title: string; body: string } {
  const amtStr = sig.amount_usd
    ? formatUsd(sig.amount_usd)
    : sig.amount_token
      ? `${sig.amount_token.toFixed(2)} tokens`
      : 'unknown amount';

  const from = sig.from_entity_name ?? walletShort(sig.from_address);
  const to   = sig.to_entity_name   ?? walletShort(sig.to_address);
  const exch = sig.shadow_source_exchange ?? sig.exchange ?? 'Unknown exchange';
  const ev3  = evidence.slice(0, 3).join('; ') || 'on-chain pattern match';

  switch (archetype) {
    case 'shadow_whale_inflow':
      return {
        title: `Shadow-Linked Whale Inflow — ${amtStr}`,
        body:
          `${amtStr} inflow to wallet with confirmed ${exch} shadow link. ` +
          `Shadow confidence: ${sig.shadow_confidence ?? 0}. ` +
          `Linkage: ${sig.shadow_linkage_reason ?? 'CEX origin traced'}. ` +
          `Evidence: ${ev3}.`,
      };

    case 'exchange_shadow_birth':
      return {
        title: `Exchange Shadow Birth — ${exch} Origin`,
        body:
          `Wallet with ${exch} shadow lineage activated confidential transfer. ` +
          `Shadow confidence: ${sig.shadow_confidence ?? 0}. ` +
          `Exchange-funded wallet later enabled privacy architecture. ` +
          `Evidence: ${ev3}.`,
      };

    case 'privacy_token_activity': {
      const tokenId = sig.token_symbol ?? (sig.token_mint ? sig.token_mint.slice(0, 8) + '…' : 'Token-2022');
      return {
        title: `Privacy Token Activity — ${tokenId}`,
        body:
          `${amtStr} moved via Token-2022 with confidential transfer enabled. ` +
          `Token: ${sig.token_symbol ?? sig.token_mint ?? 'unknown'}. ` +
          `Security flags: ${sig.token_risk_flags.join(', ') || 'none'}. ` +
          `Fog-piercing: ${sig.fog_piercing_notes.slice(0, 2).join('; ') || 'none'}.`,
      };
    }

    case 'cluster_synchronized_flow':
      return {
        title: `Cluster Synchronized Flow — ${sig.cluster_type ?? 'Cluster'}`,
        body:
          `${amtStr} flow by wallet in ${sig.cluster_type ?? 'active'} cluster ` +
          `(${sig.cluster_name ?? sig.cluster_id ?? 'cluster'}). ` +
          `${from} → ${to}. ` +
          `Sovereign confidence: ${sig.signal_confidence}.`,
      };

    case 'shadow_family_fan_out': {
      const members  = sig.shadow_family_total_members ?? '?';
      const familyEx = sig.shadow_family_source_exchange ?? exch;
      const narrative = formatFamilyNarrative(sig);
      return {
        title: `Shadow Family Fan-Out — ${members} Members via ${familyEx}`,
        body:
          `Fan-out detected: wallet is part of a multi-wallet shadow family funded by ${familyEx}. ` +
          `${amtStr} flow ${from} → ${to}. ` +
          `${narrative} ` +
          `Evidence: ${ev3}.`,
      };
    }

    case 'shadow_gas_funding_chain': {
      const familyEx2 = sig.shadow_family_source_exchange ?? exch;
      const narrative = formatFamilyNarrative(sig);
      return {
        title: `Shadow Gas-Funding Chain — ${familyEx2} Origin`,
        body:
          `Gas-funding chain detected: this wallet received a small SOL topup from an ${familyEx2}-anchored root. ` +
          `${amtStr} subsequent flow ${from} → ${to}. ` +
          `${narrative} ` +
          `Evidence: ${ev3}.`,
      };
    }

    case 'sovereign_high_confidence':
    default:
      return {
        title: `Sovereign High-Confidence Signal — ${sig.signal_confidence}`,
        body:
          `${amtStr} flow with ${sig.signal_confidence} confidence. ` +
          `${from} → ${to}. ` +
          `Attribution: ${sig.attribution_reason}. ` +
          `Evidence: ${ev3}.`,
      };
  }
}

// ── Public: evaluateSignalsForAlerts ─────────────────────────

/**
 * Pure evaluator: classify and score signals, suppress known-recent keys.
 * Returns unsorted, unconsolidated candidates — call consolidateAlerts() next.
 */
export function evaluateSignalsForAlerts(
  signals:    ReadonlyArray<PersistableSovereignSignal>,
  recentKeys: ReadonlySet<string>,
  options:    AlertEngineOptions = {},
): SovereignAlertCandidate[] {
  const minIntelScore   = options.minIntelScore    ?? 20;
  const minSigUsd       = options.minSignificantUsd ?? 10_000;

  const candidates: SovereignAlertCandidate[] = [];

  for (const sig of signals) {
    const archetype = classifyArchetype(sig, minSigUsd);
    if (!archetype) continue;

    const intel_score = scoreSignal(sig);
    if (intel_score < minIntelScore) continue;

    const consolidation_key = toConsolidationKey(archetype, sig);
    if (recentKeys.has(consolidation_key)) continue;

    const evidence = [...sig.evidence];
    for (const note of sig.fog_piercing_notes.slice(0, 2)) {
      if (!evidence.includes(note)) evidence.push(note);
    }

    const { title, body } = buildAlertContent(archetype, sig, evidence);

    candidates.push({
      archetype,
      priority: toPriority(intel_score),
      signal: sig,
      intel_score,
      evidence,
      title,
      body,
      consolidation_key,
    });
  }

  return candidates;
}

// ── Public: consolidateAlerts ─────────────────────────────────

/**
 * Group candidates by consolidation_key; highest intel_score leads each group.
 * Returns decisions sorted by intel_score descending.
 */
export function consolidateAlerts(
  candidates: SovereignAlertCandidate[],
): SovereignAlertDecision[] {
  const byKey = new Map<string, SovereignAlertCandidate[]>();

  for (const c of candidates) {
    const group = byKey.get(c.consolidation_key) ?? [];
    group.push(c);
    byKey.set(c.consolidation_key, group);
  }

  const decisions: SovereignAlertDecision[] = [];

  for (const group of byKey.values()) {
    group.sort((a, b) => b.intel_score - a.intel_score);
    const lead = group[0];

    const allEvidence = [...new Set(group.flatMap(c => c.evidence))];
    const body = group.length > 1
      ? `${lead.body} [+${group.length - 1} similar signal(s) consolidated]`
      : lead.body;

    decisions.push({
      archetype:         lead.archetype,
      priority:          lead.priority,
      intel_score:       lead.intel_score,
      evidence:          allEvidence.slice(0, 10),
      title:             lead.title,
      body,
      consolidation_key: lead.consolidation_key,
      signal_count:      group.length,
      signals:           group.map(c => c.signal),
    });
  }

  decisions.sort((a, b) => b.intel_score - a.intel_score);
  return decisions;
}

// ── Public: decisionToAlertInsert ─────────────────────────────

/** Map a SovereignAlertDecision to the existing AlertInsert shape for DB persistence. */
export function decisionToAlertInsert(decision: SovereignAlertDecision): AlertInsert {
  const priorityToSeverity: Record<AlertPriority, AlertSeverity> = {
    critical: 'major',
    high:     'significant',
    medium:   'notable',
    low:      'info',
  };

  const archetypeToAlertType: Record<AlertArchetype, AlertType> = {
    shadow_whale_inflow:       'shadow_whale_inflow',
    exchange_shadow_birth:     'exchange_shadow_birth',
    privacy_token_activity:    'privacy_token_activity',
    cluster_synchronized_flow: 'cluster_synchronized_flow',
    sovereign_high_confidence: 'sovereign_high_confidence',
    shadow_family_fan_out:     'shadow_family_fan_out',
    shadow_gas_funding_chain:  'shadow_gas_funding_chain',
  };

  return {
    alert_type:             archetypeToAlertType[decision.archetype],
    severity:               priorityToSeverity[decision.priority],
    title:                  decision.title,
    body:                   decision.body,
    data: {
      intel_score:          decision.intel_score,
      signal_count:         decision.signal_count,
      consolidation_key:    decision.consolidation_key,
      evidence:             decision.evidence,
      archetype:            decision.archetype,
    },
    ai_analysis:            null,
    movement_ids:           null,
    sent_telegram_free:     false,
    sent_telegram_premium:  false,
    sent_at:                null,
  };
}
