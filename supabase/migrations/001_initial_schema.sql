-- ============================================================
-- SONAR Database Schema — v1.0
-- Multi-chain: Solana (primary), Ethereum, Arbitrum, Base
-- ============================================================

-- Whale wallets we track
CREATE TABLE whales (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  label TEXT,                          -- Optional name/label
  chain TEXT NOT NULL DEFAULT 'solana', -- 'solana' | 'ethereum' | 'arbitrum' | 'base'
  is_active BOOLEAN DEFAULT true,

  -- Performance metrics (updated by cron job)
  win_rate_7d NUMERIC(5,2),
  win_rate_30d NUMERIC(5,2),
  pnl_7d NUMERIC(18,2),
  pnl_30d NUMERIC(18,2),
  total_trades_7d INTEGER DEFAULT 0,
  total_trades_30d INTEGER DEFAULT 0,
  avg_hold_time_hours NUMERIC(10,2),
  best_trade_pnl NUMERIC(18,2),
  worst_trade_pnl NUMERIC(18,2),
  preferred_sector TEXT,               -- 'memecoin' | 'defi' | 'nft' | 'mixed'

  -- Metadata
  discovered_at TIMESTAMPTZ DEFAULT NOW(),
  stats_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Detected transactions
CREATE TABLE transactions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  whale_id UUID REFERENCES whales(id) ON DELETE CASCADE,
  signature TEXT NOT NULL UNIQUE,      -- Transaction signature / hash

  -- Transaction details
  type TEXT NOT NULL,                  -- 'buy' | 'sell' | 'transfer'
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  token_name TEXT,

  amount_token NUMERIC(24,8),
  amount_usd NUMERIC(18,2),
  price_at_tx NUMERIC(18,8),

  -- Enrichment
  dex TEXT,                            -- 'jupiter' | 'raydium' | 'orca' | 'uniswap'

  block_time TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_transactions_token_time ON transactions(token_address, block_time DESC);
CREATE INDEX idx_transactions_whale_time ON transactions(whale_id, block_time DESC);
CREATE INDEX idx_transactions_type_time ON transactions(type, block_time DESC);

-- Generated alerts
CREATE TABLE alerts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  type TEXT NOT NULL,                  -- 'single' | 'consensus' | 'early_discovery'

  -- Consensus data
  consensus_level INTEGER DEFAULT 1,  -- Number of whales involved
  consensus_label TEXT,               -- 'emerging' | 'strong' | 'ultra'

  -- Token info
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  token_name TEXT,
  token_market_cap NUMERIC(18,2),
  token_age_hours NUMERIC(10,2),
  token_holders INTEGER,

  -- Safety
  safety_score INTEGER,               -- 0-100
  safety_level TEXT,                  -- 'safe' | 'caution' | 'danger'

  -- Aggregated data
  total_whale_volume_usd NUMERIC(18,2),
  whale_transactions JSONB,           -- Array of {whale_address, amount_usd, signature, win_rate}

  -- AI-generated content
  alert_text TEXT,                    -- Natural language alert

  -- Links
  jupiter_swap_url TEXT,
  birdeye_url TEXT,

  -- Send state
  sent_telegram BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_type_time ON alerts(type, created_at DESC);
CREATE INDEX idx_alerts_token ON alerts(token_address, created_at DESC);

-- Token safety cache (TTL managed at application layer)
CREATE TABLE token_safety (
  token_address TEXT PRIMARY KEY,

  -- Safety checks
  liquidity_locked BOOLEAN,
  liquidity_lock_duration_days INTEGER,
  owner_renounced BOOLEAN,
  mint_authority_revoked BOOLEAN,     -- Solana-specific
  top10_holder_pct NUMERIC(5,2),
  holder_count INTEGER,
  is_honeypot BOOLEAN,
  token_age_hours NUMERIC(10,2),

  -- Computed score
  safety_score INTEGER NOT NULL,      -- 0-100
  safety_level TEXT NOT NULL,         -- 'safe' | 'caution' | 'danger'

  checked_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- User profiles (extends Supabase Auth)
CREATE TABLE user_profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  telegram_chat_id TEXT,              -- For sending DM alerts
  telegram_username TEXT,

  -- Alert preferences
  alert_min_consensus INTEGER DEFAULT 2,
  alert_min_safety INTEGER DEFAULT 50,
  alert_min_volume_usd NUMERIC(18,2) DEFAULT 10000,
  alert_types TEXT[] DEFAULT ARRAY['consensus', 'early_discovery'],

  -- Subscription
  tier TEXT DEFAULT 'free',           -- 'free' | 'pro'
  stripe_customer_id TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User's custom whale watchlist (pro feature)
CREATE TABLE user_whale_watchlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES user_profiles(id) ON DELETE CASCADE,
  whale_id UUID REFERENCES whales(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, whale_id)
);

-- Auto-update user_profiles.updated_at on changes
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
