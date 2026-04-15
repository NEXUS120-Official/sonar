// ============================================================
// SONAR v2.0 — Token Movement Parser
// ============================================================
// Extracts SPL token buy/sell/LP information from Helius
// enhanced SWAP / ADD_LIQUIDITY / WITHDRAW_LIQUIDITY transactions.
//
// Complements parse-movement.ts which tracks SOL/USDC flows.
// This module tracks WHICH token a whale bought or sold.
// ============================================================

import { lookupAddress } from '@/lib/helius/known-addresses';
import { SOL_NATIVE_MINT, USDC_MINT, USDT_MINT } from '@/lib/utils/constants';
import { SOL_PRICE_FALLBACK_USD } from '@/lib/helius/sol-price-cache';
import type { TokenMovementAction } from '@/lib/supabase/types';
import type { HeliusEnhancedTx } from '@/lib/helius/parse-movement';

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;

// Mints that are SOL-equivalent or stablecoins — not "the token" being traded
const IGNORED_MINTS = new Set([
  SOL_NATIVE_MINT,
  'So11111111111111111111111111111111111111111', // wrapped SOL variant
  USDC_MINT,
  USDT_MINT,
]);

// ── Result type ────────────────────────────────────────────────

export interface ParsedTokenMovement {
  movement_id:     null;   // resolved by webhook handler after movement upsert
  whale_id:        null;   // resolved by webhook handler
  signature:       string;
  block_time:      string;
  token_mint:      string;
  token_symbol:    null;   // enriched later
  token_name:      null;   // enriched later
  action:          TokenMovementAction;
  amount_token:    number | null;
  amount_sol:      number | null;
  amount_usd:      number | null;
  price_per_token: number | null;
  protocol:        string | null;
  pool_address:    null;   // enriched later
  is_new_token:    false;
}

// ── Helpers ───────────────────────────────────────────────────

function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

function isoFromUnix(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString();
}

/** Derive protocol sub_category from Helius source field or known-address lookup. */
function resolveProtocol(tx: HeliusEnhancedTx): string | null {
  // Helius source field (e.g. 'RAYDIUM', 'ORCA', 'PUMP_FUN', 'JUPITER', etc.)
  const sourceUpper = (tx.source ?? '').toUpperCase();

  const sourceMap: Record<string, string> = {
    'RAYDIUM':  'raydium_v4',
    'ORCA':     'orca_whirlpool',
    'METEORA':  'meteora_dlmm',
    'PHOENIX':  'phoenix',
    'PUMP_FUN': 'pumpfun',
    'PUMPFUN':  'pumpfun',
    'JUPITER':  'jupiter',
  };

  if (sourceMap[sourceUpper]) return sourceMap[sourceUpper];

  // Fallback: check nativeTransfers for a known-defi address
  for (const nt of tx.nativeTransfers ?? []) {
    const toInfo = lookupAddress(nt.toUserAccount);
    if (toInfo?.category === 'defi') return toInfo.sub_category;
    const fromInfo = lookupAddress(nt.fromUserAccount);
    if (fromInfo?.category === 'defi') return fromInfo.sub_category;
  }

  return null;
}

// ── Main export ────────────────────────────────────────────────

/**
 * Extract token-level swap information from a Helius enhanced transaction.
 *
 * Returns null if:
 * - Transaction type is not SWAP / ADD_LIQUIDITY / WITHDRAW_LIQUIDITY
 * - No relevant SPL token transfer found
 * - Whale address is not in whaleAddressSet
 */
export function parseTokenMovement(
  tx:               HeliusEnhancedTx,
  whaleAddressSet:  Set<string>,
  solPriceUsd:      number = SOL_PRICE_FALLBACK_USD,
): ParsedTokenMovement | null {
  const { type, signature, timestamp } = tx;

  // Only handle SWAP-category transactions
  if (
    type !== 'SWAP' &&
    type !== 'ADD_LIQUIDITY' &&
    type !== 'WITHDRAW_LIQUIDITY'
  ) {
    return null;
  }

  const blockTime = isoFromUnix(timestamp);

  // Determine action from type
  let baseAction: TokenMovementAction;
  if (type === 'ADD_LIQUIDITY')       baseAction = 'add_liquidity';
  else if (type === 'WITHDRAW_LIQUIDITY') baseAction = 'remove_liquidity';
  else baseAction = 'buy'; // refined below for SWAP

  // ── Find the SPL token transfer for the whale ──────────────
  // For a SWAP, we look for a token transfer to or from the whale
  // that is NOT a stablecoin or SOL-equivalent.

  // Collect all tokenTransfers involving a tracked whale
  const relevant = (tx.tokenTransfers ?? []).filter(
    (tt) =>
      !IGNORED_MINTS.has(tt.mint) &&
      (whaleAddressSet.has(tt.fromUserAccount) || whaleAddressSet.has(tt.toUserAccount)) &&
      tt.tokenAmount > 0,
  );

  if (relevant.length === 0) return null;

  // Pick the largest token transfer (by raw amount) as the primary token
  const primary = relevant.reduce((max, t) =>
    t.tokenAmount > max.tokenAmount ? t : max,
  );

  // Determine whale address involved
  const whaleIsFrom = whaleAddressSet.has(primary.fromUserAccount);
  const whaleIsTo   = whaleAddressSet.has(primary.toUserAccount);

  if (!whaleIsFrom && !whaleIsTo) return null;

  // For SWAP: whale receiving token = buy; whale sending token = sell
  let action: TokenMovementAction = baseAction;
  if (type === 'SWAP') {
    action = whaleIsTo ? 'buy' : 'sell';
  }

  // ── Estimate SOL amount ────────────────────────────────────
  // Sum all native SOL transfers from or to the whale
  const whaleAddr = whaleIsFrom ? primary.fromUserAccount : primary.toUserAccount;

  const solNativeTransfers = (tx.nativeTransfers ?? []).filter(
    (nt) => nt.fromUserAccount === whaleAddr || nt.toUserAccount === whaleAddr,
  );

  // Net SOL out of whale (positive = whale spent SOL)
  let netSolLamports = 0;
  for (const nt of solNativeTransfers) {
    if (nt.fromUserAccount === whaleAddr) netSolLamports += nt.amount;
    if (nt.toUserAccount   === whaleAddr) netSolLamports -= nt.amount;
  }

  const amountSol = Math.abs(lamportsToSol(netSolLamports));
  const amountUsd = amountSol > 0 ? amountSol * solPriceUsd : null;

  const amountToken    = primary.tokenAmount > 0 ? primary.tokenAmount : null;
  const pricePerToken  = amountUsd && amountToken && amountToken > 0
    ? amountUsd / amountToken
    : null;

  const protocol = resolveProtocol(tx);

  return {
    movement_id:     null,
    whale_id:        null,
    signature,
    block_time:      blockTime,
    token_mint:      primary.mint,
    token_symbol:    null,
    token_name:      null,
    action,
    amount_token:    amountToken,
    amount_sol:      amountSol > 0 ? amountSol : null,
    amount_usd:      amountUsd,
    price_per_token: pricePerToken,
    protocol,
    pool_address:    null,
    is_new_token:    false,
  };
}
