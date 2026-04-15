// ============================================================
// SONAR — Signal Confluence Engine
// ============================================================
// Detects when multiple independent whale signals align on the
// same asset or direction within a short time window.
//
// Two types of confluence:
//
//   1. TOKEN ACCUMULATION — multiple whale wallets buy the same
//      token within a 30-minute window. Strength scales with:
//      - unique whale count
//      - total USD volume
//      - smart money fraction
//
//   2. DIRECTIONAL CONFLUENCE — when Bias Index + staking + DeFi
//      signals all point the same direction simultaneously.
//      Amplifies the main prediction signal.
// ============================================================

// ── Types ─────────────────────────────────────────────────────

export interface TokenAccumulationSignal {
  token_mint:         string;
  token_symbol:       string | null;
  unique_whales:      number;
  smart_money_count:  number;
  total_usd:          number;
  avg_usd_per_whale:  number;
  buy_sell_ratio:     number;   // >1 = more buys
  window_minutes:     number;
  confluence_score:   number;   // 0-100
  severity:           'notable' | 'significant' | 'major';
  whale_addresses:    string[];
  is_pump_fun:        boolean;
  detected_at:        string;
}

export interface DirectionalConfluence {
  direction:          'bullish' | 'bearish' | 'neutral';
  aligned_signals:    number;   // out of 4 (exchange, staking, stablecoin, defi)
  confluence_score:   number;   // 0-100
  amplifier:          number;   // multiplier for prediction (1.0–2.0)
}

// ── Token accumulation detection ──────────────────────────────

interface RawTokenMovement {
  whale_id:        string | null;
  token_mint:      string;
  token_symbol:    string | null;
  action:          'buy' | 'sell' | 'add_liquidity' | 'remove_liquidity';
  amount_usd:      number | null;
  is_pump_fun:     boolean;
  block_time:      string;
  smart_money:     boolean;
}

/**
 * Detect token accumulation clusters from recent token movements.
 * @param movements  Raw token movements from the last N minutes
 * @param windowMin  Window size in minutes (default 30)
 * @param minWhales  Minimum unique whale wallets to fire (default 2)
 */
export function detectTokenAccumulation(
  movements:   RawTokenMovement[],
  windowMin:   number = 30,
  minWhales:   number = 2,
): TokenAccumulationSignal[] {
  const now     = Date.now();
  const cutoff  = new Date(now - windowMin * 60_000).toISOString();
  const recent  = movements.filter(m => m.block_time >= cutoff && m.whale_id);

  // Group by token_mint
  const byToken = new Map<string, {
    symbol:      string | null;
    isPumpFun:   boolean;
    buys:        Array<{ whaleId: string; usd: number; smart: boolean }>;
    sells:       Array<{ whaleId: string; usd: number; smart: boolean }>;
  }>();

  for (const m of recent) {
    if (!m.whale_id) continue;
    if (!byToken.has(m.token_mint)) {
      byToken.set(m.token_mint, { symbol: m.token_symbol, isPumpFun: m.is_pump_fun, buys: [], sells: [] });
    }
    const entry = byToken.get(m.token_mint)!;
    const item  = { whaleId: m.whale_id, usd: m.amount_usd ?? 0, smart: m.smart_money };
    if (m.action === 'buy')  entry.buys.push(item);
    if (m.action === 'sell') entry.sells.push(item);
  }

  const signals: TokenAccumulationSignal[] = [];

  for (const [mint, data] of byToken) {
    const uniqueBuyWhales = new Set(data.buys.map(b => b.whaleId));
    if (uniqueBuyWhales.size < minWhales) continue;

    const totalBuyUsd     = data.buys.reduce((s, b) => s + b.usd, 0);
    const totalSellUsd    = data.sells.reduce((s, b) => s + b.usd, 0);
    const smartBuys       = data.buys.filter(b => b.smart).length;
    const buySellRatio    = totalSellUsd > 0 ? totalBuyUsd / totalSellUsd : totalBuyUsd > 0 ? Infinity : 1;
    const avgUsd          = totalBuyUsd / uniqueBuyWhales.size;

    // Confluence score formula:
    //   base = unique_whales * 15 (capped at 60)
    //   volume_bonus = log10(totalBuyUsd/1000) * 10 (capped at 30)
    //   smart_bonus = (smartBuys / uniqueBuyWhales.size) * 10
    const base         = Math.min(60, uniqueBuyWhales.size * 15);
    const volBonus     = totalBuyUsd >= 1_000
      ? Math.min(30, Math.log10(totalBuyUsd / 1_000) * 10)
      : 0;
    const smartBonus   = Math.min(10, (smartBuys / uniqueBuyWhales.size) * 10);
    const rawScore     = base + volBonus + smartBonus;
    const score        = Math.min(100, Math.round(rawScore));

    // Only fire if net buy-biased
    if (buySellRatio < 1.2 && data.buys.length <= data.sells.length) continue;

    const severity: TokenAccumulationSignal['severity'] =
      score >= 70 || uniqueBuyWhales.size >= 5 ? 'major' :
      score >= 50 || uniqueBuyWhales.size >= 3 ? 'significant' : 'notable';

    signals.push({
      token_mint:        mint,
      token_symbol:      data.symbol,
      unique_whales:     uniqueBuyWhales.size,
      smart_money_count: smartBuys,
      total_usd:         totalBuyUsd,
      avg_usd_per_whale: avgUsd,
      buy_sell_ratio:    buySellRatio,
      window_minutes:    windowMin,
      confluence_score:  score,
      severity,
      whale_addresses:   [...uniqueBuyWhales],
      is_pump_fun:       data.isPumpFun,
      detected_at:       new Date().toISOString(),
    });
  }

  // Sort by score desc
  return signals.sort((a, b) => b.confluence_score - a.confluence_score);
}

// ── Directional confluence ─────────────────────────────────────

interface BiasComponents {
  exchange_score:    number;  // positive = bullish
  staking_score:     number;
  stablecoin_score:  number;
  defi_score:        number;
}

/**
 * Compute directional confluence from Bias Index component scores.
 * Returns a multiplier (1.0–2.0) for prediction amplification.
 */
export function computeDirectionalConfluence(components: BiasComponents): DirectionalConfluence {
  const scores = [
    components.exchange_score,
    components.staking_score,
    components.stablecoin_score,
    components.defi_score,
  ];

  const bullish = scores.filter(s => s > 5).length;
  const bearish = scores.filter(s => s < -5).length;
  const neutral = 4 - bullish - bearish;

  const dominantBullish = bullish > bearish && bullish > neutral;
  const dominantBearish = bearish > bullish && bearish > neutral;

  const aligned = dominantBullish ? bullish : dominantBearish ? bearish : 0;

  // Score: aligned signals as fraction, penalised by opposing signals
  const opposing  = dominantBullish ? bearish : dominantBullish ? bullish : 0;
  const rawScore  = aligned * 25 - opposing * 10;
  const score     = Math.max(0, Math.min(100, rawScore));

  // Amplifier: 1.0 at 0 aligned, 2.0 at 4 aligned + 0 opposing
  const amplifier = 1.0 + (score / 100);

  return {
    direction:       dominantBullish ? 'bullish' : dominantBearish ? 'bearish' : 'neutral',
    aligned_signals: aligned,
    confluence_score: score,
    amplifier:        Math.round(amplifier * 100) / 100,
  };
}

// ── Alert text builders ───────────────────────────────────────

export function formatTokenAccumulationAlert(sig: TokenAccumulationSignal): {
  title: string;
  body:  string;
} {
  const fmtUsd = (v: number) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` :
    v >= 1e3 ? `$${(v / 1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;

  const smLabel   = sig.smart_money_count > 0
    ? ` (${sig.smart_money_count} smart money)` : '';
  const token     = sig.token_symbol ?? sig.token_mint.slice(0, 8);
  const pumpLabel = sig.is_pump_fun ? ' [pump.fun]' : '';

  const title = `${sig.unique_whales} Whales Accumulating ${token}${pumpLabel} — ${fmtUsd(sig.total_usd)}`;
  const body  = [
    `Token: ${token}${pumpLabel}`,
    `Wallets: ${sig.unique_whales} unique${smLabel}`,
    `Volume: ${fmtUsd(sig.total_usd)} (avg ${fmtUsd(sig.avg_usd_per_whale)}/whale)`,
    `Buy/Sell ratio: ${sig.buy_sell_ratio === Infinity ? '∞' : sig.buy_sell_ratio.toFixed(1)}×`,
    `Window: ${sig.window_minutes}m · Score: ${sig.confluence_score}/100`,
  ].join('\n');

  return { title, body };
}
