// ============================================================
// SONAR — Telegram Alert Formatter
// ============================================================
// Produces HTML-formatted messages for Telegram channel delivery.
// Uses HTML parse mode (safer than MarkdownV2 for dynamic content).

import { formatUsd, formatPercent, truncateAddress, formatHours } from '@/lib/utils/format';
import { SAFETY_EMOJI } from '@/lib/utils/constants';
import type { ResolvedConsensusAlert } from '@/lib/consensus/types';
import type { Alert } from '@/lib/supabase/types';

// ── HTML helpers ──────────────────────────────────────────────

function esc(text: string): string {
  // Escape HTML special characters for Telegram HTML parse mode
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bold(text: string): string {
  return `<b>${esc(text)}</b>`;
}

function link(text: string, url: string): string {
  return `<a href="${url}">${esc(text)}</a>`;
}

function code(text: string): string {
  return `<code>${esc(text)}</code>`;
}

// ── Consensus signal formatting ───────────────────────────────

function consensusEmoji(level: number): string {
  if (level >= 4) return '💎';
  if (level >= 3) return '🔥';
  return '⚡';
}

function consensusDisplay(level: number): string {
  if (level >= 4) return 'ULTRA SIGNAL';
  if (level >= 3) return 'STRONG SIGNAL';
  return 'EMERGING SIGNAL';
}

// ── Public formatters ─────────────────────────────────────────

/**
 * Format a ResolvedConsensusAlert into a Telegram HTML message.
 * Used immediately after the alert is generated (before DB insert round-trip).
 */
export function formatConsensusAlert(alert: ResolvedConsensusAlert): string {
  const symbol  = alert.tokenSymbol ? `$${esc(alert.tokenSymbol)}` : code(truncateAddress(alert.tokenAddress));
  const emoji   = consensusEmoji(alert.consensusLevel);
  const display = consensusDisplay(alert.consensusLevel);

  const safetyEmoji = SAFETY_EMOJI[alert.safetyLevel];

  const volumeLine = alert.totalWhaleVolumeUsd != null
    ? `💰 Whale volume: ${bold(formatUsd(alert.totalWhaleVolumeUsd))}`
    : '💰 Whale volume: unknown (SOL-denominated)';

  const ageLine = alert.tokenAgeHours != null
    ? `⏱️ Age: ${formatHours(alert.tokenAgeHours)}`
    : null;

  const holdersLine = alert.tokenHolders != null
    ? `👥 Holders: ${alert.tokenHolders.toLocaleString()}`
    : null;

  const metaLine = [ageLine, holdersLine].filter(Boolean).join('  |  ');

  const whaleLines = alert.whaleBuys
    .map((b) => {
      const winRate = b.winRate7d != null ? ` (${formatPercent(b.winRate7d)} WR)` : '';
      const amount  = b.amountUsd != null ? ` · ${formatUsd(b.amountUsd)}` : '';
      return `  • ${code(truncateAddress(b.whaleAddress))}${winRate}${amount}`;
    })
    .join('\n');

  const lines = [
    `${emoji} ${bold(display)} — ${symbol}`,
    '',
    `🐋 ${bold(String(alert.consensusLevel))} whales accumulated in the last 4h`,
    whaleLines,
    '',
    volumeLine,
    `🛡️ Safety: ${bold(String(alert.safetyScore))}/100 ${safetyEmoji}`,
    metaLine || null,
    '',
    `${link('Trade on Jupiter', alert.jupiterSwapUrl)}  |  ${link('Chart', alert.birdeyeUrl)}`,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return lines;
}

/**
 * Format an Alert row from the DB into a Telegram HTML message.
 * Used by /consensus command to re-render stored alerts.
 */
export function formatAlertRow(alert: Alert): string {
  const symbol = alert.token_symbol
    ? `$${esc(alert.token_symbol)}`
    : code(truncateAddress(alert.token_address));

  const level   = alert.consensus_level ?? 2;
  const emoji   = consensusEmoji(level);
  const display = consensusDisplay(level);

  const safetyPart = alert.safety_score != null && alert.safety_level != null
    ? `🛡️ Safety: ${bold(String(alert.safety_score))}/100 ${SAFETY_EMOJI[alert.safety_level]}`
    : null;

  const volumePart = alert.total_whale_volume_usd != null
    ? `💰 Volume: ${bold(formatUsd(alert.total_whale_volume_usd))}`
    : null;

  const agePart = alert.token_age_hours != null
    ? `⏱️ Age: ${formatHours(alert.token_age_hours)}`
    : null;

  const jupiterPart = alert.jupiter_swap_url
    ? link('Trade on Jupiter', alert.jupiter_swap_url)
    : null;

  const birdeyePart = alert.birdeye_url
    ? link('Chart', alert.birdeye_url)
    : null;

  const linkLine = [jupiterPart, birdeyePart].filter(Boolean).join('  |  ') || null;

  const ts = `🕐 ${formatRelativeTimestamp(alert.created_at)}`;

  const lines = [
    `${emoji} ${bold(display)} — ${symbol}`,
    `🐋 ${bold(String(level))} whale${level !== 1 ? 's' : ''} · ${ts}`,
    volumePart,
    safetyPart,
    agePart,
    linkLine,
  ]
    .filter((l): l is string => l !== null)
    .join('\n');

  return lines;
}

function formatRelativeTimestamp(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}
