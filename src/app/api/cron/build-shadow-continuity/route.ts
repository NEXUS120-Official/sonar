// ============================================================
// SONAR — Build Shadow Continuity Cron
// POST /api/cron/build-shadow-continuity
// ============================================================
// Runs the Multi-Hop Shadow Continuity pipeline (Block 25):
//   1. Load shadow_links as seed anchors (confirmed first-hop wallets)
//   2. Load outgoing movements from seed wallets
//   3. Load child wallet novelty + privacy activation context
//   4. Detect continuity: gas-funding, fan-out, temporal correlation,
//      downstream privacy / Token-2022 activation
//   5. Persist shadow_families + shadow_continuity records
//
// Protected by CRON_SECRET.
//
// Query params:
//   ?days=30         — lookback window (max: 90)
//   ?seeds=200       — max shadow_link seeds to process
//   ?min_seed=25     — min shadow_link confidence to use as seed
//   ?min_conf=20     — min continuity confidence to persist
//
// Run frequency: daily (after detect-shadow-links cron)
// Once shadow_families are populated, they can be used to enrich
// sovereign_signals and alerts with family_id + lineage context.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';
import { runShadowContinuityDetection }   from '@/lib/sovereign/shadow-continuity';

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

  const db  = createAdminClient();
  const url = new URL(req.url);

  const days    = parseInt(url.searchParams.get('days')     ?? '30', 10);
  const seeds   = parseInt(url.searchParams.get('seeds')    ?? '200', 10);
  const minSeed = parseInt(url.searchParams.get('min_seed') ?? '25', 10);
  const minConf = parseInt(url.searchParams.get('min_conf') ?? '20', 10);

  const result = await runShadowContinuityDetection(db, {
    lookbackDays:           isNaN(days)    ? 30  : Math.min(days, 90),
    maxSeeds:               isNaN(seeds)   ? 200 : Math.min(seeds, 1000),
    minSeedConfidence:      isNaN(minSeed) ? 25  : Math.max(0, minSeed),
    minConfidenceToPersist: isNaN(minConf) ? 20  : Math.max(0, minConf),
  });

  return NextResponse.json({
    status: result.errors === 0 ? 'OK' : 'PARTIAL',
    ...result,
  });
};

export const GET = POST;
