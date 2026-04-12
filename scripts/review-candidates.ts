#!/usr/bin/env tsx
// ============================================================
// SONAR — Review Discovery Candidates (CLI)
// ============================================================
// Usage:
//   npm run review:candidates                   # show manual_review
//   npm run review:candidates -- --all          # show all statuses
//   npm run review:candidates -- --status auto_approve
//   npm run review:candidates -- --limit 20

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('[review] ❌ Missing env vars');
  process.exit(1);
}

const db = createClient<Database>(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const args        = process.argv.slice(2);
const showAll     = args.includes('--all');
const statusIdx   = args.indexOf('--status');
const limitIdx    = args.indexOf('--limit');
const statusArg   = statusIdx  !== -1 ? args[statusIdx  + 1] : null;
const limitArg    = limitIdx   !== -1 ? parseInt(args[limitIdx + 1] ?? '50', 10) : 50;

async function main() {
  let query = db
    .from('discovery_candidates')
    .select('*')
    .order('discovery_score', { ascending: false })
    .limit(limitArg);

  if (statusArg) {
    query = query.eq('status', statusArg) as typeof query;
  } else if (!showAll) {
    query = query.eq('status', 'manual_review') as typeof query;
  }

  const { data: candidates, error } = await query;

  if (error) {
    console.error('[review] ❌ DB error:', error.message);
    process.exit(1);
  }

  const list = candidates ?? [];

  if (list.length === 0) {
    const filterDesc = statusArg ?? (showAll ? 'any' : 'manual_review');
    console.log(`[review] No candidates with status=${filterDesc}`);
    return;
  }

  const filterLabel = statusArg ?? (showAll ? 'ALL' : 'manual_review');
  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`  SONAR — DISCOVERY CANDIDATES  [${filterLabel}]  (${list.length} total)`);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('');

  for (const c of list) {
    const flags = [
      c.is_bot_flagged     ? '🤖BOT' : null,
      c.is_rug_flagged     ? '🚩RUG' : null,
      c.is_insider_flagged ? '👁INSIDER' : null,
    ].filter(Boolean).join(' ') || '✅ clean';

    const age = Math.floor(
      (Date.now() - new Date(c.created_at).getTime()) / (60 * 60 * 1000),
    );

    console.log(`  Address  : ${c.address}`);
    console.log(`  Status   : ${c.status.padEnd(14)}  Score: ${String(c.discovery_score).padStart(3)}/100`);
    console.log(`  Source   : ${c.primary_source.padEnd(14)}  Age: ${age}h ago`);
    console.log(`  WinRate  : ${c.win_rate_30d != null ? `${c.win_rate_30d.toFixed(1)}%` : 'N/A'}` +
      `   Trades: ${c.trade_count_30d ?? 'N/A'}` +
      `   Tokens: ${c.token_diversity_30d ?? 'N/A'}`);
    if (c.total_volume_30d) {
      console.log(`  Volume   : $${c.total_volume_30d.toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
    }
    console.log(`  Flags    : ${flags}`);
    if (c.notes) console.log(`  Notes    : ${c.notes}`);
    if (c.submitted_by) console.log(`  Submitted: Telegram ${c.submitted_by}`);
    console.log(`  Commands :`);
    console.log(`    npm run approve:candidate -- --address ${c.address}`);
    console.log(`    npm run approve:candidate -- --reject --address ${c.address} --reason "reason"`);
    console.log('  ──────────────────────────────────────────────────────────────────────');
    console.log('');
  }
}

main().catch((err: unknown) => {
  console.error('[review] Unhandled error:', err);
  process.exit(1);
});
