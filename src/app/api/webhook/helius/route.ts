// LEGACY ADAPTER NOTICE:
// This route remains for backward compatibility while SONAR
// transitions to sovereign/provider-agnostic ingest.
// Strategic direction: /api/webhook/sovereign
//
// Helius should become an adapter, not the core ingest doctrine.

// ============================================================
// SONAR v2.0 — Helius Webhook Receiver
// POST /api/webhook/helius
// ============================================================
// Thin HTTP adapter over HeliusWebhookProcessor.
//
// Responsibilities of this file:
//   - Verify HELIUS_WEBHOOK_SECRET
//   - Parse and validate the request body
//   - Create a single DB client (passed through to processor)
//   - Kick off fire-and-forget raw archive
//   - Fetch processing context (whale addresses + SOL price) in parallel
//   - Delegate to processor.processBatch()
//   - Return JSON receipt
//
// All pipeline logic (decode, normalize, persist, hot alerts) lives
// in HeliusWebhookProcessor — not here.
//
// Security: always returns 200 — Helius retries on non-200,
// which would create duplicate-ingestion loops.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }               from '@/lib/supabase/server';
import { type RawTxPayload }               from '@/lib/decoder';
import { HeliusWebhookProcessor }          from '@/lib/providers/adapters/helius-webhook';
import { resolveSolPriceUsd }              from '@/lib/price-engine';
import { writeSystemHeartbeatSafe }       from '@/lib/ops/system-heartbeats';

const WEBHOOK_AUTH_HEADER = 'authorization';

// Module-level singleton — re-used across warm serverless invocations.
const processor = new HeliusWebhookProcessor();

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

// ── POST handler ──────────────────────────────────────────────

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth ────────────────────────────────────────────────
  if (!verifySecret(req.headers.get(WEBHOOK_AUTH_HEADER))) {
    const db = createAdminClient();
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_helius',
      status: 'unauthorized',
      source: 'helius_webhook',
      message: 'Invalid webhook secret',
    });
    log('warn', 'Invalid webhook secret');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 200 });
  }

  // ── 2. Parse body ──────────────────────────────────────────
  let txns: RawTxPayload[];
  try {
    const body = await req.json() as unknown;
    txns = (Array.isArray(body) ? body : [body]) as RawTxPayload[];
  } catch (err) {
    log('error', 'Failed to parse webhook body', err);
    return NextResponse.json({ ok: false, error: 'invalid_body' }, { status: 200 });
  }

  if (txns.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  log('info', `Received ${txns.length} transaction(s)`);

  // Single DB client shared across the entire request — no redundant connections.
  const db = createAdminClient();

  await writeSystemHeartbeatSafe(db, {
    component: 'webhook_helius',
    status: 'active',
    source: 'helius_webhook',
    message: 'Webhook batch received',
    meta: { received: txns.length },
  });

  // ── 2b. Raw archive — fire-and-forget (sovereign immutable log) ─
  // Written before decode so even unparseable payloads are captured.
  processor.archiveRaw(txns, db).catch(async err => {
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_helius_raw_archive',
      status: 'error',
      source: 'helius_webhook',
      message: err instanceof Error ? err.message : String(err),
      meta: { received: txns.length },
    });
    log('warn', 'Raw transaction logging failed', err);
  });

  // ── 3. Fetch processing context — parallel ─────────────────
  const [whaleAddressSet, solPriceUsd] = await Promise.all([
    processor.fetchWhaleAddresses(db),
    resolveSolPriceUsd(),
  ]);
  log('info', `SOL price: $${solPriceUsd.toFixed(2)}, whale addresses: ${whaleAddressSet.size}`);

  // ── 4. Process batch (decode → normalize → persist → alerts) ─
  try {
    const receipt = await processor.processBatch(txns, { solPriceUsd, whaleAddressSet }, db);

    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_helius',
      status: 'ok',
      source: 'helius_webhook',
      message: 'Webhook batch processed',
      meta: {
        received: receipt.received,
        classified: receipt.classified,
        inserted: receipt.inserted,
        token_inserted: receipt.token_inserted,
      },
    });

    log('info', `Done — ${receipt.inserted} movements, ${receipt.token_inserted} token_movements`);

    return NextResponse.json({ ok: true, ...receipt });
  } catch (err) {
    await writeSystemHeartbeatSafe(db, {
      component: 'webhook_helius',
      status: 'error',
      source: 'helius_webhook',
      message: err instanceof Error ? err.message : String(err),
      meta: { received: txns.length },
    });
    throw err;
  }
}
