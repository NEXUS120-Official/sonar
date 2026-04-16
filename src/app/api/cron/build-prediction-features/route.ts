// ============================================================
// SONAR — Build Prediction Features Cron
// POST /api/cron/build-prediction-features
// ============================================================
// Runs every hour. Reads recent flow_snapshots and bias_index_history,
// computes normalized feature vectors, and writes rows to prediction_features
// for each horizon: 4h, 24h, 72h.
//
// Feature derivation:
//   exchange_net_flow_usd  ← sol_net_exchange_flow_usd  (negative = accumulation)
//   staking_net_flow_usd   ← net_staking_flow_usd       (positive = bullish)
//   staking_velocity       ← Δnet_staking / Δt (SOL/h) — acceleration
//   stablecoin_deploy_usd  ← net_usdc_flow_usd          (positive = deploying capital)
//   defi_rotation_score    ← net_defi_flow_usd normalized to [-1, 1]
//   large_wallet_concentration ← large_movements_count / unique_whales_active
//   smart_money_net_bias   ← bias_score / 100 from bias_index_history
//   bias_score             ← from latest bias_index_history row
//   bias_confidence        ← from latest bias_index_history row
//
// Horizons map to window_hours:
//   4h  → window_hours = 4
//   24h → window_hours = 24
//   72h → aggregate of 3 × 24h snapshots (last 72 h)
//
// Idempotent: uses unique index on (feature_time, horizon); conflicting rows
// are updated (upsert). Runs de-dup: skips if a row already exists for
// the truncated hour × horizon.
//
// Protected by CRON_SECRET.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

// ── Config ────────────────────────────────────────────────────

const NORMALIZATION_CAP_USD = 100_000_000; // $100M — cap for [-1,1] normalization

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/build-prediction-features][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn') console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Types ─────────────────────────────────────────────────────

interface FlowSnapshotRow {
  id:                      string;
  snapshot_time:           string;
  window_hours:            number;
  sol_exchange_inflow_usd:  number;
  sol_exchange_outflow_usd: number;
  sol_net_exchange_flow_usd: number;
  sol_staked_usd:           number;
  sol_unstaked_usd:         number;
  net_staking_flow_usd:     number;
  usdc_inflow_usd:          number;
  usdc_outflow_usd:         number;
  net_usdc_flow_usd:        number;
  defi_deposit_usd:         number;
  defi_withdrawal_usd:      number;
  net_defi_flow_usd:        number;
  large_movements_count:    number;
  unique_whales_active:     number;
  bias_score:               number | null;
}

interface BiasHistoryRow {
  score:      number;
  confidence: number;
  created_at: string;
}

interface FeatureVector {
  exchange_net_flow_usd:      number;
  staking_net_flow_usd:       number;
  staking_velocity:           number;
  stablecoin_deploy_usd:      number;
  defi_rotation_score:        number;
  large_wallet_concentration: number;
  smart_money_net_bias:       number;
  bias_score:                 number;
  bias_confidence:            number;
  features_json:              Record<string, number>;
}

// ── Math helpers ──────────────────────────────────────────────

function normalize(value: number, cap: number): number {
  return Math.max(-1, Math.min(1, value / cap));
}

function safeDiv(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

// ── Feature computation ───────────────────────────────────────

function computeFeatures(
  snapshot: FlowSnapshotRow,
  prevSnapshot: FlowSnapshotRow | null,
  latestBias: BiasHistoryRow | null,
): FeatureVector {
  // Staking velocity: Δnet_staking / Δt (hours)
  let stakingVelocity = 0;
  if (prevSnapshot) {
    const dtHours =
      (new Date(snapshot.snapshot_time).getTime() -
       new Date(prevSnapshot.snapshot_time).getTime()) /
      3_600_000;
    if (dtHours > 0) {
      const deltaStaking =
        (snapshot.net_staking_flow_usd ?? 0) -
        (prevSnapshot.net_staking_flow_usd ?? 0);
      stakingVelocity = safeDiv(deltaStaking, dtHours);
    }
  }

  // DeFi rotation: net_defi_flow normalized
  const defiRotationScore = normalize(
    snapshot.net_defi_flow_usd ?? 0,
    NORMALIZATION_CAP_USD,
  );

  // Whale concentration: large movements per active whale
  const largeWalletConcentration = safeDiv(
    snapshot.large_movements_count ?? 0,
    snapshot.unique_whales_active ?? 1,
  );

  const biasScore      = latestBias?.score      ?? snapshot.bias_score ?? 0;
  const biasConfidence = latestBias?.confidence ?? 50;
  const smartMoneyBias = biasScore / 100; // [-1, 1]

  return {
    exchange_net_flow_usd:      snapshot.sol_net_exchange_flow_usd ?? 0,
    staking_net_flow_usd:       snapshot.net_staking_flow_usd ?? 0,
    staking_velocity:           stakingVelocity,
    stablecoin_deploy_usd:      snapshot.net_usdc_flow_usd ?? 0,
    defi_rotation_score:        defiRotationScore,
    large_wallet_concentration: largeWalletConcentration,
    smart_money_net_bias:       smartMoneyBias,
    bias_score:                 biasScore,
    bias_confidence:            biasConfidence,
    features_json: {
      sol_inflow_usd:      snapshot.sol_exchange_inflow_usd ?? 0,
      sol_outflow_usd:     snapshot.sol_exchange_outflow_usd ?? 0,
      sol_staked_usd:      snapshot.sol_staked_usd ?? 0,
      sol_unstaked_usd:    snapshot.sol_unstaked_usd ?? 0,
      usdc_inflow_usd:     snapshot.usdc_inflow_usd ?? 0,
      usdc_outflow_usd:    snapshot.usdc_outflow_usd ?? 0,
      defi_deposit_usd:    snapshot.defi_deposit_usd ?? 0,
      defi_withdrawal_usd: snapshot.defi_withdrawal_usd ?? 0,
      large_movements_count:  snapshot.large_movements_count ?? 0,
      unique_whales_active:   snapshot.unique_whales_active ?? 0,
    },
  };
}

// ── 72h aggregate: sum 3 × 24h snapshots ─────────────────────

function aggregate72h(snapshots24h: FlowSnapshotRow[]): FlowSnapshotRow {
  const base: FlowSnapshotRow = {
    ...snapshots24h[0],
    window_hours: 72,
    sol_exchange_inflow_usd:  0,
    sol_exchange_outflow_usd: 0,
    sol_net_exchange_flow_usd: 0,
    sol_staked_usd:           0,
    sol_unstaked_usd:         0,
    net_staking_flow_usd:     0,
    usdc_inflow_usd:          0,
    usdc_outflow_usd:         0,
    net_usdc_flow_usd:        0,
    defi_deposit_usd:         0,
    defi_withdrawal_usd:      0,
    net_defi_flow_usd:        0,
    large_movements_count:    0,
    unique_whales_active:     0,
    bias_score:               null,
  };

  for (const s of snapshots24h) {
    base.sol_exchange_inflow_usd   += s.sol_exchange_inflow_usd ?? 0;
    base.sol_exchange_outflow_usd  += s.sol_exchange_outflow_usd ?? 0;
    base.sol_net_exchange_flow_usd += s.sol_net_exchange_flow_usd ?? 0;
    base.sol_staked_usd            += s.sol_staked_usd ?? 0;
    base.sol_unstaked_usd          += s.sol_unstaked_usd ?? 0;
    base.net_staking_flow_usd      += s.net_staking_flow_usd ?? 0;
    base.usdc_inflow_usd           += s.usdc_inflow_usd ?? 0;
    base.usdc_outflow_usd          += s.usdc_outflow_usd ?? 0;
    base.net_usdc_flow_usd         += s.net_usdc_flow_usd ?? 0;
    base.defi_deposit_usd          += s.defi_deposit_usd ?? 0;
    base.defi_withdrawal_usd       += s.defi_withdrawal_usd ?? 0;
    base.net_defi_flow_usd         += s.net_defi_flow_usd ?? 0;
    base.large_movements_count     += s.large_movements_count ?? 0;
    // unique_whales: take max (avoid double-counting)
    base.unique_whales_active = Math.max(
      base.unique_whales_active,
      s.unique_whales_active ?? 0,
    );
  }

  return base;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const startMs = Date.now();

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db    = createAdminClient();
  const dbAny = db as any;

  log('info', 'Starting feature store build');

  // ── 1. Fetch latest bias from bias_index_history ─────────────
  let latestBias: BiasHistoryRow | null = null;
  try {
    const { data: biasData } = await dbAny
      .from('bias_index_history')
      .select('score, confidence, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    latestBias = biasData ?? null;
  } catch (err) {
    log('warn', 'Could not fetch bias_index_history — proceeding without bias', err);
  }

  // ── 2. Fetch recent flow_snapshots (4h window, last 2 rows) ──
  // We need 2 rows to compute staking_velocity (current vs prev).
  const { data: snaps4hRaw, error: snaps4hErr } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 4)
    .order('snapshot_time', { ascending: false })
    .limit(2);

  if (snaps4hErr) {
    log('error', 'Failed to fetch 4h snapshots', snaps4hErr.message);
    return NextResponse.json({ ok: false, error: snaps4hErr.message }, { status: 500 });
  }

  const snaps4h = (snaps4hRaw ?? []) as FlowSnapshotRow[];

  // ── 3. Fetch recent flow_snapshots (24h window, last 4 rows) ─
  const { data: snaps24hRaw, error: snaps24hErr } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 24)
    .order('snapshot_time', { ascending: false })
    .limit(4);  // need 3 for 72h aggregate + 1 prev for velocity

  if (snaps24hErr) {
    log('error', 'Failed to fetch 24h snapshots', snaps24hErr.message);
    return NextResponse.json({ ok: false, error: snaps24hErr.message }, { status: 500 });
  }

  const snaps24h = (snaps24hRaw ?? []) as FlowSnapshotRow[];

  if (snaps4h.length === 0 && snaps24h.length === 0) {
    log('info', 'No flow snapshots available — skipping');
    return NextResponse.json({ ok: true, message: 'no_data', inserted: 0, duration_ms: Date.now() - startMs });
  }

  // ── 4. Compute and upsert features for each horizon ──────────

  const featureTime = new Date();
  // Truncate to the current hour for idempotency
  featureTime.setMinutes(0, 0, 0);

  let inserted = 0;
  const errors: string[] = [];

  // ── 4a. 4h horizon ───────────────────────────────────────────
  if (snaps4h.length > 0) {
    const snap    = snaps4h[0];
    const prev    = snaps4h[1] ?? null;
    const features = computeFeatures(snap, prev, latestBias);

    const { error: upsertErr } = await dbAny
      .from('prediction_features')
      .upsert({
        feature_time:               featureTime.toISOString(),
        horizon:                    '4h',
        exchange_net_flow_usd:      features.exchange_net_flow_usd,
        staking_net_flow_usd:       features.staking_net_flow_usd,
        staking_velocity:           features.staking_velocity,
        stablecoin_deploy_usd:      features.stablecoin_deploy_usd,
        defi_rotation_score:        features.defi_rotation_score,
        large_wallet_concentration: features.large_wallet_concentration,
        cluster_activity_score:     null,  // reserved for wallet cluster pass
        smart_money_net_bias:       features.smart_money_net_bias,
        bias_score:                 features.bias_score,
        bias_confidence:            features.bias_confidence,
        features_json:              features.features_json,
      }, { onConflict: 'feature_time,horizon', ignoreDuplicates: false });

    if (upsertErr) {
      errors.push(`4h upsert failed: ${upsertErr.message}`);
      log('error', '4h upsert failed', upsertErr.message);
    } else {
      inserted++;
      log('info', `4h: exchange_net=$${features.exchange_net_flow_usd.toFixed(0)} staking_net=$${features.staking_net_flow_usd.toFixed(0)} bias=${features.bias_score}`);
    }
  }

  // ── 4b. 24h horizon ──────────────────────────────────────────
  if (snaps24h.length > 0) {
    const snap    = snaps24h[0];
    const prev    = snaps24h[1] ?? null;
    const features = computeFeatures(snap, prev, latestBias);

    const { error: upsertErr } = await dbAny
      .from('prediction_features')
      .upsert({
        feature_time:               featureTime.toISOString(),
        horizon:                    '24h',
        exchange_net_flow_usd:      features.exchange_net_flow_usd,
        staking_net_flow_usd:       features.staking_net_flow_usd,
        staking_velocity:           features.staking_velocity,
        stablecoin_deploy_usd:      features.stablecoin_deploy_usd,
        defi_rotation_score:        features.defi_rotation_score,
        large_wallet_concentration: features.large_wallet_concentration,
        cluster_activity_score:     null,
        smart_money_net_bias:       features.smart_money_net_bias,
        bias_score:                 features.bias_score,
        bias_confidence:            features.bias_confidence,
        features_json:              features.features_json,
      }, { onConflict: 'feature_time,horizon', ignoreDuplicates: false });

    if (upsertErr) {
      errors.push(`24h upsert failed: ${upsertErr.message}`);
      log('error', '24h upsert failed', upsertErr.message);
    } else {
      inserted++;
      log('info', `24h: exchange_net=$${features.exchange_net_flow_usd.toFixed(0)} bias=${features.bias_score}`);
    }
  }

  // ── 4c. 72h horizon (aggregate 3 × 24h) ─────────────────────
  if (snaps24h.length >= 3) {
    const snap72h   = aggregate72h(snaps24h.slice(0, 3));
    const prev72h   = snaps24h.length >= 4 ? aggregate72h(snaps24h.slice(1, 4)) : null;
    const features  = computeFeatures(snap72h, prev72h, latestBias);

    const { error: upsertErr } = await dbAny
      .from('prediction_features')
      .upsert({
        feature_time:               featureTime.toISOString(),
        horizon:                    '72h',
        exchange_net_flow_usd:      features.exchange_net_flow_usd,
        staking_net_flow_usd:       features.staking_net_flow_usd,
        staking_velocity:           features.staking_velocity,
        stablecoin_deploy_usd:      features.stablecoin_deploy_usd,
        defi_rotation_score:        features.defi_rotation_score,
        large_wallet_concentration: features.large_wallet_concentration,
        cluster_activity_score:     null,
        smart_money_net_bias:       features.smart_money_net_bias,
        bias_score:                 features.bias_score,
        bias_confidence:            features.bias_confidence,
        features_json:              features.features_json,
      }, { onConflict: 'feature_time,horizon', ignoreDuplicates: false });

    if (upsertErr) {
      errors.push(`72h upsert failed: ${upsertErr.message}`);
      log('error', '72h upsert failed', upsertErr.message);
    } else {
      inserted++;
      log('info', `72h (aggregate 3×24h): exchange_net=$${features.exchange_net_flow_usd.toFixed(0)} bias=${features.bias_score}`);
    }
  } else {
    log('info', `72h skipped — only ${snaps24h.length} 24h snapshots available (need ≥3)`);
  }

  const duration = Date.now() - startMs;
  log('info', `Done — inserted/updated=${inserted} errors=${errors.length} duration=${duration}ms`);

  return NextResponse.json({
    ok:          errors.length === 0,
    feature_time: featureTime.toISOString(),
    inserted,
    errors:      errors.slice(0, 5),
    duration_ms: duration,
  });
}

export const GET = POST;
