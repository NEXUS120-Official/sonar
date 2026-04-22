-- ============================================================
-- SONAR Migration 019 — Family Semantics Fields
-- ============================================================
-- Additive: deeper family semantics on sovereign_signals.
-- Derived from existing shadow family context in the joiner.
--
-- Writer: persistence-manager.ts convertSignalToPayload()
-- Reader: analytics, future dashboard surfaces, future family ranking
--
-- Doctrine:
-- - behavioral intelligence, not fabricated ownership
-- - flat queryable persistence
-- - confidence-weighted family semantics
-- ============================================================

ALTER TABLE sovereign_signals
  ADD COLUMN IF NOT EXISTS family_member_role          TEXT    NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS family_coordination_posture TEXT    NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS family_structure_strength   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS family_pattern_count        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS family_reason_count         INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_family_role
  ON sovereign_signals (family_member_role, shadow_family_confidence DESC)
  WHERE shadow_family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_family_posture
  ON sovereign_signals (family_coordination_posture, family_structure_strength DESC)
  WHERE shadow_family_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sovereign_signals_family_strength
  ON sovereign_signals (family_structure_strength DESC, shadow_family_confidence DESC)
  WHERE shadow_family_id IS NOT NULL;
