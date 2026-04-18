-- ============================================================
-- SONAR Migration 012 — Sovereign Mint Enrichments
-- ============================================================
-- Stores the full output of the Sovereign Mint Enricher for each
-- inspected mint address.
--
-- This table is the persistent backing store for the in-memory
-- SovereignTokenRegistry's Token-2022 intelligence layer.
--
-- Loader: loadRegistryFromDb() in src/lib/sovereign/token-registry.ts
-- Writer: persistEnrichmentToDb() in src/lib/sovereign/mint-enricher.ts
-- Queue drain: /api/cron/enrich-unknown-mints
--
-- Key intelligence signals stored:
--   token_program             — legacy SPL vs Token-2022 (definitive from account.owner)
--   has_transfer_fee          — non-symmetric transfer delta possible
--   has_confidential_transfer — privacy-relevant asset architecture
--   has_auditor_key           — fog-piercing structural signal (§8.C)
--   has_transfer_hook         — custom transfer logic present
--   has_permanent_delegate    — control risk signal
--   risk_flags                — extensible risk context array
-- ============================================================

CREATE TABLE IF NOT EXISTS sovereign_mint_enrichments (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mint                      TEXT        NOT NULL UNIQUE,

  -- Program distinction
  token_program             TEXT        NOT NULL DEFAULT 'unknown',  -- 'spl_token' | 'token_2022' | 'unknown'

  -- Base mint info
  decimals                  INTEGER,
  mint_authority            TEXT,
  freeze_authority          TEXT,

  -- Token-2022 extension presence flags
  has_transfer_fee          BOOLEAN     NOT NULL DEFAULT FALSE,
  transfer_fee_bps          INTEGER,
  has_confidential_transfer BOOLEAN     NOT NULL DEFAULT FALSE,
  has_auditor_key           BOOLEAN     NOT NULL DEFAULT FALSE,
  auditor_elgamal_pubkey    TEXT,
  has_transfer_hook         BOOLEAN     NOT NULL DEFAULT FALSE,
  transfer_hook_program     TEXT,
  has_permanent_delegate    BOOLEAN     NOT NULL DEFAULT FALSE,
  has_native_metadata       BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Risk and fog-piercing signals
  risk_flags                TEXT[]      NOT NULL DEFAULT '{}',

  -- Enrichment quality metadata
  confidence                TEXT        NOT NULL DEFAULT 'low',   -- 'high' | 'medium' | 'low'
  needs_followup            BOOLEAN     NOT NULL DEFAULT TRUE,
  enrichment_source         TEXT,                                 -- 'sovereign_rpc_jsonparsed' | 'not_found' | 'rpc_error'
  methodology_version       TEXT,                                 -- 'mint_enricher_v1'

  inspected_at              TIMESTAMPTZ NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by token program type (Token-2022 universe)
CREATE INDEX IF NOT EXISTS idx_mint_enrichments_token_program
  ON sovereign_mint_enrichments (token_program);

-- Queue: find all mints that need follow-up inspection
CREATE INDEX IF NOT EXISTS idx_mint_enrichments_needs_followup
  ON sovereign_mint_enrichments (needs_followup, inspected_at)
  WHERE needs_followup = TRUE;

-- Fog-piercing queries: find confidential-transfer or auditor-key mints
CREATE INDEX IF NOT EXISTS idx_mint_enrichments_privacy_signals
  ON sovereign_mint_enrichments (has_confidential_transfer, has_auditor_key);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_sovereign_mint_enrichments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sovereign_mint_enrichments_updated_at ON sovereign_mint_enrichments;
CREATE TRIGGER sovereign_mint_enrichments_updated_at
  BEFORE UPDATE ON sovereign_mint_enrichments
  FOR EACH ROW EXECUTE FUNCTION update_sovereign_mint_enrichments_updated_at();
