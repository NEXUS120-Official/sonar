// ============================================================
// SONAR — Build Behavioral Clusters Cron
// POST /api/cron/build-clusters
// ============================================================
// Runs buildBehaviorClusters (behavior_v1) against the current
// whale + movement dataset. Safe to rerun — idempotent.
//
// After this runs:
//   resolveAddress() and resolveAddressBatch() in entity-graph
//   will return non-null cluster_id + cluster_type for any
//   address that received a cluster assignment.
//
// Schedule: weekly (clusters don't need to be fresher than
// the entity graph seeding cycle). Can also be triggered
// manually to rebuild after whale list changes.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { buildBehaviorClusters, METHODOLOGY_VERSION } from '@/lib/entity-graph/clustering';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db      = createAdminClient();
  const startMs = Date.now();

  const result = await buildBehaviorClusters(db);
  const duration_ms = Date.now() - startMs;

  return NextResponse.json({
    ok:                result.errors.length === 0,
    methodology:       METHODOLOGY_VERSION,
    wallets_evaluated: result.wallets_evaluated,
    assigned:          result.assigned,
    unassigned:        result.unassigned,
    assignment_rate_pct: result.wallets_evaluated > 0
      ? Math.round((result.assigned / result.wallets_evaluated) * 100)
      : 0,
    by_cluster:        result.by_cluster,
    errors:            result.errors,
    duration_ms,
  });
}

export const GET = POST;
