// ============================================================
// SONAR — Sovereign Mint Enrichment Cron
// POST /api/cron/enrich-unknown-mints
// ============================================================
// Drains the GLOBAL_MINT_ENRICHMENT_QUEUE and performs sovereign
// RPC inspection of each unknown mint.
//
// Flow:
//   1. Check SOVEREIGN_RPC_URL is configured
//   2. Drain the in-memory queue (mints flagged is_new_token=true
//      during recent normalization passes)
//   3. Also re-enqueue mints from DB that still need_followup
//      (ensures mints from cold-start sessions get processed)
//   4. Batch-inspect each mint via getAccountInfo(jsonParsed)
//   5. Interpret raw inspection → SovereignMintEnrichmentResult
//   6. Persist to sovereign_mint_enrichments + token_metadata
//
// The decoder hot path is never blocked — enqueue is O(1).
// This cron is the asynchronous consumer of that queue.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { SovereignRpcClient }             from '@/lib/sovereign/rpc-client';
import {
  GLOBAL_MINT_ENRICHMENT_QUEUE,
  interpretMintInspection,
  persistEnrichmentBatchToDb,
  type SovereignMintEnrichmentResult,
} from '@/lib/sovereign/mint-enricher';
import { inspectMintAccountBatch } from '@/lib/sovereign/mint-inspection';
import { createAdminClient }       from '@/lib/supabase/server';

const MAX_MINTS_PER_RUN = 50;   // cap to stay within Vercel function timeout
const RPC_DELAY_MS      = 200;  // inter-call delay to avoid rate limits

// ── Auth ──────────────────────────────────────────────────────

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode — no secret configured
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${secret}`;
}

// ── Main handler ──────────────────────────────────────────────

export const POST = async (req: NextRequest) => {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const rpcUrl = process.env.SOVEREIGN_RPC_URL;
  if (!rpcUrl) {
    return NextResponse.json({
      status: 'SKIP',
      reason: 'SOVEREIGN_RPC_URL not configured',
    });
  }

  const client = new SovereignRpcClient(rpcUrl);
  const db     = createAdminClient();
  const started_at = new Date().toISOString();

  // ── Step 1: collect mints to inspect ─────────────────────────
  // Start with queue mints from this warm instance
  const fromQueue = GLOBAL_MINT_ENRICHMENT_QUEUE.peek();

  // Also pull needs_followup=true mints from DB (covers cold-start sessions)
  let fromDb: string[] = [];
  try {
    const { data } = await db
      .from('sovereign_mint_enrichments')
      .select('mint')
      .eq('needs_followup', true)
      .order('inspected_at', { ascending: true })
      .limit(MAX_MINTS_PER_RUN);
    fromDb = (data ?? []).map((r: { mint: string }) => r.mint);
  } catch { /* table may not exist yet — ignore */ }

  // Merge, deduplicate, cap
  const allMints = [...new Set([...fromQueue, ...fromDb])].slice(0, MAX_MINTS_PER_RUN);

  if (allMints.length === 0) {
    return NextResponse.json({
      status:     'OK',
      enriched:   0,
      errors:     0,
      queue_size: 0,
      started_at,
      message:    'No unknown mints pending enrichment.',
    });
  }

  // Drain queue for the mints we are about to process
  // (re-snapshot so we only clear what we are handling)
  const queueSnapshot = GLOBAL_MINT_ENRICHMENT_QUEUE.peek();
  const handledFromQueue = new Set(allMints);
  // Re-add any queue items NOT in allMints (unlikely but safe)
  for (const m of queueSnapshot) {
    if (!handledFromQueue.has(m)) GLOBAL_MINT_ENRICHMENT_QUEUE.enqueue(m);
  }
  // Clear by draining without inspection (we inspect below with allMints)
  await GLOBAL_MINT_ENRICHMENT_QUEUE.drainAndEnrich(
    { getMintAccountInfo: async () => null } as unknown as SovereignRpcClient,
    0,
  );

  // ── Step 2: inspect ───────────────────────────────────────────
  const rawInspections = await inspectMintAccountBatch(client, allMints, RPC_DELAY_MS);
  const results: SovereignMintEnrichmentResult[] = rawInspections.map(interpretMintInspection);

  // ── Step 3: persist ───────────────────────────────────────────
  await persistEnrichmentBatchToDb(results);

  const errors    = results.filter(r => r.enrichment_source === 'rpc_error').length;
  const token2022 = results.filter(r => r.token_program === 'token_2022').length;
  const highConf  = results.filter(r => r.confidence === 'high').length;

  return NextResponse.json({
    status:         'OK',
    enriched:       results.length,
    errors,
    token_2022_found: token2022,
    high_confidence:  highConf,
    needs_followup:   results.filter(r => r.needs_followup).length,
    mints_processed:  results.map(r => ({
      mint:          r.mint.slice(0, 16) + '...',
      token_program: r.token_program,
      confidence:    r.confidence,
      has_transfer_fee: r.has_transfer_fee,
      has_confidential: r.has_confidential_transfer,
      has_auditor_key:  r.has_auditor_key,
      risk_flags:    r.risk_flags,
    })),
    started_at,
    completed_at: new Date().toISOString(),
  });
};

export const GET = POST;
