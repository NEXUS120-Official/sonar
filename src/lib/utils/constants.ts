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
  // ── Binance ──────────────────────────────────────────────────
  // Verified via Solscan labels ("Binance 2", "Binance 3") + Helius signature volume.
  // NOTE: 'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6' was previously mislabeled here
  //       as "Binance Hot Wallet 3". Solscan labels it as KuCoin. Moved to KuCoin section.
  { address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', label: 'Binance Hot Wallet 1',    sub_category: 'binance' },
  { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',  label: 'Binance Hot Wallet 2',    sub_category: 'binance' },
  { address: '53unSgGWqEWANcPYRF35B2Bgf8BkszUtcccKiXwGGLyr',  label: 'Binance.US Hot Wallet',   sub_category: 'binance_us' },
  // ── Coinbase ─────────────────────────────────────────────────
  // Solscan: "Coinbase Hot Wallet 2", "Coinbase Hot Wallet 3"
  { address: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE',  label: 'Coinbase Hot Wallet 2',   sub_category: 'coinbase' },
  { address: 'D89hHJT5Aqyx1trP6EnGY9jJUB3whgnq3aUvvCqedvzf',  label: 'Coinbase Hot Wallet 3',   sub_category: 'coinbase' },
  // ── OKX ──────────────────────────────────────────────────────
  // All three verified via Solscan label "OKX: Hot Wallet" / "OKX".
  // Previous entry '5VCwKtCXgCJ6kit5FybXjvFnyqVgfrl26aYhS76oeJQM' was invalid base58
  // (contained lowercase 'l'). The verified address is '5VCwKt...riW3x...' below.
  { address: 'is6MTRHEgyFLNTfYcuV4QBWLjrZBfmhVNYR6ccgr8KV',  label: 'OKX Hot Wallet 1',        sub_category: 'okx' },
  { address: 'C68a6RCGLiPskbPYtAcsCjhG8tfTWYcoB4JjCrXFdqyo',  label: 'OKX Hot Wallet 2',        sub_category: 'okx' },
  { address: '5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD',  label: 'OKX Hot Wallet 3',        sub_category: 'okx' },
  // ── KuCoin ───────────────────────────────────────────────────
  // Solscan label: "Kucoin". Was previously mislabeled as "Binance Hot Wallet 3" in this file.
  { address: 'BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6',  label: 'KuCoin Hot Wallet',       sub_category: 'kucoin' },
  // ── Gate.io ──────────────────────────────────────────────────
  // Solscan label: "Gate.io"
  { address: 'u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w',  label: 'Gate.io Hot Wallet',      sub_category: 'gate' },
  // ── HTX (Huobi) ──────────────────────────────────────────────
  // Solscan label: "HTX: Hot Wallet"
  { address: 'BY4StcU9Y2BpgH8quZzorg31EGE4L1rjomN8FNsCBEcx',  label: 'HTX Hot Wallet',          sub_category: 'htx' },
  // ── MEXC ─────────────────────────────────────────────────────
  // Solscan label: "MEXC"
  { address: 'ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ',  label: 'MEXC Hot Wallet',         sub_category: 'mexc' },
  // ── Kraken ───────────────────────────────────────────────────
  { address: 'FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5',  label: 'Kraken Hot Wallet',       sub_category: 'kraken' },
  // ── Bybit ────────────────────────────────────────────────────
  // Wallet 2: Solscan label "Bybit Hot Wallet" (AC5RDf...s5ACWjtW2).
  // Wallet 1: unverified on Solscan but retained for coverage.
  { address: 'AC5RDfQFmDS1deWZos921JfqscXdByf6BKHAbfFi1bno',  label: 'Bybit Hot Wallet 1',      sub_category: 'bybit' },
  { address: 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2',  label: 'Bybit Hot Wallet 2',      sub_category: 'bybit' },
] as const;

export const KNOWN_STAKING_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  // ── Marinade Finance ─────────────────────────────────────────
  // Program ID — confirmed via docs.marinade.finance/developers/contract-addresses
  { address: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD',  label: 'Marinade Staking',         sub_category: 'marinade' },
  // ── Jito ─────────────────────────────────────────────────────
  { address: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb',  label: 'Jito Staking',             sub_category: 'jito' },
  // ── BlazeStake (bSOL) ────────────────────────────────────────
  // Stake pool address where SOL is deposited — verified via solanacompass.com/stake-pools
  { address: 'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi',  label: 'BlazeStake Pool (bSOL)',    sub_category: 'blazestake' },
  // ── Sanctum ──────────────────────────────────────────────────
  // Router program: routes SOL into LSTs — verified via solanafm.substack.com deep-dive.
  // Unstake program: receives LSTs when unstaking back to SOL.
  { address: 'stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq',  label: 'Sanctum Router',            sub_category: 'sanctum' },
  { address: 'unpXTU2Ndrc7WWNyEhQWe4udTzSibLPi25SXv2xbCHQ',  label: 'Sanctum Unstake',           sub_category: 'sanctum' },
  // ── Lido — DISCONTINUED ──────────────────────────────────────
  // Lido on Solana sunset October 2023, frontend ended February 2024.
  // Do NOT add — monitoring a dead protocol adds noise without signal.
] as const;

export const KNOWN_DEFI_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  // ── Raydium ───────────────────────────────────────────────────
  { address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'Raydium AMM v4',        sub_category: 'raydium_v4' },
  // Raydium Authority v4 — signs AMM v4 transactions
  { address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', label: 'Raydium Authority v4',  sub_category: 'raydium_v4' },
  // Raydium CLMM (Concentrated Liquidity) — verified via raydium.io/clmm docs
  { address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', label: 'Raydium CLMM',          sub_category: 'raydium' },
  // ── Orca ──────────────────────────────────────────────────────
  { address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpool',        sub_category: 'orca_whirlpool' },
  { address: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', label: 'Orca Token Swap v2',    sub_category: 'orca' },
  // ── Meteora ───────────────────────────────────────────────────
  { address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  label: 'Meteora DLMM',          sub_category: 'meteora_dlmm' },
  { address: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vP8',  label: 'Meteora Pools',         sub_category: 'meteora' },
  // ── Phoenix ───────────────────────────────────────────────────
  // Orderbook DEX on Solana
  { address: 'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY',  label: 'Phoenix Orderbook',     sub_category: 'phoenix' },
  // ── Pump.fun ──────────────────────────────────────────────────
  { address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  label: 'Pump.fun Program',      sub_category: 'pumpfun' },
  { address: 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', label: 'Pump.fun Fee Account',  sub_category: 'pumpfun' },
  // ── Jupiter ───────────────────────────────────────────────────
  { address: 'voTpe3tHQ7AjQHMapgSue2HJFAh2cGsdokqN3XqmVSj', label: 'Jupiter Vote',          sub_category: 'jupiter' },
  // Jupiter v6 Aggregator — current routing program (replacing v4)
  { address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', label: 'Jupiter v6 Aggregator', sub_category: 'jupiter' },
  // Jupiter v4 — legacy routing program still used by some integrations
  { address: 'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',  label: 'Jupiter v4',            sub_category: 'jupiter' },
  // ── Marginfi ──────────────────────────────────────────────────
  { address: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', label: 'Marginfi Lending',      sub_category: 'marginfi' },
  // ── Drift ─────────────────────────────────────────────────────
  { address: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', label: 'Drift Protocol',        sub_category: 'drift' },
  // ── Kamino ────────────────────────────────────────────────────
  { address: 'KAMINoy7YoEFNZwnPVRVFB1ok8bSimbvJpQjTNMW4DZ', label: 'Kamino Finance',        sub_category: 'kamino' },
  // ── Solend ────────────────────────────────────────────────────
  // Main lending market program — verified via solend.fi/docs
  { address: 'So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo', label: 'Solend Main Pool',      sub_category: 'solend' },
] as const;

// ── Known bridge addresses ─────────────────────────────────────
// Source: Wormhole Foundation published contract addresses.
// These are program IDs, not rotating hot wallets — stable across time.

export const KNOWN_BRIDGE_ADDRESSES: ReadonlyArray<{
  address: string;
  label: string;
  sub_category: string;
}> = [
  // Wormhole Token Bridge — receives and releases cross-chain tokens
  { address: 'wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb', label: 'Wormhole Token Bridge', sub_category: 'wormhole' },
  // Wormhole Core Bridge — message validation and guardians
  { address: 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth', label: 'Wormhole Core Bridge',  sub_category: 'wormhole' },
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

    // Flow reversal: minimum magnitude on each side to confirm a directional flip
    // Both the current and prior 4h snapshot must exceed this value on opposite sides.
    flow_reversal_min_usd: 200_000,

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
// Log-normalized continuous scoring (replaces step-function).
//
// All components share a single `pivot_usd`:
//   - Below pivot_usd: linear ramp  0 → pts_at_pivot
//   - At pivot_usd:    exactly       pts_at_pivot
//   - Above pivot_usd: log₅ extension — score doubles every 5× increase in value
//     e.g. exchange: $100K→25 pts, $500K→50 pts, $2.5M→75 pts, $12.5M→100 pts
//
// This eliminates the cliff-edges at $100K / $500K while preserving
// the original reference values as exact calibration points.

export const BIAS_WEIGHTS = {
  // Common noise floor / pivot across all components
  pivot_usd: 100_000,

  // Exchange flow (bullish = net outflow, bearish = net inflow)
  exchange_pts_at_pivot: 25,   // 25 pts at $100K, 50 at $500K, 75 at $2.5M

  // Staking (bullish = net staked, bearish = net unstaked)
  staking_pts_at_pivot:  15,   // 15 pts at $100K, 30 at $500K

  // DeFi stablecoin deployment — bullish only (see aggregator for source)
  // Double-counting fix: USDC is no longer counted in both staking + usdc buckets.
  usdc_pts_at_pivot:     10,   // 10 pts at $100K, 20 at $500K
} as const;

// ── Confirmation count ────────────────────────────────────────
// A sub-signal must exceed this threshold to be counted as "active"
// when computing how many signals agree with the overall bias direction.
// Set at half the bias pivot ($100K) to require a meaningful signal.
export const CONFIRMATION_MIN_USD = 50_000;

// ── Alert deduplication ───────────────────────────────────────
// Cooldown per alert type: minimum ms between firings of the same type.
// Within the cooldown window the alert only re-fires if the key metric
// changed by >= ALERT_MIN_CHANGE_PCT (20%).

export const ALERT_COOLDOWNS_MS: Record<string, number> = {
  accumulation_wave: 2 * 60 * 60 * 1000,   // 2 h
  distribution_wave: 2 * 60 * 60 * 1000,   // 2 h
  exchange_spike:    4 * 60 * 60 * 1000,   // 4 h
  staking_shift:     4 * 60 * 60 * 1000,   // 4 h
  flow_reversal:     4 * 60 * 60 * 1000,   // 4 h
} as const;

// Minimum fractional change in the key metric to allow refire within cooldown.
// 0.50 = 50% — raised from 0.20 to suppress repeated near-identical alerts during
// volatile windows and reduce Anthropic token consumption.
export const ALERT_MIN_CHANGE_PCT = 0.50;

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
  // Helius valid LP types: ADD_LIQUIDITY and WITHDRAW_LIQUIDITY (not REMOVE_LIQUIDITY).
  transaction_types: ['TRANSFER', 'SWAP', 'ADD_LIQUIDITY', 'WITHDRAW_LIQUIDITY'] as const,
  webhook_type: 'enhanced' as const,
  encoding: 'jsonParsed' as const,
  max_exchange_addresses: 20,  // 16 live
  max_whale_addresses:    55,  // raised from 50 → 55 (R8 import: 53 active after adding 3)
  max_staking_addresses:  10,  // 5 live
  max_defi_addresses:     25,  // 19 live (Raydium x3, Orca x2, Meteora x2, Phoenix, Pumpfun x2, Jupiter x3, Marginfi, Drift, Kamino, Solend)
  max_bridge_addresses:    5,  // 2 live (Wormhole x2)
  total_budget:          150,  // 16 exch + 5 staking + 19 defi + 2 bridge + 55 whales = 97 used; 53 headroom
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

export const HELIUS_API_REST  = 'https://api.helius.xyz/v0';
export const JUPITER_API_BASE = 'https://price.jup.ag/v6';
export const BIRDEYE_API_BASE = 'https://public-api.birdeye.so';
