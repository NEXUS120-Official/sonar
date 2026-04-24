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
import { createBoundPersistenceManager }     from '@/lib/sovereign/persistence-manager';
import { joinAndAcceptBatch, derivePrivacyLifecycleEventsFromBatch } from '@/lib/sovereign/persistence-manager';
import { loadJoinerShadowMap }               from '@/lib/sovereign/shadow-linker';
import { loadJoinerShadowFamilyMap }         from '@/lib/sovereign/flow-joiner';
import {
  evaluateSignalsForAlerts,
  consolidateAlerts,
  decisionToAlertInsert,
  deriveSequenceAwareAlertInserts,
  applyValuationDoctrineToAlertInsert,
}                                            from '@/lib/sovereign/alert-engine';
import type { NormalizedOutput }             from '@/lib/normalizer';
import { derivePrivacyLifecycleSequencesFromEvents } from '@/lib/sovereign/privacy-sequence-engine';
import { derivePrivacySequenceAlertCandidates } from '@/lib/sovereign/privacy-sequence-alerts';
import { consolidatePrivacySequencePromotedAlerts } from '@/lib/sovereign/privacy-sequence-alert-consolidation';
import { unifyPrivacyAlertDoctrine } from '@/lib/sovereign/privacy-alert-doctrine';
import {
  loadRecentPrivacyFingerprints,
  suppressFingerprintKnownAlerts,
  upsertPrivacyFingerprintRecords,
  bumpSuppressedPrivacyFingerprints,
} from '@/lib/sovereign/privacy-alert-fingerprint-store';
import { insertPrivacySuppressionReceipts } from '@/lib/sovereign/privacy-alert-suppression-receipts';
import { envelopeFromRawTxRow }             from '@/lib/sovereign/ingest-envelope';
import { normalizeReplayRowsWithFallback } from '@/lib/sovereign/replay-normalization';
import { enqueueUnknownMint } from '@/lib/sovereign/sovereign-mint-enricher';
import { enqueueUnknownPriceAsset } from '@/lib/sovereign/sovereign-price-runtime';

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

// ── Helper: bridge MovementRow → NormalizedOutput for joiner ──
// MovementRow is the DB representation (already decoded + stored).
// NormalizedOutput is what the Sovereign Flow Joiner expects.
// Token movement context is not available here (already persisted
// separately); joiner degrades gracefully with tokenMovement=null.

function movementRowToNormalizedOutput(row: MovementRow): NormalizedOutput {
  return {
    signature: row.signature,
    movement: {
      signature:      row.signature,
      from_address:   row.from_address,
      to_address:     row.to_address,
      from_label:     row.from_label,
      to_label:       row.to_label,
      whale_id:       row.whale_id,
      token:          row.token,
      amount_token:   row.amount_token,
      amount_usd:     row.amount_usd,
      flow_type:      row.flow_type,
      flow_direction: row.flow_direction,
      exchange:       row.exchange,
      protocol:       row.protocol,
      block_time:     row.block_time,
    },
    tokenMovement:      null,
    whaleAddressHint:   null,
    skipped:            false,
    tokenDeltaAnalysis: null,
  };
}

function movementRowToReplayEnvelope(row: MovementRow) {
  return envelopeFromRawTxRow(
    {
      signature: row.signature,
      source:    'raw_transactions_replay',
      raw_json:  {
        replay_stub: true,
        signature:   row.signature,
      },
      created_at: new Date().toISOString(),
    } as any,
    'raw_transactions_replay',
  );
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

  // ── 4d. Sovereign intelligence pipeline ──────────────────────
  // Wire movement rows through the Sovereign Flow Joiner, persist
  // enriched signals, and evaluate for intelligence-grade alerts.
  //
  // Execution contract:
  //   1. Filter movements4h to significant flows (>= $10K)
  //   2. Load shadow map for all wallet addresses
  //   3. joinAndAcceptBatch() — join + enqueue (no flush yet)
  //   4. peekBuffer() → evaluateSignalsForAlerts() — pure eval
  //   5. consolidateAlerts() → decisionToAlertInsert() → DB
  //   6. manager.flush() — persist sovereign_signals
  //
  // Non-critical: wrapped in try/catch; failures never kill the cron.
  // Sovereign alerts are additive to anomaly-detector alerts (no dedup
  // against each other — different intelligence surfaces).

  try {
    const MIN_SOVEREIGN_USD  = 10_000;
    const significantRows    = movements4h.filter(r => (r.amount_usd ?? 0) >= MIN_SOVEREIGN_USD);

    if (significantRows.length > 0) {
      const replayEnvelopes = significantRows.map(movementRowToReplayEnvelope);
      const replayResult = normalizeReplayRowsWithFallback(
        significantRows,
        replayEnvelopes,
        {
          whaleAddressSet: new Set<string>(),
          solPriceUsd: 0,
        },
      );
      const normalized = replayResult.normalized;

      log(
        'info',
        `Replay normalization: ${replayResult.used_provider_path} provider-path, ` +
        `${replayResult.used_fallback_path} fallback-path`,
      );

      // Collect unique addresses for shadow map lookup
      const addrSet = new Set<string>();
      for (const r of significantRows) {
        if (r.from_address) addrSet.add(r.from_address);
        if (r.to_address)   addrSet.add(r.to_address);
      }

      // Load shadow map + shadow family map in parallel — both fall back on error
      const [shadowMap, familyMap] = await Promise.all([
        loadJoinerShadowMap([...addrSet], db).catch(() => new Map()),
        loadJoinerShadowFamilyMap([...addrSet], db).catch(() => new Map()),
      ]);

      // Bind persistence manager — flushes to sovereign_signals table
      const manager = createBoundPersistenceManager(db, { batchSizeThreshold: 200 });

      // Join + enqueue; do NOT flush yet (need peekBuffer for alert eval)
      const joinResult = await joinAndAcceptBatch(normalized, manager, db, {
        shadowMap,
        familyMap,
        flushAfter: false,
      });
      log('info', `Sovereign join: ${joinResult.accepted} accepted, ${joinResult.skipped} skipped`);

      // Evaluate in-memory buffer for intelligence-grade alerts
      if (joinResult.accepted > 0) {
        const buffer = manager.peekBuffer();

        // ── Sovereign unknown mint queueing (Block 59) ─────────
        {
          const seenUnknownMints = new Set<string>();
          for (const s of buffer) {
            if (!s.token_mint) continue;
            const unknownProgram = s.token_program_type === 'unknown';
            const emptySymbol = !s.token_symbol;
            if (!(unknownProgram || emptySymbol)) continue;
            if (seenUnknownMints.has(s.token_mint)) continue;
            seenUnknownMints.add(s.token_mint);
            await enqueueUnknownMint(db, s.token_mint);
          }
        }

        // ── Privacy lifecycle event persistence (Block 36) ────────
        // Derived from the in-memory sovereign buffer BEFORE flush.
        // Event-grade, replay-safe, additive.
        {
          const lifecycleEvents = derivePrivacyLifecycleEventsFromBatch(buffer);

          if (lifecycleEvents.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: insertedLifecycle, error: lifecycleErr } = await db
              .from('privacy_lifecycle_events')
              .upsert(lifecycleEvents as any, { onConflict: 'event_id' })
              .select('event_id');

            if (lifecycleErr) {
              log('warn', `Privacy lifecycle event insert failed (non-critical): ${lifecycleErr.message}`);
            } else {
              log('info', `Privacy lifecycle events written: ${insertedLifecycle?.length ?? 0}`);
            }

            // ── Privacy lifecycle sequence persistence (Block 38) ─────
            {
              const lifecycleSequences = derivePrivacyLifecycleSequencesFromEvents(lifecycleEvents);

              if (lifecycleSequences.length > 0) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const { data: insertedSequences, error: sequenceErr } = await db
                  .from('privacy_lifecycle_sequences')
                  .upsert(lifecycleSequences as any, { onConflict: 'sequence_id' })
                  .select('sequence_id');

                if (sequenceErr) {
                  log('warn', `Privacy lifecycle sequence insert failed (non-critical): ${sequenceErr.message}`);
                } else {
                  log('info', `Privacy lifecycle sequences written: ${insertedSequences?.length ?? 0}`);

                  const candidateSource = lifecycleSequences as Array<{
                    sequence_id: string;
                    start_event_id: string;
                    end_event_id: string;
                    token_mint: string | null;
                    token_symbol: string | null;
                    shadow_family_id: string | null;
                    start_stage: string;
                    end_stage: string;
                    stage_path: string[];
                    sequence_confidence: number;
                    elapsed_seconds: number | null;
                    sequence_reason: string | null;
                    end_event_time: string;
                    methodology_version: string;
                  }>;

                  const sequenceCandidates = derivePrivacySequenceAlertCandidates(candidateSource);

                  if (sequenceCandidates.length > 0) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const { data: insertedCandidates, error: candidateErr } = await db
                      .from('privacy_sequence_alert_candidates')
                      .upsert(sequenceCandidates as any, { onConflict: 'candidate_id' })
                      .select('candidate_id');

                    if (candidateErr) {
                      log('warn', `Privacy sequence candidate insert failed (non-critical): ${candidateErr.message}`);
                    } else {
                      log('info', `Privacy sequence alert candidates written: ${insertedCandidates?.length ?? 0}`);

                      const promotedAlerts = deriveSequenceAwareAlertInserts(
                        sequenceCandidates.map((c) => ({
                          ...c,
                          created_at: new Date().toISOString(),
                        })),
                        70,
                      );

                      const valuationAwarePromotedAlerts = await Promise.all(
                        promotedAlerts.map((a) => applyValuationDoctrineToAlertInsert(db, a))
                      );

                      const consolidatedPromotedAlerts =
                        consolidatePrivacySequencePromotedAlerts(valuationAwarePromotedAlerts);

                      const doctrineUnifiedAlerts =
                        unifyPrivacyAlertDoctrine(consolidatedPromotedAlerts);

                      const knownPrivacyFingerprints =
                        await loadRecentPrivacyFingerprints(db, 24);

                      const historyResult =
                        suppressFingerprintKnownAlerts(
                          doctrineUnifiedAlerts,
                          knownPrivacyFingerprints,
                        );

                      const historyDedupedAlerts = historyResult.kept;

                      if (historyResult.suppressedFingerprints.length > 0) {
                        await bumpSuppressedPrivacyFingerprints(
                          db,
                          historyResult.suppressedFingerprints,
                        );

                        await insertPrivacySuppressionReceipts(
                          db,
                          historyResult.suppressionCandidates,
                        );
                      }

                      if (historyDedupedAlerts.length > 0) {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const { data: insertedPromoted, error: promotedErr } = await db
                          .from('alerts')
                          .insert(historyDedupedAlerts as any)
                          .select('id');

                        if (promotedErr) {
                          log('warn', `Privacy sequence promoted alert insert failed (non-critical): ${promotedErr.message}`);
                        } else {
                          await upsertPrivacyFingerprintRecords(db, historyDedupedAlerts);
                          alerts_generated += insertedPromoted?.length ?? 0;
                          log('info', `Privacy sequence promoted alerts written: ${insertedPromoted?.length ?? 0} (from ${promotedAlerts.length} raw / ${consolidatedPromotedAlerts.length} consolidated / ${doctrineUnifiedAlerts.length} doctrine-unified / ${historyDedupedAlerts.length} fingerprint-deduped)`);
                        }
                      } else {
                        log('info', 'Privacy sequence promoted alerts: no candidates remained after doctrine/fingerprint dedup');
                      }
                    }
                  } else {
                    log('info', 'Privacy sequence alert candidates: no high-signal candidate patterns in this sovereign batch');
                  }
                }
              } else {
                log('info', 'Privacy lifecycle sequences: no forward stage progressions in this sovereign batch');
              }
            }
          } else {
            log('info', 'Privacy lifecycle events: no non-none stages in this sovereign batch');
          }
        }

        // ── Family intelligence summary log ───────────────────────
        // Log-only: validates that shadow_family_* fields are being populated.
        // Not user-facing; helps calibrate coverage before runtime tuning.
        {
          const familyLinked  = buffer.filter(s => s.shadow_family_id !== null);
          const distinctFams  = new Set(familyLinked.map(s => s.shadow_family_id)).size;
          const fanOutCount   = familyLinked.filter(s => s.shadow_family_has_fan_out).length;
          const gasCount      = familyLinked.filter(s => s.shadow_family_has_gas_funding).length;
          log('info',
            `Family summary: ${familyLinked.length}/${buffer.length} signals family-linked, ` +
            `${distinctFams} distinct families, ${fanOutCount} fan-out, ${gasCount} gas-funding`,
          );
        }

        // Build dedup key set from recently fired sovereign alerts.
        // Independent query scoped to sovereign types only — avoids
        // coupling to section 5's recentAlerts which isn't in scope yet.
        const SOVEREIGN_ALERT_TYPES = [
          'shadow_whale_inflow', 'exchange_shadow_birth',
          'privacy_token_activity', 'cluster_synchronized_flow',
          'sovereign_high_confidence',
          'shadow_family_fan_out', 'shadow_gas_funding_chain',
          'token2022_extension_sensitive', 'asymmetric_token_delta',
          'possible_transfer_fee_flow', 'privacy_adjacent_token_activity',
          'privacy_bridgehead_birth', 'exchange_funded_privacy_staging',
          'family_privacy_bridgehead',
          'privacy_exit_to_public_flow', 'post_privacy_downstream_move',
          'family_privacy_reemergence',
        ];
        const sovereignCutoff = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();
        const { data: recentSovereignRaw } = await db
          .from('alerts')
          .select('alert_type, data')
          .in('alert_type', SOVEREIGN_ALERT_TYPES)
          .gte('created_at', sovereignCutoff)
          .order('created_at', { ascending: false })
          .limit(20);

        const recentSovereignKeys = new Set<string>(
          ((recentSovereignRaw ?? []) as Array<{ alert_type: string; data: unknown }>)
            .map(r => {
              const d = r.data as Record<string, unknown> | null;
              return typeof d?.consolidation_key === 'string' ? d.consolidation_key : '';
            })
            .filter(Boolean),
        );

        const candidates = evaluateSignalsForAlerts(buffer, recentSovereignKeys);
        const decisions  = consolidateAlerts(candidates);

        {
          const tokenAwareSignals = buffer.filter(s =>
            s.is_token_2022 ||
            s.has_asymmetric_token_delta ||
            s.possible_transfer_fee_behavior
          ).length;

          const tokenAwareAlerts = decisions.filter(d =>
            d.archetype === 'token2022_extension_sensitive' ||
            d.archetype === 'asymmetric_token_delta' ||
            d.archetype === 'possible_transfer_fee_flow' ||
            d.archetype === 'privacy_adjacent_token_activity'
          );

          const bridgeheadAlerts = decisions.filter(d =>
            d.archetype === 'privacy_bridgehead_birth' ||
            d.archetype === 'exchange_funded_privacy_staging' ||
            d.archetype === 'family_privacy_bridgehead'
          );

          const reemergenceAlerts = decisions.filter(d =>
            d.archetype === 'privacy_exit_to_public_flow' ||
            d.archetype === 'post_privacy_downstream_move' ||
            d.archetype === 'family_privacy_reemergence'
          );

          const asymmetricCount = buffer.filter(s => s.has_asymmetric_token_delta).length;
          const feeLikeCount    = buffer.filter(s => s.possible_transfer_fee_behavior).length;
          const privacyAdjCount = buffer.filter(s => s.is_token_2022 && (s.has_confidential_transfer || s.has_auditor_key)).length;
          const familyPrivacyCount = buffer.filter(s => s.shadow_family_has_privacy_activation).length;
          const publicSidePrivacyCount = buffer.filter(s =>
            s.is_token_2022 &&
            !s.has_confidential_transfer &&
            (s.has_auditor_key || s.has_shadow_link || s.shadow_family_has_privacy_activation)
          ).length;

          log(
            'info',
            `Token-aware summary: ${tokenAwareSignals}/${buffer.length} token-aware signals, ` +
            `${tokenAwareAlerts.length} token-aware alert(s), ` +
            `${bridgeheadAlerts.length} privacy-bridgehead alert(s), ` +
            `${reemergenceAlerts.length} privacy-reemergence alert(s), ` +
            `${asymmetricCount} asymmetric-delta, ${feeLikeCount} possible-fee, ` +
            `${privacyAdjCount} privacy-adjacent, ${familyPrivacyCount} family-privacy, ` +
            `${publicSidePrivacyCount} public-side-privacy-context`,
          );
        }

        if (decisions.length > 0) {
          const sovereignAlerts = decisions.map(decisionToAlertInsert);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: insertedSovereign, error: sovereignErr } = await db
            .from('alerts')
            .insert(sovereignAlerts as any)
            .select('id');

          if (sovereignErr) {
            log('warn', `Sovereign alert insert failed (non-critical): ${sovereignErr.message}`);
          } else {
            const count = insertedSovereign?.length ?? 0;
            alerts_generated += count;
            log('info', `${count} sovereign alert(s) written (${decisions.map(d => d.archetype).join(', ')})`);
          }
        } else {
          log('info', 'Sovereign pipeline: no alert candidates above threshold');
        }
      }

      // Flush enriched signals to sovereign_signals table
      const flushResult = await manager.flush();
      log('info', `Sovereign signals flushed: ${flushResult.written} written, ${flushResult.failed} failed, ${flushResult.deferred} deferred`);
    } else {
      log('info', `Sovereign pipeline: no significant movements (< $${MIN_SOVEREIGN_USD.toLocaleString()}) in 4h window`);
    }
  } catch (err) {
    log('warn', `Sovereign intelligence pipeline failed (non-critical): ${String(err)}`);
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
