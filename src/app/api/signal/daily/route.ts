// ============================================================
// SONAR v2.0 — GET /api/signal/daily
// ============================================================
// Clean, publishable daily signal output.
//
// Returns:
//   score          bias_score (-100 to +100)
//   bias           bullish | bearish | neutral
//   confidence     very_high | high | moderate | low
//   drivers        per-sub-signal breakdown with notes
//   staking_velocity  pct + interpretation
//   flow_24h       key aggregated metrics
//   publish_text   ready-to-post X / Telegram text
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { FlowSnapshotRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Formatting helpers ────────────────────────────────────────

function fmtUsd(v: number): string {
  const abs  = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function fmtScore(s: number): string {
  return `${s >= 0 ? '+' : ''}${s}`;
}

// ── Interpretation helpers ────────────────────────────────────

type Confidence = 'very_high' | 'high' | 'moderate' | 'low';

function toConfidence(cc: number): Confidence {
  if (cc >= 3) return 'very_high';
  if (cc === 2) return 'high';
  if (cc === 1) return 'moderate';
  return 'low';
}

function interpretVelocity(pct: number | null): string | null {
  if (pct === null) return null;
  const abs = Math.abs(pct);
  if (abs < 10)   return 'stable';
  if (pct >  200) return 'surge';
  if (pct >   50) return 'strongly accelerating';
  if (pct >   10) return 'accelerating';
  if (pct < -200) return 'collapse';
  if (pct <  -50) return 'strongly decelerating';
  return 'decelerating';
}

type SignalDirection = 'bullish' | 'bearish' | 'neutral';

function netDirection(net: number, threshold = 50_000): SignalDirection {
  if (net > threshold) return 'bullish';
  if (net < -threshold) return 'bearish';
  return 'neutral';
}

// ── Driver builder ─────────────────────────────────────────────

interface Driver {
  signal:    string;
  direction: SignalDirection;
  net_usd:   number;
  note:      string;
}

function buildDrivers(s: FlowSnapshotRow): Driver[] {
  // Exchange: sol_net_exchange_flow_usd is negative when outflow > inflow (accumulation = bullish)
  const exchNet  = s.sol_net_exchange_flow_usd;
  // Bullish when net is negative (outflow dominates)
  const exchDir: SignalDirection = exchNet < -50_000 ? 'bullish' : exchNet > 50_000 ? 'bearish' : 'neutral';
  const exchNote = exchNet < 0
    ? `${fmtUsd(-exchNet)} net outflow (accumulation)`
    : exchNet > 0
    ? `${fmtUsd(exchNet)} net inflow (distribution)`
    : 'balanced exchange activity';

  // Staking: positive = net staked = bullish
  const stakeNet  = s.net_staking_flow_usd;
  const stakeDir  = netDirection(stakeNet);
  const stakeNote = stakeNet > 0
    ? `${fmtUsd(stakeNet)} net staked`
    : stakeNet < 0
    ? `${fmtUsd(-stakeNet)} net unstaked`
    : 'flat staking activity';

  // USDC DeFi: positive = deployed = bullish
  const usdcNet  = s.net_usdc_flow_usd;
  const usdcDir  = netDirection(usdcNet);
  const usdcNote = usdcNet > 0
    ? `${fmtUsd(usdcNet)} deployed to DeFi`
    : usdcNet < 0
    ? `${fmtUsd(-usdcNet)} withdrawn from DeFi`
    : 'flat stablecoin DeFi flow';

  return [
    { signal: 'exchange',  direction: exchDir,  net_usd: exchNet,  note: exchNote  },
    { signal: 'staking',   direction: stakeDir, net_usd: stakeNet, note: stakeNote },
    { signal: 'usdc_defi', direction: usdcDir,  net_usd: usdcNet,  note: usdcNote  },
  ];
}

// ── Publish text builder ───────────────────────────────────────

function buildPublishText(
  s24: FlowSnapshotRow,
  s4:  FlowSnapshotRow | null,
  score: number,
  bias: string,
  confidence: Confidence,
  drivers: Driver[],
  velocity_pct: number | null,
  velocity_interp: string | null,
): string {
  const date  = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const biasUpper = bias.toUpperCase();
  const confLabel = confidence.replace('_', ' ').toUpperCase();

  const lines = [
    `SONAR Signal — ${date}`,
    `Bias: ${biasUpper} ${fmtScore(score)} | Confidence: ${confLabel} (${s24.confirmation_count ?? 0}/3)`,
    '',
    'Drivers:',
    ...drivers.map(d => `  ${d.direction === 'bullish' ? '↑' : d.direction === 'bearish' ? '↓' : '→'} ${d.note}`),
  ];

  if (velocity_pct !== null && velocity_interp !== null) {
    const sign = velocity_pct >= 0 ? '+' : '';
    lines.push('');
    lines.push(`Staking velocity: ${sign}${velocity_pct.toFixed(1)}% (${velocity_interp})`);
  }

  const whales = s24.unique_whales_active;
  const large  = s24.large_movements_count;
  lines.push('');
  lines.push(`24h: ${large} large moves | ${whales} active whales`);

  return lines.join('\n');
}

// ── Handler ───────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    const { data: snapshotsRaw, error } = await db
      .from('flow_snapshots')
      .select('*')
      .in('window_hours', [4, 24])
      .order('snapshot_time', { ascending: false })
      .limit(10);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const snapshots = (snapshotsRaw ?? []) as FlowSnapshotRow[];
    const s24 = snapshots.find(s => s.window_hours === 24) ?? null;
    const s4  = snapshots.find(s => s.window_hours === 4)  ?? null;

    if (!s24) {
      return NextResponse.json({ ok: false, error: 'no_snapshot_data' }, { status: 404 });
    }

    const score      = s24.bias_score       ?? 0;
    const bias       = s24.market_bias      ?? 'neutral';
    const cc         = s24.confirmation_count ?? 0;
    const confidence = toConfidence(cc);
    const drivers    = buildDrivers(s24);

    const velocity_pct    = s4?.staking_velocity_pct ?? null;
    const velocity_interp = interpretVelocity(velocity_pct);

    const publish_text = buildPublishText(
      s24, s4, score, bias, confidence, drivers, velocity_pct, velocity_interp,
    );

    return NextResponse.json({
      ok:           true,
      generated_at: new Date().toISOString(),
      snapshot_time: s24.snapshot_time,
      score,
      bias,
      confidence,
      confirmation_count: cc,
      drivers,
      staking_velocity: {
        pct:            velocity_pct,
        interpretation: velocity_interp,
      },
      flow_24h: {
        exchange_net_usd:  s24.sol_net_exchange_flow_usd,
        staking_net_usd:   s24.net_staking_flow_usd,
        usdc_net_usd:      s24.net_usdc_flow_usd,
        defi_net_usd:      s24.net_defi_flow_usd,
        large_movements:   s24.large_movements_count,
        unique_whales:     s24.unique_whales_active,
      },
      publish_text,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
