// ============================================================
// SONAR v2.0 — GET /api/whales
// ============================================================
// Returns the active whale list with balances, discovery info,
// and last movement per whale.
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { WhaleRow, MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/whales] ${msg}`, ctx ?? '');
}

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    // Fetch active whales
    const { data: whalesRaw, error: whaleErr } = await db
      .from('whales')
      .select('id, address, label, chain, is_active, sol_balance, usdc_balance, total_value_usd, whale_type, discovery_method, discovered_at, balance_updated_at')
      .eq('is_active', true)
      .order('total_value_usd', { ascending: false, nullsFirst: false })
      .limit(200);

    if (whaleErr) {
      log('DB error', whaleErr.message);
      return NextResponse.json({ ok: false, error: whaleErr.message }, { status: 500 });
    }

    const whales = (whalesRaw ?? []) as Pick<
      WhaleRow,
      'id' | 'address' | 'label' | 'chain' | 'is_active' | 'sol_balance' | 'usdc_balance' |
      'total_value_usd' | 'whale_type' | 'discovery_method' | 'discovered_at' | 'balance_updated_at'
    >[];

    if (whales.length === 0) {
      return NextResponse.json({ ok: true, count: 0, whales: [] });
    }

    // Fetch last movement per whale
    const whaleIds = whales.map(w => w.id);
    const { data: movementsRaw, error: movErr } = await db
      .from('movements')
      .select('whale_id, flow_type, amount_usd, block_time')
      .in('whale_id', whaleIds)
      .order('block_time', { ascending: false })
      .limit(whaleIds.length * 3); // generous buffer to find 1 per whale

    if (movErr) {
      log('Movements query error (non-fatal)', movErr.message);
    }

    const movements = (movementsRaw ?? []) as Pick<
      MovementRow,
      'whale_id' | 'flow_type' | 'amount_usd' | 'block_time'
    >[];

    // Build last-movement map (already ordered desc by block_time)
    const lastMovement = new Map<
      string,
      { flow_type: string; amount_usd: number | null; block_time: string }
    >();
    for (const m of movements) {
      if (m.whale_id && !lastMovement.has(m.whale_id)) {
        lastMovement.set(m.whale_id, {
          flow_type:  m.flow_type,
          amount_usd: m.amount_usd,
          block_time: m.block_time,
        });
      }
    }

    const result = whales.map(w => ({
      id:                 w.id,
      address:            w.address,
      label:              w.label,
      chain:              w.chain,
      sol_balance:        w.sol_balance,
      usdc_balance:       w.usdc_balance,
      total_value_usd:    w.total_value_usd,
      whale_type:         w.whale_type,
      discovery_method:   w.discovery_method,
      discovered_at:      w.discovered_at,
      balance_updated_at: w.balance_updated_at,
      last_movement:      lastMovement.get(w.id) ?? null,
    }));

    return NextResponse.json({ ok: true, count: result.length, whales: result });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
