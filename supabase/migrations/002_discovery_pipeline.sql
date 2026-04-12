-- ============================================================
-- SONAR — Discovery Pipeline Schema (Migration 002)
-- ============================================================
-- DO NOT apply this file directly with psql/CLI.
-- Apply via the Supabase dashboard → SQL editor.
--
-- Creates 4 new tables:
--   discovery_candidates        — wallets under evaluation
--   discovery_candidate_sources — per-source raw data
--   discovery_reviews           — manual review audit trail
--   scout_submissions           — community Telegram /submit records
-- ============================================================

-- ── discovery_candidates ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address               TEXT NOT NULL,
  chain                 TEXT NOT NULL DEFAULT 'solana',

  -- Metrics extracted from discovery sources
  win_rate_30d          NUMERIC(5,2),         -- %
  trade_count_30d       INTEGER,
  last_active_at        TIMESTAMPTZ,
  token_diversity_30d   INTEGER,              -- unique tokens traded in 30d
  avg_trade_size_usd    NUMERIC(18,2),
  total_volume_30d      NUMERIC(18,2),
  instant_sell_pct      NUMERIC(5,2),         -- % of buys sold within 1h (rug/flip indicator)

  -- Risk flags (set by engine or manual review)
  is_bot_flagged        BOOLEAN NOT NULL DEFAULT FALSE,
  is_rug_flagged        BOOLEAN NOT NULL DEFAULT FALSE,
  is_insider_flagged    BOOLEAN NOT NULL DEFAULT FALSE,

  -- Discovery score (0–100, computed by scoring.ts)
  discovery_score       INTEGER NOT NULL DEFAULT 0,

  -- Routing status
  -- pending → evaluated → auto_reject | manual_review | auto_approve → promoted | rejected
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','auto_reject','manual_review','auto_approve','promoted','rejected')),

  -- Attribution
  primary_source        TEXT NOT NULL DEFAULT 'unknown',  -- birdeye | dexscreener | solscan | community | arkham
  submitted_by          TEXT,                              -- Telegram chat_id for community submissions

  -- Review notes (human or system)
  notes                 TEXT,

  -- Timestamps
  evaluated_at          TIMESTAMPTZ,
  reviewed_at           TIMESTAMPTZ,
  reviewed_by           TEXT,
  promoted_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A wallet can only be a candidate once per chain
  UNIQUE (address, chain)
);

-- ── discovery_candidate_sources ──────────────────────────────

CREATE TABLE IF NOT EXISTS discovery_candidate_sources (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    UUID NOT NULL REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  source          TEXT NOT NULL,   -- birdeye | dexscreener | solscan | community | arkham
  source_data     JSONB,           -- raw payload from the source (for audit/re-scoring)
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── discovery_reviews ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS discovery_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    UUID NOT NULL REFERENCES discovery_candidates(id) ON DELETE CASCADE,
  reviewer        TEXT NOT NULL DEFAULT 'system',  -- 'system' | admin telegram chat_id
  action          TEXT NOT NULL,
  -- approve | reject | flag_bot | flag_rug | flag_insider | promote | request_data
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── scout_submissions ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scout_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address           TEXT NOT NULL,
  chain             TEXT NOT NULL DEFAULT 'solana',
  submitted_by      TEXT NOT NULL,   -- Telegram chat_id
  telegram_username TEXT,
  message_id        INTEGER,         -- Telegram message_id for reply threading
  precheck_passed   BOOLEAN,
  precheck_notes    TEXT,
  candidate_id      UUID REFERENCES discovery_candidates(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_dc_status          ON discovery_candidates(status);
CREATE INDEX IF NOT EXISTS idx_dc_score           ON discovery_candidates(discovery_score DESC);
CREATE INDEX IF NOT EXISTS idx_dc_address         ON discovery_candidates(address);
CREATE INDEX IF NOT EXISTS idx_dc_source          ON discovery_candidates(primary_source);
CREATE INDEX IF NOT EXISTS idx_dc_created         ON discovery_candidates(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dcs_candidate      ON discovery_candidate_sources(candidate_id);
CREATE INDEX IF NOT EXISTS idx_dcs_source         ON discovery_candidate_sources(source);
CREATE INDEX IF NOT EXISTS idx_dr_candidate       ON discovery_reviews(candidate_id);
CREATE INDEX IF NOT EXISTS idx_ss_address         ON scout_submissions(address);
CREATE INDEX IF NOT EXISTS idx_ss_submitted_by    ON scout_submissions(submitted_by);
