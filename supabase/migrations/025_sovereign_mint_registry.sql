-- ============================================================
-- SONAR Migration 025 — Sovereign Mint Registry
-- ============================================================

CREATE TABLE IF NOT EXISTS sovereign_mint_registry (
  mint                     TEXT PRIMARY KEY,
  symbol                   TEXT,
  name                     TEXT,
  decimals                 INTEGER,
  token_program            TEXT NOT NULL DEFAULT 'unknown',
  is_token_2022            BOOLEAN NOT NULL DEFAULT FALSE,
  has_transfer_fee         BOOLEAN NOT NULL DEFAULT FALSE,
  has_transfer_hook        BOOLEAN NOT NULL DEFAULT FALSE,
  has_confidential_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  has_auditor_key          BOOLEAN NOT NULL DEFAULT FALSE,
  has_freeze_authority     BOOLEAN NOT NULL DEFAULT FALSE,
  metadata_source_mode     TEXT NOT NULL DEFAULT 'sovereign_mint_scanner_v1',
  enrichment_confidence    TEXT NOT NULL DEFAULT 'low',
  risk_flags               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  raw_snapshot             JSONB,
  last_enriched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sovereign_mint_enrichment_queue (
  mint           TEXT PRIMARY KEY,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sighting_count INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'pending',
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sovereign_mint_registry_last_enriched
  ON sovereign_mint_registry (last_enriched_at DESC);

CREATE INDEX IF NOT EXISTS idx_sovereign_mint_registry_token_program
  ON sovereign_mint_registry (token_program, last_enriched_at DESC);

CREATE INDEX IF NOT EXISTS idx_sovereign_mint_queue_status
  ON sovereign_mint_enrichment_queue (status, last_seen_at DESC);
