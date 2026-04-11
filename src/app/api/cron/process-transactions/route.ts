// ============================================================
// SONAR — Process Transactions Cron
// GET /api/cron/process-transactions
// ============================================================
// Triggered every 2 minutes by Vercel Cron (or manually).
// Runs the consensus detection engine and persists generated
// alerts to the alerts table.
//
// Auth: Authorization: Bearer {CRON_SECRET}

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { detectConsensus } from '@/lib/consensus/engine';

// ── Auth helper ───────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured — allow in dev

  const auth = req.headers.get('authorization') ?? '';
  // Accept both raw value and "Bearer <value>"
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return provided === secret;
}

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts = new Date().toISOString();
  const prefix = `[cron/process-transactions][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix,  msg, ctx ?? '');
  else                        console.log(prefix,   msg, ctx ?? '');
}

// ── Route handler ─────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // ── 1. Auth
  if (!verifyCronSecret(req)) {
    log('warn', 'Unauthorized cron attempt');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Cron triggered — running consensus detection');

  // ── 2. Run consensus engine
  let alerts;
  let summary;
  try {
    ({ alerts, summary } = await detectConsensus());
  } catch (err) {
    log('error', 'Consensus engine failed', err);
    return NextResponse.json(
      { ok: false, error: String(err) },
      { status: 500 },
    );
  }

  log('info', `Engine complete — candidates=${summary.candidateTokens} generated=${summary.alertsGenerated} skipped=${summary.alertsSkipped}`);

  // ── 3. Persist alerts to DB
  const db = createAdminClient();
  let dbInserted = 0;
  let dbErrors = 0;

  for (const alert of alerts) {
    const whaleTransactionsJson = alert.whaleBuys.map((b) => ({
      whale_address: b.whaleAddress,
      whale_id:      b.whaleId,
      win_rate_7d:   b.winRate7d,
      amount_usd:    b.amountUsd,
      signature:     b.signature,
    }));

    const { error: insertError } = await db.from('alerts').insert({
      type:                   'consensus',
      consensus_level:         alert.consensusLevel,
      consensus_label:         alert.consensusLabel,
      token_address:           alert.tokenAddress,
      token_symbol:            alert.tokenSymbol,
      token_name:              alert.tokenName,
      token_market_cap:        alert.tokenMarketCap,
      token_age_hours:         alert.tokenAgeHours,
      token_holders:           alert.tokenHolders,
      safety_score:            alert.safetyScore,
      safety_level:            alert.safetyLevel,
      total_whale_volume_usd:  alert.totalWhaleVolumeUsd,
      whale_transactions:      whaleTransactionsJson,
      alert_text:              alert.alertText,
      jupiter_swap_url:        alert.jupiterSwapUrl,
      birdeye_url:             alert.birdeyeUrl,
      sent_telegram:           false,
    });

    if (insertError) {
      log('error', `Failed to insert alert for ${alert.tokenAddress.slice(0, 8)}`, insertError.message);
      dbErrors++;
    } else {
      const emoji = alert.consensusLevel >= 4 ? '💎' : alert.consensusLevel >= 3 ? '🔥' : '⚡';
      log('info', `Alert saved — ${emoji} ${alert.tokenSymbol ?? alert.tokenAddress.slice(0, 8)} (${alert.consensusLabel})`);
      dbInserted++;
    }
  }

  // ── 4. Return summary
  const response = {
    ok:                  true,
    transactionsScanned: summary.transactionsScanned,
    candidateTokens:     summary.candidateTokens,
    alertsGenerated:     summary.alertsGenerated,
    alertsInsertedToDB:  dbInserted,
    alertsSkipped:       summary.alertsSkipped,
    dbErrors,
    skipReasons:         summary.skipReasons,
  };

  log('info', 'Cron complete', response);
  return NextResponse.json(response);
}
