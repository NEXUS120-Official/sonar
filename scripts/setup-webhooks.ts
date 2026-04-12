#!/usr/bin/env tsx
// ============================================================
// SONAR — Helius Webhook Setup
// ============================================================
// Usage:
//   npm run setup:webhooks              # dry-run (prints config, no API call)
//   npm run setup:webhooks -- --apply   # registers webhook with Helius
//
// Prerequisites before running with --apply:
//   1. NEXT_PUBLIC_APP_URL in .env.local must be a public HTTPS URL
//      (not localhost — Helius cannot reach localhost)
//   2. HELIUS_WEBHOOK_SECRET must be set to a random string
//   3. The app must be deployed and /api/webhook/helius must respond
//
// The webhook will monitor all active whales in the DB for SWAP transactions.
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '../src/lib/supabase/types';
import { createWebhook, listWebhooks, updateWebhook } from '../src/lib/helius/client';
import type { HeliusWebhookConfig } from '../src/lib/helius/client';

// ── Config ────────────────────────────────────────────────────

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appUrl         = process.env.NEXT_PUBLIC_APP_URL;
const webhookSecret  = process.env.HELIUS_WEBHOOK_SECRET;
const heliusApiKey   = process.env.HELIUS_API_KEY;

const IS_DRY_RUN  = !process.argv.includes('--apply') && !process.argv.includes('--update');
const IS_UPDATE   = process.argv.includes('--update');

// ── Validation ────────────────────────────────────────────────

function validateEnv(): string[] {
  const missing: string[] = [];
  if (!supabaseUrl)    missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!heliusApiKey)   missing.push('HELIUS_API_KEY');
  if (!IS_DRY_RUN) {
    if (!appUrl)         missing.push('NEXT_PUBLIC_APP_URL');
    if (!webhookSecret)  missing.push('HELIUS_WEBHOOK_SECRET');
  }
  return missing;
}

function isPublicUrl(url: string): boolean {
  return url.startsWith('https://') && !url.includes('localhost');
}

// ── Main ──────────────────────────────────────────────────────

async function setupWebhooks() {
  const mode = IS_DRY_RUN ? 'DRY RUN (pass --apply to register, --update to update existing)' : IS_UPDATE ? 'UPDATE' : 'APPLY';
  console.log(`[setup-webhooks] Mode: ${mode}`);
  console.log('');

  // Validate env
  const missing = validateEnv();
  if (missing.length > 0) {
    console.error('[setup-webhooks] ❌ Missing env vars:', missing.join(', '));
    process.exit(1);
  }

  // Guard: public URL required for registration
  if (!IS_DRY_RUN && appUrl && !isPublicUrl(appUrl)) {
    console.error(`[setup-webhooks] ❌ NEXT_PUBLIC_APP_URL must be a public HTTPS URL (got: ${appUrl})`);
    console.error('[setup-webhooks]    Helius cannot deliver webhooks to localhost.');
    console.error('[setup-webhooks]    Deploy the app first, then re-run with --apply.');
    process.exit(1);
  }

  // Connect to Supabase
  const db = createClient<Database>(supabaseUrl!, serviceRoleKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Fetch active whale addresses
  console.log('[setup-webhooks] Fetching active whale addresses...');
  const { data: whales, error } = await db
    .from('whales')
    .select('address, label, chain')
    .eq('is_active', true);

  if (error) {
    console.error('[setup-webhooks] ❌ Supabase error:', error.message);
    process.exit(1);
  }

  const addresses = (whales ?? []).map((w) => w.address);

  if (addresses.length === 0) {
    console.error('[setup-webhooks] ❌ No active whale addresses found in DB. Run seed:whales first.');
    process.exit(1);
  }

  console.log(`[setup-webhooks] Found ${addresses.length} active whale(s):`);
  (whales ?? []).forEach((w) => {
    console.log(`  ${w.chain} | ${w.address} ${w.label ? `(${w.label})` : ''}`);
  });
  console.log('');

  // Build webhook config
  const webhookUrl = `${appUrl ?? 'https://YOUR_APP_URL'}/api/webhook/helius`;
  const config: HeliusWebhookConfig = {
    webhookURL:         webhookUrl,
    transactionTypes:   ['SWAP'],
    accountAddresses:   addresses,
    webhookType:        'enhanced',
    encoding:           'jsonParsed',
    authHeader:         webhookSecret ?? 'SET_HELIUS_WEBHOOK_SECRET',
  };

  console.log('[setup-webhooks] Webhook config:');
  console.log(JSON.stringify({ ...config, authHeader: '[REDACTED]' }, null, 2));
  console.log('');

  if (IS_DRY_RUN) {
    console.log('[setup-webhooks] ✅ Dry run complete. No webhook was registered.');
    console.log('[setup-webhooks]    Re-run with --apply once app is deployed and env vars are set.');
    return;
  }

  // Check for existing webhooks
  console.log('[setup-webhooks] Checking existing Helius webhooks...');
  let existing;
  try {
    existing = await listWebhooks();
  } catch (err) {
    console.error('[setup-webhooks] ❌ Failed to list existing webhooks:', err);
    process.exit(1);
  }

  const duplicate = existing.find((wh) => wh.webhookURL === webhookUrl);

  if (IS_UPDATE) {
    // ── Update mode: replace address list on existing webhook
    if (!duplicate) {
      console.error('[setup-webhooks] ❌ --update specified but no existing webhook found for this URL.');
      console.error('[setup-webhooks]    Run with --apply first to create the webhook.');
      process.exit(1);
    }
    console.log(`[setup-webhooks] Updating webhook ${duplicate.webhookID} with ${addresses.length} address(es)...`);
    try {
      const updated = await updateWebhook(duplicate.webhookID, config);
      console.log('[setup-webhooks] ✅ Webhook updated successfully!');
      console.log(`[setup-webhooks]    Webhook ID : ${updated.webhookID}`);
      console.log(`[setup-webhooks]    Monitoring : ${addresses.length} address(es)`);
    } catch (err) {
      console.error('[setup-webhooks] ❌ Webhook update failed:', err);
      process.exit(1);
    }
    return;
  }

  if (duplicate) {
    console.warn(`[setup-webhooks] ⚠️  Webhook already exists with ID: ${duplicate.webhookID}`);
    console.warn('[setup-webhooks]    Run with --update to sync the address list to all active whales.');
    process.exit(0);
  }

  // Register webhook (fresh)
  console.log('[setup-webhooks] Registering webhook with Helius...');
  try {
    const created = await createWebhook(config);
    console.log('[setup-webhooks] ✅ Webhook registered successfully!');
    console.log(`[setup-webhooks]    Webhook ID : ${created.webhookID}`);
    console.log(`[setup-webhooks]    Webhook URL: ${created.webhookURL}`);
    console.log(`[setup-webhooks]    Monitoring : ${addresses.length} address(es)`);
    console.log(`[setup-webhooks]    Types      : SWAP`);
    console.log('');
    console.log('[setup-webhooks] ⚠️  Save this webhook ID — you will need it to update/delete the webhook:');
    console.log(`[setup-webhooks]    ${created.webhookID}`);
  } catch (err) {
    console.error('[setup-webhooks] ❌ Webhook registration failed:', err);
    process.exit(1);
  }
}

// ── Run ───────────────────────────────────────────────────────

setupWebhooks().catch((err: unknown) => {
  console.error('[setup-webhooks] Unhandled error:', err);
  process.exit(1);
});
