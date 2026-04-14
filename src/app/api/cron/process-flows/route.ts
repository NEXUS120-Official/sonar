// ============================================================
// SONAR v2.0 — Process Flows Cron
// POST /api/cron/process-flows
// ============================================================
// Runs every 5 minutes via Vercel Cron or external scheduler.
// Steps:
//   1. Load movements from the last 168h (max window)
//   2. Aggregate into snapshots for each window (1h, 4h, 24h, 168h)
//   3. Run anomaly detection against 24h snapshot + baseline
//   4. AI-enrich alerts
//   5. Persist snapshots and alerts to DB
//
// Protected by CRON_SECRET header.
// Returns JSON receipt.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import {
  aggregateMovements,
  filterToWindow,
  windowCutoff,
  type SnapshotInsert,
  type SnapshotWindow,
} from '@/lib/flow-engine/aggregator';
import { detectAnomalies, type AlertInsert } from '@/lib/flow-engine/anomaly-detector';
import { generateAlertAnalysis } from '@/lib/ai/alert-writer';
import { SNAPSHOT_WINDOWS } from '@/lib/utils/constants';
import type { MovementRow, FlowSnapshotRow } from '@/lib/supabase/types';
import type { FlowMetrics } from '@/lib/flow-engine/aggregator';

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/process-flows][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'CRON_SECRET not set — running unauthenticated (dev mode)');
    return true;
  }
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  const token  = header.replace(/^Bearer\s+/, '');
  return token === secret;
}

// ── Receipt type ──────────────────────────────────────────────

interface CronReceipt {
  ok:                 boolean;
  run_at:             string;
  movements_scanned:  number;
  snapshots_written:  number;
  alerts_generated:   number;
  errors_count:       number;
  errors:             string[];
  duration_ms:        number;
}

// ── Helper: extract FlowMetrics from a SnapshotInsert ─────────

function snapshotToMetrics(s: SnapshotInsert): FlowMetrics {
  return {
    sol_exchange_inflow_usd:  s.sol_exchange_inflow_usd,
    sol_exchange_outflow_usd: s.sol_exchange_outflow_usd,
    sol_net_exchange_flow_usd: s.sol_net_exchange_flow_usd,
    sol_staked_usd:       s.sol_staked_usd,
    sol_unstaked_usd:     s.sol_unstaked_usd,
    net_staking_flow_usd: s.net_staking_flow_usd,
    usdc_inflow_usd:    s.usdc_inflow_usd,
    usdc_outflow_usd:   s.usdc_outflow_usd,
    net_usdc_flow_usd:  s.net_usdc_flow_usd,
    defi_deposit_usd:    s.defi_deposit_usd,
    defi_withdrawal_usd: s.defi_withdrawal_usd,
    net_defi_flow_usd:   s.net_defi_flow_usd,
    large_movements_count: s.large_movements_count,
    unique_whales_active:  s.unique_whales_active,
    bias_score:  s.bias_score ?? 0,
    market_bias: s.market_bias ?? 'neutral',
  };
}

function rowToMetrics(r: FlowSnapshotRow): FlowMetrics {
  return snapshotToMetrics(r as unknown as SnapshotInsert);
}

// ── Main handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let movements_scanned  = 0;
  let snapshots_written  = 0;
  let alerts_generated   = 0;

  if (!verifyCronSecret(req)) {
    log('warn', 'Unauthorized cron request');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Starting flow processing run');

  const db = createAdminClient();

  // ── 1. Load movements (last 168h = max window) ─────────────
  const cutoff168h = windowCutoff(168);
  log('info', `Loading movements since ${cutoff168h}`);

  const { data: movementsRaw, error: movErr } = await db
    .from('movements')
    .select('*')
    .gte('block_time', cutoff168h)
    .order('block_time', { ascending: false })
    .limit(10_000);

  if (movErr) {
    const msg = `Failed to load movements: ${movErr.message}`;
    log('error', msg);
    errors.push(msg);
    return NextResponse.json(receipt(runAt, startMs, 0, 0, 0, errors));
  }

  const movements = (movementsRaw ?? []) as MovementRow[];
  movements_scanned = movements.length;
  log('info', `Loaded ${movements_scanned} movements`);

  // ── 2. Aggregate snapshots for all windows ──────────────────
  const now = new Date();
  const snapshots: SnapshotInsert[] = [];

  for (const windowHours of SNAPSHOT_WINDOWS) {
    try {
      const windowMovements = filterToWindow(movements, windowHours);
      const snapshot = aggregateMovements(windowMovements, windowHours as SnapshotWindow, now);
      snapshots.push(snapshot);
    } catch (err) {
      const msg = `Aggregation failed for ${windowHours}h window: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
    }
  }

  // ── 3. Persist snapshots ────────────────────────────────────
  if (snapshots.length > 0) {
    log('info', `Persisting ${snapshots.length} snapshot(s)`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error: snapErr } = await db
      .from('flow_snapshots')
      .insert(snapshots as any)
      .select('id');

    if (snapErr) {
      const msg = `Snapshot insert failed: ${snapErr.message}`;
      log('error', msg);
      errors.push(msg);
    } else {
      snapshots_written = inserted?.length ?? 0;
      log('info', `${snapshots_written} snapshot(s) written`);
    }
  }

  // ── 4. Anomaly detection (on 4h window — sensitive but not noisy) ──
  const snapshot4h = snapshots.find((s) => s.window_hours === 4);
  if (snapshot4h) {
    // Load previous 4h snapshot as baseline (last one before now)
    const { data: baselineRaw } = await db
      .from('flow_snapshots')
      .select('*')
      .eq('window_hours', 4)
      .lt('snapshot_time', now.toISOString())
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    const baseline = baselineRaw as FlowSnapshotRow | null;

    const anomalies = detectAnomalies({
      current:     snapshotToMetrics(snapshot4h),
      baseline:    baseline ? rowToMetrics(baseline) : null,
      windowHours: 4,
    });

    if (anomalies.length > 0) {
      log('info', `${anomalies.length} anomalies — enriching with AI`);

      // Enrich alerts with AI analysis
      const enriched: AlertInsert[] = await Promise.all(
        anomalies.map(async (alert) => {
          try {
            const analysis = await generateAlertAnalysis({
              alert_type:   alert.alert_type,
              title:        alert.title,
              body:         alert.body,
              window_hours: 4,
              metrics: {
                net_exchange_flow_usd: snapshot4h.sol_net_exchange_flow_usd,
                net_staking_flow_usd:  snapshot4h.net_staking_flow_usd,
                net_defi_flow_usd:     snapshot4h.net_defi_flow_usd,
                net_usdc_flow_usd:     snapshot4h.net_usdc_flow_usd,
                bias_score:            snapshot4h.bias_score ?? 0,
                market_bias:           snapshot4h.market_bias ?? 'neutral',
                large_movements_count: snapshot4h.large_movements_count,
                unique_whales_active:  snapshot4h.unique_whales_active,
              },
            });
            return { ...alert, ai_analysis: analysis };
          } catch {
            return alert;
          }
        }),
      );

      // Persist alerts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: insertedAlerts, error: alertErr } = await db
        .from('alerts')
        .insert(enriched as any)
        .select('id');

      if (alertErr) {
        const msg = `Alert insert failed: ${alertErr.message}`;
        log('error', msg);
        errors.push(msg);
      } else {
        alerts_generated = insertedAlerts?.length ?? 0;
        log('info', `${alerts_generated} alert(s) written to DB`);
      }
    }
  }

  const r = receipt(runAt, startMs, movements_scanned, snapshots_written, alerts_generated, errors);
  log('info', `Run complete — ${JSON.stringify(r)}`);
  return NextResponse.json(r);
}

// Also support GET for Vercel Cron (which sends GET requests)
export const GET = POST;

// ── Receipt builder ───────────────────────────────────────────

function receipt(
  runAt: Date,
  startMs: number,
  movements_scanned: number,
  snapshots_written: number,
  alerts_generated: number,
  errors: string[],
): CronReceipt {
  return {
    ok:                errors.length === 0,
    run_at:            runAt.toISOString(),
    movements_scanned,
    snapshots_written,
    alerts_generated,
    errors_count:      errors.length,
    errors,
    duration_ms:       Date.now() - startMs,
  };
}
