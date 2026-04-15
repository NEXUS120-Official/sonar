-- ============================================================
-- Migration 008: token_metadata cache + token_accumulation alerts
-- ============================================================

-- Token metadata cache (populated by Helius API lookups)
CREATE TABLE IF NOT EXISTS token_metadata (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  mint        text        UNIQUE NOT NULL,
  symbol      text,
  name        text,
  decimals    integer,
  is_pump_fun boolean     DEFAULT false,
  logo_uri    text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_metadata_mint ON token_metadata (mint);

-- RLS: service role only
ALTER TABLE token_metadata ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all_token_metadata"
  ON token_metadata FOR ALL TO service_role USING (true);

-- ── Add token_accumulation to alert_type check (if enum exists) ──
-- alerts.alert_type is stored as text; no enum to update.
-- Just document the new value here for reference.
-- New alert_type values: 'token_accumulation', 'smart_money_token_buy'

-- ── Update function for token_metadata.updated_at ─────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_token_metadata_updated_at ON token_metadata;
CREATE TRIGGER trg_token_metadata_updated_at
  BEFORE UPDATE ON token_metadata
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
