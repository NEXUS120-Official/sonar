// ============================================================
// SONAR v2.0 — Telegram Alert Formatter
// ============================================================
// Formats flow alerts for Telegram delivery (HTML parse mode).

import { formatUsd } from '@/lib/utils/format';
import { SEVERITY_LABELS, EXTERNAL_URLS } from '@/lib/utils/constants';
import type { AlertRow, AlertType } from '@/lib/supabase/types';

// ── HTML helpers ──────────────────────────────────────────────

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bold(text: string): string {
  return `<b>${text}</b>`; // caller must pre-escape
}

function link(text: string, url: string): string {
  return `<a href="${url}">${esc(text)}</a>`;
}

function code(text: string): string {
  return `<code>${esc(text)}</code>`;
}

function formatRelativeTimestamp(iso: string): string {
  const diffMs  = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// ── Alert type → emoji + label ────────────────────────────────

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  exchange_spike:     '📈 Exchange Spike',
  accumulation_wave:  '🟢 Accumulation Wave',
  distribution_wave:  '🔴 Distribution Wave',
  staking_shift:      '⚡ Staking Shift',
  flow_reversal:      '🔀 Flow Reversal',
  defi_rotation:      '🔄 DeFi Rotation',
  stablecoin_flow:    '💵 Stablecoin Flow',
  whale_large_move:   '🐋 Whale Move',
  weekly_report:      '📊 Weekly Report',
};

// ── Numeric context from data JSONB ───────────────────────────

function formatDataLines(alertType: AlertType, data: Record<string, unknown> | null): string[] {
  if (!data) return [];
  const lines: string[] = [];

  const fmtUsd = (v: unknown): string =>
    typeof v === 'number' ? formatUsd(Math.abs(v)) : '—';

  switch (alertType) {
    case 'accumulation_wave':
    case 'distribution_wave': {
      const inflow  = fmtUsd(data['inflow_usd']);
      const outflow = fmtUsd(data['outflow_usd']);
      const net     = fmtUsd(data['net_outflow_usd'] ?? data['net_inflow_usd']);
      lines.push(`  In:  ${inflow}`);
      lines.push(`  Out: ${outflow}`);
      lines.push(`  Net: ${net}`);
      break;
    }
    case 'staking_shift': {
      const staked   = fmtUsd(data['staked_usd']);
      const unstaked = fmtUsd(data['unstaked_usd']);
      const net      = fmtUsd(data['net_staking_usd']);
      const dir      = typeof data['net_staking_usd'] === 'number' && (data['net_staking_usd'] as number) > 0
        ? '(net staked 🔒)' : '(net unstaked ⚡)';
      lines.push(`  Staked:   ${staked}`);
      lines.push(`  Unstaked: ${unstaked}`);
      lines.push(`  Net:      ${net} ${dir}`);
      break;
    }
    case 'exchange_spike': {
      const vol   = fmtUsd(data['current_volume_usd']);
      const ratio = data['ratio'] ?? '?';
      lines.push(`  Volume: ${vol} (${ratio}× baseline)`);
      break;
    }
    case 'whale_large_move': {
      const amt = fmtUsd(data['amount_usd']);
      lines.push(`  Amount: ${amt}`);
      break;
    }
    default:
      break;
  }

  return lines;
}

// ── Flow alert formatter ──────────────────────────────────────

/**
 * Format a v2 AlertRow for Telegram delivery.
 * Used by send-alerts cron for free/premium channel posting.
 */
export function formatFlowAlert(alert: AlertRow): string {
  const severityEmoji = SEVERITY_LABELS[alert.severity] ?? '📊';
  const typeLabel     = ALERT_TYPE_LABELS[alert.alert_type] ?? esc(alert.alert_type);
  const ts            = formatRelativeTimestamp(alert.created_at);

  const dataLines = formatDataLines(
    alert.alert_type,
    alert.data as Record<string, unknown> | null,
  );

  const aiLine = alert.ai_analysis
    ? `\n💡 ${esc(alert.ai_analysis)}`
    : '';

  const lines = [
    `${severityEmoji} ${bold(typeLabel)}`,
    bold(esc(alert.title)),
    '',
    esc(alert.body),
  ];

  if (dataLines.length > 0) {
    lines.push('');
    lines.push(...dataLines);
  }

  if (aiLine) lines.push(aiLine);

  lines.push('');
  lines.push(`🕐 ${ts}  ·  📡 SONAR`);

  return lines.join('\n');
}

/**
 * Format an alert for re-rendering from stored AlertRow.
 * Used by /flow and /report commands.
 */
export function formatAlertRow(alert: AlertRow): string {
  return formatFlowAlert(alert);
}

// ── Whale movement formatter ──────────────────────────────────

export interface WhaleMovementPayload {
  fromLabel:   string | null;
  toLabel:     string | null;
  token:       string;
  amountUsd:   number | null;
  amountToken: number;
  flowType:    string;
  exchange:    string | null;
  protocol:    string | null;
  signature:   string;
  blockTime:   string;
}

export function formatWhaleMovement(m: WhaleMovementPayload): string {
  const direction =
    m.flowType === 'exchange_deposit'    ? '🔴 Deposited to exchange' :
    m.flowType === 'exchange_withdrawal' ? '🟢 Withdrawn from exchange' :
    m.flowType === 'stake'               ? '🔒 Staked' :
    m.flowType === 'unstake'             ? '⚡ Unstaked' :
    m.flowType === 'defi_deposit'        ? '📊 Deposited to DeFi' :
    m.flowType === 'defi_withdrawal'     ? '📤 Withdrawn from DeFi' :
    'Moved';

  const amount = m.amountUsd ? bold(formatUsd(m.amountUsd))
               : `${m.amountToken} ${m.token}`;

  const venue     = m.exchange ?? m.protocol ?? null;
  const venueLine = venue ? ` (${esc(venue)})` : '';
  const txLink    = link('View tx', EXTERNAL_URLS.solscanTx(m.signature));

  return [
    `🐋 ${bold('Whale Large Move')}`,
    '',
    `${direction}${venueLine}`,
    `Amount: ${amount}`,
    '',
    txLink,
  ].join('\n');
}

// ── Weekly report formatter ───────────────────────────────────

export interface WeeklyReportPayload {
  netExchangeFlowUsd:  number;
  netStakingFlowUsd:   number;
  netDefiFlowUsd:      number;
  netUsdcFlowUsd:      number;
  largeMovementsCount: number;
  marketBias:          string;
  biasScore:           number;
  weekLabel:           string;
}

export function formatWeeklyReport(r: WeeklyReportPayload): string {
  const biasEmoji   = r.biasScore > 20 ? '🟢' : r.biasScore < -20 ? '🔴' : '⚪';
  const exchangeDir = r.netExchangeFlowUsd < 0
    ? 'accumulated (bullish ↓)' : 'sent to exchanges (bearish ↑)';
  const stakingDir  = r.netStakingFlowUsd > 0 ? 'net staked 🔒' : 'net unstaked ⚡';

  return [
    `📊 ${bold(`SONAR Smart Money Weekly — ${esc(r.weekLabel)}`)}`,
    '',
    `${biasEmoji} ${bold('Bias:')} ${esc(r.marketBias.toUpperCase())} (${r.biasScore > 0 ? '+' : ''}${r.biasScore})`,
    '',
    `🏦 ${bold('Exchange Flow:')} ${formatUsd(Math.abs(r.netExchangeFlowUsd))} ${esc(exchangeDir)}`,
    `⚡ ${bold('Staking:')} ${formatUsd(Math.abs(r.netStakingFlowUsd))} ${esc(stakingDir)}`,
    `📊 ${bold('DeFi:')} ${formatUsd(Math.abs(r.netDefiFlowUsd))} ${esc(r.netDefiFlowUsd >= 0 ? 'net deposited' : 'net withdrawn')}`,
    `💵 ${bold('USDC:')} ${formatUsd(Math.abs(r.netUsdcFlowUsd))} ${esc(r.netUsdcFlowUsd >= 0 ? 'inflow' : 'outflow')}`,
    '',
    `Large movements: ${r.largeMovementsCount}`,
    '',
    '📡 SONAR by NEXUS Finance',
  ].join('\n');
}
