// ============================================================
// SONAR — Helius Webhook Receiver
// POST /api/webhook/helius
// ============================================================
// Receives enhanced transaction payloads from Helius.
// Filters to tracked whale wallets, parses SWAPs, persists to DB.
//
// Security: verifies Authorization header against HELIUS_WEBHOOK_SECRET.
// Always returns 200 — Helius retries on non-200, which we don't want
// for bad-auth or parse errors (would create infinite retry loops).

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { verifyWebhookSecret } from '@/lib/helius/client';
import type { HeliusEnhancedTransaction } from '@/lib/helius/client';
import { parseSwapTransaction } from '@/lib/helius/parse-transaction';
import { CRON_AUTH_HEADER } from '@/lib/utils/constants';

// ── Header used for Helius webhook authentication ─────────────
// Helius sends this as the raw value of the "Authorization" header.
// Set it in the Helius dashboard when creating the webhook.
// Must match HELIUS_WEBHOOK_SECRET in .env.local.
const WEBHOOK_AUTH_HEADER = 'authorization';

// ── Helpers ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts = new Date().toISOString();
  const prefix = `[webhook/helius][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn') console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

/**
 * Fetch all active whale addresses as a Set for O(1) lookup.
 * Called once per webhook invocation — acceptable for current whale list size.
 */
async function getActiveWhaleAddresses(): Promise<Map<string, string>> {
  const db = createAdminClient();
  const { data, error } = await db
    .from('whales')
    .select('id, address')
    .eq('is_active', true);

  if (error) {
    throw new Error(`[webhook/helius] Failed to fetch whale addresses: ${error.message}`);
  }

  // Map: address → whale_id
  return new Map((data ?? []).map((w) => [w.address, w.id]));
}

// ── Route handler ─────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Verify webhook secret ───────────────────────────────
  const authHeader = req.headers.get(WEBHOOK_AUTH_HEADER);
  if (!verifyWebhookSecret(authHeader)) {
    log('warn', 'Invalid webhook secret', { authHeader: authHeader?.slice(0, 8) });
    // Return 200 to prevent Helius infinite retry; the payload is rejected silently.
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 200 });
  }

  // ── 2. Parse body ──────────────────────────────────────────
  let transactions: HeliusEnhancedTransaction[];
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

  // ── 3. Load active whale address → id map ─────────────────
  let whaleMap: Map<string, string>;
  try {
    whaleMap = await getActiveWhaleAddresses();
  } catch (err) {
    log('error', 'Failed to load whale addresses', err);
    return NextResponse.json({ ok: false, error: 'db_error' }, { status: 200 });
  }

  // ── 4. Process each transaction ───────────────────────────
  const db = createAdminClient();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const tx of transactions) {
    const sig = tx.signature?.slice(0, 16) ?? 'unknown';

    try {
      // Identify the whale: feePayer is the wallet that initiated the swap
      const whaleAddress = tx.feePayer;
      const whaleId = whaleMap.get(whaleAddress);

      if (!whaleId) {
        // Transaction involves a non-tracked wallet — skip silently
        skipped++;
        continue;
      }

      // Parse the SWAP
      const parsed = parseSwapTransaction(tx, whaleAddress);
      if (!parsed) {
        log('info', `sig=${sig} skipped (not a parseable SWAP for ${whaleAddress.slice(0, 8)})`);
        skipped++;
        continue;
      }

      // Insert into transactions table
      // ON CONFLICT DO NOTHING via ignoreDuplicates — signature is UNIQUE
      const { error: insertError } = await db.from('transactions').upsert(
        {
          whale_id:      whaleId,
          signature:     parsed.signature,
          type:          parsed.type,
          token_address: parsed.tokenAddress,
          token_symbol:  parsed.tokenSymbol,
          token_name:    parsed.tokenName,
          amount_token:  parsed.amountToken,
          amount_usd:    parsed.amountUsd,
          price_at_tx:   parsed.priceAtTx,
          dex:           parsed.dex,
          block_time:    parsed.blockTime.toISOString(),
        },
        { onConflict: 'signature', ignoreDuplicates: true },
      );

      if (insertError) {
        log('error', `sig=${sig} insert failed`, insertError.message);
        errors++;
      } else {
        log('info', `sig=${sig} inserted — ${parsed.type} ${parsed.tokenAddress.slice(0, 8)} by ${whaleAddress.slice(0, 8)}`);
        inserted++;
      }
    } catch (err) {
      log('error', `sig=${sig} unhandled error`, err);
      errors++;
    }
  }

  // ── 5. Respond ─────────────────────────────────────────────
  log('info', `Done — inserted=${inserted} skipped=${skipped} errors=${errors}`);
  return NextResponse.json({ ok: true, inserted, skipped, errors });
}
