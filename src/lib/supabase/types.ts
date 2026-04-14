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
  | 'defi_rotation'
  | 'stablecoin_flow'
  | 'whale_large_move'
  | 'weekly_report';

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
  market_bias: MarketBias | null;
  bias_score: number | null;
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
