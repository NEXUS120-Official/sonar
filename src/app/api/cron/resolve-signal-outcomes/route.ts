// ============================================================
// SONAR — Resolve Signal Outcomes
// POST /api/cron/resolve-signal-outcomes   (every 5 min)
// ============================================================
// For each unresolved whale_signal_outcome:
//   - Fills price windows that have elapsed (5m, 15m, 1h, 4h)
//     using the current SOL price as a snapshot at that window
//   - Computes return_* and hit_* from price_at_signal vs window price
//   - Marks resolved=true once the 4h window is filled
//
// hit_X = the price moved ≥0.1% in the predicted direction at window X.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }               from '@/lib/supabase/server';
import { getCachedSolPrice }               from '@/lib/helius/sol-price-cache';
import type { WhaleSignalOutcomeRow }      from '@/lib/supabase/types';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('authorization') ?? req.headers.get('x-cron-secret') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

const MIN_HIT_PCT = 0.10; // 0.10% move counts as a confirmed hit

function computeReturn(priceAtSignal: number, priceAtWindow: number, direction: string): number {
  if (!priceAtSignal || !priceAtWindow) return 0;
  const raw = ((priceAtWindow - priceAtSignal) / priceAtSignal) * 100;
  // For bearish signals: lower price = positive outcome → flip sign
  return direction === 'bearish' ? -raw : raw;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs  = Date.now();
  const db       = createAdminClient();
  const now      = new Date();
  const solPrice = await getCachedSolPrice();

  const cutoff5m  = new Date(now.getTime() -  5 * 60_000).toISOString();
  const cutoff15m = new Date(now.getTime() - 15 * 60_000).toISOString();
  const cutoff1h  = new Date(now.getTime() - 60 * 60_000).toISOString();
  const cutoff4h  = new Date(now.getTime() -  4 * 3_600_000).toISOString();

  // Fetch unresolved outcomes older than 5 minutes
  const { data: rawPending, error: fetchErr } = await (db as any)
    .from('whale_signal_outcomes')
    .select('*')
    .eq('resolved', false)
    .lt('signal_time', cutoff5m)
    .limit(200);

  if (fetchErr) {
    return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
  }

  const pending = (rawPending ?? []) as WhaleSignalOutcomeRow[];
  let updated   = 0;

  for (const row of pending) {
    const sigTime = row.signal_time;
    const patch: Record<string, unknown> = {};

    // 5m window
    if (!row.price_5m && sigTime <= cutoff5m) {
      patch.price_5m = solPrice;
      const ret = computeReturn(row.price_at_signal!, solPrice, row.signal_direction);
      patch.return_5m = Math.round(ret * 10000) / 10000;
      patch.hit_5m    = ret >= MIN_HIT_PCT;
    }

    // 15m window
    if (!row.price_15m && sigTime <= cutoff15m) {
      patch.price_15m = solPrice;
      const ret = computeReturn(row.price_at_signal!, solPrice, row.signal_direction);
      patch.return_15m = Math.round(ret * 10000) / 10000;
      patch.hit_15m    = ret >= MIN_HIT_PCT;
    }

    // 1h window
    if (!row.price_1h && sigTime <= cutoff1h) {
      patch.price_1h = solPrice;
      const ret = computeReturn(row.price_at_signal!, solPrice, row.signal_direction);
      patch.return_1h = Math.round(ret * 10000) / 10000;
      patch.hit_1h    = ret >= MIN_HIT_PCT;
    }

    // 4h window — also marks resolved
    if (!row.price_4h && sigTime <= cutoff4h) {
      patch.price_4h = solPrice;
      const ret = computeReturn(row.price_at_signal!, solPrice, row.signal_direction);
      patch.return_4h = Math.round(ret * 10000) / 10000;
      patch.hit_4h    = ret >= MIN_HIT_PCT;
      patch.resolved  = true;
    }

    if (Object.keys(patch).length === 0) continue;

    await (db as any)
      .from('whale_signal_outcomes')
      .update(patch)
      .eq('id', row.id);

    updated++;
  }

  return NextResponse.json({
    ok:         true,
    pending:    pending.length,
    updated,
    sol_price:  solPrice,
    duration_ms: Date.now() - startMs,
  });
}

export const GET = POST;
