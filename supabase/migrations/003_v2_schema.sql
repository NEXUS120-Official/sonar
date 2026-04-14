-- ============================================================
-- SONAR v2.0 — Smart Money Flow Intelligence
-- Migration 003: Full pivot from v1.0 consensus model
-- ============================================================
-- Apply via Supabase dashboard → SQL editor.
-- Drops v1-only tables and creates the v2 schema.
-- ============================================================

-- ── Drop v1-only tables ───────────────────────────────────────

DROP TABLE IF EXISTS scout_submissions CASCADE;
DROP TABLE IF EXISTS discovery_reviews CASCADE;
DROP TABLE IF EXISTS discovery_candidate_sources CASCADE;
DROP TABLE IF EXISTS discovery_candidates CASCADE;
DROP TABLE IF EXISTS user_whale_watchlist CASCADE;
DROP TABLE IF EXISTS token_safety CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;

-- Drop and recreate alerts (schema change)
DROP TABLE IF EXISTS alerts CASCADE;

-- Drop and recreate whales (schema change)
DROP TABLE IF EXISTS whales CASCADE;

-- Drop and recreate user_profiles (schema change)
DROP TABLE IF EXISTS user_profiles CASCADE;

-- ── known_addresses ───────────────────────────────────────────
-- Exchange hot wallets, staking protocols, DeFi protocols

CREATE TABLE known_addresses (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address      TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  category     TEXT NOT NULL,       -- 'exchange' | 'staking' | 'defi' | 'bridge' | 'protocol'
  sub_category TEXT,                -- 'binance' | 'okx' | 'marinade' | 'jito' | 'raydium' | etc.
  chain        TEXT NOT NULL DEFAULT 'solana',
  is_active    BOOLEAN DEFAULT true,
  metadata     JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_known_addresses_category ON known_addresses(category);
CREATE INDEX idx_known_addresses_sub ON known_addresses(sub_category);

-- ── whales v2 ─────────────────────────────────────────────────
-- Large balance holders — no more win-rate / trade-pattern requirements

CREATE TABLE whales (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  address      TEXT NOT NULL UNIQUE,
  label        TEXT,
  chain        TEXT NOT NULL DEFAULT 'solana',
  is_active    BOOLEAN DEFAULT true,

  -- Balance tracking (updated hourly by cron)
  sol_balance      NUMERIC(24,8),
  usdc_balance     NUMERIC(24,8),
  total_value_usd  NUMERIC(18,2),

  -- Staking positions
  staked_sol       NUMERIC(24,8),
  staked_msol      NUMERIC(24,8),
  staked_jitosol   NUMERIC(24,8),

  -- Classification
  whale_type       TEXT,            -- 'accumulator' | 'distributor' | 'staker' | 'defi_user' | 'unknown'

  -- Discovery
  discovery_method  TEXT,           -- 'balance_scan' | 'exchange_withdrawal' | 'gmgn_feed' | 'manual'
  discovered_at     TIMESTAMPTZ DEFAULT NOW(),
  balance_updated_at TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_whales_active ON whales(is_active);
CREATE INDEX idx_whales_value ON whales(total_value_usd DESC NULLS LAST);

-- ── movements ─────────────────────────────────────────────────
-- Every significant on-chain movement detected

CREATE TABLE movements (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  signature    TEXT NOT NULL UNIQUE,

  -- Participants
  from_address  TEXT NOT NULL,
  to_address    TEXT NOT NULL,
  from_label    TEXT,               -- Resolved from known_addresses
  to_label      TEXT,
  whale_id      UUID REFERENCES whales(id),

  -- Asset
  token         TEXT NOT NULL,      -- 'SOL' | 'USDC' | 'mSOL' | 'jitoSOL'
  amount_token  NUMERIC(24,8) NOT NULL,
  amount_usd    NUMERIC(18,2),

  -- Classification
  flow_type     TEXT NOT NULL,
  -- 'exchange_deposit' | 'exchange_withdrawal'
  -- 'stake' | 'unstake'
  -- 'defi_deposit' | 'defi_withdrawal'
  -- 'bridge_in' | 'bridge_out'
  -- 'whale_transfer' | 'unknown'

  flow_direction TEXT NOT NULL,     -- 'inflow' | 'outflow' | 'internal'
  exchange       TEXT,              -- 'binance' | 'okx' | etc.
  protocol       TEXT,              -- 'marinade' | 'jito' | 'raydium' | etc.

  block_time     TIMESTAMPTZ NOT NULL,
  processed_at   TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_movements_type_time    ON movements(flow_type, block_time DESC);
CREATE INDEX idx_movements_token_time   ON movements(token, block_time DESC);
CREATE INDEX idx_movements_whale        ON movements(whale_id, block_time DESC);
CREATE INDEX idx_movements_amount       ON movements(amount_usd DESC NULLS LAST);
CREATE INDEX idx_movements_from         ON movements(from_address);
CREATE INDEX idx_movements_to           ON movements(to_address);
CREATE INDEX idx_movements_block_time   ON movements(block_time DESC);

-- ── flow_snapshots ────────────────────────────────────────────
-- Aggregated flow data, computed every 5 min by cron

CREATE TABLE flow_snapshots (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_time TIMESTAMPTZ NOT NULL,
  window_hours  INTEGER NOT NULL,   -- 1 | 4 | 24 | 168

  -- SOL exchange flows
  sol_exchange_inflow_usd   NUMERIC(18,2) DEFAULT 0,
  sol_exchange_outflow_usd  NUMERIC(18,2) DEFAULT 0,
  sol_net_exchange_flow_usd NUMERIC(18,2) DEFAULT 0, -- negative = accumulation (bullish)

  -- Staking flows
  sol_staked_usd    NUMERIC(18,2) DEFAULT 0,
  sol_unstaked_usd  NUMERIC(18,2) DEFAULT 0,
  net_staking_flow_usd NUMERIC(18,2) DEFAULT 0,     -- positive = net staked (bullish)

  -- Stablecoin flows
  usdc_inflow_usd   NUMERIC(18,2) DEFAULT 0,
  usdc_outflow_usd  NUMERIC(18,2) DEFAULT 0,
  net_usdc_flow_usd NUMERIC(18,2) DEFAULT 0,

  -- DeFi flows
  defi_deposit_usd     NUMERIC(18,2) DEFAULT 0,
  defi_withdrawal_usd  NUMERIC(18,2) DEFAULT 0,
  net_defi_flow_usd    NUMERIC(18,2) DEFAULT 0,

  -- Counts
  large_movements_count INTEGER DEFAULT 0,   -- movements > $50K
  unique_whales_active  INTEGER DEFAULT 0,

  -- Derived sentiment
  market_bias  TEXT,                         -- 'bullish' | 'bearish' | 'neutral'
  bias_score   INTEGER,                      -- -100 (extreme bear) to +100 (extreme bull)

  created_at   TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE (snapshot_time, window_hours)
);

CREATE INDEX idx_snapshots_time ON flow_snapshots(snapshot_time DESC, window_hours);

-- ── alerts v2 ─────────────────────────────────────────────────

CREATE TABLE alerts (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  alert_type TEXT NOT NULL,
  -- 'exchange_spike' | 'accumulation_wave' | 'distribution_wave'
  -- 'staking_shift' | 'defi_rotation' | 'stablecoin_flow'
  -- 'whale_large_move' | 'weekly_report'

  severity   TEXT NOT NULL,         -- 'info' | 'notable' | 'significant' | 'major'

  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  ai_analysis TEXT,

  data       JSONB,                  -- Raw data backing the alert
  movement_ids UUID[],               -- Movements that triggered this

  -- Delivery
  sent_telegram_free    BOOLEAN DEFAULT false,
  sent_telegram_premium BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_type_time ON alerts(alert_type, created_at DESC);
CREATE INDEX idx_alerts_severity  ON alerts(severity, created_at DESC);

-- ── gmgn_smart_money_cache ────────────────────────────────────
-- Cache of smart money feed data (maker field ONLY — never account_address)

CREATE TABLE gmgn_smart_money_cache (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wallet_address TEXT NOT NULL,     -- maker field from GMGN (real wallet owner)
  token_address  TEXT,
  action         TEXT,              -- 'buy' | 'sell'
  amount_usd     NUMERIC(18,2),
  source         TEXT,              -- 'smart_money' | 'kol'
  is_pump_fun    BOOLEAN DEFAULT false,
  gmgn_fetched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_gmgn_wallet ON gmgn_smart_money_cache(wallet_address);
CREATE INDEX idx_gmgn_fetched ON gmgn_smart_money_cache(gmgn_fetched_at DESC);

-- ── user_profiles v2 ─────────────────────────────────────────

CREATE TABLE user_profiles (
  id                 UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  telegram_chat_id   TEXT,
  telegram_username  TEXT,

  alert_min_severity TEXT DEFAULT 'notable',
  -- 'info' | 'notable' | 'significant' | 'major'

  alert_types TEXT[] DEFAULT ARRAY[
    'exchange_spike', 'accumulation_wave', 'whale_large_move'
  ],

  -- Subscription
  tier               TEXT DEFAULT 'free',   -- 'free' | 'pro'
  stripe_customer_id TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- ── seed: exclude list helper view ───────────────────────────
-- Convenience view for classifier — exchange + staking + defi addresses

CREATE OR REPLACE VIEW known_address_map AS
SELECT address, label, category, sub_category
FROM known_addresses
WHERE is_active = true;
