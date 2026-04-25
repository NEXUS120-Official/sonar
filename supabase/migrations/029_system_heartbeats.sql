-- ============================================================
-- SONAR Migration 029 — System Heartbeats
-- ============================================================
-- Operational observability layer for ingest / cron / persistence.
-- One latest row per component, updated via upsert.
-- ============================================================

CREATE TABLE IF NOT EXISTS system_heartbeats (
  component    TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'unknown',
  source       TEXT,
  message      TEXT,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_heartbeats_updated_at
  ON system_heartbeats (updated_at DESC);
