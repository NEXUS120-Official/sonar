// ============================================================
// SONAR — Sovereign Provider
// ============================================================
// SovereignSolanaProvider  — implements HistoricalProvider +
//                            WalletIntelProvider via a standard
//                            Solana JSON-RPC node.
// SovereignChainStreamProvider — implements ChainStreamProvider
//                            via Yellowstone/Geyser gRPC.
//
// Operational status after Block 15:
//   getTransaction()          OPERATIONAL (requires SOVEREIGN_RPC_URL)
//   getMultipleTransactions()  OPERATIONAL (requires SOVEREIGN_RPC_URL)
//   getAddressHistory()        OPERATIONAL (requires SOVEREIGN_RPC_URL)
//   getWalletBalances()        OPERATIONAL (requires SOVEREIGN_RPC_URL)
//   getWalletProfile()         OPERATIONAL (entity graph — no RPC needed)
//   discoverWhales()           NOT_OPERATIONAL (raw_account_updates ranking not yet built)
//   SovereignChainStreamProvider.*  NOT_OPERATIONAL (Yellowstone/Geyser not yet wired)
//
// NOT_OPERATIONAL vs NOT_IMPLEMENTED:
//   NOT_IMPLEMENTED  = method can never work here by design
//   NOT_OPERATIONAL  = method IS the correct target; infrastructure
//                      not yet wired
//
// Raw archive:
//   getTransaction + getAddressHistory write raw_transactions rows
//   with source='sovereign_rpc' / 'sovereign_rpc_history'.
//   The current Helius-format decoder CANNOT parse these payloads.
//   Add source-based dispatch (decodeSovereignMovement) in
//   src/lib/decoder before enabling normalization of sovereign rows.
//
// To activate sovereign mode:
//   Set SOVEREIGN_RPC_URL=<your-rpc-endpoint>
//   Set CHAIN_PROVIDER_MODE=sovereign
// ============================================================

import type {
  HistoricalProvider,
  WalletIntelProvider,
  ChainStreamProvider,
  RawTransactionEvent,
  RawAccountEvent,
  RawSlotEvent,
  AddressHistory,
  DiscoveredWallet,
  WalletBalances,
  WalletProfile,
  SubscribeTransactionsOptions,
  SubscribeAccountsOptions,
  SubscribeSlotsOptions,
} from '../interfaces';
import { ProviderError }                           from '../interfaces';
import { resolveAddress, toWalletProfile }         from '@/lib/entity-graph';
import { createAdminClient }                       from '@/lib/supabase/server';
import { resolveSolPriceUsd }                      from '@/lib/price-engine';
import { getSovereignRpcClient }                   from '@/lib/sovereign/rpc-client';
import {
  solTxToRawTransactionEvent,
  solTxToAddressHistory,
} from '@/lib/sovereign/transformers';

// ── USDC mint (Solana mainnet) ─────────────────────────────────
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Concurrency config for multi-tx fetches ───────────────────
const TX_FETCH_BATCH    = 5;    // concurrent getTransaction calls per batch
const TX_FETCH_DELAY_MS = 100;  // ms between batches (rate-limit safety)

// ── NOT_OPERATIONAL stream helper ─────────────────────────────
// Mirrors notImplementedStream in helius-stream.ts, but uses a
// different error code so logs distinguish capability gaps from
// infrastructure gaps.

function notOperationalStream<T>(method: string, detail: string): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.reject(
            new ProviderError('sovereign', 'NOT_OPERATIONAL', `${method}: ${detail}`),
          );
        },
      };
    },
  };
}

// ── Helper: require a configured RPC client ───────────────────
// Centralises the NOT_OPERATIONAL error message so it is
// consistent across methods and easy to grep.

function requireRpcClient(method: string) {
  const client = getSovereignRpcClient();
  if (!client) {
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      `${method}: SOVEREIGN_RPC_URL is not set`,
    );
  }
  return client;
}

// ── SovereignSolanaProvider ───────────────────────────────────
// Single class covers HistoricalProvider + WalletIntelProvider
// because both are satisfied by the same RPC connection.

export class SovereignSolanaProvider implements HistoricalProvider, WalletIntelProvider {
  readonly name = 'sovereign_solana';

  // ── HistoricalProvider ──────────────────────────────────────

  async getTransaction(signature: string): Promise<RawTransactionEvent | null> {
    const client = requireRpcClient('getTransaction');
    const tx = await client.getTransaction(signature);
    if (!tx) return null;
    return solTxToRawTransactionEvent(tx, signature);
  }

  async getMultipleTransactions(
    signatures: string[],
  ): Promise<(RawTransactionEvent | null)[]> {
    if (signatures.length === 0) return [];

    const client  = requireRpcClient('getMultipleTransactions');
    const results: (RawTransactionEvent | null)[] = [];

    for (let i = 0; i < signatures.length; i += TX_FETCH_BATCH) {
      const batch = signatures.slice(i, i + TX_FETCH_BATCH);

      const settled = await Promise.allSettled(
        batch.map(sig => client.getTransaction(sig)),
      );

      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status === 'fulfilled' && r.value !== null) {
          results.push(solTxToRawTransactionEvent(r.value, batch[j]));
        } else {
          results.push(null);
        }
      }

      if (i + TX_FETCH_BATCH < signatures.length) {
        await new Promise(r => setTimeout(r, TX_FETCH_DELAY_MS));
      }
    }

    return results;
  }

  async getAddressHistory(
    address: string,
    opts?: { limit?: number; before?: string; type?: string },
  ): Promise<AddressHistory[]> {
    const client = requireRpcClient('getAddressHistory');

    // Step 1: fetch signature list (1 RPC call)
    const sigInfos = await client.getSignaturesForAddress(address, {
      limit:  opts?.limit ?? 100,
      before: opts?.before,
    });

    if (sigInfos.length === 0) return [];

    // Only process confirmed/finalized signatures — skip failed txns
    const confirmed = sigInfos.filter(s => s.err === null);

    // Step 2: fetch full transactions in concurrent batches.
    // Promise.allSettled so one failed fetch does not abort the batch.
    // When a fetch fails, solTxToAddressHistory falls back to sigInfo
    // as the `raw` payload — still archivable.
    const results: AddressHistory[] = [];

    for (let i = 0; i < confirmed.length; i += TX_FETCH_BATCH) {
      const batch = confirmed.slice(i, i + TX_FETCH_BATCH);

      const settled = await Promise.allSettled(
        batch.map(s => client.getTransaction(s.signature)),
      );

      for (let j = 0; j < batch.length; j++) {
        const sigInfo  = batch[j];
        const r        = settled[j];
        const tx       = r.status === 'fulfilled' ? r.value : null;
        results.push(solTxToAddressHistory(sigInfo, tx));
      }

      if (i + TX_FETCH_BATCH < confirmed.length) {
        await new Promise(r => setTimeout(r, TX_FETCH_DELAY_MS));
      }
    }

    return results;
  }

  // ── WalletIntelProvider ─────────────────────────────────────

  async getWalletBalances(address: string): Promise<WalletBalances> {
    const client = requireRpcClient('getWalletBalances');

    // Fetch native SOL account info + USDC token accounts in parallel
    const [accountInfo, tokenAccounts] = await Promise.all([
      client.getAccountInfo(address),
      client.getTokenAccountsByOwner(address, USDC_MINT),
    ]);

    const sol_balance = accountInfo ? accountInfo.lamports / 1e9 : 0;

    // Sum all USDC token accounts owned by this address (usually 1)
    let usdc_balance = 0;
    for (const ta of tokenAccounts) {
      const uiAmount = ta.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof uiAmount === 'number') usdc_balance += uiAmount;
    }

    const solPriceUsd    = await resolveSolPriceUsd();
    const total_value_usd = sol_balance * solPriceUsd + usdc_balance;

    return {
      address,
      sol_balance,
      usdc_balance,
      total_value_usd,
      token_count:  tokenAccounts.length,
      refreshed_at: new Date(),
    };
  }

  async getWalletProfile(address: string): Promise<WalletProfile | null> {
    // Owned entirely by SONAR's internal entity graph layer.
    // Pure DB read: entity_addresses → entities. No external provider call.
    const entity = await resolveAddress(address, createAdminClient());
    if (!entity) return null;
    return toWalletProfile(address, entity);
  }

  async discoverWhales(
    _opts?: { min_value_usd?: number; limit?: number },
  ): Promise<DiscoveredWallet[]> {
    // Future: owned by SONAR's internal intelligence layer.
    // Query raw_account_updates ranked by lamports; cross-reference
    // entity_addresses + wallet_clusters for labeling.
    // No external provider involved — pure sovereign intelligence moat.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'discoverWhales: raw_account_updates ranking layer not yet built',
    );
  }
}

// ── SovereignChainStreamProvider ─────────────────────────────
// Pull-stream adapter for Yellowstone/Geyser gRPC.
// Remains NOT_OPERATIONAL until Yellowstone endpoint is wired.

export class SovereignChainStreamProvider implements ChainStreamProvider {
  readonly name = 'sovereign_geyser';

  async close(): Promise<void> {
    // Future: close the Yellowstone gRPC channel gracefully.
  }

  subscribeTransactions(_opts: SubscribeTransactionsOptions): AsyncIterable<RawTransactionEvent> {
    return notOperationalStream<RawTransactionEvent>(
      'subscribeTransactions',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }

  subscribeAccounts(_opts: SubscribeAccountsOptions): AsyncIterable<RawAccountEvent> {
    return notOperationalStream<RawAccountEvent>(
      'subscribeAccounts',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }

  subscribeSlots(_opts: SubscribeSlotsOptions): AsyncIterable<RawSlotEvent> {
    return notOperationalStream<RawSlotEvent>(
      'subscribeSlots',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }
}
