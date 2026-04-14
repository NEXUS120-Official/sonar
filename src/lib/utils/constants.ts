// ============================================================
// SONAR v2.0 — Global Constants
// Smart Money Flow Intelligence
// ============================================================

// ── Solana native addresses ───────────────────────────────────

export const SOL_NATIVE_MINT  = 'So11111111111111111111111111111111111111112';
export const USDC_MINT        = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT        = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const MSOL_MINT        = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
export const JITOSOL_MINT     = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
export const BSOL_MINT        = 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1';

// ── Known address registry ────────────────────────────────────
// Source of truth for classifier.ts.
// Addresses verified via Solscan — update if hot wallets rotate.

export const KNOWN_EXCHANGE_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  // Binance — verified via Helius signature volume (200 sigs / 2h window)
  { address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', label: 'Binance Hot Wallet 1', sub_category: 'binance' },
  { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  label: 'Binance Hot Wallet 2', sub_category: 'binance' },
  { address: 'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6',  label: 'Binance Hot Wallet 3', sub_category: 'binance' },
  // Coinbase
  { address: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',  label: 'Coinbase Hot Wallet',  sub_category: 'coinbase' },
  // OKX — previous entry '5VCwKtCXgCJ6kit5FybXjvFnyqVgfrl26aYhS76oeJQM' was invalid base58
  // (contained 'l' which is excluded from base58 alphabet). Needs re-verification.
  // { address: 'TODO_VERIFY_OKX', label: 'OKX Hot Wallet', sub_category: 'okx' },
  // Kraken
  { address: 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',  label: 'Kraken Hot Wallet',    sub_category: 'kraken' },
  // Bybit
  { address: 'AC5RDfQFmDS1deWZos921JfqscXdByf6BKHAbfFi1bno',  label: 'Bybit Hot Wallet',     sub_category: 'bybit' },
  // Gate.io / KuCoin — add verified addresses here when sourced from Solscan
  // { address: 'TODO_VERIFY_GATE',   label: 'Gate.io Hot Wallet',  sub_category: 'gate' },
  // { address: 'TODO_VERIFY_KUCOIN', label: 'KuCoin Hot Wallet',   sub_category: 'kucoin' },
] as const;

export const KNOWN_STAKING_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  { address: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',  label: 'Marinade Staking',    sub_category: 'marinade' },
  { address: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',  label: 'Jito Staking',        sub_category: 'jito' },
] as const;

export const KNOWN_DEFI_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  { address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'Raydium AMM',        sub_category: 'raydium' },
  { address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpool',     sub_category: 'orca' },
  { address: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', label: 'Marginfi Lending',   sub_category: 'marginfi' },
  { address: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', label: 'Drift Protocol',     sub_category: 'drift' },
  { address: 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj', label: 'Jupiter Vote',       sub_category: 'jupiter' },
  { address: 'KAMINoy7YoEFNZwnPVRVFB1ok8bSimbvJpQjTNMW4DZ', label: 'Kamino Finance',     sub_category: 'kamino' },
] as const;

// ── Flow detection thresholds ─────────────────────────────────

export const FLOW_THRESHOLDS = {
  // Minimum USD to record a movement in the DB
  min_movement_usd: 10_000,

  // Minimum USD for a movement to count as "large" in snapshots
  large_movement_usd: 50_000,

  // Alert trigger thresholds
  alert: {
    // Exchange spike: ratio of current 4h window vs 7d average
    exchange_spike_multiplier: 3,

    // Net exchange flow in 4h to trigger accumulation/distribution wave alert
    accumulation_wave_usd: 500_000,
    distribution_wave_usd: 500_000,

    // Net staking flow in 4h
    staking_shift_usd: 200_000,

    // Individual whale move
    whale_large_move_usd: 100_000,

    // Stablecoin flow
    stablecoin_flow_usd: 500_000,
  },

  // Whale discovery
  whale: {
    min_total_value_usd: 500_000,   // Minimum wallet value to be considered a whale
    min_withdrawal_usd:  100_000,   // Minimum exchange withdrawal to track destination
    gmgn_min_trade_usd:   50_000,   // Min non-pump trade to consider from GMGN feed
  },
} as const;

// ── Bias score calculation weights ────────────────────────────

export const BIAS_WEIGHTS = {
  // Exchange flow: negative = accumulation = bullish
  exchange_mild_threshold:   100_000,
  exchange_strong_threshold: 500_000,
  exchange_mild_pts:   25,
  exchange_strong_pts: 50,

  // Staking: net positive = bullish
  staking_threshold: 100_000,
  staking_pts:       15,

  // Stablecoin: USDC inflow = bullish
  usdc_threshold: 100_000,
  usdc_pts:       10,
} as const;

// ── Alert severity labels ─────────────────────────────────────

export const SEVERITY_LABELS: Record<string, string> = {
  info:        'ℹ️',
  notable:     '📊',
  significant: '⚡',
  major:       '🚨',
};

// ── Snapshot window configs ───────────────────────────────────

export const SNAPSHOT_WINDOWS = [1, 4, 24, 168] as const; // hours

// ── Helius webhook config ─────────────────────────────────────

export const WEBHOOK_CONFIG = {
  transaction_types: ['TRANSFER', 'SWAP'] as const,
  webhook_type: 'enhanced' as const,
  encoding: 'jsonParsed' as const,
  max_exchange_addresses: 15,
  max_whale_addresses:    50,
  max_staking_addresses:  10,
  max_defi_addresses:     15,
  total_budget:          100,
} as const;

// ── GMGN API ──────────────────────────────────────────────────

// CRITICAL: Use 'maker' field from feed — NEVER 'account_address'.
// 'account_address' returns SPL ATA, not wallet owner.
// Portfolio stats returns 0 for ATA addresses.
export const GMGN_CONFIG = {
  base_url: 'https://openapi.gmgn.ai',
  smart_money_limit: 200,
  min_non_pump_usd: 50_000,
} as const;

// ── External URLs ─────────────────────────────────────────────

export const EXTERNAL_URLS = {
  solscan:     (address: string) => `https://solscan.io/account/${address}`,
  solscanTx:   (signature: string) => `https://solscan.io/tx/${signature}`,
  birdeye:     (token: string) => `https://birdeye.so/token/${token}?chain=solana`,
  jupiterSwap: (token: string) => `https://jup.ag/swap/SOL-${token}`,
} as const;

// ── API base URLs ─────────────────────────────────────────────

export const HELIUS_API_REST  = 'https://api.helius.xyz';
export const JUPITER_API_BASE = 'https://price.jup.ag/v6';
export const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
