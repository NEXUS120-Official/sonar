// ============================================================
// SONAR — Sovereign Decoder
// ============================================================
// Decodes native Solana RPC getTransaction payloads (stored as
// source='sovereign_rpc' / 'sovereign_rpc_history') into
// SONAR ParsedMovement rows.
//
// Strategy:
//   1. SOL balance delta extraction:
//        postBalances[i] - preBalances[i], fee added back to
//        index-0 so fee is not counted as a transfer.
//      Dominant sender  = largest negative delta.
//      Dominant receiver = largest positive delta.
//   2. USDC token balance delta extraction:
//        per-owner sum of (post - pre) raw token amounts for
//        USDC mint only; owner field from preTokenBalances /
//        postTokenBalances used directly.
//
//   Both paths call the shared classifyTransfer() from the
//   Helius parser — same known-address lookup, same flow-type
//   decision tree, same threshold guard.
//
// Returns null when:
//   - meta is absent or transaction failed (meta.err !== null)
//   - no dominant pair above FLOW_THRESHOLDS.min_movement_usd
//   - neither side involves a known address or tracked whale
//
// Intentionally deferred (this block):
//   - SPL token movements other than USDC (tokenMovement = null)
//   - Native Stake Program parsing (complex instruction decode)
// ============================================================

import { classifyTransfer }         from '@/lib/helius/parse-movement';
import { FLOW_THRESHOLDS, USDC_MINT } from '@/lib/utils/constants';
import type { ParsedMovement }       from '@/lib/helius/parse-movement';
import type { SolanaTransactionResult } from '@/lib/sovereign/rpc-client';

const LAMPORTS_PER_SOL = 1_000_000_000;
const USDC_DECIMALS    = 6;

// Normalise accountKeys: handles both string[] and {pubkey}[] (jsonParsed encoding).
function extractAccountKeys(tx: SolanaTransactionResult): string[] {
  const keys = tx.transaction?.message?.accountKeys;
  if (!keys || keys.length === 0) return [];
  if (typeof keys[0] === 'string') return keys as string[];
  return (keys as Array<{ pubkey: string }>).map(k => k.pubkey);
}

/**
 * Decode a native Solana RPC getTransaction payload into a SONAR ParsedMovement.
 *
 * @param raw             raw_json field from a sovereign_rpc raw_transactions row
 * @param whaleAddressSet set of currently-tracked whale addresses
 * @param solPriceUsd     current SOL price (USD) for threshold checks
 */
export function decodeSovereignMovement(
  raw:             unknown,
  whaleAddressSet: Set<string>,
  solPriceUsd:     number,
): ParsedMovement | null {
  if (!raw || typeof raw !== 'object') return null;

  const tx = raw as SolanaTransactionResult;

  // Reject failed or metadata-absent transactions
  if (!tx.meta || tx.meta.err !== null) return null;

  const accountKeys = extractAccountKeys(tx);
  if (accountKeys.length === 0) return null;

  const signature = tx.transaction?.signatures?.[0] ?? '';
  if (!signature) return null;

  const blockTime = tx.blockTime
    ? new Date(tx.blockTime * 1000).toISOString()
    : new Date(0).toISOString();

  const minUsd = FLOW_THRESHOLDS.min_movement_usd;

  // ── 1. SOL balance deltas ─────────────────────────────────────
  const pre = tx.meta.preBalances  ?? [];
  const post = tx.meta.postBalances ?? [];
  const fee  = tx.meta.fee          ?? 0;

  type Delta = { address: string; delta: number };
  const solDeltas: Delta[] = [];

  for (let i = 0; i < accountKeys.length; i++) {
    let delta = (post[i] ?? 0) - (pre[i] ?? 0);
    // Fee payer (index 0) is charged the fee on top of any transfer;
    // add it back so we measure voluntary SOL flow, not fee burn.
    if (i === 0) delta += fee;
    if (delta !== 0) solDeltas.push({ address: accountKeys[i], delta });
  }

  const solSender   = solDeltas.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  const solReceiver = solDeltas.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta)[0];

  if (solSender && solReceiver) {
    const solAmt = Math.abs(solSender.delta) / LAMPORTS_PER_SOL;
    const usdAmt = solAmt * solPriceUsd;

    if (usdAmt >= minUsd) {
      const result = classifyTransfer({
        signature,
        from:                solSender.address,
        to:                  solReceiver.address,
        token:               'SOL',
        amount:              solAmt,
        amountUsd:           usdAmt,
        blockTime,
        knownWhaleAddresses: whaleAddressSet,
      });
      if (result) return result;
    }
  }

  // ── 2. USDC token balance deltas ──────────────────────────────
  const usdcPre  = new Map<string, number>();
  const usdcPost = new Map<string, number>();

  for (const tb of tx.meta.preTokenBalances ?? []) {
    if (tb.mint !== USDC_MINT || !tb.owner) continue;
    usdcPre.set(tb.owner, (usdcPre.get(tb.owner) ?? 0) + Number(tb.uiTokenAmount.amount));
  }
  for (const tb of tx.meta.postTokenBalances ?? []) {
    if (tb.mint !== USDC_MINT || !tb.owner) continue;
    usdcPost.set(tb.owner, (usdcPost.get(tb.owner) ?? 0) + Number(tb.uiTokenAmount.amount));
  }

  const usdcOwners = new Set([...usdcPre.keys(), ...usdcPost.keys()]);
  const usdcDeltas: Delta[] = [];
  for (const owner of usdcOwners) {
    const delta = (usdcPost.get(owner) ?? 0) - (usdcPre.get(owner) ?? 0);
    if (delta !== 0) usdcDeltas.push({ address: owner, delta });
  }

  const usdcSender   = usdcDeltas.filter(d => d.delta < 0).sort((a, b) => a.delta - b.delta)[0];
  const usdcReceiver = usdcDeltas.filter(d => d.delta > 0).sort((a, b) => b.delta - a.delta)[0];

  if (usdcSender && usdcReceiver) {
    const usdcAmt = Math.abs(usdcSender.delta) / Math.pow(10, USDC_DECIMALS);

    if (usdcAmt >= minUsd) {
      const result = classifyTransfer({
        signature,
        from:                usdcSender.address,
        to:                  usdcReceiver.address,
        token:               'USDC',
        amount:              usdcAmt,
        amountUsd:           usdcAmt,  // 1:1 peg assumption
        blockTime,
        knownWhaleAddresses: whaleAddressSet,
      });
      if (result) return result;
    }
  }

  return null;
}
