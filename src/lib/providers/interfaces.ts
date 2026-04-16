// ============================================================
// SONAR — Provider Interfaces (Sovereign Architecture v1)
// ============================================================
// All external data access must go through these interfaces.
// Today: adapters for Helius, GMGN, Birdeye, Jupiter.
// Tomorrow: SovereignSolanaProvider (Agave RPC + Yellowstone/Geyser).
//
// Design rules:
//   - No external SDK types leak through these interfaces
//   - All output types are SONAR-native (defined below)
//   - Providers are stateless; state lives in DB
//   - Adapters must handle errors internally and throw ProviderError
// ============================================================

// ── Error type ────────────────────────────────────────────────

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(`[${provider}] ${code}: ${message}`);
    this.name = 'ProviderError';
  }
}

// ── Shared value types ────────────────────────────────────────

export interface PriceQuote {
  mint:          string;        // token mint address
  price_usd:     number;
  source:        string;        // 'birdeye' | 'jupiter' | 'coingecko' | 'internal_pool'
  confidence:    number;        // 0-100
  observed_at:   Date;
}

export interface WalletBalances {
  address:         string;
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
  token_count:     number;
  refreshed_at:    Date;
}

export interface WalletProfile {
  address:          string;
  entity_type:      'exchange' | 'protocol' | 'whale' | 'market_maker' | 'bridge' | 'unknown';
  label:            string | null;
  tags:             string[];
  discovery_source: string;
}

export interface DiscoveredWallet {
  address:        string;
  total_value_usd: number;
  sol_balance:    number;
  usdc_balance:   number;
  discovery_method: string;
}

export interface RawTransactionEvent {
  signature:   string;
  slot:        number;
  block_time:  Date;
  fee:         number;
  success:     boolean;
  raw:         unknown;          // provider-specific payload, saved as-is
  source:      string;           // which provider sent this
}

export interface RawAccountEvent {
  pubkey:        string;
  slot:          number;
  lamports:      bigint;
  owner:         string;
  write_version: bigint;
  raw:           unknown;
  source:        string;
}

export interface RawSlotEvent {
  slot:        number;
  parent:      number;
  root:        number;
  status:      'processed' | 'confirmed' | 'finalized';
  source:      string;
}

export interface AddressHistory {
  signature:  string;
  block_time: Date;
  slot:       number;
  raw:        unknown;
  source:     string;
}

export interface SubscribeTransactionsOptions {
  addresses:        string[];
  transaction_types?: string[];   // e.g. SWAP, TRANSFER, ADD_LIQUIDITY
  commitment?:       'processed' | 'confirmed' | 'finalized';
}

export interface SubscribeAccountsOptions {
  addresses:   string[];
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

export interface SubscribeSlotsOptions {
  commitment?: 'processed' | 'confirmed' | 'finalized';
}

// ── Provider Interfaces ───────────────────────────────────────

/**
 * Real-time stream of on-chain events.
 * Current adapters: Helius webhook receiver (push model)
 * Future: Yellowstone/Geyser gRPC (pull stream)
 */
export interface ChainStreamProvider {
  readonly name: string;
  subscribeTransactions(opts: SubscribeTransactionsOptions): AsyncIterable<RawTransactionEvent>;
  subscribeAccounts(opts: SubscribeAccountsOptions): AsyncIterable<RawAccountEvent>;
  subscribeSlots(opts: SubscribeSlotsOptions): AsyncIterable<RawSlotEvent>;
  close(): Promise<void>;
}

/**
 * Historical on-chain data lookup.
 * Current adapters: HeliusHistoricalProvider
 * Future: SovereignSolanaProvider (local Agave RPC + archive)
 */
export interface HistoricalProvider {
  readonly name: string;
  getTransaction(signature: string): Promise<RawTransactionEvent | null>;
  getAddressHistory(
    address: string,
    opts?: { limit?: number; before?: string; type?: string }
  ): Promise<AddressHistory[]>;
  getMultipleTransactions(signatures: string[]): Promise<(RawTransactionEvent | null)[]>;
}

/**
 * Token and SOL price data.
 * Current adapters: BirdeyePriceProvider, JupiterPriceProvider
 * Future: InternalPriceEngine (pool TWAP + oracle aggregation)
 */
export interface PriceProvider {
  readonly name: string;
  getTokenPrice(mint: string, at?: Date): Promise<PriceQuote | null>;
  getSolPrice(at?: Date): Promise<PriceQuote | null>;
  getMultipleTokenPrices(mints: string[]): Promise<Map<string, PriceQuote>>;
}

/**
 * Wallet intelligence: balances, discovery, profiling.
 * Current adapters: HeliusWalletProvider, GMGNWalletProvider
 * Future: InternalWalletIntelEngine (own data, own RPC)
 */
export interface WalletIntelProvider {
  readonly name: string;
  discoverWhales(opts?: { min_value_usd?: number; limit?: number }): Promise<DiscoveredWallet[]>;
  getWalletBalances(address: string): Promise<WalletBalances>;
  getWalletProfile(address: string): Promise<WalletProfile | null>;
}
