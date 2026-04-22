-- ============================================================
-- SONAR Migration 018 — Privacy Lifecycle Fields
-- ============================================================
-- Additive: canonical privacy lifecycle fields on sovereign_signals.
-- These persist runtime privacy semantics into queryable flat columns.
--
-- Writer: persistence-manager.ts convertSignalToPayload()
-- Reader: analytics, future dashboards, future lifecycle query surfaces
--
-- Doctrine:
-- - flat columns for O(1) scan
-- - replay-safe persistence of privacy lifecycle semantics
-- - confidence-scored, non-binary, non-hype storage
-- ============================================================

ALTER TABLE sovereign_signals
  ADD COLUMN IF NOT EXISTS privacy_lifecycle_stage            TEXT    NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS privacy_lifecycle_confidence       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS privacy_lifecycle_reason           TEXT,
  ADD COLUMN IF NOT EXISTS privacy_public_side                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS privacy_reemergence_family_context BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_privacy_stage
  ON sovereign_signals (privacy_lifecycle_stage);

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_privacy_public_side
  ON sovereign_signals (privacy_lifecycle_stage, privacy_public_side)
  WHERE privacy_public_side = TRUE;

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_privacy_family_reemergence
  ON sovereign_signals (privacy_lifecycle_stage, shadow_family_id, shadow_family_confidence DESC)
  WHERE privacy_reemergence_family_context = TRUE;
