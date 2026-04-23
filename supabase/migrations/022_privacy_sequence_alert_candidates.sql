-- ============================================================
-- SONAR Migration 022 — Privacy Sequence Alert Candidates
-- ============================================================
-- Additive persistence layer for sequence-aware alert candidate logging.
-- This is NOT the final user-facing alert engine.
-- It is an internal intelligence-grade candidate layer.
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_sequence_alert_candidates (
  candidate_id             TEXT PRIMARY KEY,
  sequence_id              TEXT NOT NULL,
  start_event_id           TEXT NOT NULL,
  end_event_id             TEXT NOT NULL,

  token_mint               TEXT,
  token_symbol             TEXT,
  shadow_family_id         TEXT,

  start_stage              TEXT NOT NULL,
  end_stage                TEXT NOT NULL,
  stage_path               TEXT[] NOT NULL DEFAULT '{}',

  candidate_type           TEXT NOT NULL,
  candidate_priority       TEXT NOT NULL DEFAULT 'medium',
  candidate_confidence     INTEGER NOT NULL DEFAULT 0,
  candidate_reason         TEXT,
  candidate_evidence       TEXT[] NOT NULL DEFAULT '{}',

  elapsed_seconds          INTEGER,
  end_event_time           TIMESTAMPTZ NOT NULL,
  methodology_version      TEXT NOT NULL DEFAULT 'privacy_sequence_alert_candidates_v1',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_seq_alert_candidates_time
  ON privacy_sequence_alert_candidates (end_event_time DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_seq_alert_candidates_type
  ON privacy_sequence_alert_candidates (candidate_type, candidate_priority, candidate_confidence DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_seq_alert_candidates_family
  ON privacy_sequence_alert_candidates (shadow_family_id, candidate_confidence DESC)
  WHERE shadow_family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_seq_alert_candidates_token
  ON privacy_sequence_alert_candidates (token_mint, candidate_confidence DESC)
  WHERE token_mint IS NOT NULL;
