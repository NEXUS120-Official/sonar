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
//   /submit <addr>  — community wallet submission (discovery pipeline)

import { createAdminClient } from '@/lib/supabase/server';
import { formatAlertRow } from './formatter';
import { formatUsd, formatPercent, truncateAddress, formatHours } from '@/lib/utils/format';
import { SAFETY_EMOJI } from '@/lib/utils/constants';
import { scoreCandidate } from '@/lib/discovery/scoring';
import type { CandidateMetrics } from '@/lib/discovery/types';

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

// ── /submit <wallet_address> ──────────────────────────────────

interface SubmitContext {
  chatId:    string;
  username?: string;
  messageId: number;
}

export async function handleSubmit(
  address: string,
  ctx: SubmitContext,
): Promise<string> {
  if (!address) {
    return '⚠️ Usage: /submit &lt;solana wallet address&gt;';
  }

  // Basic format validation (Solana base58 pubkey: 32-44 chars)
  const trimmed = address.trim();
  if (trimmed.length < 32 || trimmed.length > 44) {
    return `❌ Invalid address format: ${code(truncateAddress(trimmed))}\nSolana addresses are 32–44 characters.`;
  }

  const db = createAdminClient();

  // Check if already a tracked whale
  const { data: existingWhale } = await db
    .from('whales')
    .select('id')
    .eq('address', trimmed)
    .maybeSingle();

  if (existingWhale) {
    return `ℹ️ ${code(truncateAddress(trimmed))} is already a tracked SONAR whale.`;
  }

  // Check if already a candidate
  const { data: existingCandidate } = await db
    .from('discovery_candidates')
    .select('id, status, discovery_score')
    .eq('address', trimmed)
    .maybeSingle();

  if (existingCandidate) {
    return [
      `ℹ️ ${code(truncateAddress(trimmed))} already submitted.`,
      `Status: ${bold(existingCandidate.status)} | Score: ${existingCandidate.discovery_score}/100`,
    ].join('\n');
  }

  // Log the submission
  await db.from('scout_submissions').insert({
    address:          trimmed,
    submitted_by:     ctx.chatId,
    telegram_username: ctx.username ?? null,
    message_id:       ctx.messageId,
    precheck_passed:  null,
    precheck_notes:   'Precheck in progress',
  });

  // Run precheck: basic heuristics without heavy API calls
  const precheckResult = await runPrecheck(trimmed);

  // Record precheck result in scout_submissions
  await db.from('scout_submissions')
    .update({
      precheck_passed: precheckResult.passed,
      precheck_notes:  precheckResult.notes,
    })
    .eq('address', trimmed)
    .eq('submitted_by', ctx.chatId);

  if (!precheckResult.passed) {
    return [
      `❌ ${code(truncateAddress(trimmed))} did not pass precheck.`,
      `Reason: ${esc(precheckResult.notes)}`,
      '',
      'Criteria: 32–44 char address, not already tracked, not a known system account.',
    ].join('\n');
  }

  // Create discovery candidate with status=manual_review
  const metrics: CandidateMetrics = {
    address: trimmed,
    source:  'community',
  };
  const scoring = scoreCandidate(metrics);

  const { data: candidate, error: candidateErr } = await db
    .from('discovery_candidates')
    .insert({
      address:       trimmed,
      chain:         'solana',
      primary_source: 'community',
      submitted_by:  ctx.chatId,
      status:        'manual_review',  // community submissions always go to manual review
      discovery_score: scoring.score,
      notes:         `Community submission via Telegram by ${ctx.username ?? ctx.chatId}`,
      evaluated_at:  new Date().toISOString(),
    })
    .select('id')
    .single();

  if (candidateErr) {
    console.error('[commands/submit] Candidate insert failed:', candidateErr.message);
    return '❌ Submission failed — please try again later.';
  }

  // Link submission to candidate
  await db.from('scout_submissions')
    .update({ candidate_id: candidate.id })
    .eq('address', trimmed)
    .eq('submitted_by', ctx.chatId);

  // Log review event
  await db.from('discovery_reviews').insert({
    candidate_id: candidate.id,
    reviewer:     'system',
    action:       'manual_review',
    notes:        `Community submission — awaiting curator review. Submitter: @${ctx.username ?? ctx.chatId}`,
  });

  return [
    `✅ ${code(truncateAddress(trimmed))} submitted for review!`,
    '',
    'Our curators will analyze this wallet against:',
    '• 50+ trades / 30 days',
    '• Win rate &gt; 55%',
    '• Active in last 7 days',
    '• 5+ different tokens',
    '',
    'If approved, it will be added to the SONAR tracking list.',
  ].join('\n');
}

// ── Precheck ──────────────────────────────────────────────────

async function runPrecheck(
  address: string,
): Promise<{ passed: boolean; notes: string }> {
  // Known Solana system accounts to reject immediately
  const SYSTEM_ACCOUNTS = new Set([
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'So11111111111111111111111111111111111111112',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bsX',
  ]);

  if (SYSTEM_ACCOUNTS.has(address)) {
    return { passed: false, notes: 'System program account' };
  }

  // Address looks structurally valid (already checked length above)
  return { passed: true, notes: 'Basic precheck passed — awaiting curator review' };
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
