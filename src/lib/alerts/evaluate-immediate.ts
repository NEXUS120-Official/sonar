// ============================================================
// SONAR v2.0 — Immediate Alert Evaluation
// ============================================================
// Fast-path alert evaluation for high-priority movements.
// Called synchronously after webhook persistence (non-blocking).
//
// Use: void evaluateImmediateAlert(...)
// Always fire-and-forget — never awaited by the webhook handler.
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import { sendMessage } from '@/lib/telegram/bot';
import type { MovementRow } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

export interface WhaleContext {
  label:            string | null;
  reputation_score: number | null;
  smart_money_flag: boolean | null;
}

// ── Cooldown dedup ────────────────────────────────────────────
// Prevent duplicate alerts for the same whale+flow_type within a cooldown window.

const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

async function recentAlertExists(
  db: ReturnType<typeof createAdminClient>,
  flowType: string,
  whaleId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - COOLDOWN_MS).toISOString();

  // Check in alerts table via data field containing whale_id
  // Use a conservative query — match on alert_type derived from flow_type
  const alertType = flowTypeToAlertType(flowType);
  if (!alertType) return false;

  const { data, error } = await db
    .from('alerts')
    .select('id')
    .eq('alert_type', alertType)
    .gte('created_at', since)
    .limit(1);

  if (error) return false;
  return (data?.length ?? 0) > 0;
}

function flowTypeToAlertType(
  flowType: string,
): 'exchange_spike' | 'whale_large_move' | 'defi_rotation' | null {
  switch (flowType) {
    case 'exchange_deposit':
    case 'exchange_withdrawal':
      return 'exchange_spike';
    case 'defi_deposit':
    case 'defi_withdrawal':
      return 'defi_rotation';
    case 'whale_transfer':
      return 'whale_large_move';
    default:
      return null;
  }
}

function flowTypeToSeverity(
  flowType: string,
  amountUsd: number,
  isSmartMoney: boolean,
): 'notable' | 'significant' | 'major' {
  if (isSmartMoney || amountUsd > 2_000_000) return 'major';
  if (amountUsd > 1_000_000) return 'significant';
  return 'notable';
}

function formatAlertBody(
  movement: Pick<MovementRow, 'flow_type' | 'amount_usd' | 'exchange' | 'protocol'>,
  whale: WhaleContext,
  solPriceUsd: number,
): string {
  const label       = whale.label ?? 'Unknown Whale';
  const amountUsd   = movement.amount_usd ?? 0;
  const amountFmt   = amountUsd >= 1_000_000
    ? `$${(amountUsd / 1_000_000).toFixed(2)}M`
    : `$${(amountUsd / 1_000).toFixed(0)}K`;

  const solAmt     = solPriceUsd > 0 ? (amountUsd / solPriceUsd).toFixed(0) : '—';
  const venue      = movement.exchange ?? movement.protocol ?? 'Unknown Venue';
  const smartBadge = whale.smart_money_flag ? ' ⭐ Smart Money' : '';
  const repScore   = whale.reputation_score != null
    ? ` (rep: ${(whale.reputation_score * 100).toFixed(0)}%)`
    : '';

  const action = (() => {
    switch (movement.flow_type) {
      case 'exchange_deposit':    return 'deposited to exchange';
      case 'exchange_withdrawal': return 'withdrew from exchange';
      case 'defi_deposit':        return 'deployed into DeFi';
      case 'defi_withdrawal':     return 'withdrew from DeFi';
      case 'whale_transfer':      return 'transferred';
      default:                    return movement.flow_type;
    }
  })();

  return (
    `<b>⚡ Instant Alert — Large Move</b>\n\n` +
    `<b>Whale:</b> ${label}${smartBadge}${repScore}\n` +
    `<b>Action:</b> ${action}\n` +
    `<b>Amount:</b> ${amountFmt} (~${solAmt} SOL)\n` +
    `<b>Venue:</b> ${venue}\n` +
    `<b>SOL Price:</b> $${solPriceUsd.toFixed(2)}\n\n` +
    `<i>Triggered immediately by Helius webhook — not yet batched</i>`
  );
}

// ── Main export ───────────────────────────────────────────────

export async function evaluateImmediateAlert(
  movement: Pick<MovementRow, 'id' | 'flow_type' | 'amount_usd' | 'exchange' | 'protocol' | 'whale_id'>,
  whale: WhaleContext | null,
  solPriceUsd: number,
  db: ReturnType<typeof createAdminClient>,
): Promise<void> {
  try {
    const whaleId  = movement.whale_id;
    const amountUsd = movement.amount_usd ?? 0;

    // Check threshold eligibility
    const isLargeExchange =
      (movement.flow_type === 'exchange_deposit' || movement.flow_type === 'exchange_withdrawal') &&
      amountUsd > 500_000;

    const isHighRepDefi =
      (movement.flow_type === 'defi_deposit' || movement.flow_type === 'defi_withdrawal') &&
      (whale?.reputation_score ?? 0) > 0.65;

    if (!isLargeExchange && !isHighRepDefi) return;

    // Dedup — skip if similar alert sent recently
    if (whaleId) {
      const exists = await recentAlertExists(db, movement.flow_type, whaleId);
      if (exists) return;
    }

    // Determine alert metadata
    const alertType = flowTypeToAlertType(movement.flow_type);
    if (!alertType) return;

    const isSmartMoney = whale?.smart_money_flag ?? false;
    const severity     = flowTypeToSeverity(movement.flow_type, amountUsd, isSmartMoney);
    const whaleCtx     = whale ?? { label: null, reputation_score: null, smart_money_flag: null };
    const body         = formatAlertBody(movement, whaleCtx, solPriceUsd);
    const title        = isSmartMoney
      ? `Smart Money ${movement.flow_type === 'exchange_deposit' ? 'Exchange Deposit' : 'Large Move'}`
      : `Large ${movement.flow_type === 'exchange_deposit' ? 'Exchange Deposit' : 'Move'} Detected`;

    // Insert alert row
    const { data: inserted, error: insertErr } = await (db as any)
      .from('alerts')
      .insert({
        alert_type:            alertType,
        severity,
        title,
        body,
        ai_analysis:           null,
        data:                  { movement_id: movement.id, whale_id: whaleId, amount_usd: amountUsd, immediate: true },
        movement_ids:          movement.id ? [movement.id] : null,
        sent_telegram_free:    false,
        sent_telegram_premium: false,
        sent_at:               null,
      })
      .select('id')
      .single();

    if (insertErr) {
      console.error('[evaluate-immediate] Failed to insert alert', insertErr);
      return;
    }

    // Attempt direct Telegram send for sub-minute latency
    const freeChannelId = process.env.TELEGRAM_CHANNEL_ID ?? '';
    if (!freeChannelId || !inserted) return;

    // Only push significant/major to free channel immediately
    if (severity === 'significant' || severity === 'major') {
      const result = await sendMessage({ chatId: freeChannelId, text: body, parseMode: 'HTML' });
      if (result.ok && inserted?.id) {
        await (db as any)
          .from('alerts')
          .update({ sent_telegram_free: true, sent_at: new Date().toISOString() })
          .eq('id', inserted.id);
      }
    }

    // Send to premium channel too
    const premiumChannelId = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';
    if (premiumChannelId && inserted?.id) {
      const pResult = await sendMessage({ chatId: premiumChannelId, text: body, parseMode: 'HTML' });
      if (pResult.ok) {
        await (db as any)
          .from('alerts')
          .update({ sent_telegram_premium: true })
          .eq('id', inserted.id);
      }
    }
  } catch (err) {
    // Never throw — this is fire-and-forget
    console.error('[evaluate-immediate] Unhandled error', err);
  }
}
