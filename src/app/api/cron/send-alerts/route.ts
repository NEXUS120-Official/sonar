// ============================================================
// SONAR v2.0 — Send Alerts Cron
// POST /api/cron/send-alerts
// ============================================================
// Queries unsent alerts, formats them, delivers to Telegram,
// then marks sent_telegram_free/premium = true + sent_at.
//
// Design:
//   - Idempotent: only processes rows where sent_telegram_free=false
//   - Retry-safe: marks sent AFTER successful delivery
//   - Premium send is skipped if TELEGRAM_PREMIUM_CHANNEL_ID is unset
//   - Processes up to 10 alerts per run (rate limit safety)
//   - Protected by CRON_SECRET
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { sendMessage } from '@/lib/telegram/bot';
import { formatFlowAlert } from '@/lib/telegram/formatter';
import { getCachedSolPrice } from '@/lib/helius/sol-price-cache';
import type { AlertRow, FlowType, SignalDirection } from '@/lib/supabase/types';

// ── Config ────────────────────────────────────────────────────

const MAX_ALERTS_PER_RUN     = 10;
const TELEGRAM_DELAY_MS      = 500; // 2 msg/s — well within Telegram rate limits
const FREE_CHANNEL_ID    = () => process.env.TELEGRAM_CHANNEL_ID         ?? '';
const PREMIUM_CHANNEL_ID = () => process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';

// Free group only receives high-value alerts — notable/info stay silent to save
// Anthropic tokens and reduce noise for subscribers.
const FREE_MIN_SEVERITY = ['significant', 'major'] as const;
type Severity = typeof FREE_MIN_SEVERITY[number] | 'notable' | 'info';

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/send-alerts][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'CRON_SECRET not set — unauthenticated (dev mode)');
    return true;
  }
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Telegram sender with delay ────────────────────────────────

async function sendWithDelay(chatId: string, text: string, label: string): Promise<boolean> {
  const result = await sendMessage({ chatId, text, parseMode: 'HTML' });
  if (!result.ok) {
    log('error', `Telegram delivery failed to ${label}`, result.error);
  } else {
    log('info', `Delivered to ${label} (message_id=${result.messageId})`);
  }
  await new Promise((r) => setTimeout(r, TELEGRAM_DELAY_MS));
  return result.ok;
}

// ── Mark alert as sent ────────────────────────────────────────

async function markSent(
  db: ReturnType<typeof createAdminClient>,
  alertId: string,
  fields: { free?: boolean; premium?: boolean },
): Promise<void> {
  const update: Record<string, unknown> = { sent_at: new Date().toISOString() };
  if (fields.free    !== undefined) update['sent_telegram_free']    = fields.free;
  if (fields.premium !== undefined) update['sent_telegram_premium'] = fields.premium;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (db as any)
    .from('alerts')
    .update(update)
    .eq('id', alertId);

  if (error) log('error', `Failed to mark alert ${alertId} as sent`, error.message);
}

// ── Signal direction from flow type ──────────────────────────

function flowTypeToSignalDirection(flowType: FlowType): SignalDirection {
  switch (flowType) {
    case 'exchange_withdrawal':
    case 'defi_deposit':
    case 'unstake':
      return 'bullish';
    case 'exchange_deposit':
    case 'defi_withdrawal':
    case 'stake':
      return 'bearish';
    default:
      return 'neutral';
  }
}

// ── Record signal outcomes for whale movements in an alert ────

async function recordSignalOutcomes(
  db: ReturnType<typeof createAdminClient>,
  alert: AlertRow,
  solPriceUsd: number,
): Promise<void> {
  // Only process alerts that have associated movements
  const movementIds = alert.movement_ids;
  if (!movementIds || movementIds.length === 0) return;

  try {
    // Fetch the movements and their whale_id
    const { data: movRows, error: movErr } = await db
      .from('movements')
      .select('id, whale_id, flow_type')
      .in('id', movementIds)
      .not('whale_id', 'is', null);

    if (movErr || !movRows) return;

    const rows = movRows as { id: string; whale_id: string; flow_type: FlowType }[];

    for (const mov of rows) {
      if (!mov.whale_id) continue;

      const signalDirection = flowTypeToSignalDirection(mov.flow_type);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('whale_signal_outcomes').insert({
        whale_id:         mov.whale_id,
        movement_id:      mov.id,
        alert_id:         alert.id,
        signal_direction: signalDirection,
        signal_time:      alert.created_at,
        price_at_signal:  solPriceUsd,
        resolved:         false,
      });
    }
  } catch (err) {
    log('warn', `Failed to record signal outcomes for alert ${alert.id}`, err);
  }
}

// ── Receipt type ──────────────────────────────────────────────

interface SendReceipt {
  ok:              boolean;
  run_at:          string;
  alerts_found:    number;
  sent_free:       number;
  sent_premium:    number;
  failed:          number;
  errors:          string[];
  duration_ms:     number;
}

// ── POST handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];
  let alerts_found   = 0;
  let sent_free      = 0;
  let sent_premium   = 0;
  let failed         = 0;

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const freeChannelId    = FREE_CHANNEL_ID();
  const premiumChannelId = PREMIUM_CHANNEL_ID();

  if (!freeChannelId) {
    log('error', 'TELEGRAM_CHANNEL_ID not configured');
    return NextResponse.json({ ok: false, error: 'TELEGRAM_CHANNEL_ID not set' }, { status: 500 });
  }

  const premiumEnabled = premiumChannelId.length > 0;
  if (!premiumEnabled) {
    log('warn', 'TELEGRAM_PREMIUM_CHANNEL_ID not configured — skipping premium delivery');
  }

  log('info', `Starting send-alerts run (free=${freeChannelId}, premium=${premiumEnabled ? premiumChannelId : 'disabled'})`);

  const db = createAdminClient();

  // Fetch SOL price once for signal outcome recording
  const solPriceUsd = await getCachedSolPrice().catch(() => 85);

  // ── 1. Fetch unsent alerts (free not sent) ─────────────────
  const { data: alertsRaw, error: fetchErr } = await db
    .from('alerts')
    .select('*')
    .eq('sent_telegram_free', false)
    .order('created_at', { ascending: true })
    .limit(MAX_ALERTS_PER_RUN);

  if (fetchErr) {
    const msg = `Failed to fetch alerts: ${fetchErr.message}`;
    log('error', msg);
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, 0, 0, [msg]));
  }

  const alerts = (alertsRaw ?? []) as AlertRow[];
  alerts_found = alerts.length;
  log('info', `Found ${alerts_found} unsent alert(s)`);

  if (alerts_found === 0) {
    return NextResponse.json(buildReceipt(runAt, startMs, 0, 0, 0, 0, []));
  }

  // ── 2. Format and deliver each alert ──────────────────────
  for (const alert of alerts) {
    log('info', `Processing alert ${alert.id} type=${alert.alert_type} severity=${alert.severity}`);

    let text: string;
    try {
      text = formatFlowAlert(alert);
    } catch (err) {
      const msg = `Format failed for alert ${alert.id}: ${String(err)}`;
      log('error', msg);
      errors.push(msg);
      failed++;
      continue;
    }

    // Send to free channel — significant/major for flow alerts; weekly_report always eligible
    const freeEligible = alert.alert_type === 'weekly_report'
      || (FREE_MIN_SEVERITY as readonly string[]).includes(alert.severity ?? '');
    let freeOk = false;
    if (!freeEligible) {
      log('info', `Skipping free channel for ${alert.severity} alert (below threshold)`);
      freeOk = true; // mark as "sent" so it doesn't re-queue — premium still runs below
    }
    try {
      if (freeEligible) freeOk = await sendWithDelay(freeChannelId, text, 'free channel');
    } catch (err) {
      log('error', `Free channel send threw for alert ${alert.id}`, err);
      errors.push(`Free channel exception for alert ${alert.id}: ${String(err)}`);
      failed++;
      continue;
    }

    // Send to premium channel (if configured)
    let premiumOk = false;
    if (premiumEnabled) {
      try {
        premiumOk = await sendWithDelay(premiumChannelId, text, 'premium channel');
      } catch (err) {
        log('error', `Premium channel send threw for alert ${alert.id}`, err);
        errors.push(`Premium channel exception: ${String(err)}`);
      }
    }

    // Mark sent — only fields that succeeded
    // Even partial success is marked to avoid retrying a delivered message
    if (freeOk || premiumOk) {
      await markSent(db, alert.id, {
        free:    freeOk,
        premium: premiumEnabled ? premiumOk : undefined,
      });
    }

    if (freeOk)    sent_free++;
    if (premiumOk) sent_premium++;
    if (!freeOk) {
      failed++;
      errors.push(`Free channel delivery failed for alert ${alert.id}`);
    }
    if (premiumEnabled && !premiumOk) {
      failed++;
      errors.push(`Premium channel delivery failed for alert ${alert.id}`);
    }
  }

  const r = buildReceipt(runAt, startMs, alerts_found, sent_free, sent_premium, failed, errors);
  log('info', `Run complete — ${JSON.stringify(r)}`);
  return NextResponse.json(r);
}

export const GET = POST;

// ── Receipt builder ───────────────────────────────────────────

function buildReceipt(
  runAt: Date,
  startMs: number,
  alerts_found: number,
  sent_free: number,
  sent_premium: number,
  failed: number,
  errors: string[],
): SendReceipt {
  return {
    ok:           failed === 0,
    run_at:       runAt.toISOString(),
    alerts_found,
    sent_free,
    sent_premium,
    failed,
    errors,
    duration_ms:  Date.now() - startMs,
  };
}
