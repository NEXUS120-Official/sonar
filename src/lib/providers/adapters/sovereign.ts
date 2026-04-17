// ============================================================
// SONAR — Sovereign Provider Stubs
// ============================================================
// SovereignSolanaProvider  — implements HistoricalProvider +
//                            WalletIntelProvider via Agave RPC.
// SovereignChainStreamProvider — implements ChainStreamProvider
//                            via Yellowstone/Geyser gRPC.
//
// Both classes satisfy their interfaces today but are NOT
// OPERATIONAL: every method throws ProviderError with code
// 'NOT_OPERATIONAL' until the underlying infrastructure is wired.
//
// NOT_OPERATIONAL vs NOT_IMPLEMENTED (elsewhere):
//   NOT_IMPLEMENTED  = method can never work here by design
//                      (e.g. HeliusChainStreamProvider — push/pull mismatch)
//   NOT_OPERATIONAL  = method IS the correct target; infrastructure
//                      not yet wired (Agave RPC / Yellowstone not running)
//
// To make sovereign mode operational:
//   1. Provision an Agave validator node (RPC + Geyser plugin).
//   2. Set SOVEREIGN_RPC_URL and YELLOWSTONE_ENDPOINT env vars.
//   3. Replace the throw bodies below with real client calls.
//   4. Set CHAIN_PROVIDER_MODE=sovereign.
//   No caller code changes required — providers/index.ts wires these in.
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
import { ProviderError }                from '../interfaces';
import { resolveAddress, toWalletProfile } from '@/lib/entity-graph';
import { createAdminClient }              from '@/lib/supabase/server';

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

// ── SovereignSolanaProvider ───────────────────────────────────
// Single class covers HistoricalProvider + WalletIntelProvider
// because both are satisfied by the same Agave RPC connection.
// External mode splits these across Helius + Helius; sovereign
// mode collapses them to one node operator.

export class SovereignSolanaProvider implements HistoricalProvider, WalletIntelProvider {
  readonly name = 'sovereign_solana';

  // ── HistoricalProvider ──────────────────────────────────────

  async getTransaction(_signature: string): Promise<RawTransactionEvent | null> {
    // Future: Agave RPC `getTransaction` (jsonParsed, maxSupportedTransactionVersion=0).
    // Raw payload archived to raw_transactions with source='sovereign_rpc'.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'getTransaction: Agave RPC not yet wired — set SOVEREIGN_RPC_URL',
    );
  }

  async getMultipleTransactions(_signatures: string[]): Promise<(RawTransactionEvent | null)[]> {
    // Future: batch via Agave RPC `getTransactions` (added in v1.18).
    // Fallback: sequential getTransaction calls with slot-based pagination.
    // All payloads archived to raw_transactions with source='sovereign_rpc'.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'getMultipleTransactions: Agave RPC not yet wired — set SOVEREIGN_RPC_URL',
    );
  }

  async getAddressHistory(
    _address: string,
    _opts?: { limit?: number; before?: string; type?: string },
  ): Promise<AddressHistory[]> {
    // Future: Agave RPC `getSignaturesForAddress` → `getTransaction` per sig.
    // Results archived to raw_transactions; ingest_jobs tracks replay ranges.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'getAddressHistory: Agave RPC not yet wired — set SOVEREIGN_RPC_URL',
    );
  }

  // ── WalletIntelProvider ─────────────────────────────────────

  async getWalletBalances(_address: string): Promise<WalletBalances> {
    // Future: Agave RPC `getMultipleAccounts` (SOL lamports) +
    // `getTokenAccountsByOwner` (SPL balances, including USDC).
    // No external API credits consumed — fully sovereign.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'getWalletBalances: Agave RPC not yet wired — set SOVEREIGN_RPC_URL',
    );
  }

  async getWalletProfile(address: string): Promise<WalletProfile | null> {
    // Owned entirely by SONAR's internal entity graph layer.
    // Pure DB read: entity_addresses → entities. No external provider call.
    // Returns null for unknown addresses — callers must handle null explicitly.
    const entity = await resolveAddress(address, createAdminClient());
    if (!entity) return null;
    return toWalletProfile(address, entity);
  }

  async discoverWhales(
    _opts?: { min_value_usd?: number; limit?: number },
  ): Promise<DiscoveredWallet[]> {
    // Future: owned entirely by SONAR's internal intelligence layer.
    // Query raw_account_updates ranked by lamports (no external API call).
    // Cross-reference with entity_addresses + wallet_clusters for labeling.
    // This is a core intelligence moat feature — no external provider involved.
    throw new ProviderError(
      'sovereign_solana', 'NOT_OPERATIONAL',
      'discoverWhales: internal intelligence layer not yet wired — implement raw_account_updates ranking',
    );
  }
}

// ── SovereignChainStreamProvider ─────────────────────────────
// Pull-stream adapter for Yellowstone/Geyser gRPC.
// This is the correct and intended implementation of the
// ChainStreamProvider pull-stream contract.
//
// Future wiring per method:
//   subscribeTransactions → Geyser SubscribeRequest.transactions filter;
//     events archive to raw_transactions (source='geyser').
//   subscribeAccounts     → Geyser SubscribeRequest.accounts filter;
//     events archive to raw_account_updates (source='geyser').
//   subscribeSlots        → Geyser SubscribeRequest.slots;
//     events archive to raw_blocks (source='geyser').
//   close()               → graceful gRPC channel shutdown.
//
// Active subscriptions should record subscription IDs in ingest_jobs
// for observability and restart recovery.

export class SovereignChainStreamProvider implements ChainStreamProvider {
  readonly name = 'sovereign_geyser';

  async close(): Promise<void> {
    // Future: close the Yellowstone gRPC channel gracefully.
    // No-op until the channel is established.
  }

  subscribeTransactions(_opts: SubscribeTransactionsOptions): AsyncIterable<RawTransactionEvent> {
    // Future: Yellowstone gRPC SubscribeRequest.transactions
    // filtered by _opts.addresses + _opts.transaction_types.
    // Yields RawTransactionEvent; raw payload archived to raw_transactions.
    return notOperationalStream<RawTransactionEvent>(
      'subscribeTransactions',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }

  subscribeAccounts(_opts: SubscribeAccountsOptions): AsyncIterable<RawAccountEvent> {
    // Future: Yellowstone gRPC SubscribeRequest.accounts
    // filtered by _opts.addresses and commitment level.
    // Yields RawAccountEvent; raw payload archived to raw_account_updates.
    return notOperationalStream<RawAccountEvent>(
      'subscribeAccounts',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }

  subscribeSlots(_opts: SubscribeSlotsOptions): AsyncIterable<RawSlotEvent> {
    // Future: Yellowstone gRPC SubscribeRequest.slots.
    // Yields RawSlotEvent; slot metadata archived to raw_blocks.
    return notOperationalStream<RawSlotEvent>(
      'subscribeSlots',
      'Yellowstone/Geyser gRPC not yet wired — set YELLOWSTONE_ENDPOINT',
    );
  }
}
