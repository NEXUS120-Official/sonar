-- ============================================================
-- SONAR Migration 028 — Joined Intelligence Records
-- ============================================================
-- Canonical persistence layer for FlowJoiner outputs.
-- Buffered/batched intelligence storage, replay-safe oriented.
-- ============================================================

CREATE TABLE IF NOT EXISTS joined_intelligence_records (
  record_id                 TEXT        PRIMARY KEY,
  tx_signature              TEXT        NOT NULL,
  asset_key                 TEXT,
  flow_type                 TEXT,

  token_symbol              TEXT,
  token_program_type        TEXT,

  valuation_status          TEXT        NOT NULL DEFAULT 'unknown',
  valuation_confidence      TEXT        NOT NULL DEFAULT 'unknown',

  privacy_signal            BOOLEAN     NOT NULL DEFAULT FALSE,

  source_exchange           TEXT,
  exchange_lineage_band     TEXT        NOT NULL DEFAULT 'unknown',
  exchange_lineage_confidence INTEGER   NOT NULL DEFAULT 0,

  cluster_id                TEXT,
  cluster_confidence        NUMERIC,

  attribution_confidence    INTEGER     NOT NULL DEFAULT 0,
  linkage_reason            TEXT        NOT NULL,
  evidence_bundle           JSONB       NOT NULL DEFAULT '[]'::jsonb,

  methodology_version       TEXT        NOT NULL DEFAULT 'sovereign_flow_joiner_v1',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_joined_intel_signature
  ON joined_intelligence_records (tx_signature, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_joined_intel_asset_key
  ON joined_intelligence_records (asset_key, created_at DESC)
  WHERE asset_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_joined_intel_exchange
  ON joined_intelligence_records (source_exchange, created_at DESC)
  WHERE source_exchange IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_joined_intel_privacy
  ON joined_intelligence_records (privacy_signal, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_joined_intel_attribution
  ON joined_intelligence_records (attribution_confidence DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_joined_intel_lineage
  ON joined_intelligence_records (exchange_lineage_band, exchange_lineage_confidence DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_joined_intel_cluster
  ON joined_intelligence_records (cluster_id, created_at DESC)
  WHERE cluster_id IS NOT NULL;
