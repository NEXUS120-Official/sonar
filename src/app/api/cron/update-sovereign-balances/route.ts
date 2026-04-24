// ============================================================
// SONAR — Update Sovereign Balances Cron
// ============================================================
// Provider-agnostic whale balance updater using sovereign account
// state archived in raw_transactions.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  loadSovereignAccountStateFromRaw,
  deriveValuedAccountSnapshotWithCompleteness,
} from '@/lib/providers/adapters/sovereign-account-runtime';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();

  const { data: whales, error: whaleErr } = await db
    .from('whales')
    .select('id, address')
    .eq('is_active', true)
    .limit(500);

  if (whaleErr) {
    return NextResponse.json({ ok: false, error: whaleErr.message }, { status: 500 });
  }

  let scanned = 0;
  let updated = 0;

  for (const whale of (whales ?? []) as Array<{ id: string; address: string }>) {
    scanned += 1;
    const state = await loadSovereignAccountStateFromRaw(db, whale.address);
    if (!state) continue;

    const snap = await deriveValuedAccountSnapshotWithCompleteness(db, state);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: updErr } = await (db as any)
      .from('whales')
      .update({
        sol_balance: snap.sol_balance,
        usdc_balance: snap.usdc_balance,
        total_value_usd: snap.total_value_usd,
        staked_sol: snap.staked_sol,
        staked_msol: snap.staked_msol,
        staked_jitosol: snap.staked_jitosol,
        balance_updated_at: snap.fetched_at,
      })
      .eq('id', whale.id);

    if (!updErr) updated += 1;
  }

  return NextResponse.json({
    ok: true,
    scanned,
    updated,
    source_mode: 'sovereign_account_state_v1',
  });
}

export const GET = POST;
