// ============================================================
// SONAR — Sovereign Account Runtime
// ============================================================
// Provider-agnostic account-state / balance inspection runtime.
// This is the replacement seam for Helius getAssetsByOwner-style
// balance inspection.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;
import { deriveUsdValue } from '@/lib/sovereign/sovereign-price-runtime';

export interface SovereignTokenBalance {
  mint: string;
  owner: string | null;
  amount_raw: string | null;
  amount_ui: number | null;
  decimals: number | null;
  symbol: string | null;
  token_program: 'spl_token' | 'token_2022' | 'unknown';
}

export interface SovereignAccountState {
  address: string;
  native_sol_balance: number | null;
  token_balances: SovereignTokenBalance[];
  total_token_positions: number;
  fetched_at: string;
  source_mode: 'sovereign_account_state_v1';
}

export interface SovereignAccountSnapshot {
  address: string;
  sol_balance: number;
  usdc_balance: number;
  total_value_usd: number | null;
  staked_sol: number;
  staked_msol: number;
  staked_jitosol: number;
  fetched_at: string;
  source_mode: 'sovereign_account_state_v1';
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function inferTokenProgram(v: unknown): 'spl_token' | 'token_2022' | 'unknown' {
  if (v === 'spl_token') return 'spl_token';
  if (v === 'token_2022') return 'token_2022';
  return 'unknown';
}

export function normalizeRawAccountState(
  address: string,
  raw: Record<string, unknown>,
): SovereignAccountState {
  const native_sol_balance = asNumber(raw['native_sol_balance']);

  const token_balances = Array.isArray(raw['token_balances'])
    ? raw['token_balances']
        .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((row) => ({
          mint: typeof row['mint'] === 'string' ? row['mint'] : 'unknown',
          owner: typeof row['owner'] === 'string' ? row['owner'] : null,
          amount_raw: typeof row['amount_raw'] === 'string' ? row['amount_raw'] : null,
          amount_ui: asNumber(row['amount_ui']),
          decimals: asNumber(row['decimals']),
          symbol: typeof row['symbol'] === 'string' ? row['symbol'] : null,
          token_program: inferTokenProgram(row['token_program']),
        }))
    : [];

  return {
    address,
    native_sol_balance,
    token_balances,
    total_token_positions: token_balances.length,
    fetched_at: new Date().toISOString(),
    source_mode: 'sovereign_account_state_v1',
  };
}

export function deriveAccountSnapshot(
  state: SovereignAccountState,
): SovereignAccountSnapshot {
  let usdc_balance = 0;
  let staked_msol = 0;
  let staked_jitosol = 0;

  for (const t of state.token_balances) {
    const sym = (t.symbol ?? '').toUpperCase();
    const amt = t.amount_ui ?? 0;

    if (sym === 'USDC') usdc_balance += amt;
    if (sym === 'MSOL') staked_msol += amt;
    if (sym === 'JITOSOL') staked_jitosol += amt;
  }

  return {
    address: state.address,
    sol_balance: state.native_sol_balance ?? 0,
    usdc_balance,
    total_value_usd: null,
    staked_sol: 0,
    staked_msol,
    staked_jitosol,
    fetched_at: state.fetched_at,
    source_mode: state.source_mode,
  };
}

export async function loadSovereignAccountStateFromRaw(
  db: Db,
  address: string,
): Promise<SovereignAccountState | null> {
  // Reads the latest archived sovereign account-state payload from raw_transactions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_account_state')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) throw error;

  const rows = (data ?? []) as Array<{ raw_json: Record<string, unknown> | null }>;
  for (const row of rows) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;
    if (raw['address'] !== address) continue;
    return normalizeRawAccountState(address, raw);
  }

  return null;
}


export async function deriveValuedAccountSnapshot(
  db: Db,
  state: SovereignAccountState,
): Promise<SovereignAccountSnapshot> {
  const snap = deriveAccountSnapshot(state);

  const [solVal, usdcVal] = await Promise.all([
    deriveUsdValue(db, 'SOL', snap.sol_balance),
    deriveUsdValue(db, 'USDC', snap.usdc_balance),
  ]);

  const total =
    (solVal.value_usd ?? 0) +
    (usdcVal.value_usd ?? 0);

  return {
    ...snap,
    total_value_usd: total > 0 ? total : null,
  };
}
