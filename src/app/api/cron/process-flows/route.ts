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
  computeStakingVelocity,
  filterToWindow,
  windowCutoff,
  type SnapshotInsert,
  type SnapshotWindow,
  type FlowMetrics,
} from '@/lib/signal-engine';
import { calculateBiasIndex }                from '@/lib/signal-engine';
import { detectAnomalies, type AlertInsert } from '@/lib/signal-engine';
import { type RecentAlertMap }               from '@/lib/signal-engine';
import { buildCohortContext }                from '@/lib/signal-engine';
import { generateAlertAnalysis }             from '@/lib/ai/alert-writer';
import { buildPredictionFeatures }           from '@/lib/feature-builder';
import { SNAPSHOT_WINDOWS, ALERT_COOLDOWNS_MS } from '@/lib/utils/constants';
import type { MovementRow, FlowSnapshotRow, AlertRow, AlertType, BiasIndexHistoryRow } from '@/lib/supabase/types';

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
    large_movements_count:  s.large_movements_count,
    unique_whales_active:   s.unique_whales_active,
    bias_score:             s.bias_score ?? 0,
    market_bias:            s.market_bias ?? 'neutral',
    confirmation_count:     s.confirmation_count ?? 0,
    staking_velocity_pct:   s.staking_velocity_pct ?? null,
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

  const PAGE_SIZE  = 1_000;
  const MAX_PAGES  = 50; // hard cap at 50,000 rows
  const movements: MovementRow[] = [];
  let pageOffset   = 0;
  let fetchErr: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data: pageRaw, error: pageErr } = await db
      .from('movements')
      .select('*')
      .gte('block_time', cutoff168h)
      .order('block_time', { ascending: false })
      .range(pageOffset, pageOffset + PAGE_SIZE - 1);

    if (pageErr) {
      fetchErr = `Failed to load movements (page ${page}): ${pageErr.message}`;
      break;
    }

    const rows = (pageRaw ?? []) as MovementRow[];
    movements.push(...rows);
    if (rows.length < PAGE_SIZE) break; // last page
    pageOffset += PAGE_SIZE;
  }

  if (fetchErr) {
    log('error', fetchErr);
    errors.push(fetchErr);
    return NextResponse.json(receipt(runAt, startMs, 0, 0, 0, errors));
  }

  movements_scanned = movements.length;
  log('info', `Loaded ${movements_scanned} movements`);

  // ── 2. Aggregate snapshots for all windows ──────────────────
  const now = new Date();
  const snapshots: SnapshotInsert[] = [];
  let movements4h: MovementRow[] = [];  // captured for feature-builder

  for (const windowHours of SNAPSHOT_WINDOWS) {
    try {
      const windowMovements = filterToWindow(movements, windowHours);
      if (windowHours === 4) movements4h = windowMovements;
      const snapshot = aggregateMovements(windowMovements, windowHours as SnapshotWindow, now);
      snapshots.push(snapshot);
    } catch (err) {
      const msg = `Aggregation failed for ${windowHours}h window: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
    }
  }

  // ── 3. Enrich 4h snapshot with staking velocity ─────────────
  // Load the prior 4h snapshot NOW (before persisting) so we can store
  // staking_velocity_pct in the same insert. This avoids a second UPDATE round-trip.
  const snapshot4h = snapshots.find((s) => s.window_hours === 4);
  let baseline: FlowSnapshotRow | null = null;

  if (snapshot4h) {
    const { data: baselineRaw } = await db
      .from('flow_snapshots')
      .select('*')
      .eq('window_hours', 4)
      .lt('snapshot_time', now.toISOString())
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle();

    baseline = baselineRaw as FlowSnapshotRow | null;

    if (baseline) {
      snapshot4h.staking_velocity_pct = computeStakingVelocity(
        snapshot4h.net_staking_flow_usd,
        baseline.net_staking_flow_usd,
      );
      log('info', `Staking velocity: ${snapshot4h.staking_velocity_pct?.toFixed(2) ?? 'n/a'}%`);
    }
  }

  // ── 4. Persist snapshots ────────────────────────────────────
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

  // ── 4b. Save Bias Index History (4h window) ────────────────
  // biasResult is lifted to outer scope so the feature-builder can use it.
  let biasResult: ReturnType<typeof calculateBiasIndex> | null = null;

  if (snapshot4h) {
    try {
      const { data: smData } = await db
        .from('whales')
        .select('smart_money_flag')
        .eq('is_active', true)
        .not('smart_money_flag', 'is', null);

      const smAll   = (smData ?? []) as { smart_money_flag: boolean | null }[];
      const smCount = smAll.filter(w => w.smart_money_flag === true).length;
      const smRatio = smAll.length > 0 ? smCount / smAll.length : 0.5;

      biasResult = calculateBiasIndex({
        sol_net_exchange_flow_usd: snapshot4h.sol_net_exchange_flow_usd,
        net_staking_flow_usd:      snapshot4h.net_staking_flow_usd,
        net_usdc_flow_usd:         snapshot4h.net_usdc_flow_usd,
        net_defi_flow_usd:         snapshot4h.net_defi_flow_usd,
        smart_money_ratio:         smRatio,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('bias_index_history').insert({
        score:      biasResult.score,
        bias:       biasResult.bias,
        confidence: biasResult.confidence,
        components: biasResult.components,
      });
      log('info', `Bias index saved: ${biasResult.score} (${biasResult.bias})`);
    } catch (err) {
      log('warn', `Bias index history save failed: ${String(err)}`);
    }
  }

  // ── 4c. Build prediction features ──────────────────────────
  // Derives and upserts prediction_features rows for all horizons.
  // Non-critical: wrapped in try/catch so a failure never kills the cron.
  //
  // clusterMemberMap is hoisted to outer scope so section 5 (anomaly
  // detection) can use it for per-alert cohort attribution context.
  let clusterMemberMap: Map<string, string> | undefined;

  if (snapshot4h && biasResult) {
    // Load cluster member map for cohort-aware feature scoring.
    // One read per cron tick — addresses → cluster_type.
    // Failures are non-fatal: missing map → placeholder score used.
    try {
      const { data: clusterMembers } = await (db as any)
        .from('wallet_cluster_members')
        .select('address, wallet_clusters ( cluster_type, is_active, methodology )');

      clusterMemberMap = new Map(
        ((clusterMembers ?? []) as Array<{
          address: string;
          wallet_clusters: { cluster_type: string; is_active: boolean; methodology: string | null } | null;
        }>)
          .filter(r => r.wallet_clusters?.is_active === true && r.wallet_clusters?.methodology === 'behavior_v1')
          .map(r => [r.address, r.wallet_clusters!.cluster_type]),
      );
      if (clusterMemberMap.size > 0) {
        log('info', `Cluster member map: ${clusterMemberMap.size} addresses`);
      }
    } catch (err) {
      log('warn', `Cluster member map load failed (non-critical): ${String(err)}`);
    }

    try {
      const featureReceipt = await buildPredictionFeatures(
        {
          snapshot:         snapshot4h,
          baseline,
          movements4h,
          biasScore:        biasResult.score,
          biasLabel:        biasResult.bias,
          biasConfidence:   biasResult.confidence,
          clusterMemberMap,
        },
        db,
      );
      log('info', `Prediction features written: ${featureReceipt.written} rows (${featureReceipt.horizons.join(', ')}) @ ${featureReceipt.feature_time}`);
    } catch (err) {
      log('warn', `Feature builder failed (non-critical): ${String(err)}`);
    }
  }

  // ── 5. Anomaly detection (on 4h window — sensitive but not noisy) ──
  if (snapshot4h) {

    // ── Load recent alerts for cooldown/dedup ─────────────────
    // Query most-recent alert per type within the longest cooldown window (4h).
    // We fetch up to 20 rows ordered newest-first, then keep the first per type.
    const maxCooldownMs  = Math.max(...Object.values(ALERT_COOLDOWNS_MS));
    const cooldownCutoff = new Date(now.getTime() - maxCooldownMs).toISOString();

    const { data: recentAlertsRaw } = await db
      .from('alerts')
      .select('*')
      .gte('created_at', cooldownCutoff)
      .order('created_at', { ascending: false })
      .limit(20);

    const recentAlerts: RecentAlertMap = {};
    for (const row of (recentAlertsRaw ?? []) as AlertRow[]) {
      const t = row.alert_type as AlertType;
      if (!recentAlerts[t]) recentAlerts[t] = row;
    }
    log('info', `Loaded ${Object.keys(recentAlerts).length} recent alert type(s) for dedup`);

    const anomalies = detectAnomalies({
      current:      snapshotToMetrics(snapshot4h),
      baseline:     baseline ? rowToMetrics(baseline) : null,
      windowHours:  4,
      recentAlerts,
    });

    // ── Enrich alerts with cohort attribution context ─────────
    // Additive, non-critical: merges cohort_context into alert.data.
    // Counts unique cluster-member wallet addresses only (exchange/protocol
    // counterparties are never in clusterMemberMap). Falls back to the
    // unmodified alert when map is unavailable or no members matched.
    const anomaliesWithCohort: AlertInsert[] = anomalies.map(alert => {
      if (!clusterMemberMap || clusterMemberMap.size === 0) return alert;
      const cohortCtx = buildCohortContext(movements4h, clusterMemberMap, alert.alert_type);
      if (!cohortCtx) return alert;
      const existingData =
        alert.data && typeof alert.data === 'object' && !Array.isArray(alert.data)
          ? (alert.data as Record<string, unknown>)
          : {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ...alert, data: { ...existingData, cohort_context: cohortCtx } } as any as AlertInsert;
    });

    if (anomaliesWithCohort.length > 0) {
      log('info', `${anomaliesWithCohort.length} anomalies — enriching with AI`);

      // Enrich alerts with AI analysis
      const enriched: AlertInsert[] = await Promise.all(
        anomaliesWithCohort.map(async (alert) => {

          // ── Cohort narrative (pre-AI body enrichment) ───────────
          // Extract cohort_context written by the prior enrichment step.
          // Only surfaces when dominant_unique_wallets >= 3 (meaningful cluster evidence).
          // Body is enriched before generateAlertAnalysis so the cohort line
          // is deterministic — present even when AI falls back to the template.
          const COHORT_MIN_WALLETS = 3;

          type RawCohortCtx = {
            dominant_cluster_label:       string | null;
            dominant_unique_wallets:      number;
            total_unique_cluster_wallets: number;
          };

          const rawData = alert.data;
          const cohortCtx: RawCohortCtx | null =
            rawData &&
            typeof rawData === 'object' &&
            !Array.isArray(rawData) &&
            'cohort_context' in rawData
              ? (rawData as Record<string, unknown>).cohort_context as RawCohortCtx
              : null;

          const dominantCount = cohortCtx?.dominant_unique_wallets ?? 0;
          const totalCount    = cohortCtx?.total_unique_cluster_wallets ?? 0;
          const label         = cohortCtx?.dominant_cluster_label ?? null;

          // Dominant share: what fraction of all active cluster wallets
          // belong to the leading cohort. Included when > 0 to avoid /0.
          const sharePct = totalCount > 0
            ? Math.round((dominantCount / totalCount) * 100)
            : 0;
          const shareStr = sharePct > 0 ? ` (${sharePct}% of active cluster wallets)` : '';

          // Alert-type-specific wording; null when evidence is below threshold.
          let cohortLine: string | null = null;
          if (label && dominantCount >= COHORT_MIN_WALLETS) {
            switch (alert.alert_type) {
              case 'accumulation_wave':
                cohortLine = `Cluster attribution: ${dominantCount} ${label} led this flow${shareStr}.`;
                break;
              case 'distribution_wave':
                cohortLine = `Cluster attribution: ${dominantCount} ${label} led this flow${shareStr}.`;
                break;
              case 'staking_shift':
                cohortLine = `Cluster attribution: ${label} cohort was the most active (${dominantCount} wallets${shareStr}).`;
                break;
              case 'exchange_spike':
              case 'flow_reversal':
                cohortLine = `Most active cohort: ${label} (${dominantCount} wallets${shareStr}).`;
                break;
              default:
                cohortLine = null;
            }
          }

          const enrichedBody = cohortLine ? `${alert.body}\n${cohortLine}` : alert.body;

          // Additional metrics passed to AI so it can reference cluster evidence.
          const cohortMetrics: Record<string, number | string> = cohortLine && label
            ? {
                dominant_cluster:         label,
                dominant_cluster_wallets: dominantCount,
                total_cluster_wallets:    totalCount,
              }
            : {};

          try {
            const analysis = await generateAlertAnalysis({
              alert_type:   alert.alert_type,
              title:        alert.title,
              body:         enrichedBody,
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
                ...cohortMetrics,
              },
            });
            return { ...alert, body: enrichedBody, ai_analysis: analysis };
          } catch {
            return { ...alert, body: enrichedBody };
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
