-- ============================================================
-- SONAR Migration 026 — Sovereign Price Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS sovereign_price_registry (
  asset_key           TEXT PRIMARY KEY,
  symbol              TEXT,
  price_usd           DOUBLE PRECISION,
  price_confidence    TEXT NOT NULL DEFAULT 'unknown',
  price_source_mode   TEXT NOT NULL DEFAULT 'sovereign_price_runtime_v1',
  valuation_reason    TEXT,
  raw_snapshot        JSONB,
  last_price_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sovereign_price_enrichment_queue (
  asset_key      TEXT PRIMARY KEY,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sighting_count INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sovereign_price_registry_last_price
  ON sovereign_price_registry (last_price_at DESC);

CREATE INDEX IF NOT EXISTS idx_sovereign_price_queue_status
  ON sovereign_price_enrichment_queue (status, last_seen_at DESC);
