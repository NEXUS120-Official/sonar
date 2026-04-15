// ============================================================
// SONAR — GET /api/predict/token/[mint]
// ============================================================
// Token-level directional prediction based on:
//   1. Whale accumulation pattern (last 30m/1h/4h)
//   2. Smart money presence (reputation-weighted)
//   3. Pump.fun context (higher volatility, different thresholds)
//   4. Buy/sell pressure ratio
//
// Response:
//   direction, probability, confidence, signals, whale_activity
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient }              from '@/lib/supabase/server';
import { detectTokenAccumulation }        from '@/lib/flow-engine/confluence';
import type { TokenMovementRow, WhaleRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

export async function GET(
  _req: NextRequest,
  { params }: { params: { mint: string } },
): Promise<NextResponse> {
  const { mint } = params;

  if (!mint || mint.length < 32) {
    return NextResponse.json({ ok: false, error: 'invalid mint' }, { status: 400 });
  }

  try {
    const db    = createAdminClient();
    const now   = new Date();
    const since = new Date(now.getTime() - 4 * 60 * 60_000).toISOString(); // 4h lookback

    // ── 1. Load token movements for this mint ──────────────────
    const { data: movRaw } = await (db as any)
      .from('token_movements')
      .select('whale_id, token_mint, token_symbol, token_name, action, amount_usd, is_new_token, block_time, protocol')
      .eq('token_mint', mint)
      .gte('block_time', since)
      .order('block_time', { ascending: false });

    const movements = (movRaw ?? []) as Pick<
      TokenMovementRow,
      'whale_id' | 'token_mint' | 'token_symbol' | 'token_name' | 'action' | 'amount_usd' | 'is_new_token' | 'block_time' | 'protocol'
    >[];

    if (movements.length === 0) {
      return NextResponse.json({
        ok:          true,
        mint,
        direction:   'neutral',
        probability: 0.50,
        confidence:  'insufficient_data',
        signals:     [],
        whale_activity: { total_events: 0, unique_whales: 0, total_usd: 0, buy_usd: 0, sell_usd: 0 },
        computed_at: now.toISOString(),
      });
    }

    // ── 2. Load whale metadata ─────────────────────────────────
    const whaleIds = [...new Set(movements.map(m => m.whale_id).filter(Boolean) as string[])];
    const { data: whaleRaw } = await (db as any)
      .from('whales')
      .select('id, label, smart_money_flag, reputation_score, hit_rate_30d')
      .in('id', whaleIds);

    const whaleMap = new Map<string, Pick<WhaleRow, 'id' | 'label' | 'smart_money_flag' | 'reputation_score' | 'hit_rate_30d'>>(
      ((whaleRaw ?? []) as any[]).map((w: any) => [w.id, w]),
    );

    // ── 3. Aggregate activity ──────────────────────────────────
    const uniqueWhales = new Set(movements.map(m => m.whale_id).filter(Boolean));
    const buyMovs      = movements.filter(m => m.action === 'buy');
    const sellMovs     = movements.filter(m => m.action === 'sell');
    const totalBuyUsd  = buyMovs.reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalSellUsd = sellMovs.reduce((s, m) => s + (m.amount_usd ?? 0), 0);
    const totalUsd     = totalBuyUsd + totalSellUsd;

    const tokenSymbol  = movements[0].token_symbol;
    const tokenName    = movements[0].token_name;
    const isPumpFun    = movements[0].is_new_token || mint.endsWith('pump');

    // Smart money involvement
    const smartWhaleBuys  = buyMovs.filter(m => m.whale_id && whaleMap.get(m.whale_id)?.smart_money_flag).length;
    const smartWhaleUsd   = buyMovs
      .filter(m => m.whale_id && whaleMap.get(m.whale_id)?.smart_money_flag)
      .reduce((s, m) => s + (m.amount_usd ?? 0), 0);

    // Avg reputation of buying whales (weighted by volume)
    let repWeightedSum = 0, repWeightTotal = 0;
    for (const m of buyMovs) {
      if (!m.whale_id) continue;
      const w   = whaleMap.get(m.whale_id);
      const rep = w?.reputation_score ?? 50;
      const usd = m.amount_usd ?? 0;
      repWeightedSum  += rep * usd;
      repWeightTotal  += usd;
    }
    const avgBuyerRep = repWeightTotal > 0 ? repWeightedSum / repWeightTotal : 50;

    // ── 4. Confluence in 30m window ─────────────────────────────
    const enriched = movements.map(m => ({
      whale_id:    m.whale_id,
      token_mint:  m.token_mint,
      token_symbol: m.token_symbol,
      action:      m.action as 'buy' | 'sell',
      amount_usd:  m.amount_usd,
      is_pump_fun: isPumpFun,
      block_time:  m.block_time,
      smart_money: m.whale_id ? (whaleMap.get(m.whale_id)?.smart_money_flag ?? false) : false,
    }));

    const confluenceSignals = detectTokenAccumulation(enriched, 30, 2);
    const topConfluence     = confluenceSignals[0] ?? null;

    // ── 5. Build signal stack ──────────────────────────────────
    const signals: Array<{ name: string; direction: string; strength: number; description: string }> = [];

    // Buy pressure
    const buySellRatio = totalSellUsd > 0 ? totalBuyUsd / totalSellUsd : totalBuyUsd > 0 ? 10 : 1;
    const bpStrength   = clamp(Math.log2(buySellRatio + 0.1) * 30, 0, 100);
    signals.push({
      name:        'Buy/Sell Pressure',
      direction:   buySellRatio > 1.3 ? 'bullish' : buySellRatio < 0.7 ? 'bearish' : 'neutral',
      strength:    Math.round(bpStrength),
      description: `${buyMovs.length} buys ($${(totalBuyUsd/1000).toFixed(0)}K) vs ${sellMovs.length} sells ($${(totalSellUsd/1000).toFixed(0)}K)`,
    });

    // Smart money involvement
    if (smartWhaleBuys > 0) {
      signals.push({
        name:        'Smart Money Buying',
        direction:   'bullish',
        strength:    Math.min(100, smartWhaleBuys * 25),
        description: `${smartWhaleBuys} smart wallet${smartWhaleBuys > 1 ? 's' : ''} · $${(smartWhaleUsd/1000).toFixed(0)}K`,
      });
    }

    // Confluence cluster
    if (topConfluence) {
      signals.push({
        name:        'Whale Accumulation Cluster',
        direction:   'bullish',
        strength:    topConfluence.confluence_score,
        description: `${topConfluence.unique_whales} whales in 30m · score ${topConfluence.confluence_score}/100`,
      });
    }

    // Reputation of buyers
    signals.push({
      name:        'Buyer Reputation',
      direction:   avgBuyerRep >= 60 ? 'bullish' : avgBuyerRep <= 30 ? 'bearish' : 'neutral',
      strength:    Math.round(avgBuyerRep),
      description: `Avg reputation score: ${avgBuyerRep.toFixed(0)}/100 (volume-weighted)`,
    });

    // Unique whale count
    signals.push({
      name:        'Whale Breadth',
      direction:   uniqueWhales.size >= 3 ? 'bullish' : 'neutral',
      strength:    Math.min(100, uniqueWhales.size * 20),
      description: `${uniqueWhales.size} unique whale wallet${uniqueWhales.size !== 1 ? 's' : ''} active (4h)`,
    });

    // ── 6. Final probability ───────────────────────────────────
    const bullishSignals = signals.filter(s => s.direction === 'bullish');
    const bearishSignals = signals.filter(s => s.direction === 'bearish');

    const bullishScore = bullishSignals.reduce((s, sig) => s + sig.strength, 0);
    const bearishScore = bearishSignals.reduce((s, sig) => s + sig.strength, 0);

    const netScore     = bullishScore - bearishScore;
    const totalSignals = signals.length;

    // Logistic mapping
    const k   = 0.015;
    const raw = 1 / (1 + Math.exp(-k * netScore));
    // Clamp to [0.35, 0.85] — we never express extreme certainty
    const probability = clamp(raw, 0.35, 0.85);

    const direction =
      probability > 0.60 ? 'bullish' :
      probability < 0.40 ? 'bearish' : 'neutral';

    const hasSmartMoney = smartWhaleBuys > 0;
    const confidence =
      totalUsd < 10_000 || uniqueWhales.size < 2  ? 'insufficient_data' :
      hasSmartMoney && uniqueWhales.size >= 3      ? 'high' :
      uniqueWhales.size >= 2 || hasSmartMoney      ? 'medium' : 'low';

    return NextResponse.json({
      ok:          true,
      mint,
      symbol:      tokenSymbol,
      name:        tokenName,
      is_pump_fun: isPumpFun,
      direction,
      probability: Math.round(probability * 1000) / 1000,
      confidence,
      signals,
      whale_activity: {
        total_events:  movements.length,
        unique_whales: uniqueWhales.size,
        total_usd:     Math.round(totalUsd),
        buy_usd:       Math.round(totalBuyUsd),
        sell_usd:      Math.round(totalSellUsd),
        smart_money_buys: smartWhaleBuys,
        smart_money_usd:  Math.round(smartWhaleUsd),
      },
      confluence_score: topConfluence?.confluence_score ?? 0,
      computed_at:      now.toISOString(),
    });

  } catch (err) {
    console.error('[api/predict/token]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
