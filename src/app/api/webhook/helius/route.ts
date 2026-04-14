// ============================================================
// SONAR v2.0 — Helius Webhook Receiver
// POST /api/webhook/helius
// ============================================================
// Receives enhanced transaction payloads from Helius.
// Classifies movements (exchange deposit/withdrawal, stake,
// unstake, DeFi deposit/withdrawal, whale transfer) and
// persists to the movements table.
//
// Security: verifies Authorization header against HELIUS_WEBHOOK_SECRET.
// Always returns 200 — Helius retries on non-200, creating infinite loops.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }               from '@/lib/supabase/server';
import { parseMovement, type HeliusEnhancedTx } from '@/lib/helius/parse-movement';
import { getCachedSolPrice }               from '@/lib/helius/sol-price-cache';
import type { MovementRow }                from '@/lib/supabase/types';

const WEBHOOK_AUTH_HEADER = 'authorization';

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[webhook/helius][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifySecret(header: string | null): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) return false;
  return header === secret;
}

// ── Fetch active whale address set ────────────────────────────

async function fetchWhaleAddressSet(): Promise<Set<string>> {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from('whales')
      .select('address')
      .eq('is_active', true)
      .limit(500);

    if (!data) return new Set();
    return new Set((data as { address: string }[]).map((w) => w.address));
  } catch {
    return new Set();
  }
}

// ── Persist movements ─────────────────────────────────────────

async function persistMovements(
  movements: ReturnType<typeof parseMovement>[],
): Promise<{ inserted: number; skipped: number }> {
  const valid = movements.filter((m): m is NonNullable<typeof m> => m !== null);
  if (valid.length === 0) return { inserted: 0, skipped: 0 };

  const db = createAdminClient();

  // Resolve whale_id for each movement where from/to is a tracked whale
  const whaleAddresses = [...new Set(valid.flatMap((m) => [m.from_address, m.to_address]))];
  const { data: whales } = await db
    .from('whales')
    .select('id, address')
    .in('address', whaleAddresses);

  const whaleMap = new Map<string, string>(
    ((whales ?? []) as { id: string; address: string }[]).map((w) => [w.address, w.id]),
  );

  const rows = valid.map((m) => {
    const whale_id =
      whaleMap.get(m.from_address) ?? whaleMap.get(m.to_address) ?? null;
    return { ...m, whale_id } satisfies Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>;
  });

  // Upsert on signature to handle Helius retries gracefully
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await db
    .from('movements')
    .upsert(rows as any, { onConflict: 'signature', ignoreDuplicates: true })
    .select('id');

  if (error) {
    log('error', 'Failed to upsert movements', error);
    return { inserted: 0, skipped: valid.length };
  }

  return { inserted: (inserted?.length ?? 0), skipped: valid.length - (inserted?.length ?? 0) };
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ────────────────────────────────────────────────
  const authHeader = req.headers.get(WEBHOOK_AUTH_HEADER);
  if (!verifySecret(authHeader)) {
    log('warn', 'Invalid webhook secret');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 200 });
  }

  // ── 2. Parse body ──────────────────────────────────────────
  let transactions: unknown[];
  try {
    const body = await req.json() as unknown;
    transactions = Array.isArray(body) ? body : [body];
  } catch (err) {
    log('error', 'Failed to parse webhook body', err);
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 200 });
  }

  if (transactions.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  log('info', `Received ${transactions.length} transaction(s)`);

  // ── 3. Fetch live SOL price + whale addresses in parallel ─
  const [whaleAddresses, solPriceUsd] = await Promise.all([
    fetchWhaleAddressSet(),
    getCachedSolPrice(),
  ]);
  log('info', `SOL price: $${solPriceUsd.toFixed(2)}`);

  // ── 4. Classify each transaction ──────────────────────────
  const movements = (transactions as HeliusEnhancedTx[]).map((tx) => {
    try {
      return parseMovement(tx, whaleAddresses, solPriceUsd);
    } catch (err) {
      log('warn', `Failed to parse tx ${tx?.signature ?? 'unknown'}`, err);
      return null;
    }
  });

  const classified = movements.filter((m) => m !== null).length;
  log('info', `Classified ${classified}/${transactions.length} transactions as movements`);

  // ── 5. Persist ─────────────────────────────────────────────
  const { inserted, skipped } = await persistMovements(movements);
  log('info', `Persisted ${inserted} movements (${skipped} skipped/duplicate)`);

  return NextResponse.json({
    ok:         true,
    received:   transactions.length,
    classified,
    inserted,
    skipped,
  });
}
