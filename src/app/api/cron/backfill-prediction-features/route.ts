// ============================================================
// SONAR — Backfill Prediction Features Cron
// POST /api/cron/backfill-prediction-features
// ============================================================
// One-time / re-runnable backfill: derives prediction_features
// rows for historical flow_snapshots that pre-date the live
// feature-builder deployment.
//
// Algorithm:
//   1. Page through flow_snapshots (window_hours=4), oldest-first.
//   2. Skip snapshot_times where all 3 horizons already exist.
//   3. For each snapshot: find nearest bias_index_history row
//      by created_at (within ±15 min of snapshot_time).
//   4. Call deriveFeatureColumns() with mode='historical_snapshot_backfill'.
//      No raw movements available historically — movement-level
//      features are zeroed; quality metadata records this explicitly.
//   5. Upsert prediction_features (idempotent).
//
// Quality metadata written per row (in features_json):
//   feature_source_mode:             'historical_snapshot_backfill'
//   movement_level_detail_available: false
//   exchange_flow_detail_available:  false
//   backfill_approximation:          true
//
// Query params:
//   limit    = max snapshots to process per run (default 100, max 500)
//   offset   = start offset for pagination (default 0)
//
// Idempotent: rows already written are skipped; partial batches
// can be re-run safely.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';
import { deriveFeatureColumns }           from '@/lib/feature-builder';
import type { FlowSnapshotRow, BiasIndexHistoryRow } from '@/lib/supabase/types';

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return h.replace(/^Bearer\s+/, '') === secret;
}

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/backfill-prediction-features][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn') console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Constants ─────────────────────────────────────────────────

const HORIZONS            = ['4h', '24h', '72h'] as const;
const BIAS_MATCH_WINDOW_MS = 15 * 60 * 1000; // ±15 min

// ── Bias lookup helper ────────────────────────────────────────

/**
 * Find the bias_index_history row whose created_at is closest to
 * snapshotMs, within BIAS_MATCH_WINDOW_MS. Returns null if none found.
 */
function findNearestBias(
  snapshotMs:  number,
  biasRows:    BiasIndexHistoryRow[],
): BiasIndexHistoryRow | null {
  let best:   BiasIndexHistoryRow | null = null;
  let bestDt  = Infinity;

  for (const row of biasRows) {
    const dt = Math.abs(new Date(row.created_at).getTime() - snapshotMs);
    if (dt < bestDt && dt <= BIAS_MATCH_WINDOW_MS) {
      best  = row;
      bestDt = dt;
    }
  }
  return best;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs = Date.now();
  const { searchParams } = new URL(req.url);
  const limit  = Math.min(500, parseInt(searchParams.get('limit')  ?? '100', 10));
  const offset = Math.max(0,   parseInt(searchParams.get('offset') ?? '0',   10));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  log('info', `Starting backfill — limit=${limit} offset=${offset}`);

  // ── 1. Load snapshot page ──────────────────────────────────

  const { data: snapshotsRaw, error: snapErr } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 4)
    .order('snapshot_time', { ascending: true })
    .range(offset, offset + limit - 1);

  if (snapErr) {
    log('error', `Failed to load flow_snapshots: ${snapErr.message}`);
    return NextResponse.json({ ok: false, error: snapErr.message }, { status: 500 });
  }

  const snapshots = (snapshotsRaw ?? []) as FlowSnapshotRow[];
  if (snapshots.length === 0) {
    log('info', 'No snapshots in range — backfill complete or offset past end');
    return NextResponse.json({ ok: true, processed: 0, written: 0, skipped: 0, duration_ms: Date.now() - startMs });
  }

  log('info', `Loaded ${snapshots.length} snapshots`);

  // ── 2. Load bias rows for the same time range ──────────────
  // Bias history has no explicit link to snapshots — match by proximity.
  // Expand window by BIAS_MATCH_WINDOW_MS on each side.

  const minTime = new Date(new Date(snapshots[0].snapshot_time).getTime() - BIAS_MATCH_WINDOW_MS).toISOString();
  const maxTime = new Date(new Date(snapshots[snapshots.length - 1].snapshot_time).getTime() + BIAS_MATCH_WINDOW_MS).toISOString();

  const { data: biasRaw } = await db
    .from('bias_index_history')
    .select('*')
    .gte('created_at', minTime)
    .lte('created_at', maxTime)
    .order('created_at', { ascending: true });

  const biasRows = (biasRaw ?? []) as BiasIndexHistoryRow[];
  log('info', `Loaded ${biasRows.length} bias rows for time range`);

  // ── 3. Load already-written feature_times for this page ───
  // We skip any snapshot_time that already has rows for all 3 horizons.

  const snapshotTimes = snapshots.map(s => s.snapshot_time);

  const { data: existingRaw } = await db
    .from('prediction_features')
    .select('feature_time, horizon')
    .in('feature_time', snapshotTimes);

  // Build a set of "feature_time|horizon" strings already present
  const existingSet = new Set<string>(
    ((existingRaw ?? []) as { feature_time: string; horizon: string }[])
      .map(r => `${r.feature_time}|${r.horizon}`),
  );

  // A snapshot is fully covered when all 3 horizons exist
  const alreadyFull = (snapTime: string) =>
    HORIZONS.every(h => existingSet.has(`${snapTime}|${h}`));

  // ── 4. Derive and upsert features ─────────────────────────

  let written   = 0;
  let skipped   = 0;
  let no_bias   = 0;
  const errors: string[] = [];

  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];

    if (alreadyFull(snapshot.snapshot_time)) {
      skipped++;
      continue;
    }

    const snapshotMs = new Date(snapshot.snapshot_time).getTime();
    const bias       = findNearestBias(snapshotMs, biasRows);

    if (!bias) {
      // No bias row within window — write with neutral defaults and flag it
      no_bias++;
      log('warn', `No bias row found for snapshot_time=${snapshot.snapshot_time} — using neutral defaults`);
    }

    // Prior snapshot for flow_reversal_flag (previous item in sorted page,
    // or null for the first row of the page)
    const baseline = i > 0 ? snapshots[i - 1] : null;

    const biasScore      = bias?.score      ?? 0;
    const biasLabel      = bias?.bias       ?? 'neutral';
    const biasConfidence = bias?.confidence ?? 0;

    try {
      const cols = deriveFeatureColumns(
        snapshot,
        biasScore,
        biasLabel,
        biasConfidence,
        {
          mode:     'historical_snapshot_backfill',
          baseline,
          // movements intentionally omitted — not stored historically
        },
      );

      const rows = HORIZONS.map(horizon => ({
        feature_time: snapshot.snapshot_time,
        horizon,
        ...cols,
      }));

      const { data, error: upsertErr } = await db
        .from('prediction_features')
        .upsert(rows, { onConflict: 'feature_time,horizon', ignoreDuplicates: false })
        .select('id');

      if (upsertErr) {
        const msg = `upsert failed for snapshot_time=${snapshot.snapshot_time}: ${upsertErr.message}`;
        log('error', msg);
        errors.push(msg);
      } else {
        written += data?.length ?? 0;
      }
    } catch (err) {
      const msg = `derive failed for snapshot_time=${snapshot.snapshot_time}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
    }
  }

  const duration = Date.now() - startMs;
  log('info', `Done — written=${written} skipped=${skipped} no_bias=${no_bias} errors=${errors.length} duration=${duration}ms`);

  return NextResponse.json({
    ok:         errors.length === 0,
    processed:  snapshots.length,
    written,
    skipped,
    no_bias,
    errors:     errors.slice(0, 5),
    next_offset: offset + snapshots.length,
    duration_ms: duration,
  });
}

export const GET = POST;
