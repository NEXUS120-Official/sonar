// ============================================================
// SONAR — Sovereign Mint Inspection Adapter
// ============================================================
// Adapter layer (Source of Truth §3, §11):
//   - fetches raw mint account data from sovereign RPC
//   - returns RawMintInspection (what came off the wire)
//   - performs NO interpretation
//   - interpretation lives in mint-enricher.ts (pure layer)
//
// Separation is strategic:
//   - adapter can be swapped for Geyser/stream without
//     touching the enrichment logic
//   - enricher can be tested with synthetic inspection payloads
//   - both layers are independently replayable
// ============================================================

import type { SovereignRpcClient, SolanaJsonParsedMintAccount } from './rpc-client';

// ── Types ─────────────────────────────────────────────────────

/**
 * Raw output from a sovereign mint account inspection.
 * Carries exactly what came off the wire — no interpretation.
 * The mint enricher interprets this into a SovereignMintEnrichmentResult.
 */
export interface RawMintInspection {
  mint:         string;
  /** ISO timestamp of when the RPC call was made. */
  inspected_at: string;
  /** null when the account does not exist on-chain. */
  account:      SolanaJsonParsedMintAccount | null;
  /** Present when the RPC call failed (network, HTTP, or RPC-level error). */
  rpc_error?:   string;
}

// ── Adapter function ──────────────────────────────────────────

/**
 * Fetch the mint account state via sovereign RPC (jsonParsed encoding).
 * Never throws — returns RawMintInspection with rpc_error set on failure.
 *
 * @param client  SovereignRpcClient configured for the target node
 * @param mint    Solana mint address to inspect
 */
export async function inspectMintAccount(
  client: SovereignRpcClient,
  mint:   string,
): Promise<RawMintInspection> {
  const inspected_at = new Date().toISOString();

  try {
    const account = await client.getMintAccountInfo(mint);
    return { mint, inspected_at, account };
  } catch (e) {
    return {
      mint,
      inspected_at,
      account:   null,
      rpc_error: String(e).slice(0, 300),
    };
  }
}

/**
 * Batch inspect multiple mints.
 * Applies a configurable inter-call delay to avoid rate-limit pressure.
 * Returns one RawMintInspection per input mint (same order).
 */
export async function inspectMintAccountBatch(
  client:      SovereignRpcClient,
  mints:       string[],
  delayMs:     number = 150,
): Promise<RawMintInspection[]> {
  const results: RawMintInspection[] = [];

  for (const mint of mints) {
    results.push(await inspectMintAccount(client, mint));
    if (delayMs > 0 && results.length < mints.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  return results;
}
