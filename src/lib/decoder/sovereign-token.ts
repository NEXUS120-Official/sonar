// ============================================================
// SONAR — Sovereign Token Movement Decoder
// ============================================================
// Decodes SPL token movements from native Solana RPC
// getTransaction payloads (SolanaTransactionResult).
//
// Strategy:
//   Build per-owner, per-mint token balance deltas from
//   meta.preTokenBalances / meta.postTokenBalances.
//   For each non-ignored mint, find the whale-owned delta.
//   The dominant delta (largest absolute token amount) becomes
//   the primary token movement.
//
//   SOL amount is estimated from meta.preBalances / postBalances
//   using the same delta extraction as decodeSovereignMovement.
//
// Action classification:
//   whale delta > 0 → received token → 'buy'
//   whale delta < 0 → sent token    → 'sell'
//   add_liquidity / remove_liquidity deferred (require instruction decode)
//
// Returns null when:
//   - meta absent or tx failed
//   - no non-ignored mint has a whale-owned delta
//   - all token balance entries have null owner (program-owned accounts)
//
// Intentionally deferred:
//   - protocol identification (no Helius source field)
//   - pool_address (requires instruction decode)
//   - add_liquidity / remove_liquidity action discrimination
// ============================================================

import { SOL_PRICE_FALLBACK_USD }        from '@/lib/helius/sol-price-cache';
import { SOL_NATIVE_MINT, USDC_MINT, USDT_MINT } from '@/lib/utils/constants';
import type { ParsedTokenMovement }      from '@/lib/helius/parse-token-movement';
import type { SolanaTransactionResult }  from '@/lib/sovereign/rpc-client';
import type { TokenMovementAction }      from '@/lib/supabase/types';
import {
  programIdToTokenProgram,
  buildEmptyRegistry,
  TOKEN_PROGRAM_2022,
  type TokenProgramType,
  type SovereignTokenRegistry,
} from '@/lib/sovereign/token-registry';

const LAMPORTS_PER_SOL = 1_000_000_000;

// Mints excluded from token movement decoding — same set as Helius decoder.
// We track SOL and stablecoins separately via decodeSovereignMovement.
const IGNORED_MINTS = new Set([
  SOL_NATIVE_MINT,
  'So11111111111111111111111111111111111111111', // alternative wrapped-SOL address
  USDC_MINT,
  USDT_MINT,
]);

// ── Token delta analysis types (28A/28B/28C) ─────────────────

/**
 * Transaction-level classification of how tokens flowed in this tx.
 * Derived from raw balance deltas across ALL accounts — not just whale-owned.
 *
 * symmetric_transfer:  |sent| ≈ |received| — clean single-leg transfer
 * asymmetric_transfer: |sent| > |received| by > ASYMMETRY_THRESHOLD — unaccounted tokens
 * fee_sink_visible:    asymmetric + a small separate account received tokens (fee collector)
 * multi_leg:           ≥2 whale-owned accounts had non-zero deltas for this mint
 * unknown:             insufficient token balance data
 */
export type TokenDeltaPattern =
  | 'symmetric_transfer'
  | 'asymmetric_transfer'
  | 'fee_sink_visible'
  | 'multi_leg'
  | 'unknown';

/**
 * On-chain token delta intelligence for a single transaction.
 * Produced by analyzeSovereignTokenDelta() — pure, deterministic, replay-safe.
 * Carries first-class token_program_type (not buried in the protocol field).
 */
export interface TokenDeltaAnalysis {
  /** Which token program owns this mint's accounts — authoritative from on-chain programId. */
  token_program_type:      TokenProgramType;
  /** Transaction-level delta classification. */
  delta_pattern:           TokenDeltaPattern;
  /** True when |sent| > |received| by more than ASYMMETRY_THRESHOLD. */
  has_asymmetric_delta:    boolean;
  /** True when asymmetry is consistent with transfer-fee extraction. */
  possible_transfer_fee:   boolean;
  /** True when a fee-sink-style address (tiny positive delta) was detected. */
  possible_fee_sink:       boolean;
  /** Absolute sum of all outbound token raw units for the primary mint. */
  total_sent_raw:          number;
  /** Absolute sum of all inbound token raw units for the primary mint. */
  total_received_raw:      number;
  /** total_sent_raw - total_received_raw (positive = unaccounted tokens). */
  net_discrepancy_raw:     number;
  /** net_discrepancy_raw / total_sent_raw × 100, rounded. 0 if nothing sent. */
  discrepancy_pct:         number;
  /** Number of whale-owned accounts with a non-zero delta for this mint. */
  whale_delta_count:       number;
  /** Fog-piercing evidence strings — honest, never overclaims hidden amounts. */
  evidence:                string[];
}

// ── Analysis constants ────────────────────────────────────────

/** Minimum relative discrepancy (%) to classify as asymmetric. Integer raw amounts
 *  have no floating-point noise, so even 0.05% is a real signal. */
const ASYMMETRY_THRESHOLD_PCT = 0.1;

/** Fee-sink: a non-whale account received tokens but less than this fraction of total
 *  outflow. Transfer-fee receivers are typically tiny relative to the transfer. */
const FEE_SINK_FRACTION = 0.05;  // 5% of total outflow

// ── Module-level helpers ──────────────────────────────────────

type MintOwnerMap = Map<string, Map<string, number>>; // mint → owner → total raw amount

function buildMintOwnerMap(
  balances: Array<{ mint?: string; owner?: string | null; uiTokenAmount: { amount: string } }> | null | undefined,
): MintOwnerMap {
  const m: MintOwnerMap = new Map();
  for (const tb of balances ?? []) {
    if (!tb.owner || !tb.mint) continue;
    if (!m.has(tb.mint)) m.set(tb.mint, new Map());
    const ownerMap = m.get(tb.mint)!;
    ownerMap.set(tb.owner, (ownerMap.get(tb.owner) ?? 0) + Number(tb.uiTokenAmount.amount));
  }
  return m;
}

function extractAccountKeys(tx: SolanaTransactionResult): string[] {
  const keys = tx.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return [];
  if (typeof keys[0] === 'string') return keys as string[];
  return (keys as Array<{ pubkey: string }>).map(k => k.pubkey);
}

// ── 28A+28B+28C: Token delta analysis ────────────────────────

/**
 * Analyze the token delta pattern for a specific mint in a transaction.
 *
 * Pure function — same inputs → same output. No DB, no network.
 * Must be called AFTER decodeSovereignTokenMovement() to know which
 * primaryMint to analyze.
 *
 * Fog-piercing doctrine: we detect structural signals (asymmetric flow,
 * fee-sink addresses, Token-2022 program) without fabricating hidden amounts.
 */
export function analyzeSovereignTokenDelta(
  raw:             unknown,
  primaryMint:     string,
  whaleAddressSet: Set<string>,
  registry:        SovereignTokenRegistry = buildEmptyRegistry(),
): TokenDeltaAnalysis | null {
  if (!raw || typeof raw !== 'object') return null;

  const tx = raw as SolanaTransactionResult;
  if (!tx.meta || tx.meta.err !== null) return null;

  const meta = tx.meta;

  // ── Detect token program type ──────────────────────────────────
  // Registry is authoritative; fall back to programId in balance entries.
  let tokenProgramType: TokenProgramType =
    registry.get(primaryMint)?.token_program ?? 'unknown';

  if (tokenProgramType === 'unknown') {
    const allBals = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])];
    for (const tb of allBals) {
      if (tb.mint === primaryMint) {
        const detected = programIdToTokenProgram(tb.programId);
        if (detected !== 'unknown') { tokenProgramType = detected; break; }
      }
    }
  }

  // ── Build full account-delta picture for primaryMint ──────────
  const preMintOwner  = buildMintOwnerMap(meta.preTokenBalances);
  const postMintOwner = buildMintOwnerMap(meta.postTokenBalances);

  const preOwners  = preMintOwner.get(primaryMint)  ?? new Map<string, number>();
  const postOwners = postMintOwner.get(primaryMint) ?? new Map<string, number>();
  const allOwners  = new Set([...preOwners.keys(), ...postOwners.keys()]);

  if (allOwners.size === 0) {
    return {
      token_program_type:   tokenProgramType,
      delta_pattern:        'unknown',
      has_asymmetric_delta: false,
      possible_transfer_fee: false,
      possible_fee_sink:    false,
      total_sent_raw:       0,
      total_received_raw:   0,
      net_discrepancy_raw:  0,
      discrepancy_pct:      0,
      whale_delta_count:    0,
      evidence:             [],
    };
  }

  // ── Compute aggregate deltas ───────────────────────────────────
  let totalSentRaw     = 0;
  let totalReceivedRaw = 0;
  let whaleDeltaCount  = 0;
  let feeSinkRaw:       number | null = null;

  for (const owner of allOwners) {
    const delta = (postOwners.get(owner) ?? 0) - (preOwners.get(owner) ?? 0);
    if (delta < 0) totalSentRaw     += Math.abs(delta);
    else if (delta > 0) totalReceivedRaw += delta;

    if (whaleAddressSet.has(owner) && delta !== 0) whaleDeltaCount++;
  }

  const netDiscrepancy = totalSentRaw - totalReceivedRaw;
  const discrepancyPct = totalSentRaw > 0
    ? Math.round((netDiscrepancy / totalSentRaw) * 10_000) / 100  // round to 2 dp
    : 0;

  // ── Detect fee sink ────────────────────────────────────────────
  // A non-whale account that received a small positive delta (< FEE_SINK_FRACTION
  // of total sent) could be a transfer-fee collector.
  if (totalSentRaw > 0) {
    const feeThreshold = totalSentRaw * FEE_SINK_FRACTION;
    for (const owner of allOwners) {
      if (whaleAddressSet.has(owner)) continue;
      const delta = (postOwners.get(owner) ?? 0) - (preOwners.get(owner) ?? 0);
      if (delta > 0 && delta < feeThreshold) {
        // Take the smallest non-whale positive delta as the fee-sink candidate
        if (feeSinkRaw === null || delta < feeSinkRaw) feeSinkRaw = delta;
      }
    }
  }

  const hasAsymmetric    = discrepancyPct > ASYMMETRY_THRESHOLD_PCT && totalSentRaw > 0;
  const possibleFee      = hasAsymmetric && (feeSinkRaw !== null || tokenProgramType === 'token_2022');
  const possibleFeeSink  = feeSinkRaw !== null;

  // ── Classify pattern ───────────────────────────────────────────
  let pattern: TokenDeltaPattern;
  if (whaleDeltaCount > 1) {
    pattern = 'multi_leg';
  } else if (possibleFeeSink && hasAsymmetric) {
    pattern = 'fee_sink_visible';
  } else if (hasAsymmetric) {
    pattern = 'asymmetric_transfer';
  } else {
    pattern = 'symmetric_transfer';
  }

  // ── Build evidence strings (honest, cautious phrasing) ────────
  const evidence: string[] = [];

  if (tokenProgramType === 'token_2022') {
    evidence.push('Token-2022 program detected via on-chain programId');
  }
  if (pattern === 'multi_leg') {
    evidence.push(`Multi-leg token movement: ${whaleDeltaCount} whale-owned accounts active for this mint`);
  }
  if (hasAsymmetric) {
    evidence.push(
      `Asymmetric token delta: ${discrepancyPct.toFixed(2)}% of outflow unaccounted for ` +
      `(${netDiscrepancy} raw units — consistent with transfer-fee behavior, not confirmed)`,
    );
  }
  if (possibleFeeSink) {
    evidence.push(
      `Possible fee-sink address: non-whale account received ${feeSinkRaw} raw units ` +
      `(${((feeSinkRaw! / totalSentRaw) * 100).toFixed(3)}% of total outflow — structural fee-sink signal)`,
    );
  }
  if (possibleFee && tokenProgramType !== 'token_2022') {
    evidence.push('Asymmetric delta on non-Token-2022 mint — possible custom transfer fee or multi-leg DEX routing');
  }

  return {
    token_program_type:    tokenProgramType,
    delta_pattern:         pattern,
    has_asymmetric_delta:  hasAsymmetric,
    possible_transfer_fee: possibleFee,
    possible_fee_sink:     possibleFeeSink,
    total_sent_raw:        totalSentRaw,
    total_received_raw:    totalReceivedRaw,
    net_discrepancy_raw:   netDiscrepancy,
    discrepancy_pct:       discrepancyPct,
    whale_delta_count:     whaleDeltaCount,
    evidence,
  };
}

/**
 * Decode an SPL token movement from a native Solana RPC getTransaction
 * payload.  Returns null if no whale-owned non-ignored token delta is found.
 *
 * @param raw             raw_json field from a sovereign_rpc row
 * @param whaleAddressSet set of currently-tracked whale addresses
 * @param solPriceUsd     current SOL price (USD) for amount_usd estimation
 * @param registry        immutable token registry snapshot; well-known-only used if omitted
 */
export function decodeSovereignTokenMovement(
  raw:             unknown,
  whaleAddressSet: Set<string>,
  solPriceUsd:     number = SOL_PRICE_FALLBACK_USD,
  registry:        SovereignTokenRegistry = buildEmptyRegistry(),
): ParsedTokenMovement | null {
  if (!raw || typeof raw !== 'object') return null;

  const tx = raw as SolanaTransactionResult;
  if (!tx.meta || tx.meta.err !== null) return null;

  const signature = tx.transaction?.signatures?.[0] ?? '';
  if (!signature) return null;

  const blockTime = tx.blockTime
    ? new Date(tx.blockTime * 1000).toISOString()
    : new Date(0).toISOString();

  const meta        = tx.meta;
  const accountKeys = extractAccountKeys(tx);

  // ── Build per-owner, per-mint raw-amount maps ─────────────────
  // raw amount = uiTokenAmount.amount (integer string, e.g. "1000000" for 1 USDC)
  // We sum across multiple token accounts owned by the same wallet+mint.
  // Uses module-level buildMintOwnerMap() — also called by analyzeSovereignTokenDelta().

  const preMintOwner  = buildMintOwnerMap(meta.preTokenBalances);
  const postMintOwner = buildMintOwnerMap(meta.postTokenBalances);

  // ── Collect all mints, filter to non-ignored ─────────────────
  const allMints = new Set([...preMintOwner.keys(), ...postMintOwner.keys()]);
  const relevantMints = [...allMints].filter(m => !IGNORED_MINTS.has(m));
  if (relevantMints.length === 0) return null;

  // ── Find whale-owned deltas ───────────────────────────────────

  interface WhaleDelta {
    mint:        string;
    owner:       string;
    rawDelta:    number;   // post - pre, raw integer units
    decimals:    number;
    amountToken: number;   // |rawDelta| / 10^decimals
  }

  const whaleDeltas: WhaleDelta[] = [];

  for (const mint of relevantMints) {
    const preOwners  = preMintOwner.get(mint)  ?? new Map<string, number>();
    const postOwners = postMintOwner.get(mint) ?? new Map<string, number>();
    const allOwners  = new Set([...preOwners.keys(), ...postOwners.keys()]);

    for (const owner of allOwners) {
      if (!whaleAddressSet.has(owner)) continue;

      const rawDelta = (postOwners.get(owner) ?? 0) - (preOwners.get(owner) ?? 0);
      if (rawDelta === 0) continue;

      // Resolve decimals: registry is authoritative (handles zero-balance edge cases);
      // fall back to the balance entry value, then 0.
      let decimals = registry.get(mint)?.decimals ?? null;
      if (decimals === null) {
        const allBals = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])];
        for (const tb of allBals) {
          if (tb.mint === mint && tb.owner === owner) {
            decimals = tb.uiTokenAmount.decimals;
            break;
          }
        }
        decimals = decimals ?? 0;
      }

      whaleDeltas.push({
        mint,
        owner,
        rawDelta,
        decimals,
        amountToken: Math.abs(rawDelta) / Math.pow(10, decimals),
      });
    }
  }

  if (whaleDeltas.length === 0) return null;

  // ── Select dominant delta (largest absolute token amount) ─────
  const primary = whaleDeltas.reduce((best, d) =>
    d.amountToken > best.amountToken ? d : best,
  );

  // ── Classify action ───────────────────────────────────────────
  // > 0 → whale received → buy; < 0 → whale sent → sell
  const action: TokenMovementAction = primary.rawDelta > 0 ? 'buy' : 'sell';

  // ── Estimate SOL amount from balance deltas ───────────────────
  // Whale's net SOL change, fee added back at index 0 (same as decodeSovereignMovement).
  const pre = meta.preBalances  ?? [];
  const post = meta.postBalances ?? [];
  const fee  = meta.fee ?? 0;

  let whaleSolDeltaLamports = 0;
  for (let i = 0; i < accountKeys.length; i++) {
    if (!whaleAddressSet.has(accountKeys[i])) continue;
    let d = (post[i] ?? 0) - (pre[i] ?? 0);
    if (i === 0) d += fee;
    whaleSolDeltaLamports += d;
  }

  const amountSol = Math.abs(whaleSolDeltaLamports) / LAMPORTS_PER_SOL;
  const amountUsd = amountSol > 0 ? amountSol * solPriceUsd : null;

  const pricePerToken = amountUsd && primary.amountToken > 0
    ? amountUsd / primary.amountToken
    : null;

  // ── Registry enrichment ───────────────────────────────────────
  const regEntry = registry.get(primary.mint);
  const tokenSymbol = regEntry?.symbol ?? null;
  const tokenName   = regEntry?.name   ?? null;

  // is_new_token: true when the mint is absent from the registry (first sighting).
  // Excludes well-known mints which are always present.
  const isNewToken = !registry.has(primary.mint);

  // Token-2022 detection: prefer registry; fall back to programId in balance entries.
  // If Token-2022 is detected and not yet in registry, note it via protocol field
  // so the Mint Enricher can prioritize enrichment of this mint.
  let isToken2022 = regEntry?.token_program === 'token_2022';
  if (!isToken2022) {
    const allBals = [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])];
    for (const tb of allBals) {
      if (tb.mint === primary.mint && tb.programId === TOKEN_PROGRAM_2022) {
        isToken2022 = true;
        break;
      }
    }
  }

  return {
    movement_id:     null,
    whale_id:        null,
    whale_address:   primary.owner,
    signature,
    block_time:      blockTime,
    token_mint:      primary.mint,
    token_symbol:    tokenSymbol,
    token_name:      tokenName,
    action,
    amount_token:    primary.amountToken > 0 ? primary.amountToken : null,
    amount_sol:      amountSol > 0 ? amountSol : null,
    amount_usd:      amountUsd,
    price_per_token: pricePerToken,
    // protocol carries a Token-2022 signal when detected but not yet registry-enriched.
    // The FlowJoiner (future block) will upgrade this to a full protocol attribution.
    protocol:        isToken2022 ? 'token_2022' : null,
    pool_address:    null,
    is_new_token:    isNewToken,
  };
}
