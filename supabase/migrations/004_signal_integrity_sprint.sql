-- ============================================================
-- SONAR v2.0 — Signal Integrity Sprint Schema Additions
-- Migration 004
-- ============================================================
-- Adds two new columns to flow_snapshots:
--
--   confirmation_count INTEGER
--     How many of the 3 sub-signals (exchange, staking, usdc)
--     agree with the overall market_bias direction.
--     Range: 0–3. High count = strong conviction.
--
--   staking_velocity_pct NUMERIC(8,4)
--     Rate of change in net_staking_flow_usd vs the previous
--     4h snapshot. Positive = staking accelerating (bullish),
--     negative = unstaking accelerating (bearish).
--     NULL for the first snapshot (no prior to compare).
--
-- Both columns are nullable — existing rows keep NULL and
-- the application logic handles NULL gracefully.
-- ============================================================

ALTER TABLE flow_snapshots
  ADD COLUMN IF NOT EXISTS confirmation_count   INTEGER       DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS staking_velocity_pct NUMERIC(8,4)  DEFAULT NULL;

-- Index for time-series queries that filter on confirmation quality
CREATE INDEX IF NOT EXISTS idx_snapshots_confirmation
  ON flow_snapshots(window_hours, confirmation_count, snapshot_time DESC)
  WHERE confirmation_count IS NOT NULL;
