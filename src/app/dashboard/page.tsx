// ============================================================
// Dashboard Overview — Bias Index™ + WWWD + movements
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { BiasGauge } from '@/components/BiasGauge';
import { BiasChart } from '@/components/BiasChart';
import { WWWDWidget } from '@/components/WWWDWidget';
import { ProGate } from '@/components/ProGate';
import { SummaryCard } from '@/components/SummaryCard';
import { MovementRow } from '@/components/MovementRow';
import type { FlowSnapshotRow, MovementRow as MovRow, BiasIndexHistoryRow } from '@/lib/supabase/types';

function fmtUsd(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function sign(v: number) { return v > 0 ? '+' : ''; }

// ── Inline WWWD derivation (avoids extra HTTP hop) ────────────

type WWWDSignal = 'accumulate' | 'distribute' | 'hold' | 'rotate_to_defi' | 'reduce_defi';
type ConfidenceTier = 'high' | 'medium' | 'low';

function deriveWWWD(
  score: number,
  components: Record<string, { score: number; interpretation: string }>,
  cohortDist: Record<string, number>,
): { signal: WWWDSignal; confidence: ConfidenceTier; headline: string; rationale: string[] } {
  const accCount  = cohortDist.accumulator ?? 0;
  const disCount  = cohortDist.distributor ?? 0;
  const defiCount = cohortDist.defi_user   ?? 0;
  const exchInterp  = components.exchange?.interpretation ?? '';
  const defiInterp  = components.defi?.interpretation     ?? '';
  const stakeInterp = components.staking?.interpretation  ?? '';
  const rationale: string[] = [];

  const confidence: ConfidenceTier =
    Math.abs(score) >= 40 ? 'high' : Math.abs(score) >= 20 ? 'medium' : 'low';

  let signal: WWWDSignal;
  let headline: string;

  if (score >= 40) {
    const totalActive = accCount + disCount + defiCount + (cohortDist.staker ?? 0) + (cohortDist.opportunist ?? 0);
    if (defiCount > 0 && defiCount / (totalActive || 1) > 0.35 && defiInterp.includes('risk-on')) {
      signal = 'rotate_to_defi';
      headline = 'Whales rotating into DeFi — risk-on mode';
      rationale.push(`${defiCount} whales adding capital to DeFi protocols`);
    } else {
      signal = 'accumulate';
      headline = 'Smart money accumulating — bullish bias confirmed';
      if (accCount > 0) rationale.push(`${accCount} accumulators vs ${disCount} distributors`);
    }
    rationale.push(`Exchange: ${exchInterp}`);
    if (stakeInterp !== 'flat') rationale.push(`Staking: ${stakeInterp}`);
    rationale.push(`Bias score ${score > 0 ? '+' : ''}${score}`);
  } else if (score <= -40) {
    if (defiInterp.includes('risk-off')) {
      signal = 'reduce_defi';
      headline = 'Whales de-risking — DeFi outflows detected';
      rationale.push(`DeFi signal: ${defiInterp}`);
    } else {
      signal = 'distribute';
      headline = 'Smart money distributing — bearish bias confirmed';
      if (disCount > 0) rationale.push(`${disCount} distributors vs ${accCount} accumulators`);
    }
    rationale.push(`Exchange: ${exchInterp}`);
    rationale.push(`Bias score ${score}`);
  } else {
    signal = 'hold';
    headline = 'Mixed signals — whales in wait-and-see mode';
    rationale.push(`Bias score ${score > 0 ? '+' : ''}${score} — neutral zone`);
    if (exchInterp !== 'balanced') rationale.push(`Exchange: ${exchInterp}`);
    rationale.push(`${accCount} acc / ${disCount} dist / ${defiCount} defi whales`);
  }

  return { signal, confidence: confidence || 'low', headline, rationale };
}

// ── Data fetching ─────────────────────────────────────────────

async function getData() {
  const db    = createAdminClient();
  const h24   = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [snapRes, biasLatestRes, biasHistRes, movRes, whaleTypesRes] = await Promise.all([
    db.from('flow_snapshots')
      .select('*')
      .eq('window_hours', 24)
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle(),

    db.from('bias_index_history')
      .select('score, bias, confidence, components, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    db.from('bias_index_history')
      .select('score, created_at')
      .gte('created_at', h24)
      .order('created_at', { ascending: true }),

    db.from('movements')
      .select('id, flow_type, flow_direction, from_label, to_label, from_address, to_address, exchange, protocol, amount_usd, token, block_time')
      .order('block_time', { ascending: false })
      .limit(20),

    db.from('whales')
      .select('whale_type')
      .eq('is_active', true)
      .not('whale_type', 'is', null),
  ]);

  const snap       = (snapRes.data as FlowSnapshotRow | null);
  const biasLatest = biasLatestRes.data as Pick<BiasIndexHistoryRow, 'score' | 'bias' | 'confidence' | 'components' | 'created_at'> | null;
  const biasHist   = (biasHistRes.data ?? []) as Pick<BiasIndexHistoryRow, 'score' | 'created_at'>[];
  const movements  = (movRes.data ?? []) as Pick<
    MovRow,
    'id' | 'flow_type' | 'flow_direction' | 'from_label' | 'to_label' |
    'from_address' | 'to_address' | 'exchange' | 'protocol' | 'amount_usd' | 'token' | 'block_time'
  >[];

  const cohortDist: Record<string, number> = {};
  for (const w of (whaleTypesRes.data ?? []) as any[]) {
    const t = (w.whale_type as string) ?? 'unknown';
    cohortDist[t] = (cohortDist[t] ?? 0) + 1;
  }

  return { snap, biasLatest, biasHist, movements, cohortDist };
}

// ── Page ──────────────────────────────────────────────────────

export default async function DashboardPage() {
  const { snap, biasLatest, biasHist, movements, cohortDist } = await getData();

  const netExchange = snap?.sol_net_exchange_flow_usd ?? 0;
  const netStaking  = snap?.net_staking_flow_usd      ?? 0;
  const netDefi     = snap?.net_defi_flow_usd         ?? 0;

  const biasScore      = biasLatest?.score      ?? null;
  const biasBias       = biasLatest?.bias        ?? null;
  const biasConfidence = biasLatest?.confidence  ?? null;
  const biasComponents = biasLatest?.components  ?? null;

  const wwwd = biasLatest
    ? deriveWWWD(biasScore ?? 0, biasComponents ?? {}, cohortDist)
    : null;

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">

      {/* ── Header ── */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            Flow Overview
          </h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            24-hour smart money activity · Solana
          </p>
        </div>
        {snap?.snapshot_time && (
          <p className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Last snapshot: {new Date(snap.snapshot_time).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* ── Hero: Bias Gauge + WWWD ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* Bias Gauge */}
        <div
          className="lg:col-span-2 flex flex-col p-6 rounded-xl border"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            SONAR Bias Index™
          </p>
          <BiasGauge
            score={biasScore}
            bias={biasBias}
            confidence={biasConfidence}
            components={biasComponents}
            size={200}
          />
          {!biasLatest && (
            <p className="text-xs text-center mt-4" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
              Populates on next cron run (every 5 min)
            </p>
          )}
        </div>

        {/* WWWD */}
        <div className="lg:col-span-3 flex flex-col justify-center">
          <ProGate featureName="What Would Whales Do?">
            {wwwd ? (
              <WWWDWidget
                signal={wwwd.signal}
                confidence={wwwd.confidence}
                score={biasScore ?? 0}
                bias={biasBias ?? 'neutral'}
                headline={wwwd.headline}
                rationale={wwwd.rationale}
                cohort_distribution={cohortDist}
                generated_at={biasLatest?.created_at}
              />
            ) : (
              <div
                className="rounded-xl border p-8 text-center"
                style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#4b4b60' }}
              >
                <p className="text-sm" style={{ color: '#6b6b80' }}>What Would Whales Do?</p>
                <p className="text-xs mt-2">Signal available once Bias Index data arrives.</p>
              </div>
            )}
          </ProGate>
        </div>

      </div>

      {/* ── Bias History Chart ── */}
      {biasHist.length >= 2 && (
        <div
          className="rounded-xl border p-5"
          style={{ background: '#12121a', borderColor: '#1e1e2e' }}
        >
          <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            Bias Index — 24h History
          </p>
          <BiasChart data={biasHist} height={120} />
        </div>
      )}

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        <SummaryCard
          title="Exchange Net Flow"
          value={snap ? `${sign(netExchange)}${fmtUsd(Math.abs(netExchange))}` : '—'}
          sub={netExchange < 0 ? 'Net outflow (accumulation)' : netExchange > 0 ? 'Net inflow (sell pressure)' : 'Balanced'}
          accent={netExchange < 0 ? 'green' : netExchange > 0 ? 'red' : 'muted'}
        />
        <SummaryCard
          title="Staking Net Flow"
          value={snap ? `${sign(netStaking)}${fmtUsd(Math.abs(netStaking))}` : '—'}
          sub={netStaking > 0 ? 'Net staking (bullish)' : 'Net unstaking'}
          accent={netStaking > 0 ? 'blue' : 'yellow'}
        />
        <SummaryCard
          title="DeFi Net Flow"
          value={snap ? `${sign(netDefi)}${fmtUsd(Math.abs(netDefi))}` : '—'}
          sub="Protocol deposits vs. withdrawals"
          accent="blue"
        />
        <SummaryCard
          title="Large Movements"
          value={snap ? String(snap.large_movements_count) : '—'}
          sub="Transactions > $50K"
          accent="yellow"
        />
        <SummaryCard
          title="Active Whales"
          value={snap ? String(snap.unique_whales_active) : '—'}
          sub="Unique wallets in window"
          accent="muted"
        />
        <SummaryCard
          title="Exchange Inflow"
          value={snap ? fmtUsd(snap.sol_exchange_inflow_usd) : '—'}
          sub={snap ? `Outflow: ${fmtUsd(snap.sol_exchange_outflow_usd)}` : ''}
          accent="muted"
        />
      </div>

      {/* ── Movement feed ── */}
      <div>
        <h2 className="text-base font-semibold mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
          Recent Movements
        </h2>

        {movements.length === 0 ? (
          <div
            className="rounded-xl border p-8 text-center"
            style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}
          >
            <p className="text-sm">No movements recorded yet.</p>
            <p className="text-xs mt-1" style={{ color: '#4b4b60' }}>
              Movements appear once Helius delivers webhook events.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {movements.map(m => (
              <MovementRow key={m.id} m={{
                ...m,
                from: m.from_address,
                to:   m.to_address,
              }} />
            ))}
          </div>
        )}
      </div>

    </div>
  );
}
