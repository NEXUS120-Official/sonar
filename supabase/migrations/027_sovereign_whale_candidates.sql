-- ============================================================
-- SONAR Migration 027 — Sovereign Whale Candidates
-- ============================================================
-- Persistence layer for sovereign/provider-agnostic whale discovery.
-- Supports discovery method, exchange-origin hints, valuation
-- completeness, and future ranking / cluster intelligence.
-- ============================================================

CREATE TABLE IF NOT EXISTS sovereign_whale_candidates (
  address                        TEXT        PRIMARY KEY,
  discovery_method               TEXT        NOT NULL,
  source_exchange                TEXT,
  triggering_signature           TEXT,
  first_seen_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence_count                 INTEGER     NOT NULL DEFAULT 1,
  estimated_balance_usd          NUMERIC,
  priced_component_count         INTEGER     NOT NULL DEFAULT 0,
  unpriced_component_count       INTEGER     NOT NULL DEFAULT 0,
  valuation_completeness_ratio   NUMERIC     NOT NULL DEFAULT 0,
  valuation_status               TEXT        NOT NULL DEFAULT 'unknown',
  confidence_score               INTEGER     NOT NULL DEFAULT 0,
  linkage_reason                 TEXT        NOT NULL,
  methodology_version            TEXT        NOT NULL DEFAULT 'sovereign_whale_discovery_v1',
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sovereign_whale_candidates_first_seen
  ON sovereign_whale_candidates (first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_sovereign_whale_candidates_exchange
  ON sovereign_whale_candidates (source_exchange, first_seen_at DESC)
  WHERE source_exchange IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sovereign_whale_candidates_confidence
  ON sovereign_whale_candidates (confidence_score DESC, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_sovereign_whale_candidates_valuation
  ON sovereign_whale_candidates (
    valuation_status,
    valuation_completeness_ratio DESC,
    first_seen_at DESC
  );
