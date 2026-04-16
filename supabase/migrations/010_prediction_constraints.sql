-- ============================================================
-- SONAR Migration 010 — Prediction table unique constraints
-- ============================================================
-- Adds UNIQUE constraints required for upsert operations in
-- build-prediction-features and evaluate-predictions crons.
--
-- Safe to run multiple times (IF NOT EXISTS).
-- ============================================================

-- prediction_features: unique on (feature_time, horizon)
-- Required for: upsert in build-prediction-features cron
CREATE UNIQUE INDEX IF NOT EXISTS idx_pred_features_uniq
  ON prediction_features (feature_time, horizon);

-- prediction_targets: already has unique index from migration 009
-- (idx_pred_targets_uniq ON prediction_targets (feature_time, horizon))
-- Nothing to add here.

-- prediction_runs: no unique constraint needed (we insert new rows per run,
-- duplicates for same feature_time+horizon are filtered in app code).
