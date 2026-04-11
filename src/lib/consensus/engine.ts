// ============================================================
// SONAR — Consensus Detection Engine
// ============================================================
// Implements the core "Smart Money Consensus" algorithm:
//   1. Group recent whale buys by token
//   2. Filter excluded tokens (SOL, USDC, USDT, etc.)
//   3. Apply whale count + volume thresholds
//   4. Deduplicate against recent alerts
//   5. Fetch safety score; skip if below threshold
//   6. Build resolved alert payload

import { createAdminClient } from '@/lib/supabase/server';
import { getTokenSafetyReport } from '@/lib/safety/checker';
import { EXCLUDED_TOKEN_ADDRESSES_SOLANA, EXTERNAL_URLS, SAFETY_EMOJI } from '@/lib/utils/constants';
import { formatUsd } from '@/lib/utils/format';
import type { ConsensusLabel } from '@/lib/supabase/types';
import {
  DEFAULT_CONSENSUS_CONFIG,
  type ConsensusConfig,
  type ConsensusCandidate,
  type ResolvedConsensusAlert,
  type ConsensusRunSummary,
  type WhaleTokenBuy,
} from './types';

// ── Internal helpers ──────────────────────────────────────────

function getConsensusLabel(whaleCount: number): ConsensusLabel {
  if (whaleCount >= 4) return 'ultra';
  if (whaleCount >= 3) return 'strong';
  return 'emerging';
}

function getConsensusEmoji(whaleCount: number): string {
  if (whaleCount >= 4) return '💎';
  if (whaleCount >= 3) return '🔥';
  return '⚡';
}

function getConsensusDisplay(whaleCount: number): string {
  if (whaleCount >= 4) return 'ULTRA SIGNAL';
  if (whaleCount >= 3) return 'STRONG SIGNAL';
  return 'EMERGING SIGNAL';
}

/**
 * Build a simple (non-AI) alert text from resolved data.
 * AI-enhanced version is wired in Phase D via lib/ai/alert-writer.ts.
 */
function buildAlertText(alert: Omit<ResolvedConsensusAlert, 'alertText'>): string {
  const symbol  = alert.tokenSymbol ? `$${alert.tokenSymbol}` : alert.tokenAddress.slice(0, 8);
  const emoji   = getConsensusEmoji(alert.consensusLevel);
  const display = getConsensusDisplay(alert.consensusLevel);
  const safetyEmoji = SAFETY_EMOJI[alert.safetyLevel];

  const volumeLine = alert.totalWhaleVolumeUsd != null
    ? `💰 Whale volume: ${formatUsd(alert.totalWhaleVolumeUsd)}`
    : '💰 Whale volume: unknown (SOL-denominated)';

  const ageLine = alert.tokenAgeHours != null
    ? `⏱️ Token age: ${Math.round(alert.tokenAgeHours)}h`
    : '';

  const holdersLine = alert.tokenHolders != null
    ? `👥 Holders: ${alert.tokenHolders}`
    : '';

  const metaLines = [ageLine, holdersLine].filter(Boolean).join(' | ');

  return [
    `${emoji} ${display} — ${symbol}`,
    '',
    `${alert.consensusLevel} whale(s) accumulated in the last 4h`,
    volumeLine,
    `🛡️ Safety: ${alert.safetyScore}/100 ${safetyEmoji}`,
    metaLines,
  ]
    .filter((l) => l !== undefined && l !== '')
    .join('\n');
}

// ── Dedup check ───────────────────────────────────────────────

/**
 * Returns true if an alert already exists for this token within dedupWindowHours.
 */
async function recentAlertExists(
  tokenAddress: string,
  dedupWindowHours: number,
): Promise<boolean> {
  const db = createAdminClient();
  const since = new Date(Date.now() - dedupWindowHours * 60 * 60 * 1000).toISOString();

  const { count } = await db
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('token_address', tokenAddress)
    .gte('created_at', since);

  return (count ?? 0) > 0;
}

// ── Step 1: Group transactions into candidates ─────────────────

interface EnrichedTransaction {
  whaleId:      string;
  whaleAddress: string;
  winRate7d:    number | null;
  tokenAddress: string;
  tokenSymbol:  string | null;
  tokenName:    string | null;
  amountUsd:    number | null;
  signature:    string;
  blockTime:    string;
}

function groupIntoCandidates(
  txs: EnrichedTransaction[],
  config: ConsensusConfig,
): ConsensusCandidate[] {
  // Group buy transactions by token
  const byToken = new Map<string, EnrichedTransaction[]>();

  for (const tx of txs) {
    if (EXCLUDED_TOKEN_ADDRESSES_SOLANA.includes(tx.tokenAddress)) continue;

    const existing = byToken.get(tx.tokenAddress) ?? [];
    existing.push(tx);
    byToken.set(tx.tokenAddress, existing);
  }

  const candidates: ConsensusCandidate[] = [];

  for (const [tokenAddress, tokenTxs] of byToken) {
    // Count unique whale buyers
    const uniqueWhaleIds = new Set(tokenTxs.map((t) => t.whaleId));
    if (uniqueWhaleIds.size < config.minWhales) continue;

    // Aggregate volume
    const knownAmounts = tokenTxs
      .map((t) => t.amountUsd)
      .filter((a): a is number => a !== null);

    const volumeIsKnown = knownAmounts.length > 0;
    const totalVolumeUsd = volumeIsKnown
      ? knownAmounts.reduce((s, a) => s + a, 0)
      : null;

    // Volume check:
    //   - If volume is known and below threshold → skip
    //   - If volume is entirely unknown (all SOL-paid, not enriched) → proceed
    //     (can't enforce threshold without enrichment; log warning)
    if (volumeIsKnown && totalVolumeUsd! < config.minVolumeUsd) continue;

    // Build per-whale buy list (one entry per unique whale, largest buy first)
    const whaleBuys: WhaleTokenBuy[] = [];
    for (const whaleId of uniqueWhaleIds) {
      const whaleTxs = tokenTxs.filter((t) => t.whaleId === whaleId);
      const best = whaleTxs.sort((a, b) =>
        (b.amountUsd ?? 0) - (a.amountUsd ?? 0),
      )[0];
      whaleBuys.push({
        whaleId:      best.whaleId,
        whaleAddress: best.whaleAddress,
        winRate7d:    best.winRate7d,
        amountUsd:    best.amountUsd,
        signature:    best.signature,
        blockTime:    best.blockTime,
      });
    }

    const whaleCount = uniqueWhaleIds.size;
    const firstTx    = tokenTxs[0];

    candidates.push({
      tokenAddress,
      tokenSymbol:    firstTx.tokenSymbol,
      tokenName:      firstTx.tokenName,
      whaleCount,
      totalVolumeUsd,
      volumeIsKnown,
      whaleBuys,
      consensusLabel: getConsensusLabel(whaleCount),
      consensusEmoji: getConsensusEmoji(whaleCount),
    });
  }

  // Sort by whale count desc, then volume desc
  return candidates.sort((a, b) => {
    if (b.whaleCount !== a.whaleCount) return b.whaleCount - a.whaleCount;
    return (b.totalVolumeUsd ?? 0) - (a.totalVolumeUsd ?? 0);
  });
}

// ── Public API ────────────────────────────────────────────────

/**
 * Run the consensus detection algorithm against recent transactions.
 *
 * @param timeWindowHours  Look-back window. Defaults to config.timeWindowHours.
 * @param config           Override default thresholds.
 * @returns                Resolved alerts + run summary.
 */
export async function detectConsensus(
  config: Partial<ConsensusConfig> = {},
): Promise<{ alerts: ResolvedConsensusAlert[]; summary: ConsensusRunSummary }> {
  const cfg: ConsensusConfig = { ...DEFAULT_CONSENSUS_CONFIG, ...config };

  const db = createAdminClient();
  const since = new Date(Date.now() - cfg.timeWindowHours * 60 * 60 * 1000).toISOString();

  // ── Query 1: whale id → address + win_rate lookup map
  const { data: whaleRows, error: whaleError } = await db
    .from('whales')
    .select('id, address, win_rate_7d')
    .eq('is_active', true);

  if (whaleError) {
    throw new Error(`[consensus/engine] Whale query failed: ${whaleError.message}`);
  }

  const whaleMap = new Map(
    (whaleRows ?? []).map((w) => [w.id, { address: w.address, winRate7d: w.win_rate_7d }]),
  );

  // ── Query 2: buy transactions in the time window
  const { data: rows, error } = await db
    .from('transactions')
    .select('whale_id, token_address, token_symbol, token_name, amount_usd, signature, block_time')
    .eq('type', 'buy')
    .gte('block_time', since)
    .order('block_time', { ascending: false });

  if (error) {
    throw new Error(`[consensus/engine] Transactions query failed: ${error.message}`);
  }

  // ── Merge: enrich each transaction with whale address
  const txs: EnrichedTransaction[] = (rows ?? [])
    .filter((r) => whaleMap.has(r.whale_id))
    .map((r) => {
      const whale = whaleMap.get(r.whale_id)!;
      return {
        whaleId:      r.whale_id,
        whaleAddress: whale.address,
        winRate7d:    whale.winRate7d,
        tokenAddress: r.token_address,
        tokenSymbol:  r.token_symbol,
        tokenName:    r.token_name,
        amountUsd:    r.amount_usd,
        signature:    r.signature,
        blockTime:    r.block_time,
      };
    });

  const summary: ConsensusRunSummary = {
    transactionsScanned: txs.length,
    candidateTokens:     0,
    alertsGenerated:     0,
    alertsSkipped:       0,
    skipReasons:         [],
  };

  // ── Group into candidates
  const candidates = groupIntoCandidates(txs, cfg);
  summary.candidateTokens = candidates.length;

  const resolvedAlerts: ResolvedConsensusAlert[] = [];

  for (const candidate of candidates) {
    const addr = candidate.tokenAddress;

    // ── Dedup check
    const alreadyAlerted = await recentAlertExists(addr, cfg.dedupWindowHours);
    if (alreadyAlerted) {
      summary.alertsSkipped++;
      summary.skipReasons.push({ tokenAddress: addr, reason: 'dedup: recent alert exists' });
      continue;
    }

    // ── Safety score
    let safety;
    try {
      safety = await getTokenSafetyReport(addr);
    } catch (err) {
      summary.alertsSkipped++;
      summary.skipReasons.push({ tokenAddress: addr, reason: `safety fetch error: ${String(err)}` });
      continue;
    }

    if (safety.safetyScore < cfg.minSafetyScore) {
      console.warn(
        `[consensus/engine] Skipping ${addr.slice(0, 8)} — safety ${safety.safetyScore} < ${cfg.minSafetyScore}`,
      );
      summary.alertsSkipped++;
      summary.skipReasons.push({
        tokenAddress: addr,
        reason: `safety ${safety.safetyScore} < threshold ${cfg.minSafetyScore}`,
      });
      continue;
    }

    if (!candidate.volumeIsKnown) {
      console.warn(
        `[consensus/engine] ${addr.slice(0, 8)} volume unknown (SOL-paid, not enriched) — proceeding`,
      );
    }

    // ── Build resolved alert
    const partial: Omit<ResolvedConsensusAlert, 'alertText'> = {
      tokenAddress:        addr,
      tokenSymbol:         candidate.tokenSymbol,
      tokenName:           candidate.tokenName,
      tokenMarketCap:      null,
      tokenAgeHours:       safety.tokenAgeHours,
      tokenHolders:        safety.holderCount,
      consensusLevel:      candidate.whaleCount,
      consensusLabel:      candidate.consensusLabel,
      safetyScore:         safety.safetyScore,
      safetyLevel:         safety.safetyLevel,
      totalWhaleVolumeUsd: candidate.totalVolumeUsd,
      whaleBuys:           candidate.whaleBuys,
      jupiterSwapUrl:      EXTERNAL_URLS.jupiterSwap(addr),
      birdeyeUrl:          EXTERNAL_URLS.birdeye(addr),
    };

    resolvedAlerts.push({ ...partial, alertText: buildAlertText(partial) });
    summary.alertsGenerated++;
  }

  return { alerts: resolvedAlerts, summary };
}
