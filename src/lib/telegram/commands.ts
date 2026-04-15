// ============================================================
// SONAR v2.0 — Telegram Command Handlers
// ============================================================
// Commands:
//   /start    — welcome + brief
//   /flow     — 24h flow summary + bias score
//   /exchanges — exchange net flow last 24h
//   /staking  — staking net flow last 24h
//   /whale <addr> — whale balance + recent moves
//   /report   — latest weekly report
//   /predict  — SOL directional prediction (Bayesian)
//   /tokens   — top tokens by whale volume (24h)
//   /signals  — smart money copy signals (latest buys)
//   /pro      — info on Pro tier

import { createAdminClient } from '@/lib/supabase/server';
import type { FlowSnapshotRow, MovementRow, WhaleRow, TokenMovementRow } from '@/lib/supabase/types';
import { formatUsd, truncateAddress, formatRelativeTime } from '@/lib/utils/format';
import { EXTERNAL_URLS } from '@/lib/utils/constants';

// ── HTML helpers ──────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bold(s: string): string {
  return `<b>${esc(s)}</b>`;
}

function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

function biasEmoji(bias: string | null): string {
  if (bias === 'bullish') return '🟢';
  if (bias === 'bearish') return '🔴';
  return '⚪';
}

function biasBar(score: number): string {
  // -100 to +100 → 0-20 filled blocks
  const filled = Math.round(((score + 100) / 200) * 20);
  const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  return bar;
}

// ── /start ────────────────────────────────────────────────────

export function handleStart(): string {
  return [
    `📡 ${bold('Welcome to SONAR')}`,
    '',
    'Smart Money Flow Intelligence for Solana.',
    'I track where large capital moves — accumulation, distribution, staking shifts, DeFi rotation.',
    '',
    bold('Flow commands:'),
    '/flow — 24h smart money flow summary',
    '/exchanges — exchange in/out flow',
    '/staking — staking flow (Marinade, Jito)',
    '/report — latest weekly smart money report',
    '',
    bold('Intelligence commands:'),
    '/predict — SOL directional prediction',
    '/tokens — top tokens by whale volume (24h)',
    '/signals — smart money copy signals',
    '/whale &lt;address&gt; — whale wallet lookup',
    '',
    '/pro — unlock real-time alerts',
    '',
    '📡 SONAR by NEXUS Finance',
  ].join('\n');
}

// ── /flow ─────────────────────────────────────────────────────

export async function handleFlow(): Promise<string> {
  const db = createAdminClient();

  const { data: snapshotRaw, error } = await db
    .from('flow_snapshots')
    .select('*')
    .eq('window_hours', 24)
    .order('snapshot_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return `❌ DB error: ${esc(error.message)}`;
  const snapshot = snapshotRaw as FlowSnapshotRow | null;
  if (!snapshot) {
    return '📭 No flow data yet. The engine runs every 5 minutes.';
  }

  const bias  = snapshot.market_bias ?? 'neutral';
  const score = snapshot.bias_score  ?? 0;
  const emoji = biasEmoji(bias);
  const bar   = biasBar(score);

  const exchangeSign = snapshot.sol_net_exchange_flow_usd < 0 ? '↓ accumulation' : '↑ to exchanges';
  const stakingSign  = snapshot.net_staking_flow_usd > 0 ? '↑ net staked' : '↓ net unstaked';

  return [
    `📡 ${bold('SONAR — 24h Smart Money Flow')}`,
    '',
    `${emoji} ${bold('Bias:')} ${bias.toUpperCase()} (${score > 0 ? '+' : ''}${score})`,
    `${bar}`,
    '',
    bold('Exchange Flow:'),
    `  In:  ${formatUsd(snapshot.sol_exchange_inflow_usd)}`,
    `  Out: ${formatUsd(snapshot.sol_exchange_outflow_usd)}`,
    `  Net: ${formatUsd(Math.abs(snapshot.sol_net_exchange_flow_usd))} ${exchangeSign}`,
    '',
    bold('Staking:'),
    `  Net: ${formatUsd(Math.abs(snapshot.net_staking_flow_usd))} ${stakingSign}`,
    '',
    bold('DeFi:'),
    `  Net: ${formatUsd(Math.abs(snapshot.net_defi_flow_usd))} ${snapshot.net_defi_flow_usd >= 0 ? '↑ deposits' : '↓ withdrawals'}`,
    '',
    `Large movements: ${snapshot.large_movements_count}`,
    `Active whales: ${snapshot.unique_whales_active}`,
  ].join('\n');
}

// ── /exchanges ────────────────────────────────────────────────

export async function handleExchanges(): Promise<string> {
  const db = createAdminClient();

  // Last 5 exchange movements
  const { data: movementsRaw, error } = await db
    .from('movements')
    .select('*')
    .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
    .order('block_time', { ascending: false })
    .limit(8);

  if (error) return `❌ DB error: ${esc(error.message)}`;
  const movements = movementsRaw as MovementRow[] | null;
  if (!movements || movements.length === 0) {
    return '📭 No exchange movements recorded yet.';
  }

  const lines = movements.map((m) => {
    const dir   = m.flow_type === 'exchange_withdrawal' ? '🟢 OUT' : '🔴 IN';
    const label = m.exchange ? esc(m.exchange.toUpperCase()) : 'Exchange';
    const amt   = m.amount_usd ? formatUsd(m.amount_usd) : `${m.amount_token} ${m.token}`;
    const age   = formatRelativeTime(m.block_time);
    return `${dir} ${bold(amt)} → ${label} (${age})`;
  });

  return [`🏦 ${bold('Recent Exchange Flows')}`, '', ...lines].join('\n');
}

// ── /staking ─────────────────────────────────────────────────

export async function handleStaking(): Promise<string> {
  const db = createAdminClient();

  const { data: snapshotRaw2 } = await db
    .from('flow_snapshots')
    .select('sol_staked_usd, sol_unstaked_usd, net_staking_flow_usd, snapshot_time')
    .eq('window_hours', 24)
    .order('snapshot_time', { ascending: false })
    .limit(1)
    .maybeSingle();
  const snapshot = snapshotRaw2 as Pick<FlowSnapshotRow, 'sol_staked_usd' | 'sol_unstaked_usd' | 'net_staking_flow_usd' | 'snapshot_time'> | null;

  const { data: recentRaw } = await db
    .from('movements')
    .select('*')
    .in('flow_type', ['stake', 'unstake'])
    .order('block_time', { ascending: false })
    .limit(5);
  const recent = recentRaw as MovementRow[] | null;

  const summaryLines = snapshot
    ? [
        `⚡ ${bold('24h Staking Flow')}`,
        `  Staked:   ${formatUsd(snapshot.sol_staked_usd)}`,
        `  Unstaked: ${formatUsd(snapshot.sol_unstaked_usd)}`,
        `  Net:      ${formatUsd(Math.abs(snapshot.net_staking_flow_usd))} ${snapshot.net_staking_flow_usd >= 0 ? '(net staked 🔒)' : '(net unstaked ⚡)'}`,
      ]
    : ['⚡ Staking data not yet available.'];

  const recentLines =
    recent && recent.length > 0
      ? [
          '',
          bold('Recent:'),
          ...recent.map((m) => {
            const dir   = m.flow_type === 'stake' ? '🔒' : '⚡';
            const proto = m.protocol ? ` (${esc(m.protocol)})` : '';
            const amt   = m.amount_usd ? formatUsd(m.amount_usd) : `${m.amount_token} SOL`;
            const age   = formatRelativeTime(m.block_time);
            return `${dir} ${bold(amt)}${proto} — ${age}`;
          }),
        ]
      : [];

  return [...summaryLines, ...recentLines].join('\n');
}

// ── /whale <address> ──────────────────────────────────────────

export async function handleWhale(address: string): Promise<string> {
  if (!address) {
    return '⚠️ Usage: /whale &lt;wallet address&gt;';
  }

  const db = createAdminClient();

  const { data: whaleRaw, error } = await db
    .from('whales')
    .select('*')
    .eq('address', address.trim())
    .maybeSingle();

  if (error) return `❌ DB error: ${esc(error.message)}`;
  const whale = whaleRaw as WhaleRow | null;
  if (!whale) return `❓ Whale not found: ${code(truncateAddress(address))}`;

  const solVal  = whale.sol_balance   != null ? `${Number(whale.sol_balance).toFixed(2)} SOL` : 'N/A';
  const usdcVal = whale.usdc_balance  != null ? formatUsd(Number(whale.usdc_balance)) : 'N/A';
  const total   = whale.total_value_usd != null ? formatUsd(Number(whale.total_value_usd)) : 'N/A';
  const solscan = EXTERNAL_URLS.solscan(whale.address);

  return [
    `🐋 ${bold('Whale:')} ${code(truncateAddress(whale.address))}`,
    whale.label ? `🏷️ Label: ${esc(whale.label)}` : null,
    whale.whale_type ? `📂 Type: ${esc(whale.whale_type)}` : null,
    '',
    `💰 ${bold('Balance:')} ${total}`,
    `  SOL:  ${solVal}`,
    `  USDC: ${usdcVal}`,
    whale.staked_msol   ? `  mSOL: ${Number(whale.staked_msol).toFixed(2)}` : null,
    whale.staked_jitosol ? `  jitoSOL: ${Number(whale.staked_jitosol).toFixed(2)}` : null,
    '',
    `🔗 <a href="${solscan}">View on Solscan</a>`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
}

// ── /report ───────────────────────────────────────────────────

export async function handleReport(): Promise<string> {
  const db = createAdminClient();

  const { data: reportRaw, error } = await db
    .from('alerts')
    .select('title, body, created_at')
    .eq('alert_type', 'weekly_report')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return `❌ DB error: ${esc(error.message)}`;
  const report = reportRaw as Pick<import('@/lib/supabase/types').AlertRow, 'title' | 'body' | 'created_at'> | null;
  if (!report) {
    return '📭 No weekly report yet. The first one publishes next Saturday.';
  }

  const age = formatRelativeTime(report.created_at);
  return [
    `📊 ${bold('SONAR Weekly Report')} (${age})`,
    '',
    esc(report.body),
  ].join('\n');
}

// ── /predict ─────────────────────────────────────────────────

export async function handlePredict(): Promise<string> {
  const db = createAdminClient();

  const { data: snapshotRaw } = await db
    .from('flow_snapshots')
    .select('market_bias, bias_score, sol_net_exchange_flow_usd, net_staking_flow_usd, net_defi_flow_usd, unique_whales_active, snapshot_time')
    .eq('window_hours', 24)
    .order('snapshot_time', { ascending: false })
    .limit(1)
    .maybeSingle();

  const s = snapshotRaw as Pick<FlowSnapshotRow,
    'market_bias' | 'bias_score' | 'sol_net_exchange_flow_usd' | 'net_staking_flow_usd' |
    'net_defi_flow_usd' | 'unique_whales_active' | 'snapshot_time'
  > | null;

  if (!s) return '📭 No prediction data yet. Engine runs every 5 minutes.';

  const bias      = s.market_bias ?? 'neutral';
  const score     = s.bias_score ?? 0;
  const emoji     = bias === 'bullish' ? '🟢' : bias === 'bearish' ? '🔴' : '⚪';

  // Bayesian probability estimate from bias score
  const prob      = Math.round(50 + Math.min(40, Math.abs(score) / 2.5));
  const direction = bias === 'neutral' ? '→ NEUTRAL' : bias === 'bullish' ? '↑ BULLISH' : '↓ BEARISH';

  // Signal breakdown
  const exchSignal   = s.sol_net_exchange_flow_usd < -10_000 ? '🟢 accumulation'
                     : s.sol_net_exchange_flow_usd >  10_000 ? '🔴 distribution'
                     : '⚪ neutral';
  const stakeSignal  = s.net_staking_flow_usd > 5_000 ? '🟢 staking ↑' : s.net_staking_flow_usd < -5_000 ? '🔴 unstaking ↑' : '⚪ flat';
  const defiSignal   = s.net_defi_flow_usd > 5_000   ? '🟢 DeFi in'   : s.net_defi_flow_usd < -5_000   ? '🔴 DeFi out'   : '⚪ flat';
  const smSignal     = score > 20 ? '🟢 buying' : score < -20 ? '🔴 selling' : '⚪ mixed';

  return [
    `🧠 ${bold('SONAR — SOL Prediction')}`,
    '',
    `${emoji} ${bold(direction)} — ${prob}% probability`,
    `Bias score: ${score > 0 ? '+' : ''}${score} / 100`,
    '',
    bold('Signal breakdown:'),
    `  Exchange:    ${exchSignal}`,
    `  Staking:     ${stakeSignal}`,
    `  DeFi:        ${defiSignal}`,
    `  Smart money: ${smSignal}`,
    '',
    `Whales active: ${s.unique_whales_active ?? 0}`,
    `Updated: ${formatRelativeTime(s.snapshot_time)}`,
    '',
    '⚠️ Not financial advice. Track record at /report.',
  ].join('\n');
}

// ── /tokens ──────────────────────────────────────────────────

export async function handleTokens(): Promise<string> {
  const db    = createAdminClient();
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const { data: movRaw } = await (db as any)
    .from('token_movements')
    .select('token_mint, token_symbol, action, amount_usd, whale_id')
    .gte('block_time', since)
    .in('action', ['buy', 'sell'])
    .not('whale_id', 'is', null);

  const movements = (movRaw ?? []) as Pick<
    TokenMovementRow, 'token_mint' | 'token_symbol' | 'action' | 'amount_usd' | 'whale_id'
  >[];

  if (movements.length === 0) {
    return '📭 No token movements in last 24h yet.';
  }

  // Aggregate by token
  const tokenMap = new Map<string, { symbol: string | null; buys: number; sells: number; vol: number; whales: Set<string> }>();
  for (const m of movements) {
    if (!tokenMap.has(m.token_mint)) {
      tokenMap.set(m.token_mint, { symbol: m.token_symbol, buys: 0, sells: 0, vol: 0, whales: new Set() });
    }
    const t = tokenMap.get(m.token_mint)!;
    if (m.action === 'buy')  t.buys++;
    if (m.action === 'sell') t.sells++;
    t.vol += m.amount_usd ?? 0;
    if (m.whale_id) t.whales.add(m.whale_id);
  }

  const top = [...tokenMap.entries()]
    .map(([mint, d]) => ({ mint, ...d }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 7);

  const fmtVol = (v: number) =>
    v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000   ? `$${(v / 1_000).toFixed(0)}K`
    : `$${v.toFixed(0)}`;

  const lines = top.map((t, i) => {
    const sym    = t.symbol ?? `${t.mint.slice(0, 8)}…`;
    const bias   = t.buys > t.sells ? '🟢' : t.sells > t.buys ? '🔴' : '⚪';
    const bsLabel = `${t.buys}B/${t.sells}S`;
    return `${i + 1}. ${bold(sym)} ${bias} — ${fmtVol(t.vol)} (${bsLabel}, ${t.whales.size}🐋)`;
  });

  return [
    `🎯 ${bold('Top Tokens — Whale Activity 24h')}`,
    '',
    ...lines,
    '',
    `${tokenMap.size} tokens tracked · ${movements.length} events`,
  ].join('\n');
}

// ── /signals ─────────────────────────────────────────────────

export async function handleSignals(): Promise<string> {
  const db    = createAdminClient();
  const since = new Date(Date.now() - 4 * 3_600_000).toISOString();

  // Get smart money whales
  const { data: smRaw } = await db
    .from('whales')
    .select('id, label, address, reputation_score')
    .eq('smart_money_flag', true)
    .eq('is_active', true);

  type SM = Pick<WhaleRow, 'id' | 'label' | 'address' | 'reputation_score'>;
  const smWhales  = (smRaw ?? []) as SM[];
  const smMap     = new Map(smWhales.map(w => [w.id, w]));
  const smIds     = smWhales.map(w => w.id);

  if (smIds.length === 0) return '📭 No smart money whales tracked yet.';

  const { data: movRaw } = await (db as any)
    .from('token_movements')
    .select('whale_id, token_symbol, token_mint, amount_usd, protocol, block_time')
    .gte('block_time', since)
    .in('whale_id', smIds)
    .eq('action', 'buy')
    .order('amount_usd', { ascending: false })
    .limit(50);

  const movements = (movRaw ?? []) as Pick<
    TokenMovementRow, 'whale_id' | 'token_symbol' | 'token_mint' | 'amount_usd' | 'protocol' | 'block_time'
  >[];

  if (movements.length === 0) return '📭 No smart money buys in last 4h.';

  // Deduplicate: one line per whale+token
  const seen = new Set<string>();
  const top  = movements.filter(m => {
    const k = `${m.whale_id}:${m.token_mint}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);

  const fmtAmt = (v: number | null) =>
    !v ? '—'
    : v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M`
    : v >= 1_000     ? `$${(v / 1_000).toFixed(0)}K`
    : `$${v.toFixed(0)}`;

  const lines = top.map(m => {
    const whale = m.whale_id ? smMap.get(m.whale_id) : null;
    const name  = whale?.label ?? (whale?.address ? `${whale.address.slice(0, 6)}…` : '?');
    const rep   = whale?.reputation_score ? Math.round((whale.reputation_score) * 100) : '—';
    const sym   = m.token_symbol ?? `${m.token_mint.slice(0, 8)}…`;
    const age   = formatRelativeTime(m.block_time);
    return `🧠 ${bold(name)} → ${esc(sym)}\n   ${fmtAmt(m.amount_usd)} · rep ${rep}/100 · ${age}`;
  });

  return [
    `🧠 ${bold('Smart Money Signals — 4h')}`,
    '',
    ...lines,
    '',
    `${smWhales.length} smart whales tracked`,
  ].join('\n');
}

// ── /pro ─────────────────────────────────────────────────────

export function handlePro(): string {
  return [
    `💎 ${bold('SONAR Pro — €19/month')}`,
    '',
    'What you get:',
    '• Real-time alerts (no 15min delay)',
    '• Individual whale movements &gt;$100K',
    '• Full DeFi rotation breakdown',
    '• Weekly AI analysis report',
    '• 90 days of historical flow data',
    '',
    'Coming soon — join the waitlist.',
  ].join('\n');
}
