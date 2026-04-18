// ============================================================
// SONAR v2.0 — Helius Enhanced Transaction → Movement Classifier
// ============================================================
// Takes a raw Helius enhanced transaction payload and returns a
// classified movement for persistence, or null if below threshold
// or not relevant.
//
// Movement type decision tree:
//   from/to is exchange  → exchange_deposit / exchange_withdrawal
//   from/to is staking   → stake / unstake
//   from/to is defi      → defi_deposit / defi_withdrawal
//   large SOL transfer between non-classified addresses → whale_transfer
//   else                 → null (skip)
// ============================================================

import { lookupAddress, getKnownAddressMap } from '@/lib/helius/known-addresses';
import { FLOW_THRESHOLDS, SOL_NATIVE_MINT, USDC_MINT, USDT_MINT } from '@/lib/utils/constants';
import { SOL_PRICE_FALLBACK_USD } from '@/lib/helius/sol-price-cache';
import type { FlowType, FlowDirection } from '@/lib/supabase/types';

// ── Helius enhanced transaction shape (relevant fields only) ──

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount:   string;
  amount:          number; // lamports for SOL, raw units for tokens
}

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount:   string;
  mint:            string;
  tokenAmount:     number;
}

export interface HeliusEnhancedTx {
  signature:        string;
  timestamp:        number;            // Unix seconds
  type:             string;            // 'TRANSFER' | 'SWAP' | ...
  source:           string;            // 'SYSTEM_PROGRAM' | 'RAYDIUM' | ...
  fee:              number;
  feePayer:         string;
  nativeTransfers:  HeliusNativeTransfer[];
  tokenTransfers:   HeliusTokenTransfer[];
  accountData?:     unknown[];
  events?:          Record<string, unknown>;
}

// ── Parsed movement result ─────────────────────────────────────

export interface ParsedMovement {
  signature:      string;
  from_address:   string;
  to_address:     string;
  from_label:     string | null;
  to_label:       string | null;
  whale_id:       null;          // resolved later by pipeline
  token:          string;        // 'SOL' | 'USDC' | mint address
  amount_token:   number;
  amount_usd:     number | null; // null until price-enriched
  flow_type:      FlowType;
  flow_direction: FlowDirection;
  exchange:       string | null;
  protocol:       string | null;
  block_time:     string;        // ISO timestamp
}

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_DECIMALS     = 9;
const USDC_DECIMALS    = 6;

// SOL_PRICE_FALLBACK_USD is imported from sol-price-cache.ts.
// parseMovement() accepts solPriceUsd as an optional parameter — callers
// should supply a fresh price via getCachedSolPrice(); the fallback is used
// only when no price is provided (e.g. in unit tests or first cold start).

// ── Helpers ───────────────────────────────────────────────────

function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

function rawToToken(rawAmount: number, decimals: number): number {
  return rawAmount / Math.pow(10, decimals);
}

function isoFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

// Pick the dominant SOL native transfer in a transaction —
// the largest one by amount, filtered to exclude dust/fee moves.
function dominantNativeTransfer(
  transfers: HeliusNativeTransfer[],
  minLamports: number,
): HeliusNativeTransfer | null {
  const relevant = transfers.filter(
    (t) => t.amount >= minLamports && t.fromUserAccount && t.toUserAccount,
  );
  if (relevant.length === 0) return null;
  return relevant.reduce((max, t) => (t.amount > max.amount ? t : max));
}

// Pick the dominant stablecoin (USDC/USDT) token transfer.
function dominantStableTransfer(
  transfers: HeliusTokenTransfer[],
  minRaw: number,
): HeliusTokenTransfer | null {
  const relevant = transfers.filter(
    (t) =>
      (t.mint === USDC_MINT || t.mint === USDT_MINT) &&
      t.tokenAmount >= minRaw &&
      t.fromUserAccount &&
      t.toUserAccount,
  );
  if (relevant.length === 0) return null;
  return relevant.reduce((max, t) => (t.tokenAmount > max.tokenAmount ? t : max));
}

// ── classify ──────────────────────────────────────────────────

/**
 * Classify a single Helius enhanced transaction into a ParsedMovement.
 * Returns null if the transaction is not relevant (below threshold,
 * wallet-to-self, or unclassifiable).
 *
 * @param tx       Raw Helius enhanced transaction payload
 * @param knownWhalAddresses  Set of whale addresses currently tracked
 */
export function parseMovement(
  tx:                   HeliusEnhancedTx,
  knownWhaleAddresses?: Set<string>,
  /** Live SOL price in USD. Supply via getCachedSolPrice(); falls back to compile-time constant. */
  solPriceUsd:          number = SOL_PRICE_FALLBACK_USD,
): ParsedMovement | null {
  // Minimum lamports for a native transfer to be considered
  const minSolUsd   = FLOW_THRESHOLDS.min_movement_usd;
  const minLamports = Math.ceil((minSolUsd / solPriceUsd) * LAMPORTS_PER_SOL);
  const minUsdcRaw  = minSolUsd * Math.pow(10, USDC_DECIMALS);

  const blockTime = isoFromUnix(tx.timestamp);

  // ── 1. Try to find a dominant SOL native transfer ──────────
  const nativeTx = dominantNativeTransfer(tx.nativeTransfers ?? [], minLamports);
  if (nativeTx) {
    return classifyTransfer({
      signature: tx.signature,
      from:      nativeTx.fromUserAccount,
      to:        nativeTx.toUserAccount,
      token:     'SOL',
      amount:    lamportsToSol(nativeTx.amount),
      amountUsd: lamportsToSol(nativeTx.amount) * solPriceUsd,
      blockTime,
      knownWhaleAddresses,
    });
  }

  // ── 2. Try to find a dominant stablecoin transfer ──────────
  const stableTx = dominantStableTransfer(tx.tokenTransfers ?? [], minUsdcRaw);
  if (stableTx) {
    const decimals  = stableTx.mint === USDC_MINT ? USDC_DECIMALS : USDC_DECIMALS; // USDT also 6
    const amtToken  = rawToToken(stableTx.tokenAmount, decimals);
    const amtUsd    = amtToken; // 1:1 peg assumption

    return classifyTransfer({
      signature: tx.signature,
      from:      stableTx.fromUserAccount,
      to:        stableTx.toUserAccount,
      token:     stableTx.mint === USDC_MINT ? 'USDC' : 'USDT',
      amount:    amtToken,
      amountUsd: amtUsd,
      blockTime,
      knownWhaleAddresses,
    });
  }

  // ── 3. SWAP / DEX fallback ─────────────────────────────────
  // For SWAP-type transactions where there is no dominant native SOL
  // transfer (e.g. the SOL goes to a pool account, not directly to
  // a known DEX program address), use feePayer + source to classify.
  // This ensures pump.fun and aggregator swaps are captured even when
  // the SOL transfer is split across many pool accounts.
  if (tx.type === 'SWAP' || tx.type === 'ADD_LIQUIDITY' || tx.type === 'WITHDRAW_LIQUIDITY') {
    const feePayer    = tx.feePayer;
    const sourceUpper = (tx.source ?? '').toUpperCase();

    // Map Helius source field to a known-address lookup key
    const sourceToAddress: Record<string, string> = {
      'RAYDIUM':        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
      'ORCA':           'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      'METEORA':        'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      'PHOENIX':        'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',
      'PUMP_FUN':       '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'PUMPFUN':        '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'JUPITER':        'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
    };

    // Try to match source to a known DEX address
    const knownAddrMap = getKnownAddressMap();
    let dexAddress: string | null = null;

    // 1. Try direct source-field mapping
    const mappedAddr = sourceToAddress[sourceUpper];
    if (mappedAddr && knownAddrMap.has(mappedAddr)) {
      dexAddress = mappedAddr;
    }

    // 2. Fallback: look for any known-defi address in nativeTransfers
    if (!dexAddress) {
      for (const nt of tx.nativeTransfers ?? []) {
        if (knownAddrMap.get(nt.toUserAccount)?.category === 'defi') {
          dexAddress = nt.toUserAccount;
          break;
        }
        if (knownAddrMap.get(nt.fromUserAccount)?.category === 'defi') {
          dexAddress = nt.fromUserAccount;
          break;
        }
      }
    }

    if (dexAddress && feePayer && (knownWhaleAddresses?.has(feePayer) ?? false)) {
      // Sum all native SOL transfers involving feePayer to estimate swap size
      const totalLamports = (tx.nativeTransfers ?? [])
        .filter((nt) => nt.fromUserAccount === feePayer)
        .reduce((sum, nt) => sum + nt.amount, 0);

      const solAmt    = lamportsToSol(Math.max(totalLamports, tx.fee ?? 0));
      const amountUsd = solAmt * solPriceUsd;

      // Only record if above threshold
      if (amountUsd >= FLOW_THRESHOLDS.min_movement_usd) {
        return classifyTransfer({
          signature: tx.signature,
          from:      feePayer,
          to:        dexAddress,
          token:     'SOL',
          amount:    solAmt,
          amountUsd,
          blockTime,
          knownWhaleAddresses,
        });
      }
    }
  }

  return null;
}

// ── classify a single transfer by from/to ────────────────────

export interface TransferClassifyInput {
  signature:           string;
  from:                string;
  to:                  string;
  token:               string;
  amount:              number;
  amountUsd:           number;
  blockTime:           string;
  knownWhaleAddresses?: Set<string>;
}

export function classifyTransfer(input: TransferClassifyInput): ParsedMovement | null {
  const { signature, from, to, token, amount, amountUsd, blockTime, knownWhaleAddresses } = input;

  // Skip wallet-to-self (e.g. wrap/unwrap)
  if (from === to) return null;

  const fromInfo = lookupAddress(from);
  const toInfo   = lookupAddress(to);

  const isFromKnown = fromInfo !== null;
  const isToKnown   = toInfo   !== null;

  const isFromWhale = knownWhaleAddresses?.has(from) ?? false;
  const isToWhale   = knownWhaleAddresses?.has(to)   ?? false;

  // Must involve at least one known address OR be a whale move
  if (!isFromKnown && !isToKnown && !isFromWhale && !isToWhale) {
    return null;
  }

  let flow_type:      FlowType;
  let flow_direction: FlowDirection;
  let exchange:       string | null = null;
  let protocol:       string | null = null;

  // ── Exchange flows ────────────────────────────────────────
  if (toInfo?.category === 'exchange') {
    flow_type      = 'exchange_deposit';
    flow_direction = 'inflow';
    exchange       = toInfo.sub_category;
  } else if (fromInfo?.category === 'exchange') {
    flow_type      = 'exchange_withdrawal';
    flow_direction = 'outflow';
    exchange       = fromInfo.sub_category;
  }

  // ── Staking flows ─────────────────────────────────────────
  else if (toInfo?.category === 'staking') {
    flow_type      = 'stake';
    flow_direction = 'inflow';
    protocol       = toInfo.sub_category;
  } else if (fromInfo?.category === 'staking') {
    flow_type      = 'unstake';
    flow_direction = 'outflow';
    protocol       = fromInfo.sub_category;
  }

  // ── DeFi flows ────────────────────────────────────────────
  else if (toInfo?.category === 'defi') {
    flow_type      = 'defi_deposit';
    flow_direction = 'inflow';
    protocol       = toInfo.sub_category;
  } else if (fromInfo?.category === 'defi') {
    flow_type      = 'defi_withdrawal';
    flow_direction = 'outflow';
    protocol       = fromInfo.sub_category;
  }

  // ── Bridge flows ──────────────────────────────────────────
  else if (toInfo?.category === 'bridge') {
    flow_type      = 'bridge_in';
    flow_direction = 'inflow';
    protocol       = toInfo.sub_category;
  } else if (fromInfo?.category === 'bridge') {
    flow_type      = 'bridge_out';
    flow_direction = 'outflow';
    protocol       = fromInfo.sub_category;
  }

  // ── Whale transfers (large moves between unknown addresses) ─
  else if (isFromWhale || isToWhale) {
    flow_type      = 'whale_transfer';
    flow_direction = 'internal';
  }

  // ── Unclassifiable (shouldn't reach here given guards above)
  else {
    return null;
  }

  return {
    signature,
    from_address:   from,
    to_address:     to,
    from_label:     fromInfo?.label ?? null,
    to_label:       toInfo?.label ?? null,
    whale_id:       null,
    token,
    amount_token:   amount,
    amount_usd:     amountUsd,
    flow_type,
    flow_direction,
    exchange,
    protocol,
    block_time:     blockTime,
  };
}
