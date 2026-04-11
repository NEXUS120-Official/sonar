// ============================================================
// SONAR — Global Constants
// ============================================================

// Supported chains (multi-chain from day 1)
export const SUPPORTED_CHAINS = ['solana', 'ethereum', 'arbitrum', 'base'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

// Solana addresses to exclude from token alerts (stablecoins + native)
export const EXCLUDED_TOKEN_ADDRESSES_SOLANA = [
  'So11111111111111111111111111111111111111112',  // Wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
];

// Consensus detection config
export const CONSENSUS_CONFIG = {
  timeWindowHours: 4,
  minWhales: 2,
  minVolumeUsd: 5_000,
  dedupWindowHours: 6,      // Don't re-alert same token within 6h
} as const;

// Consensus level labels
export const CONSENSUS_LABELS = {
  2: { label: 'emerging', emoji: '⚡', display: 'Emerging Signal' },
  3: { label: 'strong',   emoji: '🔥', display: 'Strong Signal'   },
  4: { label: 'ultra',    emoji: '💎', display: 'Ultra Signal'     },
} as const;

// Early discovery config
export const EARLY_DISCOVERY_CONFIG = {
  maxTokenAgeHours: 48,
  minWhalebuyers: 2,
  minSafetyScore: 60,
  maxMarketCapUsd: 1_000_000,
} as const;

// Safety score thresholds
export const SAFETY_THRESHOLDS = {
  safe: 80,
  caution: 50,
} as const;

// Safety score emojis
export const SAFETY_EMOJI = {
  safe:    '🟢',
  caution: '🟡',
  danger:  '🔴',
} as const;

// External URLs
export const EXTERNAL_URLS = {
  jupiterSwap: (tokenAddress: string) =>
    `https://jup.ag/swap/SOL-${tokenAddress}`,
  birdeye: (tokenAddress: string) =>
    `https://birdeye.so/token/${tokenAddress}?chain=solana`,
  solscan: (signature: string) =>
    `https://solscan.io/tx/${signature}`,
} as const;

// Helius API
export const HELIUS_API_BASE = 'https://mainnet.helius-rpc.com';
export const HELIUS_API_REST = 'https://api.helius.xyz/v0';

// Rate limits (requests per minute)
export const RATE_LIMITS = {
  helius: 50,
  jupiter: 100,
  birdeye: 30,
  anthropic: 10,
} as const;

// Alert send config
export const ALERT_CONFIG = {
  freeDelayMinutes: 15,   // Free tier alert delay
  maxAlertAgeHours: 24,   // Don't send alerts older than this
} as const;

// Cron secret header name
export const CRON_AUTH_HEADER = 'x-cron-secret';

// Initial seed whale addresses (Solana)
// These will be populated via scripts/seed-whales.ts
// Source: Birdeye Top Traders, DEXScreener top buyers
export const SEED_WHALE_ADDRESSES: Array<{ address: string; label?: string }> = [
  // Placeholder — populated in seed script with real curated addresses
  // Criteria: win rate > 55%, 50+ trades, active last 7d, Solana
];
