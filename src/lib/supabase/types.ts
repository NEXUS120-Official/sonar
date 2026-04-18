// ============================================================
// SONAR v2.0 — Supabase Database Types
// Auto-maintained — regenerate with: npx supabase gen types typescript
// ============================================================

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ── Enum-like string unions ───────────────────────────────────

export type FlowType =
  | 'exchange_deposit'
  | 'exchange_withdrawal'
  | 'stake'
  | 'unstake'
  | 'defi_deposit'
  | 'defi_withdrawal'
  | 'bridge_in'
  | 'bridge_out'
  | 'whale_transfer'
  | 'unknown';

export type FlowDirection = 'inflow' | 'outflow' | 'internal';

export type MarketBias = 'bullish' | 'bearish' | 'neutral';

export type AlertType =
  | 'exchange_spike'
  | 'accumulation_wave'
  | 'distribution_wave'
  | 'staking_shift'
  | 'flow_reversal'
  | 'defi_rotation'
  | 'stablecoin_flow'
  | 'whale_large_move'
  | 'weekly_report'
  | 'token_accumulation'
  | 'smart_money_token_buy';

export type AlertSeverity = 'info' | 'notable' | 'significant' | 'major';

export type WhaleType = 'accumulator' | 'distributor' | 'staker' | 'defi_user' | 'unknown';

export type WhaleDiscoveryMethod =
  | 'balance_scan'
  | 'exchange_withdrawal'
  | 'gmgn_feed'
  | 'manual';

export type KnownAddressCategory = 'exchange' | 'staking' | 'defi' | 'bridge' | 'protocol';

export type UserTier = 'free' | 'pro';

// ── Table row types ───────────────────────────────────────────

export type EntityType =
  | 'exchange'
  | 'protocol'
  | 'whale'
  | 'market_maker'
  | 'bridge'
  | 'treasury'
  | 'unknown';

export interface EntityRow {
  id:             string;
  entity_type:    EntityType;
  canonical_name: string | null;
  description:    string | null;
  confidence:     number;          // 0-100
  verified:       boolean;
  source:         string | null;   // 'manual' | 'on-chain-analysis' | 'gmgn' | 'known_addresses_seed' | ...
  metadata:       Json | null;
  created_at:     string;
  updated_at:     string;
}

export interface EntityAddressRow {
  id:         string;
  entity_id:  string;
  address:    string;
  chain:      string;
  label:      string | null;   // 'hot_wallet' | 'cold_wallet' | 'vault' | 'fee_account' | ...
  confidence: number;          // 0-100
  is_active:  boolean;
  source:     string | null;
  notes:      string | null;
  created_at: string;
}

export interface KnownAddressRow {
  id: string;
  address: string;
  label: string;
  category: KnownAddressCategory;
  sub_category: string | null;
  chain: string;
  is_active: boolean;
  metadata: Json | null;
  created_at: string;
}

export interface WhaleRow {
  id: string;
  address: string;
  label: string | null;
  chain: string;
  is_active: boolean;
  sol_balance: number | null;
  usdc_balance: number | null;
  total_value_usd: number | null;
  staked_sol: number | null;
  staked_msol: number | null;
  staked_jitosol: number | null;
  whale_type: WhaleType | null;
  discovery_method: WhaleDiscoveryMethod | null;
  discovered_at: string;
  balance_updated_at: string | null;
  created_at: string;
  // Reputation columns — added by migration 007
  reputation_score:   number | null;
  signal_count_30d:   number | null;
  hit_rate_30d:       number | null;
  mean_return_30d:    number | null;
  last_reputation_at: string | null;
  smart_money_flag:   boolean | null;
}

export interface WalletClusterRow {
  id:            string;
  cluster_name:  string | null;
  cluster_type:  string;
  methodology:   string | null;  // 'behavior_v1' | future versions
  avg_trade_usd: number | null;
  member_count:  number;
  is_active:     boolean;
  last_computed: string | null;
  metadata:      Json | null;
  created_at:    string;
}

export interface WalletClusterMemberRow {
  cluster_id: string;
  address:    string;
  weight:     number;  // 0.0–1.0 normalized strength score (behavior_v1)
  metadata:   Json | null; // per-member supporting metrics — added by migration 011
  added_at:   string;
}

export type SignalDirection = 'bullish' | 'bearish' | 'neutral';

export interface WhaleSignalOutcomeRow {
  id:               string;
  whale_id:         string;
  movement_id:      string | null;
  alert_id:         string | null;
  signal_direction: SignalDirection;
  signal_time:      string;
  price_at_signal:  number | null;
  price_5m:         number | null;
  price_15m:        number | null;
  price_1h:         number | null;
  price_4h:         number | null;
  return_5m:        number | null;
  return_15m:       number | null;
  return_1h:        number | null;
  return_4h:        number | null;
  hit_5m:           boolean | null;
  hit_15m:          boolean | null;
  hit_1h:           boolean | null;
  hit_4h:           boolean | null;
  resolved:         boolean;
  created_at:       string;
}

export interface MovementRow {
  id: string;
  signature: string;
  from_address: string;
  to_address: string;
  from_label: string | null;
  to_label: string | null;
  whale_id: string | null;
  token: string;
  amount_token: number;
  amount_usd: number | null;
  flow_type: FlowType;
  flow_direction: FlowDirection;
  exchange: string | null;
  protocol: string | null;
  block_time: string;
  processed_at: string;
  created_at: string;
}

export interface FlowSnapshotRow {
  id: string;
  snapshot_time: string;
  window_hours: number;
  sol_exchange_inflow_usd: number;
  sol_exchange_outflow_usd: number;
  sol_net_exchange_flow_usd: number;
  sol_staked_usd: number;
  sol_unstaked_usd: number;
  net_staking_flow_usd: number;
  usdc_inflow_usd: number;
  usdc_outflow_usd: number;
  net_usdc_flow_usd: number;
  defi_deposit_usd: number;
  defi_withdrawal_usd: number;
  net_defi_flow_usd: number;
  large_movements_count: number;
  unique_whales_active: number;
  market_bias:        MarketBias | null;
  bias_score:         number | null;
  confirmation_count: number | null;   // 0–3: sub-signals agreeing with bias direction
  staking_velocity_pct: number | null; // rate of change in net_staking vs prior 4h snapshot
  created_at: string;
}

export interface AlertRow {
  id: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  body: string;
  ai_analysis: string | null;
  data: Json | null;
  movement_ids: string[] | null;
  sent_telegram_free: boolean;
  sent_telegram_premium: boolean;
  sent_at: string | null;
  created_at: string;
}

// Finer-grained bias label stored in bias_index_history (superset of MarketBias)
export type BiasLabel = 'extreme_bearish' | 'bearish' | 'neutral' | 'bullish' | 'extreme_bullish';

export interface BiasIndexHistoryRow {
  id:         string;
  score:      number;        // -100..+100
  bias:       BiasLabel;
  confidence: number;        // 0-100 (% of active components)
  components: Record<string, { score: number; interpretation: string }> | null;
  created_at: string;
}

export type TokenMovementAction = 'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity';

export interface TokenMovementRow {
  id:              string;
  movement_id:     string | null;
  whale_id:        string | null;
  signature:       string;
  block_time:      string;
  token_mint:      string;
  token_symbol:    string | null;
  token_name:      string | null;
  action:          TokenMovementAction;
  amount_token:    number | null;
  amount_sol:      number | null;
  amount_usd:      number | null;
  price_per_token: number | null;
  protocol:        string | null;
  pool_address:    string | null;
  is_new_token:    boolean;
  created_at:      string;
}

export interface TokenMetadataRow {
  id:          string;
  mint:        string;
  symbol:      string | null;
  name:        string | null;
  decimals:    number | null;
  is_pump_fun: boolean;
  logo_uri:    string | null;
  created_at:  string;
  updated_at:  string;
}

export interface SovereignMintEnrichmentRow {
  id:                        string;
  mint:                      string;
  token_program:             string;   // 'spl_token' | 'token_2022' | 'unknown'
  decimals:                  number | null;
  mint_authority:            string | null;
  freeze_authority:          string | null;
  has_transfer_fee:          boolean;
  transfer_fee_bps:          number | null;
  has_confidential_transfer: boolean;
  has_auditor_key:           boolean;
  auditor_elgamal_pubkey:    string | null;
  has_transfer_hook:         boolean;
  transfer_hook_program:     string | null;
  has_permanent_delegate:    boolean;
  has_native_metadata:       boolean;
  risk_flags:                string[];
  confidence:                string;   // 'high' | 'medium' | 'low'
  needs_followup:            boolean;
  enrichment_source:         string | null;
  methodology_version:       string | null;
  inspected_at:              string;
  created_at:                string;
  updated_at:                string;
}

export interface SovereignSignalRow {
  id:                     string;
  signature:              string;
  persisted_at:           string;
  enriched_at:            string;
  methodology_version:    string;
  block_time:             string | null;
  from_address:           string | null;
  to_address:             string | null;
  amount_token:           number | null;
  amount_usd:             number | null;
  token_mint:             string | null;
  token_symbol:           string | null;
  flow_type:              string | null;
  flow_direction:         string | null;
  exchange:               string | null;
  protocol:               string | null;
  from_entity_name:       string | null;
  from_entity_type:       string | null;
  from_entity_confidence: number;
  from_entity_verified:   boolean;
  to_entity_name:         string | null;
  to_entity_type:         string | null;
  to_entity_confidence:   number;
  to_entity_verified:     boolean;
  whale_entity_name:      string | null;
  whale_entity_type:      string | null;
  whale_entity_confidence:number;
  whale_entity_verified:  boolean;
  token_program_type:             string;
  is_token_2022:                  boolean;
  has_transfer_fee:               boolean;
  has_confidential_transfer:      boolean;
  has_transfer_hook:              boolean;
  has_permanent_delegate:         boolean;
  has_auditor_key:                boolean;
  token_security_confidence:      string;
  token_risk_flags:               string[];
  fog_piercing_notes:             string[];
  cluster_id:             string | null;
  cluster_type:           string | null;
  cluster_name:           string | null;
  has_shadow_link:        boolean;
  shadow_source_exchange: string | null;
  shadow_confidence:      number | null;
  shadow_linkage_reason:  string | null;
  signal_score:           number;
  signal_confidence:      string;
  evidence:               string[];
  attribution_reason:     string | null;
  raw_movement:           Json | null;
  raw_token_movement:     Json | null;
  created_at:             string;
}

export interface GmgnSmartMoneyCacheRow {
  id: string;
  wallet_address: string;
  token_address: string | null;
  action: string | null;
  amount_usd: number | null;
  source: string | null;
  is_pump_fun: boolean;
  gmgn_fetched_at: string;
  created_at: string;
}

export interface UserProfileRow {
  id: string;
  telegram_chat_id: string | null;
  telegram_username: string | null;
  alert_min_severity: AlertSeverity;
  alert_types: AlertType[];
  tier: UserTier;
  stripe_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Supabase Database definition ─────────────────────────────

export interface Database {
  public: {
    Tables: {
      known_addresses: {
        Row: KnownAddressRow;
        Insert: Omit<KnownAddressRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<KnownAddressRow, 'id'>>;
      };
      whales: {
        Row: WhaleRow;
        Insert: Omit<WhaleRow, 'id' | 'discovered_at' | 'created_at'> & {
          id?: string;
          discovered_at?: string;
          created_at?: string;
        };
        Update: Partial<Omit<WhaleRow, 'id'>>;
      };
      movements: {
        Row: MovementRow;
        Insert: Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> & {
          id?: string;
          processed_at?: string;
          created_at?: string;
        };
        Update: Partial<Omit<MovementRow, 'id'>>;
      };
      flow_snapshots: {
        Row: FlowSnapshotRow;
        Insert: Omit<FlowSnapshotRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<FlowSnapshotRow, 'id'>>;
      };
      alerts: {
        Row: AlertRow;
        Insert: Omit<AlertRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<AlertRow, 'id'>>;
      };
      bias_index_history: {
        Row: BiasIndexHistoryRow;
        Insert: Omit<BiasIndexHistoryRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<BiasIndexHistoryRow, 'id'>>;
      };
      token_movements: {
        Row: TokenMovementRow;
        Insert: Omit<TokenMovementRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<TokenMovementRow, 'id'>>;
      };
      token_metadata: {
        Row: TokenMetadataRow;
        Insert: Omit<TokenMetadataRow, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Omit<TokenMetadataRow, 'id'>>;
      };
      sovereign_mint_enrichments: {
        Row: SovereignMintEnrichmentRow;
        Insert: Omit<SovereignMintEnrichmentRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<SovereignMintEnrichmentRow, 'id'>>;
      };
      sovereign_signals: {
        Row: SovereignSignalRow;
        Insert: Omit<SovereignSignalRow, 'id' | 'persisted_at' | 'created_at'> & {
          id?: string;
          persisted_at?: string;
          created_at?: string;
        };
        Update: Partial<Omit<SovereignSignalRow, 'id'>>;
      };
      gmgn_smart_money_cache: {
        Row: GmgnSmartMoneyCacheRow;
        Insert: Omit<GmgnSmartMoneyCacheRow, 'id' | 'gmgn_fetched_at' | 'created_at'> & {
          id?: string;
          gmgn_fetched_at?: string;
          created_at?: string;
        };
        Update: Partial<Omit<GmgnSmartMoneyCacheRow, 'id'>>;
      };
      user_profiles: {
        Row: UserProfileRow;
        Insert: Omit<UserProfileRow, 'created_at' | 'updated_at'> & {
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<UserProfileRow, 'id'>>;
      };
      whale_signal_outcomes: {
        Row: WhaleSignalOutcomeRow;
        Insert: Omit<WhaleSignalOutcomeRow, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<WhaleSignalOutcomeRow, 'id'>>;
      };
    };
    Views: {
      known_address_map: {
        Row: Pick<KnownAddressRow, 'address' | 'label' | 'category' | 'sub_category'>;
      };
    };
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
