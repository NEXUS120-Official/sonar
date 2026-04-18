-- ============================================================
-- SONAR Migration 015 — Shadow Continuity
-- ============================================================
-- Multi-hop shadow lineage persistence layer (Block 25).
-- Builds on shadow_links (Block 23) to model operational shadow
-- families: gas-funding chains, fan-out behavior, temporal
-- correlation, and downstream privacy activation.
--
-- Two tables:
--   shadow_families   — one row per root wallet (lineage family anchor)
--   shadow_continuity — one row per (parent_wallet, child_wallet) hop
--
-- Writer: shadow-continuity.ts persistContinuityBatch()
-- Reader: future joiner seam, analytics, alert engine
--
-- Doctrine: Source of Truth §3, §8, §11, §16
--   - Preserve provenance, pattern, evidence, confidence tier
--   - No fabricated ownership — behavioral continuity only
--   - family_id is SHA-256 derived from root_wallet (stable across runs)
--   - All upserts are idempotent: safe to re-run on schedule
--
-- Query patterns supported:
--   - all wallets in shadow family X: WHERE family_id = X
--   - all families funded by Binance: WHERE source_exchange = 'Binance'
--   - all families with gas funding + privacy: WHERE has_gas_funding AND has_privacy_activation
--   - all families with fan-out: WHERE has_fan_out = TRUE
--   - all hops that are gas-topups: WHERE is_gas_topup = TRUE
--   - all hops leading to privacy activation: WHERE child_privacy_activated = TRUE
--   - wallet membership lookup: WHERE 'wallet' = ANY(member_wallets)
-- ============================================================

-- ── shadow_families ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shadow_families (
  -- ── Identity ─────────────────────────────────────────────────
  family_id                 TEXT        PRIMARY KEY,
    -- Deterministic SHA-256 hash from root_wallet (stable across runs)

  root_wallet               TEXT        NOT NULL UNIQUE,
    -- The exchange-funded anchor wallet (from shadow_links)

  -- ── Exchange origin ───────────────────────────────────────────
  source_exchange           TEXT,                          -- 'Binance' | 'OKX' | etc.
  source_exchange_wallet    TEXT,                          -- exchange hot wallet address

  -- ── Family membership ─────────────────────────────────────────
  member_wallets            TEXT[]      NOT NULL DEFAULT '{}',
    -- All wallets in this family: [root_wallet, ...children]
  total_members             INTEGER     NOT NULL DEFAULT 0,
  hop_depth                 INTEGER     NOT NULL DEFAULT 0,
    -- Max depth from root (1 = direct children only for v1)

  -- ── Behavioral pattern taxonomy ───────────────────────────────
  patterns                  TEXT[]      NOT NULL DEFAULT '{}',
    -- ContinuityPattern values observed in this family
  continuity_reasons        TEXT[]      NOT NULL DEFAULT '{}',
    -- Human-readable per-hop linkage reasons
  evidence                  TEXT[]      NOT NULL DEFAULT '{}',

  -- ── Confidence ────────────────────────────────────────────────
  confidence                INTEGER     NOT NULL DEFAULT 0
                              CHECK (confidence BETWEEN 0 AND 100),
  confidence_tier           TEXT        NOT NULL DEFAULT 'unknown',
    -- 'direct_proof' | 'strong_evidence' | 'moderate_evidence'
    -- | 'weak_association' | 'unknown'

  -- ── Intelligence facets (analytics shortcuts) ─────────────────
  has_privacy_activation    BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Any child wallet activated confidential transfer post-receipt
  has_token2022_activity    BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Any child wallet used Token-2022 post-receipt
  has_gas_funding           BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Root made at least one gas-topup transfer
  has_fan_out               BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Root funded >= 3 child wallets
  has_fan_in                BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Future: multiple parents converge on one sink (cross-family)
  has_temporal_correlation  BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Any two sibling transfers within 5-minute window

  -- ── Temporal range ────────────────────────────────────────────
  earliest_activity         TIMESTAMPTZ,
  latest_activity           TIMESTAMPTZ,

  -- ── Provenance ───────────────────────────────────────────────
  methodology_version       TEXT        NOT NULL DEFAULT 'shadow_continuity_v1',
  first_detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── shadow_continuity ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shadow_continuity (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Family linkage ────────────────────────────────────────────
  family_id                 TEXT        NOT NULL REFERENCES shadow_families(family_id),

  -- ── Hop identity ─────────────────────────────────────────────
  parent_wallet             TEXT        NOT NULL,   -- source (shadow root or intermediate)
  child_wallet              TEXT        NOT NULL,   -- destination (newly discovered member)
  hop_depth                 INTEGER     NOT NULL,   -- 1 = direct child of root

  -- ── Pattern ───────────────────────────────────────────────────
  pattern                   TEXT        NOT NULL,
    -- ContinuityPattern: 'gas_funding' | 'fan_out' | 'downstream_privacy' | etc.

  -- ── Transfer evidence ─────────────────────────────────────────
  transfer_signature        TEXT,                  -- on-chain proof
  transfer_time             TIMESTAMPTZ,
  transfer_amount_sol       NUMERIC(20, 9),        -- SOL amount (null if not SOL)
  transfer_amount_usd       NUMERIC(20, 2),
  is_gas_topup              BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Parent context ────────────────────────────────────────────
  parent_has_shadow_link    BOOLEAN     NOT NULL DEFAULT FALSE,
  parent_shadow_exchange    TEXT,
  parent_shadow_confidence  INTEGER,

  -- ── Child downstream behavior ─────────────────────────────────
  child_privacy_activated   BOOLEAN     NOT NULL DEFAULT FALSE,
  child_token2022_active    BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Evidence ─────────────────────────────────────────────────
  evidence                  TEXT[]      NOT NULL DEFAULT '{}',
  linkage_reason            TEXT        NOT NULL,

  -- ── Confidence ────────────────────────────────────────────────
  confidence                INTEGER     NOT NULL DEFAULT 0
                              CHECK (confidence BETWEEN 0 AND 100),
  confidence_tier           TEXT        NOT NULL DEFAULT 'unknown',

  -- ── Provenance ───────────────────────────────────────────────
  methodology_version       TEXT        NOT NULL DEFAULT 'shadow_continuity_v1',
  first_detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One hop record per wallet pair — upsert on conflict
  UNIQUE (parent_wallet, child_wallet)
);

-- ── Indexes: shadow_families ─────────────────────────────────

-- Confidence ranking (top families)
CREATE INDEX IF NOT EXISTS idx_shadow_families_confidence
  ON shadow_families (confidence DESC, confidence_tier);

-- Exchange-origin analytics
CREATE INDEX IF NOT EXISTS idx_shadow_families_exchange
  ON shadow_families (source_exchange, confidence DESC)
  WHERE source_exchange IS NOT NULL;

-- Privacy-activated families
CREATE INDEX IF NOT EXISTS idx_shadow_families_privacy
  ON shadow_families (has_privacy_activation, has_gas_funding, confidence DESC)
  WHERE has_privacy_activation = TRUE;

-- Fan-out families
CREATE INDEX IF NOT EXISTS idx_shadow_families_fan_out
  ON shadow_families (has_fan_out, total_members DESC)
  WHERE has_fan_out = TRUE;

-- Gas-funding families
CREATE INDEX IF NOT EXISTS idx_shadow_families_gas
  ON shadow_families (has_gas_funding, confidence DESC)
  WHERE has_gas_funding = TRUE;

-- Temporal correlation (machine-like families)
CREATE INDEX IF NOT EXISTS idx_shadow_families_temporal
  ON shadow_families (has_temporal_correlation, confidence DESC)
  WHERE has_temporal_correlation = TRUE;

-- Temporal range queries
CREATE INDEX IF NOT EXISTS idx_shadow_families_activity
  ON shadow_families (latest_activity DESC NULLS LAST);

-- GIN: member wallet containment — find all families containing a wallet
-- e.g. WHERE 'wallet_addr' = ANY(member_wallets)
CREATE INDEX IF NOT EXISTS idx_shadow_families_member_wallets
  ON shadow_families USING GIN (member_wallets);

-- GIN: pattern containment
-- e.g. WHERE 'gas_funding' = ANY(patterns)
CREATE INDEX IF NOT EXISTS idx_shadow_families_patterns
  ON shadow_families USING GIN (patterns);

-- ── Indexes: shadow_continuity ───────────────────────────────

-- Family member lookup
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_family
  ON shadow_continuity (family_id, hop_depth);

-- Parent-centric (fan-out analysis)
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_parent
  ON shadow_continuity (parent_wallet, confidence DESC);

-- Child-centric (fan-in analysis, lineage tracing backwards)
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_child
  ON shadow_continuity (child_wallet, confidence DESC);

-- Gas-topup universe
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_gas
  ON shadow_continuity (is_gas_topup, confidence DESC)
  WHERE is_gas_topup = TRUE;

-- Privacy-downstream hops
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_privacy
  ON shadow_continuity (child_privacy_activated, confidence DESC)
  WHERE child_privacy_activated = TRUE;

-- Exchange-origin lineage
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_exchange
  ON shadow_continuity (parent_shadow_exchange, confidence DESC)
  WHERE parent_shadow_exchange IS NOT NULL;

-- Temporal ordering within families
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_transfer_time
  ON shadow_continuity (transfer_time DESC NULLS LAST);

-- GIN: evidence containment
CREATE INDEX IF NOT EXISTS idx_shadow_continuity_evidence
  ON shadow_continuity USING GIN (evidence);

-- ── Auto-update last_updated_at ───────────────────────────────

CREATE OR REPLACE FUNCTION update_shadow_families_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shadow_families_updated_at ON shadow_families;
CREATE TRIGGER shadow_families_updated_at
  BEFORE UPDATE ON shadow_families
  FOR EACH ROW EXECUTE FUNCTION update_shadow_families_updated_at();

CREATE OR REPLACE FUNCTION update_shadow_continuity_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shadow_continuity_updated_at ON shadow_continuity;
CREATE TRIGGER shadow_continuity_updated_at
  BEFORE UPDATE ON shadow_continuity
  FOR EACH ROW EXECUTE FUNCTION update_shadow_continuity_updated_at();
