-- ============================================================
-- SONAR Migration 024 — Privacy Alert Suppression Receipts
-- ============================================================
-- Audit-grade explainability layer for suppressed privacy alerts.
-- Stores why an alert was suppressed, under which policy family,
-- and with which fingerprint/cooldown context.
-- ============================================================

CREATE TABLE IF NOT EXISTS privacy_alert_suppression_receipts (
  receipt_id                TEXT        PRIMARY KEY,
  fingerprint               TEXT        NOT NULL,
  alert_family              TEXT        NOT NULL,
  candidate_alert_type      TEXT        NOT NULL,
  token_mint                TEXT,
  shadow_family_id          TEXT,
  suppression_reason        TEXT        NOT NULL,
  cooldown_hours            INTEGER,
  last_seen_at              TIMESTAMPTZ,
  suppressed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  methodology_version       TEXT        NOT NULL DEFAULT 'privacy_alert_suppression_receipt_v1',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privacy_suppression_receipts_suppressed_at
  ON privacy_alert_suppression_receipts (suppressed_at DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_suppression_receipts_family
  ON privacy_alert_suppression_receipts (alert_family, suppressed_at DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_suppression_receipts_fingerprint
  ON privacy_alert_suppression_receipts (fingerprint, suppressed_at DESC);

CREATE INDEX IF NOT EXISTS idx_privacy_suppression_receipts_token
  ON privacy_alert_suppression_receipts (token_mint, suppressed_at DESC)
  WHERE token_mint IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_privacy_suppression_receipts_shadow_family
  ON privacy_alert_suppression_receipts (shadow_family_id, suppressed_at DESC)
  WHERE shadow_family_id IS NOT NULL;
