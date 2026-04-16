// ============================================================
// SONAR — Provider Registry & Factory
// ============================================================
// Central place to get the right provider based on runtime config.
// Set CHAIN_PROVIDER_MODE in .env:
//   external   → all traffic goes to Helius/GMGN/Birdeye/Jupiter
//   hybrid     → sovereign pipeline runs in parallel (shadow mode)
//   sovereign  → own Agave RPC node + Yellowstone + internal engines
//
// Callers import from here, not from individual adapters.
// That way swapping a provider requires changing only this file.
// ============================================================

import type { HistoricalProvider, PriceProvider, WalletIntelProvider, ChainStreamProvider } from './interfaces';
import { HeliusHistoricalProvider, HeliusWalletProvider } from './adapters/helius';
import { BirdeyePriceProvider } from './adapters/birdeye';
import { GMGNWalletProvider } from './adapters/gmgn';
import { JupiterPriceProvider } from './adapters/jupiter';
import { HeliusChainStreamProvider } from './adapters/helius-stream';
import { SovereignSolanaProvider, SovereignChainStreamProvider } from './adapters/sovereign';
export { HeliusWebhookProcessor } from './adapters/helius-webhook';
export type { WebhookProcessingContext, WebhookProcessingReceipt } from './adapters/helius-webhook';

// ── Mode ──────────────────────────────────────────────────────

type ProviderMode = 'external' | 'hybrid' | 'sovereign';

function getMode(): ProviderMode {
  const m = process.env.CHAIN_PROVIDER_MODE;
  if (m === 'hybrid' || m === 'sovereign') return m;
  return 'external';
}

// ── Singletons (module-level, re-used across requests) ────────

let _stream:     ChainStreamProvider  | null = null;
let _historical: HistoricalProvider  | null = null;
let _price:      PriceProvider       | null = null;
let _walletIntel: WalletIntelProvider | null = null;
let _gmgn:       WalletIntelProvider | null = null;

// ── Factory functions ─────────────────────────────────────────

/**
 * Pull-model chain stream provider (AsyncIterable<RawTransactionEvent|...>).
 *
 * external/hybrid: HeliusChainStreamProvider — satisfies the interface but
 *   subscribe* methods throw NOT_IMPLEMENTED. Helius is push (webhook); the
 *   live ingestion path is HeliusWebhookProcessor, not this provider.
 * sovereign: SovereignChainStreamProvider (Yellowstone/Geyser gRPC) — the
 *   intended implementation of the pull-stream contract.
 *
 * NOTE: do not use this for live ingestion today. Use HeliusWebhookProcessor
 * directly. This factory exists to make the seam real and sovereign-ready.
 */
export function getChainStreamProvider(): ChainStreamProvider {
  if (!_stream) {
    const mode = getMode();
    _stream = mode === 'sovereign'
      ? new SovereignChainStreamProvider()
      : new HeliusChainStreamProvider();
  }
  return _stream;
}

/**
 * Historical on-chain data provider.
 * external/hybrid: Helius Enhanced Transactions API
 * sovereign: SovereignSolanaProvider (own Agave RPC)
 */
export function getHistoricalProvider(): HistoricalProvider {
  if (!_historical) {
    const mode = getMode();
    _historical = mode === 'sovereign'
      ? new SovereignSolanaProvider()
      : new HeliusHistoricalProvider();
  }
  return _historical;
}

/**
 * Price provider with fallback chain: Birdeye → Jupiter.
 * sovereign: InternalPriceEngine (pool TWAP + oracle composite)
 */
export function getPriceProvider(): PriceProvider {
  if (!_price) {
    const mode = getMode();
    if (mode === 'sovereign') {
      // TODO: return new InternalPriceEngine();
      throw new Error('Sovereign price engine not yet implemented — set CHAIN_PROVIDER_MODE=external');
    }
    _price = new BirdeyePriceProvider();
  }
  return _price;
}

/**
 * Fallback price provider (Jupiter).
 * Used when primary price provider fails.
 */
export function getFallbackPriceProvider(): PriceProvider {
  return new JupiterPriceProvider();
}

/**
 * Wallet intelligence: balance checks, profiling.
 * sovereign: InternalWalletIntelEngine (own data, own RPC)
 */
export function getWalletIntelProvider(): WalletIntelProvider {
  if (!_walletIntel) {
    const mode = getMode();
    _walletIntel = mode === 'sovereign'
      ? new SovereignSolanaProvider()
      : new HeliusWalletProvider();
  }
  return _walletIntel;
}

/**
 * GMGN smart money discovery (supplementary — not primary signal source).
 * NOTE: always use maker field, never account_address. GMGNWalletProvider enforces this.
 */
export function getGMGNProvider(): WalletIntelProvider {
  if (!_gmgn) _gmgn = new GMGNWalletProvider();
  return _gmgn;
}

// ── Provider info (for health checks / introspection) ─────────

export function getProviderManifest() {
  const mode = getMode();
  return {
    mode,
    historical:  mode === 'sovereign' ? 'sovereign_solana' : 'helius',
    price:       mode === 'sovereign' ? 'internal_price_engine' : 'birdeye+jupiter',
    wallet_intel: mode === 'sovereign' ? 'internal_intel_engine' : 'helius+gmgn',
    discovery:   'gmgn',
    sovereign_ready: false,   // flip to true when Agave RPC + Yellowstone are wired
  };
}

// ── Re-export adapters for convenience ───────────────────────

export { HeliusChainStreamProvider } from './adapters/helius-stream';

// ── Re-export interfaces for convenience ─────────────────────

export type {
  HistoricalProvider,
  PriceProvider,
  WalletIntelProvider,
  ChainStreamProvider,
  PriceQuote,
  WalletBalances,
  WalletProfile,
  DiscoveredWallet,
  AddressHistory,
  RawTransactionEvent,
  ProviderError,
} from './interfaces';
