// ============================================================
// SONAR v2.0 — GET /api/flow/defi
// ============================================================
// Returns DeFi flow breakdown:
//   - net per protocol (last 24h)
//   - recent protocol rotations
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/flow/defi] ${msg}`, ctx ?? '');
}

const WINDOW_HOURS = 24;
const TOP_MOVEMENTS = 20;

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();
    const cutoff = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    const { data: rawMovements, error } = await db
      .from('movements')
      .select('id, from_address, to_address, from_label, to_label, flow_type, protocol, amount_usd, token, block_time')
      .in('flow_type', ['defi_deposit', 'defi_withdrawal'])
      .gte('block_time', cutoff)
      .order('block_time', { ascending: false })
      .limit(500);

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const movements = (rawMovements ?? []) as Pick<
      MovementRow,
      'id' | 'from_address' | 'to_address' | 'from_label' | 'to_label' |
      'flow_type' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
    >[];

    const protocolMap = new Map<string, { deposit: number; withdrawal: number; count: number }>();
    for (const m of movements) {
      const key = m.protocol ?? 'unknown';
      const entry = protocolMap.get(key) ?? { deposit: 0, withdrawal: 0, count: 0 };
      const usd = m.amount_usd ?? 0;
      if (m.flow_type === 'defi_deposit')    entry.deposit    += usd;
      if (m.flow_type === 'defi_withdrawal') entry.withdrawal += usd;
      entry.count++;
      protocolMap.set(key, entry);
    }

    const byProtocol = Array.from(protocolMap.entries())
      .map(([protocol, v]) => ({
        protocol,
        deposit_usd:    v.deposit,
        withdrawal_usd: v.withdrawal,
        net_usd:        v.deposit - v.withdrawal,
        count:          v.count,
      }))
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd));

    const total_deposit    = movements.filter(m => m.flow_type === 'defi_deposit').reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const total_withdrawal = movements.filter(m => m.flow_type === 'defi_withdrawal').reduce((s, m) => s + (m.amount_usd ?? 0), 0);

    return NextResponse.json({
      ok:           true,
      window_hours: WINDOW_HOURS,
      totals: {
        deposit_usd:    total_deposit,
        withdrawal_usd: total_withdrawal,
        net_usd:        total_deposit - total_withdrawal,
        count:          movements.length,
      },
      by_protocol:  byProtocol,
      recent:       movements.slice(0, TOP_MOVEMENTS).map(m => ({
        id:         m.id,
        flow_type:  m.flow_type,
        protocol:   m.protocol,
        token:      m.token,
        amount_usd: m.amount_usd,
        from:       m.from_label ?? m.from_address,
        to:         m.to_label   ?? m.to_address,
        block_time: m.block_time,
      })),
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
