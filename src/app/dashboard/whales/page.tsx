// ============================================================
// Whale Tracker — with CohortCard + type badges
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { CohortCard } from '@/components/CohortCard';
import {
  classifyWhaleCohort,
  summariseCohorts,
  type WhaleMovementSummary,
} from '@/lib/flow-engine/cohort-analysis';
import type { WhaleRow, MovementRow } from '@/lib/supabase/types';

function fmtUsd(v: number | null) {
  if (!v) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-4)}`;
}

const COHORT_META: Record<string, { label: string; color: string; bg: string }> = {
  accumulator: { label: 'Accum',  color: '#00e599', bg: '#00e59918' },
  distributor: { label: 'Dist',   color: '#ff4757', bg: '#ff475718' },
  staker:      { label: 'Staker', color: '#7b68ee', bg: '#7b68ee18' },
  defi_user:   { label: 'DeFi',   color: '#ffd60a', bg: '#ffd60a18' },
  opportunist: { label: 'Opp',    color: '#9b9bb0', bg: '#9b9bb018' },
  dormant:     { label: 'Dormant',color: '#4b4b60', bg: '#1e1e2e'   },
  unknown:     { label: '—',      color: '#4b4b60', bg: '#1e1e2e'   },
};

const METHOD_LABELS: Record<string, string> = {
  manual:              'Manual',
  exchange_withdrawal: 'Ex. Withdrawal',
  gmgn_feed:           'GMGN Feed',
  balance_scan:        'Balance Scan',
};

async function getData() {
  const db    = createAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [whalesRes, movsRes] = await Promise.all([
    db.from('whales')
      .select('id, address, label, sol_balance, usdc_balance, total_value_usd, whale_type, discovery_method, balance_updated_at, is_active')
      .order('total_value_usd', { ascending: false, nullsFirst: false })
      .limit(200),

    db.from('movements')
      .select('whale_id, flow_type, flow_direction, amount_usd, block_time')
      .gte('block_time', since)
      .not('whale_id', 'is', null),
  ]);

  const whales = (whalesRes.data ?? []) as Pick<
    WhaleRow,
    'id' | 'address' | 'label' | 'sol_balance' | 'usdc_balance' | 'total_value_usd' |
    'whale_type' | 'discovery_method' | 'balance_updated_at' | 'is_active'
  >[];

  const rawMovs = (movsRes.data ?? []) as Pick<MovementRow, 'whale_id' | 'flow_type' | 'flow_direction' | 'amount_usd' | 'block_time'>[];

  // Last movement per whale (any time)
  const lastMov = new Map<string, { flow_type: string; block_time: string }>();
  for (const m of rawMovs) {
    if (m.whale_id && !lastMov.has(m.whale_id)) {
      lastMov.set(m.whale_id, { flow_type: m.flow_type, block_time: m.block_time });
    }
  }

  // Cohort classification from 24h movements
  const aggMap = new Map<string, WhaleMovementSummary>();
  for (const w of whales) {
    aggMap.set(w.id, {
      whale_address:        w.address,
      label:                w.label,
      total_value_usd:      w.total_value_usd,
      net_exchange_usd:     0,
      net_staking_usd:      0,
      net_defi_usd:         0,
      net_stablecoin_usd:   0,
      movement_count:       0,
      window_hours:         24,
      exchange_consistency: 1,
    });
  }

  const exchDirs = new Map<string, number[]>();
  for (const m of rawMovs) {
    const id  = m.whale_id!;
    const agg = aggMap.get(id);
    if (!agg) continue;
    const usd = m.amount_usd ?? 0;
    agg.movement_count += 1;
    if (m.flow_type === 'exchange_withdrawal') {
      agg.net_exchange_usd += usd;
      if (!exchDirs.has(id)) exchDirs.set(id, []);
      exchDirs.get(id)!.push(1);
    } else if (m.flow_type === 'exchange_deposit') {
      agg.net_exchange_usd -= usd;
      if (!exchDirs.has(id)) exchDirs.set(id, []);
      exchDirs.get(id)!.push(-1);
    } else if (m.flow_type === 'stake') {
      agg.net_staking_usd += usd;
    } else if (m.flow_type === 'unstake') {
      agg.net_staking_usd -= usd;
    } else if (m.flow_type === 'defi_deposit') {
      agg.net_defi_usd += usd;
    } else if (m.flow_type === 'defi_withdrawal') {
      agg.net_defi_usd -= usd;
    }
  }
  for (const [id, dirs] of exchDirs.entries()) {
    const agg = aggMap.get(id);
    if (!agg || dirs.length < 2) continue;
    const pos = dirs.filter(d => d > 0).length;
    agg.exchange_consistency = Math.max(pos, dirs.length - pos) / dirs.length;
  }

  // Build id → cohort map
  const cohortById = new Map<string, string>();
  const summaries  = Array.from(aggMap.entries());
  const results    = summaries.map(([id, s]) => {
    const r = classifyWhaleCohort(s);
    cohortById.set(id, r.cohort);
    return r;
  });

  const groups  = summariseCohorts(results);
  const active  = results.filter(r => r.cohort !== 'dormant').sort((a, b) => b.cohort_score - a.cohort_score);
  const dormant = results.filter(r => r.cohort === 'dormant').length;

  return { whales, lastMov, cohortById, groups, active, dormant };
}

export default async function WhalesPage() {
  const { whales, lastMov, cohortById, groups, active, dormant } = await getData();
  const activeWhales   = whales.filter(w => w.is_active);
  const inactiveWhales = whales.filter(w => !w.is_active);

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
          Whale Tracker
        </h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
          {activeWhales.length} active whale{activeWhales.length !== 1 ? 's' : ''} · {whales.length} total
        </p>
      </div>

      {/* Cohort overview */}
      {groups.length > 0 && (
        <div
          className="rounded-xl border p-5"
          style={{ background: '#12121a', borderColor: '#1e1e2e', maxWidth: 480 }}
        >
          <p className="text-xs uppercase tracking-widest mb-4" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            Cohort Distribution · 24h
          </p>
          <CohortCard
            groups={groups}
            whales={active}
            dormant={dormant}
            total={whales.length}
            hours={24}
            showWhales={false}
          />
        </div>
      )}

      {/* Whale table */}
      {whales.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
          <p className="text-base font-semibold">No whales tracked yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>Run the discover-whales cron or seed known addresses.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Header row */}
          <div
            className="grid gap-3 px-4 py-2 text-xs uppercase tracking-widest"
            style={{ gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr', color: '#4b4b60', fontFamily: 'var(--font-mono)' }}
          >
            <span>Address</span>
            <span className="text-right">SOL</span>
            <span className="text-right">USDC</span>
            <span className="text-right">Total</span>
            <span>Cohort</span>
            <span>Discovery</span>
            <span>Last Move</span>
          </div>

          {whales.map(w => {
            const mov    = lastMov.get(w.id);
            const cohort = cohortById.get(w.id) ?? w.whale_type ?? 'unknown';
            const cm     = COHORT_META[cohort] ?? COHORT_META.unknown;
            return (
              <div
                key={w.id}
                className="grid gap-3 px-4 py-3 rounded-lg border items-center text-sm"
                style={{
                  gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr',
                  background:   '#12121a',
                  borderColor:  w.is_active ? '#1e1e2e' : '#15151f',
                  opacity:      w.is_active ? 1 : 0.45,
                }}
              >
                {/* Address */}
                <div className="flex flex-col gap-0.5 min-w-0">
                  <a
                    href={`https://solscan.io/account/${w.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:opacity-70 transition-opacity truncate"
                    style={{ color: '#00b8ff', fontFamily: 'var(--font-mono)', fontSize: '0.78rem' }}
                  >
                    {shortAddr(w.address)}
                  </a>
                  {w.label && (
                    <span className="text-xs truncate" style={{ color: '#6b6b80' }}>{w.label}</span>
                  )}
                </div>

                {/* SOL */}
                <span className="text-right" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef', fontSize: '0.82rem' }}>
                  {w.sol_balance ? w.sol_balance.toFixed(0) : '—'}
                </span>

                {/* USDC */}
                <span className="text-right" style={{ fontFamily: 'var(--font-mono)', color: '#e8e8ef', fontSize: '0.82rem' }}>
                  {fmtUsd(w.usdc_balance)}
                </span>

                {/* Total */}
                <span
                  className="text-right font-semibold"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: '0.82rem', color: w.is_active ? '#00e599' : '#6b6b80' }}
                >
                  {fmtUsd(w.total_value_usd)}
                </span>

                {/* Cohort badge */}
                <span style={{
                  display:      'inline-block',
                  fontSize:     10,
                  padding:      '2px 7px',
                  borderRadius: 4,
                  color:        cm.color,
                  background:   cm.bg,
                  whiteSpace:   'nowrap',
                }}>
                  {cm.label}
                </span>

                {/* Discovery */}
                <span className="text-xs" style={{ color: '#6b6b80' }}>
                  {METHOD_LABELS[w.discovery_method ?? ''] ?? w.discovery_method ?? '—'}
                </span>

                {/* Last move */}
                <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                  {mov ? new Date(mov.block_time).toLocaleDateString() : '—'}
                </span>
              </div>
            );
          })}

          {inactiveWhales.length > 0 && (
            <p className="text-xs mt-2" style={{ color: '#4b4b60' }}>
              {inactiveWhales.length} inactive wallet{inactiveWhales.length !== 1 ? 's' : ''} shown at reduced opacity.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
