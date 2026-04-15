// ============================================================
// SONAR v2.0 — GET /api/token-movements
// ============================================================
// Returns SPL token buy/sell/LP movements by tracked whales.
// Supports filtering by whale_id, token_mint, action, and time.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { TokenMovementRow, WhaleRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

function log(msg: string, ctx?: unknown) {
  console.log(`[api/token-movements] ${msg}`, ctx ?? '');
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = req.nextUrl;

    const whale_id   = searchParams.get('whale_id')   ?? undefined;
    const token_mint = searchParams.get('token_mint') ?? undefined;
    const action     = searchParams.get('action')     ?? undefined;
    const since      = searchParams.get('since')      ?? undefined;
    const limitParam = parseInt(searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
    const limit      = Math.min(isNaN(limitParam) ? DEFAULT_LIMIT : limitParam, MAX_LIMIT);

    // Validate action if provided
    const VALID_ACTIONS = new Set(['buy', 'sell', 'add_liquidity', 'remove_liquidity']);
    if (action && !VALID_ACTIONS.has(action)) {
      return NextResponse.json(
        { ok: false, error: `Invalid action: ${action}. Must be one of: buy, sell, add_liquidity, remove_liquidity` },
        { status: 400 },
      );
    }

    const db = createAdminClient();

    // ── Build query ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (db as any)
      .from('token_movements')
      .select(`
        id,
        movement_id,
        whale_id,
        signature,
        block_time,
        token_mint,
        token_symbol,
        token_name,
        action,
        amount_token,
        amount_sol,
        amount_usd,
        price_per_token,
        protocol,
        pool_address,
        is_new_token,
        created_at
      `)
      .order('block_time', { ascending: false })
      .limit(limit);

    if (whale_id)   query = query.eq('whale_id',   whale_id);
    if (token_mint) query = query.eq('token_mint', token_mint);
    if (action)     query = query.eq('action',     action);
    if (since)      query = query.gte('block_time', since);

    const { data: rows, error } = await query;

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const tokenMovements = (rows ?? []) as TokenMovementRow[];

    // ── Enrich with whale label/tier where available ─────────
    const whaleIds = [...new Set(
      tokenMovements.map((m) => m.whale_id).filter((id): id is string => !!id),
    )];

    let whaleMap = new Map<string, Pick<WhaleRow, 'id' | 'label' | 'whale_type'>>();

    if (whaleIds.length > 0) {
      const { data: whaleRows } = await db
        .from('whales')
        .select('id, label, whale_type')
        .in('id', whaleIds);

      for (const w of (whaleRows ?? []) as Pick<WhaleRow, 'id' | 'label' | 'whale_type'>[]) {
        whaleMap.set(w.id, w);
      }
    }

    const enriched = tokenMovements.map((m) => ({
      ...m,
      whale_label:      m.whale_id ? (whaleMap.get(m.whale_id)?.label ?? null) : null,
      whale_type:       m.whale_id ? (whaleMap.get(m.whale_id)?.whale_type ?? null) : null,
    }));

    log(`Returning ${enriched.length} token movements`);

    return NextResponse.json({
      ok:    true,
      count: enriched.length,
      data:  enriched,
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
