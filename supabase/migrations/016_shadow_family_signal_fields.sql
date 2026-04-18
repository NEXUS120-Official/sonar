-- ============================================================
-- SONAR Migration 016 — Shadow Family Fields on sovereign_signals
-- ============================================================
-- Additive: adds 16 shadow_family_* columns to sovereign_signals.
-- All columns are nullable — existing rows get NULL defaults.
-- Safe to re-run: all statements use IF NOT EXISTS / safe ALTER.
--
-- Writer: persistence-manager.ts createSupabaseFlushFn()
-- Reader: alert-engine.ts, analytics, alert enrichment
--
-- Doctrine: Source of Truth §3, §8, §16
--   - Flat column layout for O(1) column scan (no JSONB unwrap needed)
--   - All array columns are TEXT[] (GIN-indexable)
--   - Boolean facets default FALSE (not null) — safe for WHERE filters
-- ============================================================

ALTER TABLE sovereign_signals
  ADD COLUMN IF NOT EXISTS shadow_family_id                     TEXT,
  ADD COLUMN IF NOT EXISTS shadow_family_root_wallet            TEXT,
  ADD COLUMN IF NOT EXISTS shadow_family_source_exchange        TEXT,
  ADD COLUMN IF NOT EXISTS shadow_family_source_exchange_wallet TEXT,
  ADD COLUMN IF NOT EXISTS shadow_family_total_members          INTEGER,
  ADD COLUMN IF NOT EXISTS shadow_family_hop_depth              INTEGER,
  ADD COLUMN IF NOT EXISTS shadow_family_confidence             INTEGER,
  ADD COLUMN IF NOT EXISTS shadow_family_confidence_tier        TEXT,
  ADD COLUMN IF NOT EXISTS shadow_family_patterns               TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS shadow_family_continuity_reasons     TEXT[]  NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS shadow_family_has_privacy_activation BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shadow_family_has_token2022_activity BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shadow_family_has_gas_funding        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shadow_family_has_fan_out            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shadow_family_has_fan_in             BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS shadow_family_has_temporal_correlation BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Indexes ───────────────────────────────────────────────────

-- Family membership lookup (join sovereign_signals → shadow_families)
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_shadow_family_id
  ON sovereign_signals (shadow_family_id)
  WHERE shadow_family_id IS NOT NULL;

-- Fan-out families in signal stream
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_shadow_family_fan_out
  ON sovereign_signals (shadow_family_id, shadow_family_confidence DESC)
  WHERE shadow_family_has_fan_out = TRUE;

-- Gas-funding chains in signal stream
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_shadow_family_gas
  ON sovereign_signals (shadow_family_id, shadow_family_confidence DESC)
  WHERE shadow_family_has_gas_funding = TRUE;

-- Privacy-activated families in signal stream
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_shadow_family_privacy
  ON sovereign_signals (shadow_family_id, shadow_family_confidence DESC)
  WHERE shadow_family_has_privacy_activation = TRUE;
