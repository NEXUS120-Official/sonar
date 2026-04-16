-- ============================================================
-- SONAR Migration 009 — Sovereign Schema
-- ============================================================
-- Adds the raw data plane, entity graph, wallet clustering,
-- internal price tracking, and prediction tables.
--
-- These tables run in parallel with the existing application tables.
-- Nothing existing is dropped or altered.
-- The app continues to work exactly as before.
--
-- Philosophy:
--   - raw_* tables = immutable append-only log from on-chain data
--   - entity_* tables = the curated label graph (our moat)
--   - wallet_clusters = behavioral grouping (better than single-whale)
--   - token_prices_internal = our own price derivation (path away from Birdeye)
--   - prediction_* tables = the AI/ML layer (built on OUR data)
-- ============================================================

-- ── Raw Data Plane ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_blocks (
  slot        BIGINT PRIMARY KEY,
  parent_slot BIGINT,
  blockhash   TEXT,
  block_time  TIMESTAMPTZ,
  tx_count    INTEGER,
  raw_json    JSONB,
  source      TEXT NOT NULL DEFAULT 'helius',  -- 'helius' | 'sovereign_rpc'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_blocks_block_time ON raw_blocks (block_time DESC);
CREATE INDEX IF NOT EXISTS idx_raw_blocks_source ON raw_blocks (source);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_transactions (
  signature  TEXT PRIMARY KEY,
  slot       BIGINT NOT NULL,
  block_time TIMESTAMPTZ,
  is_vote    BOOLEAN DEFAULT FALSE,
  status     TEXT,            -- 'success' | 'failed'
  fee        BIGINT,          -- lamports
  raw_json   JSONB,           -- full provider payload
  source     TEXT NOT NULL DEFAULT 'helius_webhook',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_txns_slot      ON raw_transactions (slot DESC);
CREATE INDEX IF NOT EXISTS idx_raw_txns_block_time ON raw_transactions (block_time DESC);
CREATE INDEX IF NOT EXISTS idx_raw_txns_source    ON raw_transactions (source);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS raw_account_updates (
  id            BIGSERIAL PRIMARY KEY,
  pubkey        TEXT NOT NULL,
  slot          BIGINT NOT NULL,
  owner         TEXT,
  lamports      NUMERIC(30,0),
  write_version BIGINT,
  is_startup    BOOLEAN DEFAULT FALSE,
  raw_json      JSONB,
  source        TEXT NOT NULL DEFAULT 'geyser',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_raw_account_pubkey ON raw_account_updates (pubkey, slot DESC);
CREATE INDEX IF NOT EXISTS idx_raw_account_slot   ON raw_account_updates (slot DESC);

-- ── Entity Graph (the label moat) ────────────────────────────

CREATE TABLE IF NOT EXISTS entities (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    TEXT NOT NULL,     -- exchange | protocol | whale | market_maker | bridge | treasury | unknown
  canonical_name TEXT,
  description    TEXT,
  confidence     INTEGER DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  verified       BOOLEAN DEFAULT FALSE,
  source         TEXT,              -- manual | on-chain-analysis | gmgn | helius-label
  metadata       JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities (entity_type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities (canonical_name);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_addresses (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id  UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  chain      TEXT NOT NULL DEFAULT 'solana',
  label      TEXT,              -- specific role: 'hot_wallet' | 'cold_wallet' | 'vault' | 'fee_account'
  confidence INTEGER DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  is_active  BOOLEAN DEFAULT TRUE,
  source     TEXT,
  notes      TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (address, chain)
);

CREATE INDEX IF NOT EXISTS idx_entity_addr_address   ON entity_addresses (address);
CREATE INDEX IF NOT EXISTS idx_entity_addr_entity_id ON entity_addresses (entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_addr_chain     ON entity_addresses (chain, is_active);

-- ── Wallet Clustering ─────────────────────────────────────────
-- Behavioral groups — more powerful than tracking individual wallets.
-- cluster_type examples: accumulator | distributor | staker | rotation | sniper | market_maker

CREATE TABLE IF NOT EXISTS wallet_clusters (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_name   TEXT,
  cluster_type   TEXT NOT NULL,
  methodology    TEXT,          -- description of how this cluster was identified
  avg_trade_usd  NUMERIC(20,2),
  member_count   INTEGER DEFAULT 0,
  is_active      BOOLEAN DEFAULT TRUE,
  last_computed  TIMESTAMPTZ,
  metadata       JSONB,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_clusters_type ON wallet_clusters (cluster_type, is_active);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_cluster_members (
  cluster_id UUID NOT NULL REFERENCES wallet_clusters(id) ON DELETE CASCADE,
  address    TEXT NOT NULL,
  weight     NUMERIC(8,4) DEFAULT 1.0,  -- relative importance in cluster
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (cluster_id, address)
);

CREATE INDEX IF NOT EXISTS idx_cluster_members_address ON wallet_cluster_members (address);

-- ── Internal Price Engine ─────────────────────────────────────
-- Path to price sovereignty: derive prices from pool data, not external APIs.
-- source examples: pool_twap | oracle_switchboard | oracle_pyth | birdeye | jupiter | internal_composite

CREATE TABLE IF NOT EXISTS token_prices_internal (
  id          BIGSERIAL PRIMARY KEY,
  mint        TEXT NOT NULL,
  symbol      TEXT,
  price_usd   NUMERIC(30, 12) NOT NULL,
  source      TEXT NOT NULL,
  confidence  INTEGER DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  pool_address TEXT,           -- if derived from a specific pool
  observed_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_prices_mint       ON token_prices_internal (mint, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_prices_observed   ON token_prices_internal (observed_at DESC);

-- ── Prediction Engine Tables ──────────────────────────────────
-- These tables are built on OUR flow data — not on price feeds.
-- The pipeline: normalized_movements → feature_store → prediction_features → prediction_runs

CREATE TABLE IF NOT EXISTS prediction_features (
  id              BIGSERIAL PRIMARY KEY,
  feature_time    TIMESTAMPTZ NOT NULL,      -- the moment the feature snapshot is for
  horizon         TEXT NOT NULL,             -- '4h' | '24h' | '72h'
  -- SOL Flow features
  exchange_net_flow_usd    NUMERIC(20,2),
  staking_net_flow_usd     NUMERIC(20,2),
  staking_velocity         NUMERIC(10,6),    -- acceleration of staking
  stablecoin_deploy_usd    NUMERIC(20,2),
  defi_rotation_score      NUMERIC(10,4),
  -- Whale behavior features
  large_wallet_concentration NUMERIC(10,4),
  cluster_activity_score   NUMERIC(10,4),
  smart_money_net_bias     NUMERIC(10,4),
  -- Bias index
  bias_score               NUMERIC(10,4),
  bias_confidence          INTEGER,
  -- Extra features (overflow)
  features_json            JSONB,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pred_features_time    ON prediction_features (feature_time DESC);
CREATE INDEX IF NOT EXISTS idx_pred_features_horizon ON prediction_features (horizon, feature_time DESC);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prediction_targets (
  id              BIGSERIAL PRIMARY KEY,
  feature_time    TIMESTAMPTZ NOT NULL,   -- matches prediction_features.feature_time
  horizon         TEXT NOT NULL,
  -- Target values (filled in retrospect)
  price_at_start  NUMERIC(20,8),
  price_at_end    NUMERIC(20,8),
  pct_change      NUMERIC(10,6),
  direction       INTEGER,                -- +1 up, -1 down, 0 flat
  realized_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pred_targets_time    ON prediction_targets (feature_time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pred_targets_uniq ON prediction_targets (feature_time, horizon);

-- ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS prediction_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name    TEXT NOT NULL,        -- 'logistic_v1' | 'gradient_boost_v1' | etc.
  model_version TEXT NOT NULL,
  horizon       TEXT NOT NULL,
  -- Output for this run
  prob_up       NUMERIC(6,4),         -- probability of upward move
  prob_down     NUMERIC(6,4),
  prob_flat     NUMERIC(6,4),
  confidence    INTEGER,
  direction     INTEGER,              -- predicted: +1 | 0 | -1
  top_features  JSONB,                -- feature importances for this prediction
  -- Evaluation (filled after horizon elapses)
  actual_direction INTEGER,
  correct          BOOLEAN,
  evaluated_at     TIMESTAMPTZ,
  -- Metadata
  feature_time  TIMESTAMPTZ NOT NULL,
  predictions   JSONB,               -- full output blob
  metrics       JSONB,               -- batch metrics if this was a batch run
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pred_runs_feature_time ON prediction_runs (feature_time DESC);
CREATE INDEX IF NOT EXISTS idx_pred_runs_model        ON prediction_runs (model_name, horizon);

-- ── Ingest Jobs (dedup + retry tracking) ─────────────────────

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type     TEXT NOT NULL,       -- 'backfill_address' | 'replay_slot_range' | 'sync_entity'
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed
  params       JSONB NOT NULL,
  result       JSONB,
  attempts     INTEGER DEFAULT 0,
  last_error   TEXT,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ingest_jobs_type   ON ingest_jobs (job_type, status);

-- ── Update updated_at on entities automatically ───────────────

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entities_updated_at ON entities;
CREATE TRIGGER entities_updated_at
  BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
