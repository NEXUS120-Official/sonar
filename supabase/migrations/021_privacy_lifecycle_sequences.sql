-- ============================================================
-- SONAR Migration 021 — Privacy Lifecycle Sequences
-- ============================================================
-- Additive: causal sequence layer built from privacy_lifecycle_events.
-- Replay-safe, idempotent, event-derived, queryable.
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_lifecycle_sequences (
  sequence_id                 TEXT PRIMARY KEY,
  start_event_id              TEXT NOT NULL,
  end_event_id                TEXT NOT NULL,

  start_signature             TEXT NOT NULL,
  end_signature               TEXT NOT NULL,

  token_mint                  TEXT,
  token_symbol                TEXT,
  shadow_family_id            TEXT,

  start_stage                 TEXT NOT NULL,
  end_stage                   TEXT NOT NULL,
  stage_path                  TEXT[] NOT NULL DEFAULT '{}',

  sequence_confidence         INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds             INTEGER,
  sequence_reason             TEXT,

  start_event_time            TIMESTAMPTZ NOT NULL,
  end_event_time              TIMESTAMPTZ NOT NULL,

  methodology_version         TEXT NOT NULL DEFAULT 'privacy_sequence_engine_v1',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (sequence_confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_sequences_token
  ON privacy_lifecycle_sequences (token_mint, end_event_time DESC)
  WHERE token_mint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_sequences_family
  ON privacy_lifecycle_sequences (shadow_family_id, end_event_time DESC)
  WHERE shadow_family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_sequences_stage_pair
  ON privacy_lifecycle_sequences (start_stage, end_stage, end_event_time DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_sequences_end_time
  ON privacy_lifecycle_sequences (end_event_time DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_lifecycle_sequences_stage_path
  ON privacy_lifecycle_sequences USING GIN (stage_path);
