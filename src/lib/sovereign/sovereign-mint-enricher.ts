// ============================================================
// SONAR — Sovereign Mint Enricher
// ============================================================
// Deferred sovereign mint enrichment runtime.
// No hot-path blocking. Registry updates compound over time.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';

type Db = ReturnType<typeof createAdminClient>;

export interface SovereignMintInspection {
  mint: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  token_program: 'spl_token' | 'token_2022' | 'unknown';
  is_token_2022: boolean;
  has_transfer_fee: boolean;
  has_transfer_hook: boolean;
  has_confidential_transfer: boolean;
  has_auditor_key: boolean;
  has_freeze_authority: boolean;
  enrichment_confidence: 'high' | 'medium' | 'low';
  risk_flags: string[];
  raw_snapshot: Record<string, unknown> | null;
  metadata_source_mode: 'sovereign_mint_scanner_v1';
}

function asBool(v: unknown): boolean {
  return v === true;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function inferConfidence(raw: Record<string, unknown>): 'high' | 'medium' | 'low' {
  const decimals = asNum(raw['decimals']);
  const program = asStr(raw['token_program']);
  if (decimals !== null && program) return 'high';
  if (decimals !== null || program) return 'medium';
  return 'low';
}

export function inspectRawMintSnapshot(
  mint: string,
  raw: Record<string, unknown>,
): SovereignMintInspection {
  const tokenProgramRaw = asStr(raw['token_program']);
  const token_program: 'spl_token' | 'token_2022' | 'unknown' =
    tokenProgramRaw === 'token_2022'
      ? 'token_2022'
      : tokenProgramRaw === 'spl_token'
        ? 'spl_token'
        : 'unknown';

  const risk_flags: string[] = [];
  if (asBool(raw['has_transfer_fee'])) risk_flags.push('transfer_fee_enabled');
  if (asBool(raw['has_transfer_hook'])) risk_flags.push('transfer_hook_enabled');
  if (asBool(raw['has_confidential_transfer'])) risk_flags.push('confidential_transfer_adjacent');
  if (asBool(raw['has_auditor_key'])) risk_flags.push('auditor_key_present');
  if (asBool(raw['has_freeze_authority'])) risk_flags.push('freeze_authority_present');
  if (token_program === 'unknown') risk_flags.push('unknown_program');

  return {
    mint,
    symbol: asStr(raw['symbol']),
    name: asStr(raw['name']),
    decimals: asNum(raw['decimals']),
    token_program,
    is_token_2022: token_program === 'token_2022' || asBool(raw['is_token_2022']),
    has_transfer_fee: asBool(raw['has_transfer_fee']),
    has_transfer_hook: asBool(raw['has_transfer_hook']),
    has_confidential_transfer: asBool(raw['has_confidential_transfer']),
    has_auditor_key: asBool(raw['has_auditor_key']),
    has_freeze_authority: asBool(raw['has_freeze_authority']),
    enrichment_confidence: inferConfidence(raw),
    risk_flags,
    raw_snapshot: raw,
    metadata_source_mode: 'sovereign_mint_scanner_v1',
  };
}

export async function enqueueUnknownMint(
  db: Db,
  mint: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_mint_enrichment_queue')
    .upsert({
      mint,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      sighting_count: 1,
      status: 'pending',
      last_error: null,
    }, { onConflict: 'mint' });
}

export async function loadPendingMintQueue(
  db: Db,
  limit: number = 100,
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('sovereign_mint_enrichment_queue')
    .select('mint')
    .eq('status', 'pending')
    .order('last_seen_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as Array<{ mint: string }>).map((r) => r.mint);
}

export async function loadRawMintSnapshot(
  db: Db,
  mint: string,
): Promise<Record<string, unknown> | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('raw_transactions')
    .select('raw_json, created_at')
    .eq('source', 'sovereign_mint_state')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) throw error;

  for (const row of (data ?? []) as Array<{ raw_json: Record<string, unknown> | null }>) {
    const raw = row.raw_json;
    if (!raw || typeof raw !== 'object') continue;
    if (raw['mint'] === mint) return raw;
  }

  return null;
}

export async function upsertMintInspection(
  db: Db,
  inspection: SovereignMintInspection,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_mint_registry')
    .upsert({
      mint: inspection.mint,
      symbol: inspection.symbol,
      name: inspection.name,
      decimals: inspection.decimals,
      token_program: inspection.token_program,
      is_token_2022: inspection.is_token_2022,
      has_transfer_fee: inspection.has_transfer_fee,
      has_transfer_hook: inspection.has_transfer_hook,
      has_confidential_transfer: inspection.has_confidential_transfer,
      has_auditor_key: inspection.has_auditor_key,
      has_freeze_authority: inspection.has_freeze_authority,
      metadata_source_mode: inspection.metadata_source_mode,
      enrichment_confidence: inspection.enrichment_confidence,
      risk_flags: inspection.risk_flags,
      raw_snapshot: inspection.raw_snapshot,
      last_enriched_at: new Date().toISOString(),
    }, { onConflict: 'mint' });
}

export async function markMintQueueStatus(
  db: Db,
  mint: string,
  status: 'done' | 'pending' | 'error',
  lastError: string | null = null,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('sovereign_mint_enrichment_queue')
    .update({
      status,
      last_error: lastError,
      last_seen_at: new Date().toISOString(),
    })
    .eq('mint', mint);
}
