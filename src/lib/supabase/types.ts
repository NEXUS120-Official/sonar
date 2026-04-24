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
  | 'smart_money_token_buy'
  // ── Sovereign intelligence archetypes (Block 24) ─────────────
  | 'shadow_whale_inflow'         // shadow-linked wallet receives large inflow
  | 'exchange_shadow_birth'       // exchange-funded wallet activates privacy
  | 'privacy_token_activity'      // Token-2022 confidential transfer activity
  | 'cluster_synchronized_flow'   // cluster-member coordinated positioning
  | 'sovereign_high_confidence'   // joiner direct_proof / strong_evidence
  // ── Shadow family archetypes (Block 26) ──────────────────────
  | 'shadow_family_fan_out'       // family root funded ≥3 child wallets
  | 'shadow_gas_funding_chain'          // gas-funding lineage chain detected
  | 'token2022_extension_sensitive'     // Token-2022 extension-sensitive posture
  | 'asymmetric_token_delta'            // structural sender/receiver token asymmetry
  | 'possible_transfer_fee_flow'        // delta pattern consistent with fee-on-transfer behavior
  | 'privacy_adjacent_token_activity'   // privacy-adjacent Token-2022 architecture
  | 'privacy_bridgehead_birth'          // shadow-linked Token-2022 wallet enters privacy-adjacent posture
  | 'exchange_funded_privacy_staging'   // exchange-linked Token-2022 extension-sensitive staging
  | 'family_privacy_bridgehead'         // family-level privacy activation becomes operationally visible
  | 'privacy_exit_to_public_flow'       // privacy-capable asset re-emerges in visible public flow
  | 'post_privacy_downstream_move'      // downstream public-side move after privacy-capable context
  | 'family_privacy_reemergence'        // family-level privacy re-emergence into public-side activity
  | 'privacy_sequence_bridgehead_reemergence' // lifecycle sequence: bridgehead -> public re-emergence
  | 'privacy_sequence_downstream_continuation' // lifecycle sequence: re-emergence -> downstream continuation
  | 'privacy_sequence_family_reemergence'; // lifecycle sequence: family-linked re-emergence candidate

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
  // ── Token delta analysis (Block 28) ──────────────────────────
  token_delta_pattern:            string | null;   // symmetric_transfer | asymmetric_transfer | fee_sink_visible | multi_leg | unknown
  has_asymmetric_token_delta:     boolean;
  possible_transfer_fee_behavior: boolean;
  // ── Shadow family / multi-hop lineage (Block 26) ──────────────
  shadow_family_id:                     string | null;
  shadow_family_root_wallet:            string | null;
  shadow_family_source_exchange:        string | null;
  shadow_family_source_exchange_wallet: string | null;
  shadow_family_total_members:          number | null;
  shadow_family_hop_depth:              number | null;
  shadow_family_confidence:             number | null;
  shadow_family_confidence_tier:        string | null;
  shadow_family_patterns:               string[];
  shadow_family_continuity_reasons:     string[];
  shadow_family_has_privacy_activation: boolean;
  shadow_family_has_token2022_activity: boolean;
  shadow_family_has_gas_funding:        boolean;
  shadow_family_has_fan_out:            boolean;
  shadow_family_has_fan_in:             boolean;
  shadow_family_has_temporal_correlation: boolean;
  // ── Deeper family semantics (Block 35) ──────────────────────
  family_member_role:          string;
  family_coordination_posture: string;
  family_structure_strength:   number;
  family_pattern_count:        number;
  family_reason_count:         number;
  // ── Privacy lifecycle persistence (Block 33) ────────────────
  privacy_lifecycle_stage:             string;        // none | bridgehead_birth | privacy_staging | privacy_active | public_reemergence | downstream_after_reemergence | family_privacy_reemergence
  privacy_lifecycle_confidence:        number;        // 0-100
  privacy_lifecycle_reason:            string | null;
  privacy_public_side:                 boolean;
  privacy_reemergence_family_context:  boolean;
  signal_score:           number;
  signal_confidence:      string;
  evidence:               string[];
  attribution_reason:     string | null;
  raw_movement:           Json | null;
  raw_token_movement:     Json | null;
  created_at:             string;
}

export interface ShadowLinkRow {
  id:                        string;
  target_wallet:             string;
  funding_signature:         string;
  methodology_version:       string;
  source_exchange:           string;
  exchange_wallet:           string;
  funding_time:              string;
  funding_amount_usd:        number | null;
  prior_movement_count:      number;
  is_novel_wallet:           boolean;
  privacy_activated:         boolean;
  privacy_activation_time:   string | null;
  time_gap_seconds:          number | null;
  activated_mints:           string[];
  has_confidential_transfer: boolean;
  evidence_type:             string;
  evidence:                  string[];
  linkage_reason:            string;
  entity_verified:           boolean;
  confidence:                number;
  confidence_tier:           string;
  first_detected_at:         string;
  last_updated_at:           string;
}

export interface ShadowFamilyRow {
  family_id:                string;
  root_wallet:              string;
  source_exchange:          string | null;
  source_exchange_wallet:   string | null;
  member_wallets:           string[];
  total_members:            number;
  hop_depth:                number;
  patterns:                 string[];
  continuity_reasons:       string[];
  evidence:                 string[];
  confidence:               number;
  confidence_tier:          string;
  has_privacy_activation:   boolean;
  has_token2022_activity:   boolean;
  has_gas_funding:          boolean;
  has_fan_out:              boolean;
  has_fan_in:               boolean;
  has_temporal_correlation: boolean;
  earliest_activity:        string | null;
  latest_activity:          string | null;
  methodology_version:      string;
  first_detected_at:        string;
  last_updated_at:          string;
}

export interface ShadowContinuityRow {
  id:                       string;
  family_id:                string;
  parent_wallet:            string;
  child_wallet:             string;
  hop_depth:                number;
  pattern:                  string;
  transfer_signature:       string | null;
  transfer_time:            string | null;
  transfer_amount_sol:      number | null;
  transfer_amount_usd:      number | null;
  is_gas_topup:             boolean;
  parent_has_shadow_link:   boolean;
  parent_shadow_exchange:   string | null;
  parent_shadow_confidence: number | null;
  child_privacy_activated:  boolean;
  child_token2022_active:   boolean;
  evidence:                 string[];
  linkage_reason:           string;
  confidence:               number;
  confidence_tier:          string;
  methodology_version:      string;
  first_detected_at:        string;
  last_updated_at:          string;
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
      shadow_links: {
        Row: ShadowLinkRow;
        Insert: Omit<ShadowLinkRow, 'id' | 'first_detected_at' | 'last_updated_at'> & {
          id?: string;
          first_detected_at?: string;
          last_updated_at?: string;
        };
        Update: Partial<Omit<ShadowLinkRow, 'id'>>;
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


export interface PrivacyLifecycleEventRow {
  event_id:                       string;
  signature:                      string;
  event_time:                     string;
  persisted_at:                   string;
  event_type:                     string;   // mirrors privacy_lifecycle_stage
  privacy_lifecycle_stage:        string;
  event_confidence:               number;
  event_reason:                   string | null;

  token_mint:                     string | null;
  token_symbol:                   string | null;
  amount_usd:                     number | null;

  is_public_side:                 boolean;
  shadow_source_exchange:         string | null;
  shadow_family_id:               string | null;

  family_member_role:             string;
  family_coordination_posture:    string;
  family_structure_strength:      number;

  methodology_version:            string;
  created_at:                     string;
}

export interface PrivacyLifecycleSequenceRow {
  sequence_id:          string;
  start_event_id:       string;
  end_event_id:         string;

  start_signature:      string;
  end_signature:        string;

  token_mint:           string | null;
  token_symbol:         string | null;
  shadow_family_id:     string | null;

  start_stage:          string;
  end_stage:            string;
  stage_path:           string[];

  sequence_confidence:  number;
  elapsed_seconds:      number | null;
  sequence_reason:      string | null;

  start_event_time:     string;
  end_event_time:       string;

  methodology_version:  string;
  created_at:           string;
}



export interface PrivacySequenceAlertCandidateRow {
  candidate_id:         string;
  sequence_id:          string;
  start_event_id:       string;
  end_event_id:         string;

  token_mint:           string | null;
  token_symbol:         string | null;
  shadow_family_id:     string | null;

  start_stage:          string;
  end_stage:            string;
  stage_path:           string[];

  candidate_type:       string;
  candidate_priority:   string;
  candidate_confidence: number;
  candidate_reason:     string | null;
  candidate_evidence:   string[];

  elapsed_seconds:      number | null;
  end_event_time:       string;
  methodology_version:  string;
  created_at:           string;
}


export interface PrivacyAlertFingerprintRow {
  fingerprint:         string;
  alert_family:        string;
  token_mint:          string | null;
  shadow_family_id:    string | null;
  first_seen_at:       string;
  last_seen_at:        string;
  suppression_count:   number;
  methodology_version: string;
  created_at:          string;
}


export interface PrivacyAlertSuppressionReceiptRow {
  receipt_id:          string;
  fingerprint:         string;
  alert_family:        string;
  candidate_alert_type:string;
  token_mint:          string | null;
  shadow_family_id:    string | null;
  suppression_reason:  string;
  cooldown_hours:      number | null;
  last_seen_at:        string | null;
  suppressed_at:       string;
  methodology_version: string;
  created_at:          string;
}


export interface SovereignAccountStateSnapshotRow {
  address: string;
  sol_balance: number;
  usdc_balance: number;
  total_value_usd: number | null;
  staked_sol: number;
  staked_msol: number;
  staked_jitosol: number;
  fetched_at: string;
  source_mode: string;
}


export interface SovereignWhaleCandidateRow {
  address: string;
  discovery_method: string;
  source_exchange: string | null;
  triggering_signature: string | null;
  first_seen_at: string;
  evidence_count: number;
  estimated_balance_usd: number | null;
  priced_component_count: number;
  unpriced_component_count: number;
  valuation_completeness_ratio: number;
  valuation_status: string;
  confidence_score: number;
  linkage_reason: string;
  methodology_version: string;
}


export interface SovereignMintRegistryRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  token_program: string;
  is_token_2022: boolean;
  has_transfer_fee: boolean;
  has_transfer_hook: boolean;
  has_confidential_transfer: boolean;
  has_auditor_key: boolean;
  has_freeze_authority: boolean;
  metadata_source_mode: string;
  enrichment_confidence: string;
  risk_flags: string[];
  raw_snapshot: Record<string, unknown> | null;
  last_enriched_at: string;
  created_at: string;
}

export interface SovereignMintEnrichmentQueueRow {
  mint: string;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
  status: string;
  last_error: string | null;
  created_at: string;
}


export interface SovereignPriceRegistryRow {
  asset_key: string;
  symbol: string | null;
  price_usd: number | null;
  price_confidence: string;
  price_source_mode: string;
  valuation_reason: string | null;
  raw_snapshot: Record<string, unknown> | null;
  last_price_at: string;
  created_at: string;
}

export interface SovereignPriceEnrichmentQueueRow {
  asset_key: string;
  first_seen_at: string;
  last_seen_at: string;
  sighting_count: number;
  status: string;
  last_error: string | null;
  created_at: string;
}


export interface SovereignValuationDoctrinePreviewRow {
  asset_key: string;
  price_usd: number | null;
  effective_price_usd: number | null;
  value_usd: number | null;
  price_confidence: string;
  effective_confidence: string;
  valuation_reason: string;
  last_price_at: string | null;
  price_source_mode: string;
  price_age_seconds: number | null;
  is_stale_price: boolean;
}


export interface SovereignAlertDoctrinePreviewRow {
  alert_type: string;
  severity: string;
  valuation_doctrine_reason: string | null;
  valuation_value_usd: number | null;
  valuation_effective_confidence: string | null;
  valuation_is_stale_price: boolean;
  created_at: string;
}


export interface SovereignValuationCoverageRow {
  asset_key: string;
  price_usd: number | null;
  effective_price_usd: number | null;
  price_confidence: string;
  effective_confidence: string;
  price_age_seconds: number | null;
  is_stale_price: boolean;
  valuation_reason: string;
  last_price_at: string | null;
  price_source_mode: string;
}


export interface SovereignPriceMergePreviewRow {
  asset_key: string;
  price_usd: number | null;
  price_confidence: string;
  price_source_mode: string;
  merge_score: number;
  merge_reason: string;
  last_price_at: string | null;
}


export interface SovereignValuationCompleteness {
  priced_asset_count: number;
  unpriced_asset_count: number;
  valuation_completeness_ratio: number;
  valuation_status: 'complete' | 'partial' | 'unknown';
}

export interface SovereignValuedTokenComponentRow {
  asset_key: string;
  amount: number | null;
  price_usd: number | null;
  effective_price_usd: number | null;
  value_usd: number | null;
  effective_confidence: string;
  is_stale_price: boolean;
  valuation_status: string;
}

export interface SovereignWhaleCandidateValuationPreviewRow {
  address: string;
  estimated_balance_usd: number | null;
  priced_component_count: number;
  unpriced_component_count: number;
  valuation_completeness_ratio: number;
  valuation_status: string;
}


export interface SovereignTokenValuationGapPreviewRow {
  asset_key: string;
  sightings: number;
  priced_count: number;
  unpriced_count: number;
  priced_ratio: number;
}

export interface SovereignExchangeValuationCompletenessPreviewRow {
  source_exchange: string;
  wallets: number;
  avg_completeness_ratio: number;
  partial_wallets: number;
  unknown_wallets: number;
}


export interface SovereignWhaleCandidateRankingPreviewRow {
  address: string;
  estimated_balance_usd: number | null;
  confidence_score: number;
  valuation_completeness_ratio: number;
  valuation_status: string;
  source_exchange: string | null;
  evidence_count: number;
  ranking_score: number;
  ranking_band: string;
  ranking_reason: string;
}


export interface SovereignExchangeLineagePreviewRow {
  address: string;
  source_exchange: string | null;
  valuation_status: string;
  confidence_score: number;
  evidence_count: number;
  lineage_confidence: number;
  lineage_band: string;
  lineage_reason: string;
}


export interface SovereignJoinedMovementPreviewRow {
  signature: string;
  asset_key: string | null;
  flow_type: string | null;
  token_symbol: string | null;
  token_program_type: string | null;
  valuation_status: string;
  valuation_confidence: string;
  privacy_signal: boolean;
  exchange_lineage_band: string;
  attribution_confidence: number;
  linkage_reason: string;
  methodology_version: string;
}
