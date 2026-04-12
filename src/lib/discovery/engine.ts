// ============================================================
// SONAR — Discovery Engine
// ============================================================
// Orchestrates the full whale discovery pipeline:
//   1. Fetch candidates from all configured sources
//   2. Deduplicate against existing whales + previous candidates
//   3. Enrich with Solscan (if key set)
//   4. Score and route each candidate
//   5. Persist to discovery_candidates + discovery_candidate_sources
//   6. Auto-promote if status = auto_approve
//
// Does NOT modify the consensus alert pipeline.

import { createAdminClient } from '@/lib/supabase/server';
import { scoreCandidate } from './scoring';
import { fetchBirdeyeTopTraders } from './sources/birdeye';
import { fetchDexScreenerCandidates } from './sources/dexscreener';
import { enrichWithSolscan } from './sources/solscan';
import type { CandidateMetrics, DiscoveryRunSummary, DiscoverySource } from './types';

// ── Public API ────────────────────────────────────────────────

/**
 * Run the full discovery pipeline and return a run summary.
 * Called by the cron route — safe to run on any schedule.
 */
export async function runDiscovery(): Promise<DiscoveryRunSummary> {
  const runAt = new Date().toISOString();
  const db    = createAdminClient();

  const summary: DiscoveryRunSummary = {
    runAt,
    walletsAnalyzed:  0,
    sourceBreakdown:  { birdeye: 0, dexscreener: 0, solscan: 0, community: 0, arkham: 0, unknown: 0 },
    autoRejected:     0,
    manualReview:     0,
    autoApproved:     0,
    promoted:         0,
    webhookSynced:    false,
    webhookAddresses: 0,
    skipReasons:      [],
  };

  // ── Step 1: Fetch candidates from sources ─────────────────────

  const [birdeyeBatch, dexBatch] = await Promise.all([
    fetchBirdeyeTopTraders(30).catch((e) => {
      console.error('[discovery/engine] Birdeye fetch failed:', e);
      return [] as CandidateMetrics[];
    }),
    fetchDexScreenerCandidates(10).catch((e) => {
      console.error('[discovery/engine] DEXScreener fetch failed:', e);
      return [] as CandidateMetrics[];
    }),
  ]);

  const allCandidates: CandidateMetrics[] = [...birdeyeBatch, ...dexBatch];

  for (const c of allCandidates) {
    summary.sourceBreakdown[c.source as DiscoverySource] =
      (summary.sourceBreakdown[c.source as DiscoverySource] ?? 0) + 1;
  }

  console.log(
    `[discovery/engine] Fetched ${allCandidates.length} candidates — ` +
    `birdeye=${birdeyeBatch.length} dexscreener=${dexBatch.length}`,
  );

  if (allCandidates.length === 0) return summary;

  // ── Step 2: Load exclusion sets ───────────────────────────────

  const [whaleRows, existingRows] = await Promise.all([
    db.from('whales').select('address').then((r) => r.data ?? []),
    db.from('discovery_candidates').select('address').then((r) => r.data ?? []),
  ]);

  const knownAddresses = new Set<string>([
    ...whaleRows.map((w) => w.address),
    ...existingRows.map((c) => c.address),
  ]);

  // ── Step 3: Deduplicate ───────────────────────────────────────

  const seen = new Set<string>();
  const fresh: CandidateMetrics[] = [];

  for (const c of allCandidates) {
    if (seen.has(c.address)) continue;
    seen.add(c.address);

    if (knownAddresses.has(c.address)) {
      summary.skipReasons.push({ address: c.address, reason: 'already known (whale or candidate)' });
      continue;
    }

    fresh.push(c);
  }

  summary.walletsAnalyzed = fresh.length;
  console.log(`[discovery/engine] ${fresh.length} new candidates to evaluate`);

  // ── Step 4: Enrich + score + persist ─────────────────────────

  for (const candidate of fresh) {
    // Optional Solscan enrichment (overrides/supplements source metrics)
    const enriched = await enrichWithSolscan(candidate.address).catch(() => null);
    if (enriched) {
      Object.assign(candidate, {
        tradeCount30d:    enriched.tradeCount30d    ?? candidate.tradeCount30d,
        tokenDiversity30d: enriched.tokenDiversity30d ?? candidate.tokenDiversity30d,
        lastActiveAt:     enriched.lastActiveAt     ?? candidate.lastActiveAt,
        totalVolume30d:   enriched.totalVolume30d   ?? candidate.totalVolume30d,
        avgTradeSizeUsd:  enriched.avgTradeSizeUsd  ?? candidate.avgTradeSizeUsd,
      });
    }

    const { score, status, gateFailures } = scoreCandidate(candidate);

    if (status === 'auto_reject') {
      summary.autoRejected++;
      summary.skipReasons.push({
        address: candidate.address,
        reason:  `auto_reject: ${gateFailures.join(', ')}`,
      });
    } else if (status === 'manual_review') {
      summary.manualReview++;
    } else if (status === 'auto_approve') {
      summary.autoApproved++;
    }

    // Persist candidate row
    const { data: inserted, error: insertErr } = await db
      .from('discovery_candidates')
      .insert({
        address:            candidate.address,
        chain:              'solana',
        win_rate_30d:       candidate.winRate30d ?? null,
        trade_count_30d:    candidate.tradeCount30d ?? null,
        last_active_at:     candidate.lastActiveAt?.toISOString() ?? null,
        token_diversity_30d: candidate.tokenDiversity30d ?? null,
        avg_trade_size_usd: candidate.avgTradeSizeUsd ?? null,
        total_volume_30d:   candidate.totalVolume30d ?? null,
        instant_sell_pct:   candidate.instantSellPct ?? null,
        is_bot_flagged:     candidate.isBotFlagged ?? false,
        is_rug_flagged:     candidate.isRugFlagged ?? false,
        is_insider_flagged: candidate.isInsiderFlagged ?? false,
        discovery_score:    score,
        status,
        primary_source:     candidate.source,
        evaluated_at:       new Date().toISOString(),
        notes:              gateFailures.length > 0
          ? `Gate failures: ${gateFailures.join('; ')}`
          : null,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error(
        `[discovery/engine] Insert failed for ${candidate.address.slice(0, 8)}:`,
        insertErr.message,
      );
      continue;
    }

    // Store raw source data for audit
    await db.from('discovery_candidate_sources').insert({
      candidate_id: inserted.id,
      source:       candidate.source,
      source_data:  (candidate.rawData ?? null) as import('@/lib/supabase/types').Json | null,
    });

    // Log review event
    await db.from('discovery_reviews').insert({
      candidate_id: inserted.id,
      reviewer:     'system',
      action:       status,
      notes:        gateFailures.length > 0
        ? `Auto-routed. Failures: ${gateFailures.join('; ')}`
        : `Score ${score}/100 → ${status}`,
    });

    // Auto-promote if eligible
    if (status === 'auto_approve') {
      const promoted = await promoteToWhales(inserted.id, candidate.address, score);
      if (promoted) {
        summary.promoted++;
        console.log(
          `[discovery/engine] ✅ Auto-promoted ${candidate.address.slice(0, 8)} ` +
          `(score=${score}, source=${candidate.source})`,
        );
      }
    }
  }

  // ── Step 5: Webhook sync (if any auto-approvals this run) ────

  if (summary.promoted > 0) {
    const syncResult = await syncWebhook();
    summary.webhookSynced    = syncResult.ok;
    summary.webhookAddresses = syncResult.count;
  }

  return summary;
}

// ── Internal helpers ──────────────────────────────────────────

/**
 * Insert an auto-approved candidate into the whales table and
 * update the candidate row to status=promoted.
 */
async function promoteToWhales(
  candidateId: string,
  address: string,
  score: number,
): Promise<boolean> {
  const db = createAdminClient();

  const { error: whaleErr } = await db.from('whales').insert({
    address,
    chain:     'solana',
    is_active: true,
    label:     `auto_approved_score${score}`,
  });

  if (whaleErr) {
    // Likely already exists — log and continue
    console.warn(
      `[discovery/engine] Whale insert failed for ${address.slice(0, 8)}:`,
      whaleErr.message,
    );
    return false;
  }

  // Mark candidate as promoted
  await db.from('discovery_candidates').update({
    status:       'promoted',
    promoted_at:  new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  }).eq('id', candidateId);

  await db.from('discovery_reviews').insert({
    candidate_id: candidateId,
    reviewer:     'system',
    action:       'promote',
    notes:        `Auto-promoted to whales table. Score: ${score}/100`,
  });

  return true;
}

/**
 * Update the Helius webhook with all current active whale addresses.
 * Re-uses the same updateWebhook call from setup-webhooks.ts logic.
 */
async function syncWebhook(): Promise<{ ok: boolean; count: number }> {
  const db = createAdminClient();

  const { data: whales } = await db
    .from('whales')
    .select('address')
    .eq('is_active', true);

  const addresses = (whales ?? []).map((w) => w.address);
  if (addresses.length === 0) return { ok: false, count: 0 };

  const webhookId = process.env.HELIUS_WEBHOOK_ID;
  if (!webhookId) {
    console.warn('[discovery/engine] HELIUS_WEBHOOK_ID not set — skipping webhook sync');
    return { ok: false, count: addresses.length };
  }

  const heliusKey = process.env.HELIUS_API_KEY;
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL;
  const webhookSecret = process.env.HELIUS_WEBHOOK_SECRET;

  if (!heliusKey || !appUrl || !webhookSecret) {
    console.warn('[discovery/engine] Missing Helius env vars — skipping webhook sync');
    return { ok: false, count: addresses.length };
  }

  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${heliusKey}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookURL:       `${appUrl}/api/webhook/helius`,
          transactionTypes: ['SWAP'],
          accountAddresses: addresses,
          webhookType:      'enhanced',
          encoding:         'jsonParsed',
          authHeader:       webhookSecret,
        }),
      },
    );

    if (!res.ok) {
      console.error(`[discovery/engine] Webhook sync HTTP ${res.status}`);
      return { ok: false, count: addresses.length };
    }

    return { ok: true, count: addresses.length };
  } catch (err) {
    console.error('[discovery/engine] Webhook sync error:', err);
    return { ok: false, count: addresses.length };
  }
}
