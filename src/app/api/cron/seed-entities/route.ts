// ============================================================
// SONAR — Seed Entity Graph
// POST /api/cron/seed-entities
// ============================================================
// Idempotent cron that seeds entities + entity_addresses from
// trusted internal sources (known_addresses, whales).
//
// Safe to re-run at any time:
//   - already-mapped addresses are skipped (batch pre-filter)
//   - entity inserts use SELECT-before-INSERT (no duplicate entities)
//   - address inserts use UPSERT ON CONFLICT (address, chain)
//
// Protected by CRON_SECRET.
// Returns a receipt with coverage stats so the operator can
// track graph density over time.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  seedKnownAddressesToEntityGraph,
  seedWhalesToEntityGraph,
} from '@/lib/entity-graph/seeding';
import { getEntityCoverage } from '@/lib/entity-graph';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();

  // ── Seed both sources in parallel ────────────────────────────
  const [knownResult, whaleResult] = await Promise.all([
    seedKnownAddressesToEntityGraph(db),
    seedWhalesToEntityGraph(db),
  ]);

  // ── Coverage stats (post-seed snapshot) ──────────────────────
  const coverage = await getEntityCoverage(db, { topUncoveredN: 10 });

  const allErrors = [...knownResult.errors, ...whaleResult.errors];

  return NextResponse.json({
    ok:                        allErrors.length === 0,
    known_addresses: {
      groups_processed:  knownResult.groups_processed,
      entities_created:  knownResult.entities_created,
      addresses_created: knownResult.addresses_created,
    },
    whales: {
      processed: whaleResult.processed,
      created:   whaleResult.created,
      skipped:   whaleResult.skipped,
    },
    coverage: {
      total_entities:           coverage.total_entities,
      by_entity_type:           coverage.by_entity_type,
      by_source:                coverage.by_source,
      total_addresses:          coverage.total_addresses,
      active_addresses:         coverage.active_addresses,
      unverified_entities:      coverage.unverified_entities,
      low_confidence_mappings:  coverage.low_confidence_mappings,
      unmapped_whales:          coverage.unmapped_whales,
      unmapped_known_addresses: coverage.unmapped_known_addresses,
      top_uncovered_hot:        coverage.uncovered_hot,
    },
    errors: allErrors.slice(0, 20),
  });
}

export const GET = POST;
