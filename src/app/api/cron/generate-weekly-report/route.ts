// ============================================================
// SONAR v2.0 — Weekly Intelligence Report Generator
// POST /api/cron/generate-weekly-report
// ============================================================
// Runs every Monday at 00:00 UTC via Vercel Cron.
//
// Computes a 7-day intelligence report from live DB data:
//   - Exchange flow recap (7d totals + dominant exchange)
//   - Staking recap (7d totals + velocity range)
//   - Bias trend (daily 24h bias scores + days per direction)
//   - Alerts summary (total + by type)
//   - Top movements by USD amount
//   - Publishable weekly summary text
//
// Stores the report as a weekly_report alert in the DB
// (body = publish text, data = full structured JSON).
//
// Protected by CRON_SECRET header.
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { resolveAddressBatch } from '@/lib/entity-graph';
import type { FlowSnapshotRow, AlertRow, MovementRow, AlertType } from '@/lib/supabase/types';

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Formatting helpers ────────────────────────────────────────

function fmtUsd(v: number): string {
  const abs  = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function weekLabel(d: Date): string {
  // ISO week: YYYY-Www
  const jan1     = new Date(d.getFullYear(), 0, 1);
  const weekNum  = Math.ceil(((d.getTime() - jan1.getTime()) / 86_400_000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function interpretNetExchange(net: number): string {
  // convention in snapshots: negative = outflow = accumulation = bullish
  const abs = Math.abs(net);
  if (abs < 100_000) return 'balanced';
  return net < 0 ? 'accumulation' : 'distribution';
}

function interpretNetStaking(net: number): string {
  const abs = Math.abs(net);
  if (abs < 100_000) return 'stable';
  return net > 0 ? 'strengthening' : 'weakening';
}

// ── Build publish text ─────────────────────────────────────────

interface WeeklyReport {
  week: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  exchange_recap: {
    net_7d_usd: number;
    avg_daily_net_usd: number;
    direction: string;
    dominant_exchange: string | null;
    inflow_7d_usd: number;
    outflow_7d_usd: number;
  };
  staking_recap: {
    net_7d_usd: number;
    avg_daily_net_usd: number;
    direction: string;
    velocity_range_pct: [number, number] | null;
  };
  bias_trend: {
    scores_7d: number[];
    avg_score: number;
    current_score: number;
    score_7d_ago: number;
    score_change: number;
    days_bullish: number;
    days_bearish: number;
    days_neutral: number;
  };
  alerts_summary: {
    total: number;
    by_type: Record<string, number>;
  };
  top_moves: {
    flow_type:   string;
    token:       string;
    amount_usd:  number;
    exchange:    string | null;
    protocol:    string | null;
    block_time:  string;
    entity_name: string | null;
  }[];
  publish_text: string;
}

function buildPublishText(r: Omit<WeeklyReport, 'publish_text'>): string {
  const {
    week, exchange_recap: ex, staking_recap: st, bias_trend: bt, alerts_summary: al, top_moves,
  } = r;

  const avgBias   = bt.avg_score;
  const direction = avgBias > 10 ? 'BULLISH' : avgBias < -10 ? 'BEARISH' : 'NEUTRAL';
  const netLabel  = ex.direction === 'accumulation' ? 'net accumulation' : ex.direction === 'distribution' ? 'net distribution' : 'balanced';

  const topMoveLines = top_moves.slice(0, 5).map(m => {
    const actor    = m.entity_name ?? m.exchange ?? m.protocol ?? null;
    const actorStr = actor ? ` — ${actor}` : '';
    return `  • ${m.flow_type.replace(/_/g, ' ')} ${fmtUsd(m.amount_usd)}${actorStr}`;
  });

  const lines = [
    `SONAR Weekly Intelligence — ${week}`,
    '',
    `Avg Bias: ${direction} (${avgBias >= 0 ? '+' : ''}${avgBias}) | ${bt.days_bullish}d bull / ${bt.days_neutral}d neutral / ${bt.days_bearish}d bear`,
    '',
    `Exchange: ${fmtUsd(ex.net_7d_usd)} 7d (${netLabel})`,
    `  Inflow ${fmtUsd(ex.inflow_7d_usd)} | Outflow ${fmtUsd(ex.outflow_7d_usd)}`,
    ex.dominant_exchange ? `  Dominant: ${ex.dominant_exchange}` : '',
    '',
    `Staking: ${fmtUsd(st.net_7d_usd)} 7d (${st.direction})`,
    st.velocity_range_pct
      ? `  Velocity range: ${st.velocity_range_pct[0].toFixed(1)}% to ${st.velocity_range_pct[1].toFixed(1)}%`
      : '',
    '',
    `Alerts fired: ${al.total}`,
    ...Object.entries(al.by_type).map(([t, n]) => `  ${t}: ${n}`),
    ...(topMoveLines.length > 0 ? ['', 'Top moves:'] : []),
    ...topMoveLines,
  ].filter(l => l !== '');

  return lines.join('\n');
}

// ── Handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const startMs = Date.now();
  const now     = new Date();
  const db      = createAdminClient();

  const periodEnd   = now;
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  console.log(`[cron/weekly-report] Generating report for ${isoDate(periodStart)} → ${isoDate(periodEnd)}`);

  // ── 1. Load 7d of 24h snapshots ─────────────────────────────
  const { data: snapshotsRaw } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 24)
    .gte('snapshot_time', periodStart.toISOString())
    .order('snapshot_time', { ascending: true });

  const snapshots = (snapshotsRaw ?? []) as FlowSnapshotRow[];

  // ── 2. Load 7d of 4h snapshots (for velocity range) ─────────
  const { data: snap4hRaw } = await db
    .from('flow_snapshots')
    .select('staking_velocity_pct, snapshot_time')
    .eq('window_hours', 4)
    .gte('snapshot_time', periodStart.toISOString())
    .not('staking_velocity_pct', 'is', null);

  const velocities = (snap4hRaw ?? [])
    .map((r: { staking_velocity_pct: number | null }) => r.staking_velocity_pct!)
    .filter((v): v is number => v !== null);

  // ── 3. Load 7d alerts ─────────────────────────────────────────
  const { data: alertsRaw } = await db
    .from('alerts')
    .select('alert_type, severity, created_at')
    .gte('created_at', periodStart.toISOString())
    .neq('alert_type', 'weekly_report'); // exclude prior weekly reports

  const alerts = (alertsRaw ?? []) as Pick<AlertRow, 'alert_type' | 'severity' | 'created_at'>[];

  // ── 4. Load top 10 movements by USD (+ from_address for entity lookup) ──
  const { data: topMovesRaw } = await db
    .from('movements')
    .select('flow_type, token, amount_usd, exchange, protocol, block_time, from_address')
    .gte('block_time', periodStart.toISOString())
    .order('amount_usd', { ascending: false })
    .limit(10);

  type TopMoveRow = Pick<MovementRow, 'flow_type' | 'token' | 'amount_usd' | 'exchange' | 'protocol' | 'block_time' | 'from_address'>;
  const topMoveRows = (topMovesRaw ?? []) as TopMoveRow[];

  // Entity resolution for top move addresses (single batch)
  const topMoveAddrs = [...new Set(topMoveRows.map(m => m.from_address).filter((a): a is string => Boolean(a)))];
  const topMoveEntityMap = topMoveAddrs.length > 0
    ? await resolveAddressBatch(topMoveAddrs, db)
    : new Map();

  // ── 5. Compute exchange_recap ─────────────────────────────────
  const totalExchangeInflow  = snapshots.reduce((s, r) => s + r.sol_exchange_inflow_usd,  0);
  const totalExchangeOutflow = snapshots.reduce((s, r) => s + r.sol_exchange_outflow_usd, 0);
  // snapshot convention: negative net = net outflow = accumulation
  const netExchange7d  = snapshots.reduce((s, r) => s + r.sol_net_exchange_flow_usd, 0);
  const avgDailyExchange = snapshots.length > 0 ? Math.round(netExchange7d / snapshots.length) : 0;

  // Find dominant exchange from movements
  const { data: exchBreakdown } = await db
    .from('movements')
    .select('exchange, amount_usd')
    .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
    .gte('block_time', periodStart.toISOString())
    .not('exchange', 'is', null);

  const exchVol: Record<string, number> = {};
  for (const m of (exchBreakdown ?? []) as Pick<MovementRow, 'exchange' | 'amount_usd'>[]) {
    const k = m.exchange ?? 'unknown';
    exchVol[k] = (exchVol[k] ?? 0) + (m.amount_usd ?? 0);
  }
  const dominantExchange = Object.entries(exchVol).sort(([, a], [, b]) => b - a)[0]?.[0] ?? null;

  // ── 6. Compute staking_recap ──────────────────────────────────
  const netStaking7d   = snapshots.reduce((s, r) => s + r.net_staking_flow_usd, 0);
  const avgDailyStaking = snapshots.length > 0 ? Math.round(netStaking7d / snapshots.length) : 0;
  const velRange: [number, number] | null = velocities.length > 0
    ? [Math.min(...velocities), Math.max(...velocities)]
    : null;

  // ── 7. Compute bias_trend ─────────────────────────────────────
  const biasScores = snapshots.map(r => r.bias_score ?? 0);
  const avgScore   = biasScores.length > 0
    ? Math.round(biasScores.reduce((s, v) => s + v, 0) / biasScores.length)
    : 0;
  const currentScore = snapshots.at(-1)?.bias_score ?? 0;
  const oldestScore  = snapshots.at(0)?.bias_score  ?? 0;

  const daysBullish = snapshots.filter(r => r.market_bias === 'bullish').length;
  const daysBearish = snapshots.filter(r => r.market_bias === 'bearish').length;
  const daysNeutral = snapshots.filter(r => r.market_bias === 'neutral').length;

  // ── 8. Alerts summary ─────────────────────────────────────────
  const byType: Record<string, number> = {};
  for (const a of alerts) {
    byType[a.alert_type] = (byType[a.alert_type] ?? 0) + 1;
  }

  // ── 9. Assemble report ────────────────────────────────────────
  const reportData: Omit<WeeklyReport, 'publish_text'> = {
    week:         weekLabel(now),
    period_start: isoDate(periodStart),
    period_end:   isoDate(periodEnd),
    generated_at: now.toISOString(),
    exchange_recap: {
      net_7d_usd:       netExchange7d,
      avg_daily_net_usd: avgDailyExchange,
      direction:        interpretNetExchange(netExchange7d),
      dominant_exchange: dominantExchange,
      inflow_7d_usd:    totalExchangeInflow,
      outflow_7d_usd:   totalExchangeOutflow,
    },
    staking_recap: {
      net_7d_usd:        netStaking7d,
      avg_daily_net_usd: avgDailyStaking,
      direction:         interpretNetStaking(netStaking7d),
      velocity_range_pct: velRange,
    },
    bias_trend: {
      scores_7d:    biasScores,
      avg_score:    avgScore,
      current_score: currentScore,
      score_7d_ago:  oldestScore,
      score_change:  currentScore - oldestScore,
      days_bullish:  daysBullish,
      days_bearish:  daysBearish,
      days_neutral:  daysNeutral,
    },
    alerts_summary: {
      total:   alerts.length,
      by_type: byType,
    },
    top_moves: topMoveRows.map(m => {
      const entity      = m.from_address ? topMoveEntityMap.get(m.from_address) ?? null : null;
      const entity_name = entity?.canonical_name ?? entity?.label ?? null;
      return {
        flow_type:   m.flow_type,
        token:       m.token,
        amount_usd:  m.amount_usd ?? 0,
        exchange:    m.exchange,
        protocol:    m.protocol,
        block_time:  m.block_time,
        entity_name,
      };
    }),
  };

  const publish_text = buildPublishText(reportData);
  const report: WeeklyReport = { ...reportData, publish_text };

  // ── 10. Persist as weekly_report alert ────────────────────────
  const title = `Weekly Report: ${report.week} — ${report.exchange_recap.direction}, avg bias ${avgScore >= 0 ? '+' : ''}${avgScore}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: insertErr } = await db.from('alerts').insert({
    alert_type:            'weekly_report' as AlertType,
    severity:              'info',
    title,
    body:                  publish_text,
    data:                  report as unknown as Record<string, unknown>,
    sent_telegram_free:    false,
    sent_telegram_premium: false,
  } as any);

  if (insertErr) {
    console.error('[cron/weekly-report] Insert failed', insertErr.message);
    return NextResponse.json({ ok: false, error: insertErr.message }, { status: 500 });
  }

  const duration_ms = Date.now() - startMs;
  console.log(`[cron/weekly-report] Done in ${duration_ms}ms — ${report.week}`);

  return NextResponse.json({
    ok:          true,
    week:        report.week,
    period:      `${report.period_start} → ${report.period_end}`,
    snapshots_used: snapshots.length,
    alerts_found:   alerts.length,
    duration_ms,
  });
}

// Support GET for Vercel Cron
export const GET = POST;
