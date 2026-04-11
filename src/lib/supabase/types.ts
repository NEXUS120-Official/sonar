export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ChainType = 'solana' | 'ethereum' | 'arbitrum' | 'base';
export type WhaleSector = 'memecoin' | 'defi' | 'nft' | 'mixed';
export type TransactionType = 'buy' | 'sell' | 'transfer';
export type AlertType = 'single' | 'consensus' | 'early_discovery';
export type ConsensusLabel = 'emerging' | 'strong' | 'ultra';
export type SafetyLevel = 'safe' | 'caution' | 'danger';
export type UserTier = 'free' | 'pro';
export type DexType = 'jupiter' | 'raydium' | 'orca' | 'uniswap' | 'unknown';

// Supabase GenericTable requires a Relationships array on each table.
// We have no FK relationships that need client-side join types, so all are empty.
type NoRelationships = [];

export interface Database {
  public: {
    Tables: {
      whales: {
        Row: {
          id: string;
          address: string;
          label: string | null;
          chain: ChainType;
          is_active: boolean;
          win_rate_7d: number | null;
          win_rate_30d: number | null;
          pnl_7d: number | null;
          pnl_30d: number | null;
          total_trades_7d: number;
          total_trades_30d: number;
          avg_hold_time_hours: number | null;
          best_trade_pnl: number | null;
          worst_trade_pnl: number | null;
          preferred_sector: WhaleSector | null;
          discovered_at: string;
          stats_updated_at: string | null;
          created_at: string;
        };
        Insert: {
          address: string;
          id?: string;
          label?: string | null;
          chain?: ChainType;
          is_active?: boolean;
          win_rate_7d?: number | null;
          win_rate_30d?: number | null;
          pnl_7d?: number | null;
          pnl_30d?: number | null;
          total_trades_7d?: number;
          total_trades_30d?: number;
          avg_hold_time_hours?: number | null;
          best_trade_pnl?: number | null;
          worst_trade_pnl?: number | null;
          preferred_sector?: WhaleSector | null;
          discovered_at?: string;
          stats_updated_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['whales']['Insert']>;
        Relationships: NoRelationships;
      };
      transactions: {
        Row: {
          id: string;
          whale_id: string;
          signature: string;
          type: TransactionType;
          token_address: string;
          token_symbol: string | null;
          token_name: string | null;
          amount_token: number | null;
          amount_usd: number | null;
          price_at_tx: number | null;
          dex: DexType | null;
          block_time: string;
          processed_at: string;
          created_at: string;
        };
        Insert: {
          whale_id: string;
          signature: string;
          type: TransactionType;
          token_address: string;
          block_time: string;
          id?: string;
          token_symbol?: string | null;
          token_name?: string | null;
          amount_token?: number | null;
          amount_usd?: number | null;
          price_at_tx?: number | null;
          dex?: DexType | null;
          processed_at?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['transactions']['Insert']>;
        Relationships: NoRelationships;
      };
      alerts: {
        Row: {
          id: string;
          type: AlertType;
          consensus_level: number;
          consensus_label: ConsensusLabel | null;
          token_address: string;
          token_symbol: string | null;
          token_name: string | null;
          token_market_cap: number | null;
          token_age_hours: number | null;
          token_holders: number | null;
          safety_score: number | null;
          safety_level: SafetyLevel | null;
          total_whale_volume_usd: number | null;
          whale_transactions: Json | null;
          alert_text: string | null;
          jupiter_swap_url: string | null;
          birdeye_url: string | null;
          sent_telegram: boolean;
          sent_at: string | null;
          created_at: string;
        };
        Insert: {
          type: AlertType;
          token_address: string;
          id?: string;
          consensus_level?: number;
          consensus_label?: ConsensusLabel | null;
          token_symbol?: string | null;
          token_name?: string | null;
          token_market_cap?: number | null;
          token_age_hours?: number | null;
          token_holders?: number | null;
          safety_score?: number | null;
          safety_level?: SafetyLevel | null;
          total_whale_volume_usd?: number | null;
          whale_transactions?: Json | null;
          alert_text?: string | null;
          jupiter_swap_url?: string | null;
          birdeye_url?: string | null;
          sent_telegram?: boolean;
          sent_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['alerts']['Insert']>;
        Relationships: NoRelationships;
      };
      token_safety: {
        Row: {
          token_address: string;
          liquidity_locked: boolean | null;
          liquidity_lock_duration_days: number | null;
          owner_renounced: boolean | null;
          mint_authority_revoked: boolean | null;
          top10_holder_pct: number | null;
          holder_count: number | null;
          is_honeypot: boolean | null;
          token_age_hours: number | null;
          safety_score: number;
          safety_level: SafetyLevel;
          checked_at: string;
          created_at: string;
        };
        Insert: {
          token_address: string;
          safety_score: number;
          safety_level: SafetyLevel;
          liquidity_locked?: boolean | null;
          liquidity_lock_duration_days?: number | null;
          owner_renounced?: boolean | null;
          mint_authority_revoked?: boolean | null;
          top10_holder_pct?: number | null;
          holder_count?: number | null;
          is_honeypot?: boolean | null;
          token_age_hours?: number | null;
          checked_at?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['token_safety']['Insert']>;
        Relationships: NoRelationships;
      };
      user_profiles: {
        Row: {
          id: string;
          telegram_chat_id: string | null;
          telegram_username: string | null;
          alert_min_consensus: number;
          alert_min_safety: number;
          alert_min_volume_usd: number | null;
          alert_types: string[];
          tier: UserTier;
          stripe_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          telegram_chat_id?: string | null;
          telegram_username?: string | null;
          alert_min_consensus?: number;
          alert_min_safety?: number;
          alert_min_volume_usd?: number | null;
          alert_types?: string[];
          tier?: UserTier;
          stripe_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database['public']['Tables']['user_profiles']['Insert']>;
        Relationships: NoRelationships;
      };
      user_whale_watchlist: {
        Row: {
          id: string;
          user_id: string;
          whale_id: string;
          added_at: string;
        };
        Insert: {
          user_id: string;
          whale_id: string;
          id?: string;
          added_at?: string;
        };
        Update: Partial<Database['public']['Tables']['user_whale_watchlist']['Insert']>;
        Relationships: NoRelationships;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

// Convenience row types
export type Whale = Database['public']['Tables']['whales']['Row'];
export type Transaction = Database['public']['Tables']['transactions']['Row'];
export type Alert = Database['public']['Tables']['alerts']['Row'];
export type TokenSafety = Database['public']['Tables']['token_safety']['Row'];
export type UserProfile = Database['public']['Tables']['user_profiles']['Row'];
export type UserWhaleWatchlist = Database['public']['Tables']['user_whale_watchlist']['Row'];
