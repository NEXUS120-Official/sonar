-- ============================================================
-- SONAR v2.0 — Token Movements
-- Migration 006
-- ============================================================
-- Tracks SPL token buy/sell/LP actions at the token level.
-- This is the primary table for price prediction intelligence:
-- records WHICH token a whale bought/sold in a SWAP, how much,
-- at what implied price, and via which protocol.
-- ============================================================

CREATE TABLE IF NOT EXISTS token_movements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  movement_id     UUID REFERENCES movements(id) ON DELETE CASCADE,
  whale_id        UUID REFERENCES whales(id) ON DELETE SET NULL,
  signature       TEXT NOT NULL,
  block_time      TIMESTAMPTZ NOT NULL,
  token_mint      TEXT NOT NULL,          -- SPL token mint address
  token_symbol    TEXT,                   -- resolved later (nullable)
  token_name      TEXT,                   -- resolved later (nullable)
  action          TEXT NOT NULL CHECK (action IN ('buy','sell','add_liquidity','remove_liquidity')),
  amount_token    NUMERIC,
  amount_sol      NUMERIC,                -- SOL paid/received
  amount_usd      NUMERIC,               -- USD value at time
  price_per_token NUMERIC,               -- implied price: amount_usd / amount_token
  protocol        TEXT,                  -- 'raydium_v4', 'pumpfun', 'orca_whirlpool', etc.
  pool_address    TEXT,                  -- LP pool involved
  is_new_token    BOOLEAN DEFAULT false, -- true if token first seen < 24h ago
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_movements_whale_id   ON token_movements(whale_id);
CREATE INDEX IF NOT EXISTS idx_token_movements_token_mint ON token_movements(token_mint);
CREATE INDEX IF NOT EXISTS idx_token_movements_block_time ON token_movements(block_time DESC);
CREATE INDEX IF NOT EXISTS idx_token_movements_action     ON token_movements(action);

-- Enable RLS
ALTER TABLE token_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON token_movements
  FOR ALL TO service_role USING (true);

CREATE POLICY "Anon read" ON token_movements
  FOR SELECT TO anon USING (true);

CREATE POLICY "Authenticated read" ON token_movements
  FOR SELECT TO authenticated USING (true);
