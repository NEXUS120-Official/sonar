// ============================================================
// SONAR — HeliusChainStreamProvider
// ============================================================
// Satisfies the ChainStreamProvider interface for external/hybrid
// mode, but Helius is a PUSH provider — it calls our webhook
// endpoint; we never pull from it.
//
// All subscribe* methods therefore throw NOT_IMPLEMENTED with a
// clear explanation. This is intentional: the live push path is
// HeliusWebhookProcessor (/api/webhook/helius), which is the
// correct abstraction for push ingestion and is unrelated to the
// ChainStreamProvider pull-stream contract.
//
// The pull-stream contract is reserved for the Yellowstone/Geyser
// gRPC adapter (SovereignChainStreamProvider), which is the natural
// implementation of AsyncIterable<RawTransactionEvent>.
//
// To use real pull-stream semantics: set CHAIN_PROVIDER_MODE=sovereign
// and implement SovereignChainStreamProvider.
// ============================================================

import type {
  ChainStreamProvider,
  RawTransactionEvent,
  RawAccountEvent,
  RawSlotEvent,
  SubscribeTransactionsOptions,
  SubscribeAccountsOptions,
  SubscribeSlotsOptions,
} from '../interfaces';
import { ProviderError } from '../interfaces';

// ── NOT_IMPLEMENTED generator ─────────────────────────────────
// Returns an AsyncIterable that immediately throws on first iteration,
// rather than appearing to succeed silently.

function notImplementedStream<T>(method: string, reason: string): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.reject(
            new ProviderError('helius_stream', 'NOT_IMPLEMENTED', `${method}: ${reason}`),
          );
        },
      };
    },
  };
}

const PUSH_REASON =
  'Helius delivers on-chain events via push webhook (POST /api/webhook/helius). ' +
  'Pull-model AsyncIterable streams require the Yellowstone/Geyser gRPC adapter — ' +
  'implement SovereignChainStreamProvider and set CHAIN_PROVIDER_MODE=sovereign.';

// ── HeliusChainStreamProvider ─────────────────────────────────

export class HeliusChainStreamProvider implements ChainStreamProvider {
  readonly name = 'helius_stream';

  // Push provider — no persistent connection to close.
  async close(): Promise<void> {}

  // ── Pull-stream methods (NOT IMPLEMENTED — push model mismatch) ──

  subscribeTransactions(_opts: SubscribeTransactionsOptions): AsyncIterable<RawTransactionEvent> {
    return notImplementedStream<RawTransactionEvent>('subscribeTransactions', PUSH_REASON);
  }

  subscribeAccounts(_opts: SubscribeAccountsOptions): AsyncIterable<RawAccountEvent> {
    return notImplementedStream<RawAccountEvent>('subscribeAccounts', PUSH_REASON);
  }

  subscribeSlots(_opts: SubscribeSlotsOptions): AsyncIterable<RawSlotEvent> {
    return notImplementedStream<RawSlotEvent>('subscribeSlots', PUSH_REASON);
  }
}
