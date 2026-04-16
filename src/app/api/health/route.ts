// ============================================================
// SONAR v2.0 — System Health Check
// GET /api/health
// ============================================================
// Public endpoint (no auth required) for external monitoring.
// Returns overall system status + per-subsystem freshness.
//
// Status logic:
//   ok       — all subsystems fresh within expected windows
//   degraded — one or more subsystems stale but not dead
//   down     — webhook silent >2h OR no snapshots in >30min
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

// Staleness thresholds (ms)
const THRESHOLDS = {
  webhook_silent_warn_ms:  30 * 60_000,   // 30 min  → degraded
  webhook_silent_down_ms:  2  * 3_600_000, // 2 h     → down
  snapshot_stale_warn_ms:  15 * 60_000,   // 15 min  → degraded (runs every 5m)
  snapshot_stale_down_ms:  30 * 60_000,   // 30 min  → down
  balance_stale_warn_ms:   2  * 3_600_000, // 2 h     → degraded (runs hourly)
  balance_stale_down_ms:   6  * 3_600_000, // 6 h     → down
  alert_stale_warn_ms:     30 * 60_000,   // 30 min  (only relevant if movements are flowing)
};

export async function GET(): Promise<NextResponse> {
  const startMs = Date.now();
  const now     = Date.now();
  const db      = createAdminClient();

  // ── Fetch subsystem state ─────────────────────────────────
  const db2 = db as any;
  const [movRes, snapRes, whaleRes, alertRes] = await Promise.all([
    // Last movement received via webhook
    db2.from('movements')
      .select('block_time, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle() as Promise<{ data: { created_at: string } | null }>,

    // Last flow snapshot
    db2.from('flow_snapshots')
      .select('snapshot_time')
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle() as Promise<{ data: { snapshot_time: string } | null }>,

    // Whale stats
    db2
      .from('whales')
      .select('id, is_active, balance_updated_at')
      .order('balance_updated_at', { ascending: false, nullsFirst: false })
      .limit(200) as Promise<{ data: { id: string; is_active: boolean; balance_updated_at: string | null }[] | null }>,

    // Last alert
    db2.from('alerts')
      .select('created_at, sent_telegram_free')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle() as Promise<{ data: { created_at: string } | null }>,
  ]);

  // ── Movement / webhook freshness ──────────────────────────
  const lastMovementAt   = movRes.data?.created_at ?? null;
  const movementAgeMs    = lastMovementAt ? now - new Date(lastMovementAt).getTime() : Infinity;
  const webhookStatus    =
    movementAgeMs === Infinity   ? 'never' :
    movementAgeMs > THRESHOLDS.webhook_silent_down_ms ? 'down' :
    movementAgeMs > THRESHOLDS.webhook_silent_warn_ms ? 'degraded' : 'ok';

  // ── Snapshot freshness ────────────────────────────────────
  const lastSnapshotAt   = snapRes.data?.snapshot_time ?? null;
  const snapshotAgeMs    = lastSnapshotAt ? now - new Date(lastSnapshotAt).getTime() : Infinity;
  const snapshotStatus   =
    snapshotAgeMs === Infinity  ? 'never' :
    snapshotAgeMs > THRESHOLDS.snapshot_stale_down_ms ? 'down' :
    snapshotAgeMs > THRESHOLDS.snapshot_stale_warn_ms ? 'degraded' : 'ok';

  // ── Whale stats ───────────────────────────────────────────
  const whales        = (whaleRes.data ?? []);
  const activeWhales  = whales.filter(w => w.is_active).length;
  const inactiveWhales= whales.length - activeWhales;
  const lastBalanceAt = whales[0]?.balance_updated_at ?? null;
  const balanceAgeMs  = lastBalanceAt ? now - new Date(lastBalanceAt).getTime() : Infinity;
  const balanceStatus =
    balanceAgeMs === Infinity  ? 'never' :
    balanceAgeMs > THRESHOLDS.balance_stale_down_ms ? 'down' :
    balanceAgeMs > THRESHOLDS.balance_stale_warn_ms ? 'degraded' : 'ok';

  // ── Alert freshness ───────────────────────────────────────
  const lastAlertAt   = alertRes.data?.created_at ?? null;
  const alertAgeMs    = lastAlertAt ? now - new Date(lastAlertAt).getTime() : Infinity;

  // ── Overall status ─────────────────────────────────────────
  const statuses = [webhookStatus, snapshotStatus, balanceStatus];
  const overall  =
    statuses.includes('down')     ? 'down' :
    statuses.includes('never')    ? 'degraded' :
    statuses.includes('degraded') ? 'degraded' : 'ok';

  const httpStatus = overall === 'down' ? 503 : 200;

  return NextResponse.json(
    {
      status:     overall,
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - startMs,
      subsystems: {
        webhook: {
          status:      webhookStatus,
          last_movement_at: lastMovementAt,
          age_minutes: lastMovementAt ? Math.round(movementAgeMs / 60_000) : null,
        },
        flow_engine: {
          status:         snapshotStatus,
          last_snapshot_at: lastSnapshotAt,
          age_minutes:    lastSnapshotAt ? Math.round(snapshotAgeMs / 60_000) : null,
        },
        balance_updater: {
          status:         balanceStatus,
          last_updated_at: lastBalanceAt,
          age_hours:      lastBalanceAt ? Math.round(balanceAgeMs / 3_600_000 * 10) / 10 : null,
        },
        whales: {
          active:   activeWhales,
          inactive: inactiveWhales,
          total:    whales.length,
        },
        alerts: {
          last_alert_at: lastAlertAt,
          age_hours:     lastAlertAt ? Math.round(alertAgeMs / 3_600_000 * 10) / 10 : null,
        },
      },
    },
    { status: httpStatus },
  );
}
