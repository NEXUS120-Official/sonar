-- ============================================================
-- SONAR Migration 013 — Sovereign Signals
-- ============================================================
-- Durable, queryable persistence layer for EnrichedSovereignSignal
-- output from the Sovereign Flow Joiner (Block 21).
--
-- This table is the persistence spine of the sovereign intelligence
-- machine. Every enriched signal written here is:
--   - replayable (signature + raw decoded slices preserved)
--   - analytically queryable (flat columns, GIN-indexed arrays)
--   - future-ready (shape maps 1:1 to ClickHouse column schema)
--   - confidence-aware (signal_score + signal_confidence stored)
--
-- Writer:   SovereignPersistenceManager (persistence-manager.ts)
-- Reader:   future alert engine, backtesting, lineage analysis
-- Doctrine: Source of Truth §3, §8, §16, §17
--
-- Retention note: this table grows proportionally to on-chain
-- activity. Partition by block_time (monthly) when row count
-- exceeds ~10M for ClickHouse migration compatibility.
-- ============================================================

CREATE TABLE IF NOT EXISTS sovereign_signals (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  signature             TEXT         NOT NULL UNIQUE,   -- tx signature (replay key)
  persisted_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  enriched_at           TIMESTAMPTZ  NOT NULL,
  methodology_version   TEXT         NOT NULL DEFAULT 'flow_joiner_v1',

  -- ── Temporal ─────────────────────────────────────────────────
  block_time            TIMESTAMPTZ,

  -- ── Core movement identity ────────────────────────────────────
  from_address          TEXT,
  to_address            TEXT,
  amount_token          NUMERIC(40, 12),
  amount_usd            NUMERIC(20, 2),
  token_mint            TEXT,
  token_symbol          TEXT,
  flow_type             TEXT,   -- FlowType union
  flow_direction        TEXT,   -- 'inflow' | 'outflow' | 'internal'
  exchange              TEXT,
  protocol              TEXT,

  -- ── Entity attribution (flat for SQL queryability) ────────────
  from_entity_name        TEXT,
  from_entity_type        TEXT,
  from_entity_confidence  INTEGER NOT NULL DEFAULT 0,
  from_entity_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  to_entity_name          TEXT,
  to_entity_type          TEXT,
  to_entity_confidence    INTEGER NOT NULL DEFAULT 0,
  to_entity_verified      BOOLEAN NOT NULL DEFAULT FALSE,
  whale_entity_name       TEXT,
  whale_entity_type       TEXT,
  whale_entity_confidence INTEGER NOT NULL DEFAULT 0,
  whale_entity_verified   BOOLEAN NOT NULL DEFAULT FALSE,

  -- ── Token security posture ────────────────────────────────────
  token_program_type           TEXT    NOT NULL DEFAULT 'unknown',
  is_token_2022                BOOLEAN NOT NULL DEFAULT FALSE,
  has_transfer_fee             BOOLEAN NOT NULL DEFAULT FALSE,
  has_confidential_transfer    BOOLEAN NOT NULL DEFAULT FALSE,
  has_transfer_hook            BOOLEAN NOT NULL DEFAULT FALSE,
  has_permanent_delegate       BOOLEAN NOT NULL DEFAULT FALSE,
  has_auditor_key              BOOLEAN NOT NULL DEFAULT FALSE,
  token_security_confidence    TEXT    NOT NULL DEFAULT 'low',
  token_risk_flags             TEXT[]  NOT NULL DEFAULT '{}',
  fog_piercing_notes           TEXT[]  NOT NULL DEFAULT '{}',

  -- ── Cluster context ───────────────────────────────────────────
  cluster_id            TEXT,
  cluster_type          TEXT,
  cluster_name          TEXT,

  -- ── Shadow / CEX-origin lineage ───────────────────────────────
  -- Populated by Block 23 (CEX-to-Shadow Linker).
  -- Scaffolded here so the schema does not change at Block 23.
  has_shadow_link           BOOLEAN NOT NULL DEFAULT FALSE,
  shadow_source_exchange    TEXT,
  shadow_confidence         INTEGER,
  shadow_linkage_reason     TEXT,

  -- ── Signal quality (Source of Truth §16) ─────────────────────
  signal_score          INTEGER NOT NULL DEFAULT 0,
  signal_confidence     TEXT    NOT NULL DEFAULT 'unknown',
  evidence              TEXT[]  NOT NULL DEFAULT '{}',
  attribution_reason    TEXT,

  -- ── Replay traceability ───────────────────────────────────────
  -- Raw decoded movement slices stored as JSONB.
  -- Enables replay without re-fetching from RPC / Helius archive.
  raw_movement          JSONB,
  raw_token_movement    JSONB,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes for analytics interrogation ──────────────────────

-- Time-series: most queries are time-range scans
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_block_time
  ON sovereign_signals (block_time DESC NULLS LAST);

-- Address-based lineage queries (both directions)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_from_addr
  ON sovereign_signals (from_address, block_time DESC)
  WHERE from_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_to_addr
  ON sovereign_signals (to_address, block_time DESC)
  WHERE to_address IS NOT NULL;

-- Token-universe filtering
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_token_mint
  ON sovereign_signals (token_mint, block_time DESC)
  WHERE token_mint IS NOT NULL;

-- Signal quality ranking (alert engine: score ≥ threshold)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_score
  ON sovereign_signals (signal_score DESC, block_time DESC);

-- Confidence tier filtering
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_confidence
  ON sovereign_signals (signal_confidence, block_time DESC);

-- Token-2022 / privacy signal universe
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_privacy
  ON sovereign_signals (is_token_2022, has_confidential_transfer, has_auditor_key)
  WHERE is_token_2022 = TRUE;

-- Shadow / CEX-origin lineage queries (Block 23)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_shadow
  ON sovereign_signals (has_shadow_link, shadow_source_exchange)
  WHERE has_shadow_link = TRUE;

-- Cohort evolution queries
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_cluster
  ON sovereign_signals (cluster_type, block_time DESC)
  WHERE cluster_type IS NOT NULL;

-- Entity-named signals (verified exchange/protocol hits)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_entity
  ON sovereign_signals (from_entity_type, to_entity_type, from_entity_verified);

-- GIN indexes for array containment queries
-- e.g. WHERE 'freeze_authority' = ANY(token_risk_flags)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_risk_flags
  ON sovereign_signals USING GIN (token_risk_flags);

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_fog_notes
  ON sovereign_signals USING GIN (fog_piercing_notes);

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_evidence
  ON sovereign_signals USING GIN (evidence);
