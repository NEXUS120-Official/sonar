#!/usr/bin/env tsx
// ============================================================
// SONAR — Approve Discovery Candidate
// ============================================================
// Usage:
//   npm run approve:candidate -- --address <wallet_address>
//   npm run approve:candidate -- --id <candidate_uuid>
//   npm run approve:candidate -- --reject --address <wallet_address> [--reason "reason text"]
//
// On approval:
//   1. Inserts wallet into whales table with is_active=true
//   2. Updates candidate status → promoted
//   3. Logs approval review record
//   4. Updates Helius webhook to include the new address
//   5. Prints a signed approval receipt
//
// On rejection:
//   1. Updates candidate status → rejected
//   2. Logs rejection review record
//   3. Prints rejection receipt

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const heliusApiKey   = process.env.HELIUS_API_KEY;
const webhookId      = process.env.HELIUS_WEBHOOK_ID;
const appUrl         = process.env.NEXT_PUBLIC_APP_URL;
const webhookSecret  = process.env.HELIUS_WEBHOOK_SECRET;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('[approve] ❌ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Arg parsing ───────────────────────────────────────────────

const args        = process.argv.slice(2);
const isReject    = args.includes('--reject');

const addrIdx     = args.indexOf('--address');
const idIdx       = args.indexOf('--id');
const reasonIdx   = args.indexOf('--reason');
const reviewerIdx = args.indexOf('--reviewer');

const addressArg  = addrIdx  !== -1 ? args[addrIdx  + 1] : undefined;
const idArg       = idIdx    !== -1 ? args[idIdx    + 1] : undefined;
const reason      = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
const reviewer    = reviewerIdx !== -1 ? args[reviewerIdx + 1] : 'admin-cli';

if (!addressArg && !idArg) {
  console.error('[approve] ❌ Provide --address <addr> or --id <uuid>');
  console.error('Usage:');
  console.error('  npm run approve:candidate -- --address <addr>');
  console.error('  npm run approve:candidate -- --reject --address <addr> --reason "text"');
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const action = isReject ? 'REJECT' : 'APPROVE';
  console.log(`\n[approve] Action: ${action}`);
  console.log(`[approve] Reviewer: ${reviewer}`);
  if (addressArg) console.log(`[approve] Address: ${addressArg}`);
  if (idArg)      console.log(`[approve] Candidate ID: ${idArg}`);
  console.log('');

  // ── Load candidate ────────────────────────────────────────────
  let query = db.from('discovery_candidates').select('*');
  if (addressArg) query = query.eq('address', addressArg) as typeof query;
  if (idArg)      query = query.eq('id', idArg) as typeof query;

  const { data: candidate, error: fetchErr } = await query.maybeSingle();

  if (fetchErr) {
    console.error('[approve] ❌ DB error:', fetchErr.message);
    process.exit(1);
  }

  if (!candidate) {
    console.error('[approve] ❌ Candidate not found.');
    process.exit(1);
  }

  console.log(`[approve] Found candidate:`);
  console.log(`  Address     : ${candidate.address}`);
  console.log(`  Status      : ${candidate.status}`);
  console.log(`  Score       : ${candidate.discovery_score}/100`);
  console.log(`  Source      : ${candidate.primary_source}`);
  console.log(`  Win rate 30d: ${candidate.win_rate_30d ?? 'N/A'}%`);
  console.log(`  Trades 30d  : ${candidate.trade_count_30d ?? 'N/A'}`);
  console.log(`  Created     : ${candidate.created_at}`);
  console.log('');

  if (candidate.status === 'promoted') {
    console.warn('[approve] ⚠️  Already promoted to whales table.');
    process.exit(0);
  }
  if (candidate.status === 'rejected') {
    console.warn('[approve] ⚠️  Already rejected.');
    process.exit(0);
  }

  const now = new Date().toISOString();

  // ── Reject branch ─────────────────────────────────────────────
  if (isReject) {
    await db.from('discovery_candidates').update({
      status:      'rejected',
      reviewed_at: now,
      reviewed_by: reviewer,
      updated_at:  now,
      notes:       reason ? `Rejected: ${reason}` : 'Manually rejected',
    }).eq('id', candidate.id);

    await db.from('discovery_reviews').insert({
      candidate_id: candidate.id,
      reviewer,
      action:       'reject',
      notes:        reason ?? 'Manually rejected via CLI',
    });

    printReceipt({ action: 'REJECTED', candidate, reviewer, reason, now });
    return;
  }

  // ── Approve branch ────────────────────────────────────────────

  // Check if already in whales table
  const { data: existingWhale } = await db
    .from('whales')
    .select('id')
    .eq('address', candidate.address)
    .maybeSingle();

  if (!existingWhale) {
    const label = `approved_${candidate.primary_source}_score${candidate.discovery_score}`;
    const { error: whaleErr } = await db.from('whales').insert({
      address:   candidate.address,
      chain:     candidate.chain as 'solana',
      is_active: true,
      label,
    });

    if (whaleErr) {
      console.error('[approve] ❌ Failed to insert into whales:', whaleErr.message);
      process.exit(1);
    }

    console.log(`[approve] ✅ Inserted into whales table (label: ${label})`);
  } else {
    console.log('[approve] ℹ️  Already in whales table — activating');
    await db.from('whales').update({ is_active: true }).eq('address', candidate.address);
  }

  // Update candidate status
  await db.from('discovery_candidates').update({
    status:      'promoted',
    promoted_at: now,
    reviewed_at: now,
    reviewed_by: reviewer,
    updated_at:  now,
  }).eq('id', candidate.id);

  // Log review
  await db.from('discovery_reviews').insert({
    candidate_id: candidate.id,
    reviewer,
    action:       'approve',
    notes:        `Manually approved. Score: ${candidate.discovery_score}/100. Reviewer: ${reviewer}`,
  });

  console.log('[approve] ✅ Candidate promoted');

  // ── Webhook sync ──────────────────────────────────────────────

  const webhookSynced = await syncWebhook();
  if (webhookSynced.ok) {
    console.log(`[approve] ✅ Helius webhook updated — now monitoring ${webhookSynced.count} wallets`);
  } else {
    console.warn(`[approve] ⚠️  Webhook sync skipped: ${webhookSynced.reason}`);
  }

  printReceipt({ action: 'APPROVED', candidate, reviewer, reason, now, webhookSynced });
}

// ── Webhook sync ──────────────────────────────────────────────

async function syncWebhook(): Promise<{ ok: boolean; count: number; reason?: string }> {
  if (!webhookId) return { ok: false, count: 0, reason: 'HELIUS_WEBHOOK_ID not set' };
  if (!heliusApiKey) return { ok: false, count: 0, reason: 'HELIUS_API_KEY not set' };
  if (!appUrl) return { ok: false, count: 0, reason: 'NEXT_PUBLIC_APP_URL not set' };
  if (!webhookSecret) return { ok: false, count: 0, reason: 'HELIUS_WEBHOOK_SECRET not set' };

  const { data: whales } = await db.from('whales').select('address').eq('is_active', true);
  const addresses = (whales ?? []).map((w) => w.address);

  if (addresses.length === 0) return { ok: false, count: 0, reason: 'no active whales' };

  try {
    const res = await fetch(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${heliusApiKey}`,
      {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
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
      const body = await res.text().catch(() => '');
      return { ok: false, count: addresses.length, reason: `HTTP ${res.status}: ${body.slice(0, 100)}` };
    }

    return { ok: true, count: addresses.length };
  } catch (err) {
    return { ok: false, count: addresses.length, reason: String(err) };
  }
}

// ── Receipt printer ───────────────────────────────────────────

function printReceipt(opts: {
  action: string;
  candidate: { address: string; discovery_score: number; primary_source: string; win_rate_30d: number | null; trade_count_30d: number | null };
  reviewer: string;
  reason?: string;
  now: string;
  webhookSynced?: { ok: boolean; count: number };
}) {
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  SONAR — DISCOVERY CANDIDATE RECEIPT');
  console.log('══════════════════════════════════════════════════════');
  console.log(`  Action     : ${opts.action}`);
  console.log(`  Address    : ${opts.candidate.address}`);
  console.log(`  Score      : ${opts.candidate.discovery_score}/100`);
  console.log(`  Source     : ${opts.candidate.primary_source}`);
  console.log(`  Win rate   : ${opts.candidate.win_rate_30d ?? 'N/A'}%`);
  console.log(`  Trades 30d : ${opts.candidate.trade_count_30d ?? 'N/A'}`);
  console.log(`  Reviewer   : ${opts.reviewer}`);
  if (opts.reason) console.log(`  Reason     : ${opts.reason}`);
  console.log(`  Timestamp  : ${opts.now}`);
  if (opts.webhookSynced) {
    console.log(`  Webhook    : ${opts.webhookSynced.ok ? `✅ synced (${opts.webhookSynced.count} wallets)` : '⚠️  skipped'}`);
  }
  console.log('══════════════════════════════════════════════════════');
  console.log('');
}

// ── Run ───────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('[approve] Unhandled error:', err);
  process.exit(1);
});
