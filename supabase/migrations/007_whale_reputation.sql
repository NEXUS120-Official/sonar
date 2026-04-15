-- ============================================================
-- SONAR v2.0 — Whale Reputation System
-- Migration 007
-- ============================================================
-- Tracks per-whale prediction quality over a rolling 30-day window.
-- Stores individual resolved signal outcomes for each whale movement.
-- ============================================================

ALTER TABLE whales ADD COLUMN IF NOT EXISTS reputation_score    NUMERIC DEFAULT 0.5;
ALTER TABLE whales ADD COLUMN IF NOT EXISTS signal_count_30d    INTEGER DEFAULT 0;
ALTER TABLE whales ADD COLUMN IF NOT EXISTS hit_rate_30d        NUMERIC DEFAULT 0.5;
ALTER TABLE whales ADD COLUMN IF NOT EXISTS mean_return_30d     NUMERIC DEFAULT 0;
ALTER TABLE whales ADD COLUMN IF NOT EXISTS last_reputation_at  TIMESTAMPTZ;
ALTER TABLE whales ADD COLUMN IF NOT EXISTS smart_money_flag    BOOLEAN DEFAULT false;

-- Stores individual resolved signal outcomes for each whale movement
CREATE TABLE IF NOT EXISTS whale_signal_outcomes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  whale_id        UUID NOT NULL REFERENCES whales(id) ON DELETE CASCADE,
  movement_id     UUID REFERENCES movements(id) ON DELETE SET NULL,
  alert_id        UUID REFERENCES alerts(id) ON DELETE SET NULL,
  signal_direction TEXT NOT NULL CHECK (signal_direction IN ('bullish','bearish','neutral')),
  signal_time     TIMESTAMPTZ NOT NULL,
  price_at_signal NUMERIC,
  price_5m        NUMERIC,
  price_15m       NUMERIC,
  price_1h        NUMERIC,
  price_4h        NUMERIC,
  return_5m       NUMERIC,   -- (price_5m - price_at_signal) / price_at_signal
  return_15m      NUMERIC,
  return_1h       NUMERIC,
  return_4h       NUMERIC,
  hit_5m          BOOLEAN,   -- did price move in predicted direction at 5m?
  hit_15m         BOOLEAN,
  hit_1h          BOOLEAN,
  hit_4h          BOOLEAN,
  resolved        BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wso_whale_id    ON whale_signal_outcomes(whale_id);
CREATE INDEX IF NOT EXISTS idx_wso_signal_time ON whale_signal_outcomes(signal_time DESC);
CREATE INDEX IF NOT EXISTS idx_wso_resolved    ON whale_signal_outcomes(resolved) WHERE resolved = false;

ALTER TABLE whale_signal_outcomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON whale_signal_outcomes FOR ALL TO service_role USING (true);
CREATE POLICY "Anon read"               ON whale_signal_outcomes FOR SELECT TO anon USING (true);
CREATE POLICY "Authenticated read"      ON whale_signal_outcomes FOR SELECT TO authenticated USING (true);
