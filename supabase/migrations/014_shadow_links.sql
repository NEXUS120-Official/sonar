-- ============================================================
-- SONAR Migration 014 — Shadow Links
-- ============================================================
-- Durable persistence for CEX-to-Shadow Linker output (Block 23).
-- Each row represents a detected exchange-origin funding relationship
-- with confidence scoring and downstream privacy/Token-2022 evidence.
--
-- This table is the foundational moat layer for shadow lineage
-- intelligence. It enables:
--   - joiner: has_shadow_link / shadow_context for EnrichedSovereignSignal
--   - sovereign_signals: shadow columns populated for historical signals
--   - future alert engine: shadow-linked signal boosting
--   - future analytics: exchange-origin lineage / cluster correlation
--
-- Writer:  shadow-linker.ts persistShadowLinkBatch()
-- Reader:  shadow-linker.ts loadJoinerShadowMap()
--
-- Doctrine: Source of Truth §3, §8, §11 — preserve provenance,
-- timing gap, evidence type, and confidence tier.
--
-- Retention: rows are immutable once written.
-- last_updated_at updates when confidence or privacy_activated changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS shadow_links (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ── Identity ────────────────────────────────────────────────
  target_wallet           TEXT        NOT NULL,    -- recipient wallet (the shadow candidate)
  funding_signature       TEXT        NOT NULL,    -- tx signature (on-chain proof of funding event)
  methodology_version     TEXT        NOT NULL DEFAULT 'shadow_linker_v1',

  -- ── Exchange origin ──────────────────────────────────────────
  source_exchange         TEXT        NOT NULL,    -- 'Binance' | 'OKX' | etc.
  exchange_wallet         TEXT        NOT NULL,    -- exchange hot wallet address

  -- ── Funding event ────────────────────────────────────────────
  funding_time            TIMESTAMPTZ NOT NULL,
  funding_amount_usd      NUMERIC(20,2),

  -- ── Recipient novelty ────────────────────────────────────────
  prior_movement_count    INTEGER     NOT NULL DEFAULT 0,
  is_novel_wallet         BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Privacy / Token-2022 activation ──────────────────────────
  privacy_activated           BOOLEAN     NOT NULL DEFAULT FALSE,
  privacy_activation_time     TIMESTAMPTZ,
  time_gap_seconds            INTEGER,              -- funding → first privacy activation
  activated_mints             TEXT[]      NOT NULL DEFAULT '{}',
  has_confidential_transfer   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Evidence ─────────────────────────────────────────────────
  evidence_type           TEXT        NOT NULL DEFAULT 'exchange_funding_historical',
  evidence                TEXT[]      NOT NULL DEFAULT '{}',
  linkage_reason          TEXT        NOT NULL,
  entity_verified         BOOLEAN     NOT NULL DEFAULT FALSE,

  -- ── Confidence (Source of Truth §16) ─────────────────────────
  confidence              INTEGER     NOT NULL DEFAULT 0
                            CHECK (confidence BETWEEN 0 AND 100),
  confidence_tier         TEXT        NOT NULL DEFAULT 'unknown',
    -- 'direct_proof' | 'strong_evidence' | 'moderate_evidence'
    -- | 'weak_association' | 'unknown'

  -- ── Timestamps ───────────────────────────────────────────────
  first_detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Deduplication: one row per (wallet, funding_tx) pair
  UNIQUE (target_wallet, funding_signature)
);

-- ── Indexes for analytics interrogation ──────────────────────

-- Primary lookup for joiner: addresses → shadow links
CREATE INDEX IF NOT EXISTS idx_shadow_links_target_wallet
  ON shadow_links (target_wallet, confidence DESC);

-- Exchange-centric analysis: all wallets funded by a given exchange
CREATE INDEX IF NOT EXISTS idx_shadow_links_exchange
  ON shadow_links (source_exchange, confidence DESC, funding_time DESC);

-- Quality filtering: only high/strong confidence links
CREATE INDEX IF NOT EXISTS idx_shadow_links_confidence
  ON shadow_links (confidence DESC, confidence_tier);

-- Temporal analysis: exchange funding event timeline
CREATE INDEX IF NOT EXISTS idx_shadow_links_funding_time
  ON shadow_links (funding_time DESC);

-- Privacy universe: wallets that activated privacy post-funding
CREATE INDEX IF NOT EXISTS idx_shadow_links_privacy
  ON shadow_links (privacy_activated, has_confidential_transfer, funding_time DESC)
  WHERE privacy_activated = TRUE;

-- Novel wallet universe
CREATE INDEX IF NOT EXISTS idx_shadow_links_novel
  ON shadow_links (is_novel_wallet, confidence DESC)
  WHERE is_novel_wallet = TRUE;

-- Exchange wallet lineage: which exchange addresses are most active
CREATE INDEX IF NOT EXISTS idx_shadow_links_exchange_wallet
  ON shadow_links (exchange_wallet, funding_time DESC);

-- GIN for activated_mints containment queries
-- e.g. WHERE 'SomeToken2022Mint...' = ANY(activated_mints)
CREATE INDEX IF NOT EXISTS idx_shadow_links_activated_mints
  ON shadow_links USING GIN (activated_mints);

-- Auto-update last_updated_at on any change
CREATE OR REPLACE FUNCTION update_shadow_links_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.last_updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS shadow_links_updated_at ON shadow_links;
CREATE TRIGGER shadow_links_updated_at
  BEFORE UPDATE ON shadow_links
  FOR EACH ROW EXECUTE FUNCTION update_shadow_links_updated_at();
