// ============================================================
// SONAR — Helius Transaction Parser (Solana)
// ============================================================
// Converts Helius enhanced transaction objects into our internal
// ParsedTransaction shape, which maps directly to the DB schema.

import type { HeliusEnhancedTransaction, HeliusSwapTokenAmount } from './client';
import type { TransactionType, DexType } from '@/lib/supabase/types';
import { EXCLUDED_TOKEN_ADDRESSES_SOLANA } from '@/lib/utils/constants';

// ── Output type ───────────────────────────────────────────────

export interface ParsedTransaction {
  signature: string;
  type: TransactionType;
  tokenAddress: string;
  tokenSymbol: string | null;
  tokenName: string | null;
  amountToken: number | null;
  amountUsd: number | null;
  priceAtTx: number | null;
  dex: DexType;
  blockTime: Date;
  whaleAddress: string;          // The tracked wallet involved
}

// ── DEX source mapping ────────────────────────────────────────

const DEX_SOURCE_MAP: Record<string, DexType> = {
  JUPITER:       'jupiter',
  RAYDIUM:       'raydium',
  ORCA:          'orca',
  WHIRLPOOL:     'orca',   // Orca Whirlpool
  METEORA:       'unknown',
  LIFINITY:      'unknown',
  PHOENIX:       'unknown',
  OPENBOOK:      'unknown',
};

function parseDex(source: string): DexType {
  return DEX_SOURCE_MAP[source.toUpperCase()] ?? 'unknown';
}

// ── Token filtering ───────────────────────────────────────────

function isExcludedToken(mint: string): boolean {
  return EXCLUDED_TOKEN_ADDRESSES_SOLANA.includes(mint);
}

function isStablecoin(mint: string): boolean {
  // EPjFWdd... = USDC, Es9vMF... = USDT
  return (
    mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ||
    mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
  );
}

function isWrappedSol(mint: string): boolean {
  return mint === 'So11111111111111111111111111111111111111112';
}

// ── Amount helpers ────────────────────────────────────────────

const LAMPORTS_PER_SOL = 1_000_000_000;

function lamportsToSol(lamports: string | number): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

function rawTokenToDecimal(raw: { tokenAmount: string; decimals: number }): number {
  return Number(raw.tokenAmount) / Math.pow(10, raw.decimals);
}

// ── Core parsing ──────────────────────────────────────────────

/**
 * Determine whether the transaction is a BUY or SELL from the whale's POV.
 *
 * Logic (using events.swap):
 *   BUY  = whale spent SOL/stablecoin → received non-stable token
 *   SELL = whale spent non-stable token → received SOL/stablecoin
 *
 * Returns null if the transaction is not a parseable swap
 * (e.g. stablecoin-to-stablecoin, excluded token, no swap event).
 */
function classifySwap(
  tx: HeliusEnhancedTransaction,
  whaleAddress: string,
): {
  type: TransactionType;
  tokenAddress: string;
  amountToken: number | null;
  amountUsd: number | null;
  priceAtTx: number | null;
} | null {
  const swap = tx.events?.swap;

  // ── Path 1: events.swap present (preferred, more accurate) ──
  if (swap) {
    // Collect non-excluded outputs received by the whale
    const relevantOutputs = swap.tokenOutputs.filter(
      (o) => o.userAccount === whaleAddress && !isExcludedToken(o.mint),
    );

    // Collect non-excluded inputs sent by the whale
    const relevantInputs = swap.tokenInputs.filter(
      (i) => i.userAccount === whaleAddress && !isExcludedToken(i.mint),
    );

    // BUY: whale received a non-excluded token
    if (relevantOutputs.length > 0) {
      const out = relevantOutputs[0];
      const amountToken = rawTokenToDecimal(out.rawTokenAmount);

      // Calculate USD value from what the whale spent
      const usdSpent = calcUsdSpent(swap, whaleAddress);

      return {
        type: 'buy',
        tokenAddress: out.mint,
        amountToken,
        amountUsd: usdSpent,
        priceAtTx: usdSpent && amountToken ? usdSpent / amountToken : null,
      };
    }

    // SELL: whale sent a non-excluded token
    if (relevantInputs.length > 0) {
      const inp = relevantInputs[0];
      const amountToken = rawTokenToDecimal(inp.rawTokenAmount);

      // Calculate USD value from what the whale received
      const usdReceived = calcUsdReceived(swap, whaleAddress);

      return {
        type: 'sell',
        tokenAddress: inp.mint,
        amountToken,
        amountUsd: usdReceived,
        priceAtTx: usdReceived && amountToken ? usdReceived / amountToken : null,
      };
    }

    return null; // Could not classify (e.g. stablecoin swap)
  }

  // ── Path 2: Fallback — use tokenTransfers ──────────────────
  return classifyFromTokenTransfers(tx, whaleAddress);
}

/**
 * Calculate USD spent by the whale (for BUY classification).
 * Looks at: USDC/USDT input, or SOL input converted at ~$1 per lamport heuristic.
 * Note: For accurate SOL→USD, the caller should enrich with Jupiter price post-parse.
 */
function calcUsdSpent(
  swap: HeliusEnhancedTransaction['events']['swap'],
  whaleAddress: string,
): number | null {
  if (!swap) return null;

  // Stablecoin input
  const stableInput = swap.tokenInputs.find(
    (i) => i.userAccount === whaleAddress && isStablecoin(i.mint),
  );
  if (stableInput) {
    return rawTokenToDecimal(stableInput.rawTokenAmount);
  }

  // SOL input (native) — amount in lamports, USD value resolved later via Jupiter
  if (swap.nativeInput?.account === whaleAddress) {
    // Return SOL amount as a sentinel; caller enriches with real USD price
    return null; // enriched by Jupiter client post-parse
  }

  return null;
}

/**
 * Calculate USD received by the whale (for SELL classification).
 */
function calcUsdReceived(
  swap: HeliusEnhancedTransaction['events']['swap'],
  whaleAddress: string,
): number | null {
  if (!swap) return null;

  // Stablecoin output
  const stableOutput = swap.tokenOutputs.find(
    (o) => o.userAccount === whaleAddress && isStablecoin(o.mint),
  );
  if (stableOutput) {
    return rawTokenToDecimal(stableOutput.rawTokenAmount);
  }

  return null; // SOL output enriched later
}

/**
 * Fallback parser using raw tokenTransfers (less precise than events.swap).
 */
function classifyFromTokenTransfers(
  tx: HeliusEnhancedTransaction,
  whaleAddress: string,
): ReturnType<typeof classifySwap> {
  const received = tx.tokenTransfers.filter(
    (t) => t.toUserAccount === whaleAddress && !isExcludedToken(t.mint),
  );
  const sent = tx.tokenTransfers.filter(
    (t) => t.fromUserAccount === whaleAddress && !isExcludedToken(t.mint),
  );

  if (received.length > 0) {
    const r = received[0];
    return {
      type: 'buy',
      tokenAddress: r.mint,
      amountToken: r.tokenAmount,
      amountUsd: null,
      priceAtTx: null,
    };
  }

  if (sent.length > 0) {
    const s = sent[0];
    return {
      type: 'sell',
      tokenAddress: s.mint,
      amountToken: s.tokenAmount,
      amountUsd: null,
      priceAtTx: null,
    };
  }

  return null;
}

// ── Public entry point ────────────────────────────────────────

/**
 * Parse a Helius enhanced transaction into our internal format.
 *
 * Returns null when:
 *  - Transaction type is not SWAP
 *  - Transaction has an error
 *  - Could not determine direction (stablecoin swap, etc.)
 *  - Token is in the exclusion list (SOL, USDC, USDT, etc.)
 *
 * @param tx            Helius enhanced transaction object
 * @param whaleAddress  The tracked wallet address that triggered the webhook
 */
export function parseHeliusTransaction(
  tx: HeliusEnhancedTransaction,
  whaleAddress: string,
): ParsedTransaction | null {
  const context = `[parse-transaction] sig=${tx.signature.slice(0, 12)}`;

  // Skip failed transactions
  if (tx.transactionError) {
    return null;
  }

  // Only process SWAPs
  if (tx.type !== 'SWAP') {
    return null;
  }

  const classified = classifySwap(tx, whaleAddress);
  if (!classified) {
    return null;
  }

  const dex = parseDex(tx.source);
  const blockTime = new Date(tx.timestamp * 1000);

  return {
    signature: tx.signature,
    type: classified.type,
    tokenAddress: classified.tokenAddress,
    tokenSymbol: null,    // enriched downstream by Jupiter/Birdeye
    tokenName: null,
    amountToken: classified.amountToken,
    amountUsd: classified.amountUsd,
    priceAtTx: classified.priceAtTx,
    dex,
    blockTime,
    whaleAddress,
  };
}

/**
 * Parse an array of Helius transactions, filtering nulls.
 * Suitable for batch processing from the webhook or backfill script.
 */
export function parseHeliusTransactions(
  txs: HeliusEnhancedTransaction[],
  whaleAddress: string,
): ParsedTransaction[] {
  return txs
    .map((tx) => parseHeliusTransaction(tx, whaleAddress))
    .filter((tx): tx is ParsedTransaction => tx !== null);
}

// ── PRD-interface alias ───────────────────────────────────────

/**
 * Alias for parseHeliusTransaction — PRD documented name.
 * Parse a single SWAP transaction from the whale's perspective.
 */
export const parseSwapTransaction = parseHeliusTransaction;
