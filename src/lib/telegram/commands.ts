// ============================================================
// SONAR — Telegram Command Handlers
// ============================================================
// Each handler queries the DB and returns a formatted HTML string.
// Call sendToChat(chatId, await handle*(chatId)) from the webhook route.
//
// Commands:
//   /start          — welcome message
//   /consensus      — latest 5 consensus alerts
//   /whale <addr>   — whale stats summary
//   /safety <addr>  — token safety report
//   /top            — top whales by win rate

import { createAdminClient } from '@/lib/supabase/server';
import { formatAlertRow } from './formatter';
import { formatUsd, formatPercent, truncateAddress, formatHours } from '@/lib/utils/format';
import { SAFETY_EMOJI } from '@/lib/utils/constants';

// ── HTML helpers (local, same as formatter) ───────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bold(s: string): string {
  return `<b>${esc(s)}</b>`;
}

function code(s: string): string {
  return `<code>${esc(s)}</code>`;
}

// ── /start ────────────────────────────────────────────────────

export function handleStart(): string {
  return [
    `🦈 ${bold('Welcome to SONAR')}`,
    '',
    'Smart Money Consensus tracker for Solana tokens.',
    'I alert you when 2+ top whale wallets buy the same token within 4 hours.',
    '',
    bold('Commands:'),
    '/consensus — latest 5 consensus alerts',
    '/top — top whales by win rate',
    '/whale &lt;address&gt; — whale wallet stats',
    '/safety &lt;token&gt; — token safety report',
  ].join('\n');
}

// ── /consensus ────────────────────────────────────────────────

export async function handleConsensus(): Promise<string> {
  const db = createAdminClient();

  const { data: alerts, error } = await db
    .from('alerts')
    .select('*')
    .eq('type', 'consensus')
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    return `❌ Failed to load alerts: ${esc(error.message)}`;
  }

  if (!alerts || alerts.length === 0) {
    return '📭 No consensus alerts yet. The engine runs every 2 minutes.';
  }

  const header = `${bold('Latest consensus alerts')} (${alerts.length}):`;
  const bodies = alerts.map((a, i) => `${i + 1}. ${formatAlertRow(a)}`);

  return [header, '', ...bodies].join('\n\n');
}

// ── /whale <address> ──────────────────────────────────────────

export async function handleWhale(address: string): Promise<string> {
  if (!address) {
    return '⚠️ Usage: /whale &lt;wallet address&gt;';
  }

  const db = createAdminClient();

  const { data: whale, error } = await db
    .from('whales')
    .select('*')
    .eq('address', address)
    .maybeSingle();

  if (error) return `❌ DB error: ${esc(error.message)}`;
  if (!whale) return `❓ Whale not found: ${code(truncateAddress(address))}`;

  const winRate7d  = whale.win_rate_7d  != null ? formatPercent(whale.win_rate_7d)  : 'N/A';
  const winRate30d = whale.win_rate_30d != null ? formatPercent(whale.win_rate_30d) : 'N/A';
  const pnl7d      = whale.pnl_7d  != null ? formatUsd(whale.pnl_7d)  : 'N/A';
  const pnl30d     = whale.pnl_30d != null ? formatUsd(whale.pnl_30d) : 'N/A';

  const labelLine = whale.label ? `${bold('Label:')} ${esc(whale.label)}` : null;

  const avgHold = whale.avg_hold_time_hours != null
    ? `⏱️ Avg hold: ${formatHours(whale.avg_hold_time_hours)}`
    : null;

  const lines = [
    `🐋 ${bold('Whale:')} ${code(truncateAddress(whale.address))}`,
    labelLine,
    '',
    `📊 ${bold('7d:')} WR ${winRate7d} | PnL ${pnl7d} | Trades ${whale.total_trades_7d}`,
    `📊 ${bold('30d:')} WR ${winRate30d} | PnL ${pnl30d} | Trades ${whale.total_trades_30d}`,
    avgHold,
    whale.preferred_sector ? `🏷️ Sector: ${esc(whale.preferred_sector)}` : null,
    `✅ Active: ${whale.is_active ? 'Yes' : 'No'}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return lines;
}

// ── /safety <token address> ───────────────────────────────────

export async function handleSafety(tokenAddress: string): Promise<string> {
  if (!tokenAddress) {
    return '⚠️ Usage: /safety &lt;token address&gt;';
  }

  const db = createAdminClient();

  const { data: safety, error } = await db
    .from('token_safety')
    .select('*')
    .eq('token_address', tokenAddress)
    .maybeSingle();

  if (error) return `❌ DB error: ${esc(error.message)}`;

  if (!safety) {
    return [
      `🔍 No cached safety data for ${code(truncateAddress(tokenAddress))}.`,
      'Run the consensus engine first or check back after the next cron cycle.',
    ].join('\n');
  }

  const safetyEmoji = SAFETY_EMOJI[safety.safety_level];

  const mintLine = safety.mint_authority_revoked != null
    ? `🔐 Mint authority: ${safety.mint_authority_revoked ? 'Revoked ✅' : 'Active ⚠️'}`
    : null;

  const holdersLine = safety.holder_count != null
    ? `👥 Holders: ${safety.holder_count.toLocaleString()}`
    : null;

  const top10Line = safety.top10_holder_pct != null
    ? `🏆 Top 10 holders: ${formatPercent(safety.top10_holder_pct)}`
    : null;

  const ageLine = safety.token_age_hours != null
    ? `⏱️ Token age: ${formatHours(safety.token_age_hours)}`
    : null;

  const checkedLine = `🕐 Checked: ${formatRelativeTimestamp(safety.checked_at)}`;

  const lines = [
    `🛡️ ${bold('Safety Report')} — ${code(truncateAddress(tokenAddress))}`,
    '',
    `Score: ${bold(String(safety.safety_score))}/100 ${safetyEmoji} (${esc(safety.safety_level)})`,
    mintLine,
    holdersLine,
    top10Line,
    ageLine,
    checkedLine,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return lines;
}

// ── /top ─────────────────────────────────────────────────────

export async function handleTop(): Promise<string> {
  const db = createAdminClient();

  const { data: whales, error } = await db
    .from('whales')
    .select('address, label, win_rate_7d, pnl_7d, total_trades_7d')
    .eq('is_active', true)
    .not('win_rate_7d', 'is', null)
    .order('win_rate_7d', { ascending: false })
    .limit(10);

  if (error) return `❌ DB error: ${esc(error.message)}`;
  if (!whales || whales.length === 0) {
    return '📭 No whale stats available yet.';
  }

  const header = `🏆 ${bold('Top whales by 7d win rate:')}`;
  const rows = whales.map((w, i) => {
    const label   = w.label ? ` (${esc(w.label)})` : '';
    const winRate = w.win_rate_7d != null ? formatPercent(w.win_rate_7d) : 'N/A';
    const pnl     = w.pnl_7d     != null ? formatUsd(w.pnl_7d)          : 'N/A';
    return `${i + 1}. ${code(truncateAddress(w.address))}${label}\n   WR ${winRate} | PnL ${pnl} | ${w.total_trades_7d} trades`;
  });

  return [header, '', ...rows].join('\n');
}

// ── helpers ───────────────────────────────────────────────────

function formatRelativeTimestamp(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
