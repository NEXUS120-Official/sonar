-- ============================================================
-- SONAR Migration 020 — Privacy Lifecycle Events Table
-- ============================================================
-- Event-grade persistence for privacy lifecycle transitions.
-- Built from sovereign_signals runtime semantics, but stored as
-- a first-class event table for replay, sequence analysis, and
-- future stream portability.
--
-- Writer: process-flows cron (derived from sovereign buffer)
-- Reader: analytics, future lifecycle timelines, future stream backfill
--
-- Doctrine:
-- - preserve provenance
-- - preserve confidence
-- - preserve exact observed event type
-- - no fabricated transition chains
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_lifecycle_events (
  event_id                    TEXT PRIMARY KEY,
  signature                   TEXT        NOT NULL,
  event_time                  TIMESTAMPTZ NOT NULL,
  persisted_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  event_type                  TEXT        NOT NULL,
  privacy_lifecycle_stage     TEXT        NOT NULL,
  event_confidence            INTEGER     NOT NULL DEFAULT 0 CHECK (event_confidence BETWEEN 0 AND 100),
  event_reason                TEXT,

  token_mint                  TEXT,
  token_symbol                TEXT,
  amount_usd                  NUMERIC(20, 2),

  is_public_side              BOOLEAN     NOT NULL DEFAULT FALSE,
  shadow_source_exchange      TEXT,
  shadow_family_id            TEXT,

  family_member_role          TEXT        NOT NULL DEFAULT 'unknown',
  family_coordination_posture TEXT        NOT NULL DEFAULT 'unknown',
  family_structure_strength   INTEGER     NOT NULL DEFAULT 0,

  methodology_version         TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_time
  ON privacy_lifecycle_events (event_time DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_stage
  ON privacy_lifecycle_events (privacy_lifecycle_stage, event_confidence DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_token
  ON privacy_lifecycle_events (token_mint, event_time DESC)
  WHERE token_mint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_exchange
  ON privacy_lifecycle_events (shadow_source_exchange, event_time DESC)
  WHERE shadow_source_exchange IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_family
  ON privacy_lifecycle_events (shadow_family_id, event_time DESC)
  WHERE shadow_family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_events_public_side
  ON privacy_lifecycle_events (privacy_lifecycle_stage, is_public_side, event_time DESC)
  WHERE is_public_side = TRUE;
