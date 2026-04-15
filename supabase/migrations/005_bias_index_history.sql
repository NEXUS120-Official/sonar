-- ============================================================
-- SONAR v2.0 — Bias Index History
-- Migration 005
-- ============================================================
-- Stores one row per process-flows run (every 5 min, 4h window).
-- Used by /api/bias-index/history to serve the BiasChart.
-- ============================================================

CREATE TABLE IF NOT EXISTS bias_index_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  score       INTEGER NOT NULL CHECK (score BETWEEN -100 AND 100),
  bias        TEXT    NOT NULL,
  components  JSONB   NOT NULL,
  confidence  INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  snapshot_id UUID    REFERENCES flow_snapshots(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bias_history_created
  ON bias_index_history(created_at DESC);
