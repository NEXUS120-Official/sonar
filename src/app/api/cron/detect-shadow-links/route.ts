// ============================================================
// SONAR — Shadow Link Detection Cron
// POST /api/cron/detect-shadow-links
// ============================================================
// Runs the CEX-to-Shadow Linker pipeline:
//   1. Load exchange_withdrawal movements (configurable window)
//   2. Load recipient novelty (prior movement counts)
//   3. Load post-funding Token-2022 / privacy mint activity
//   4. Detect shadow links with confidence scoring
//   5. Persist to shadow_links table
//
// Protected by CRON_SECRET.
//
// Run frequency: daily (or hourly for near-real-time detection).
// Once shadow_links are populated, joinSovereignFlow() can be called
// with loadJoinerShadowMap() to activate real shadow context.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }               from '@/lib/supabase/server';
import { runShadowLinkDetection }          from '@/lib/sovereign/shadow-linker';

// ── Auth ──────────────────────────────────────────────────────

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;  // dev mode
  const header = req.headers.get('authorization') ?? req.headers.get('x-cron-secret') ?? '';
  return header === `Bearer ${secret}` || header === secret;
}

// ── Handler ───────────────────────────────────────────────────

export const POST = async (req: NextRequest) => {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();

  // Optional query params for tuning
  const url      = new URL(req.url);
  const days     = parseInt(url.searchParams.get('days') ?? '30', 10);
  const maxLinks = parseInt(url.searchParams.get('max') ?? '500', 10);
  const minConf  = parseInt(url.searchParams.get('min_confidence') ?? '15', 10);

  const result = await runShadowLinkDetection(db, {
    lookbackDays:           isNaN(days)     ? 30  : Math.min(days, 90),
    maxFundingEvents:       isNaN(maxLinks) ? 500 : Math.min(maxLinks, 2000),
    minConfidenceToPersist: isNaN(minConf)  ? 15  : Math.max(0, minConf),
  });

  return NextResponse.json({
    status: result.errors === 0 ? 'OK' : 'PARTIAL',
    ...result,
  });
};

export const GET = POST;
