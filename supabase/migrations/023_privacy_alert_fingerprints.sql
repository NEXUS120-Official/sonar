-- ============================================================
-- SONAR Migration 023 — Privacy Alert Fingerprints
-- ============================================================
-- Dedicated persistence layer for privacy alert dedup memory.
-- Stores deterministic fingerprints for recent-history suppression
-- without forcing runtime scans over generic alerts table.
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_alert_fingerprints (
  fingerprint              TEXT        PRIMARY KEY,
  alert_family             TEXT        NOT NULL,
  token_mint               TEXT,
  shadow_family_id         TEXT,
  first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suppression_count        INTEGER     NOT NULL DEFAULT 0,
  methodology_version      TEXT        NOT NULL DEFAULT 'privacy_alert_fingerprint_v1',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_alert_fingerprints_last_seen
  ON privacy_alert_fingerprints (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_alert_fingerprints_family
  ON privacy_alert_fingerprints (alert_family, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_alert_fingerprints_token
  ON privacy_alert_fingerprints (token_mint, last_seen_at DESC)
  WHERE token_mint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_alert_fingerprints_shadow_family
  ON privacy_alert_fingerprints (shadow_family_id, last_seen_at DESC)
  WHERE shadow_family_id IS NOT NULL;
