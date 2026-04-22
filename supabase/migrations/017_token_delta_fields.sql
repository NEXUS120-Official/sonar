-- ============================================================
-- SONAR Migration 017 — Token Delta Analysis Fields
-- ============================================================
-- Additive: 3 new columns on sovereign_signals for Block 28
-- token delta pattern classification and asymmetry detection.
--
-- Writer: persistence-manager.ts convertSignalToPayload()
-- Reader: alert-engine.ts, token-analytics.ts, analytics
--
-- token_delta_pattern: NULL = no token movement in this signal.
-- Boolean flags default FALSE — safe for WHERE filters without NULLs.
--
-- Doctrine: Source of Truth §3, §8, §16
--   - Flat columns for O(1) scan (no JSONB unwrapping)
--   - Cautious labelling — "consistent with" not "is"
-- ============================================================

ALTER TABLE sovereign_signals
  ADD COLUMN IF NOT EXISTS token_delta_pattern            TEXT,
  ADD COLUMN IF NOT EXISTS has_asymmetric_token_delta     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS possible_transfer_fee_behavior BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Indexes ────────────────────────────────────────────────────

-- Asymmetric delta universe — useful for tuning fee-detection thresholds
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_asymmetric_delta
  ON sovereign_signals (token_delta_pattern, has_asymmetric_token_delta)
  WHERE has_asymmetric_token_delta = TRUE;

-- Possible transfer-fee behavior — cross-reference with has_transfer_fee
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_possible_fee
  ON sovereign_signals (possible_transfer_fee_behavior, is_token_2022)
  WHERE possible_transfer_fee_behavior = TRUE;

-- Delta pattern distribution — fast enumeration by pattern value
CREATE INDEX IF NOT EXISTS idx_sovereign_signals_delta_pattern
  ON sovereign_signals (token_delta_pattern)
  WHERE token_delta_pattern IS NOT NULL;
