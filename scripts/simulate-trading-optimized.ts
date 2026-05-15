import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Carica prezzi SOL 1m
const pricesRaw = readFileSync(path.resolve(__dirname, '..', 'data', 'SOLUSDT_1m.csv'), 'utf8')
  .split('\n').slice(1).filter(l => l.trim());
const prices: { timestamp: Date; close: number }[] = [];
for (const line of pricesRaw) {
  const [ts, , , , c] = line.split(',');
  if (!ts || !c) continue;
  prices.push({ timestamp: new Date(ts), close: parseFloat(c) });
}
prices.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

// ATR realistico per SOL: 2% giornaliero, 0.5% per 15min
function getATR(horizonMin: number): number {
  if (horizonMin <= 30) return 0.005;  // 0.5% per scalping
  if (horizonMin <= 240) return 0.01;  // 1% per intraday
  return 0.02;                         // 2% per swing
}

const SL_ATR_MULT = 2.0;
const TP_ATR_MULT = 3.0;
const MAX_ADDITIONS = 3;
const SIZE_DECAY = 0.5;
const MIN_VOLUME_USD = 50000; // soglia più bassa

function findPriceAt(targetTime: Date, maxDiffMs = 300_000): number | null {
  let closest = null; let minDiff = Infinity;
  for (const p of prices) {
    const diff = Math.abs(p.timestamp.getTime() - targetTime.getTime());
    if (diff < minDiff && diff <= maxDiffMs) { minDiff = diff; closest = p.close; }
  }
  return closest;
}

function simulateTradeOutcome(entryTime: Date, entryPrice: number, direction: string, horizonMin: number, slPct: number, tpPct: number): { exitPrice: number; exitTime: Date } {
  const endTime = new Date(entryTime.getTime() + horizonMin * 60_000);
  const slPrice = direction === 'LONG' ? entryPrice * (1 - slPct/100) : entryPrice * (1 + slPct/100);
  const tpPrice = direction === 'LONG' ? entryPrice * (1 + tpPct/100) : entryPrice * (1 - tpPct/100);

  for (const p of prices) {
    if (p.timestamp <= entryTime) continue;
    if (p.timestamp > endTime) break;
    if (direction === 'LONG') {
      if (p.close <= slPrice) return { exitPrice: slPrice, exitTime: p.timestamp };
      if (p.close >= tpPrice) return { exitPrice: tpPrice, exitTime: p.timestamp };
    } else {
      if (p.close >= slPrice) return { exitPrice: slPrice, exitTime: p.timestamp };
      if (p.close <= tpPrice) return { exitPrice: tpPrice, exitTime: p.timestamp };
    }
  }
  const exitPrice = findPriceAt(endTime, 300_000) || entryPrice;
  return { exitPrice, exitTime: endTime };
}

async function main() {
  console.log('📊 SIMULAZIONE OTTIMIZZATA (corretta) — 1.000€\n');

  const { data: alerts } = await supabase
    .from('alerts')
    .select('id, alert_type, data, created_at')
    .not('data->trade_signal', 'is', null)
    .order('created_at', { ascending: true });

  if (!alerts || alerts.length === 0) { console.log('Nessun trade signal.'); return; }

  let capital = 1000;
  const closedTrades: any[] = [];
  const activePositions: Map<string, { entryTime: Date; entryPrice: number; totalSize: number; additions: number; direction: string; horizonMin: number; alertType: string }> = new Map();

  for (const alert of alerts) {
    const ts = alert.data?.trade_signal;
    if (!ts) continue;

    const created = new Date(alert.created_at);
    const alertType = alert.alert_type;
    const data = alert.data || {};

    // Filtro volume con fallback: se i dati non ci sono, accetta il segnale
    const volume = (data.inflow_usd || 0) + (data.outflow_usd || 0);
    if (volume > 0 && volume < MIN_VOLUME_USD) continue; // scarta solo se volume è esplicito e basso

    const existing = activePositions.get(alertType);
    
    if (existing) {
      // Posizione già aperta: pyramiding
      if (existing.additions >= MAX_ADDITIONS) continue;
      if (created.getTime() - existing.entryTime.getTime() > existing.horizonMin * 60_000) {
        // Scaduta: chiudi e apri nuova sotto
        const exitPrice = findPriceAt(new Date(existing.entryTime.getTime() + existing.horizonMin * 60_000), 300_000) || existing.entryPrice;
        let ret = existing.direction === 'SHORT' ? (existing.entryPrice - exitPrice) / existing.entryPrice : (exitPrice - existing.entryPrice) / existing.entryPrice;
        const pnl = existing.totalSize * ret;
        capital += pnl;
        closedTrades.push({ entry: existing.entryTime, exit: new Date(existing.entryTime.getTime() + existing.horizonMin * 60_000), type: alertType, dir: existing.direction, horizon: ts.horizon_label, entryPrice: existing.entryPrice, exitPrice, ret: (ret*100).toFixed(2)+'%', pnl: pnl.toFixed(2), capital: capital.toFixed(2), additions: existing.additions });
        activePositions.delete(alertType);
      } else {
        const additionSize = existing.totalSize * SIZE_DECAY;
        existing.totalSize += additionSize;
        existing.additions++;
        console.log(`  ➕ ${alertType}: +${additionSize.toFixed(2)}€ (tot: ${existing.totalSize.toFixed(2)}€, add:${existing.additions})`);
        continue;
      }
    }

    const entryPrice = findPriceAt(created, 600_000);
    if (!entryPrice) continue;

    const atr = getATR(ts.horizon_minutes);
    const slPct = SL_ATR_MULT * atr * 100;
    const tpPct = TP_ATR_MULT * atr * 100;

    const positionSize = capital * Math.min(0.25, Math.max(0.02, parseFloat(ts.position_size_eur) / capital));

    activePositions.set(alertType, {
      entryTime: created, entryPrice, totalSize: positionSize, additions: 0,
      direction: ts.direction, horizonMin: ts.horizon_minutes, alertType
    });
  }

  // Chiudi posizioni aperte
  for (const [type, pos] of activePositions) {
    const exitTime = new Date(pos.entryTime.getTime() + pos.horizonMin * 60_000);
    const exitPrice = findPriceAt(exitTime, 300_000) || pos.entryPrice;
    let ret = pos.direction === 'SHORT' ? (pos.entryPrice - exitPrice) / pos.entryPrice : (exitPrice - pos.entryPrice) / pos.entryPrice;
    const pnl = pos.totalSize * ret;
    capital += pnl;
    closedTrades.push({ entry: pos.entryTime, exit: exitTime, type: pos.alertType, dir: pos.direction, horizon: '1d', entryPrice: pos.entryPrice, exitPrice, ret: (ret*100).toFixed(2)+'%', pnl: pnl.toFixed(2), capital: capital.toFixed(2), additions: pos.additions });
  }

  // Riepilogo
  const wins = closedTrades.filter((t: any) => parseFloat(t.pnl) > 0).length;
  const total = closedTrades.length;
  const wr = total > 0 ? (wins / total * 100).toFixed(1) : '0';
  const totalPnl = capital - 1000;
  const gains = closedTrades.filter((t: any) => parseFloat(t.pnl) > 0).reduce((s: number, t: any) => s + parseFloat(t.pnl), 0);
  const losses = closedTrades.filter((t: any) => parseFloat(t.pnl) < 0).reduce((s: number, t: any) => s + Math.abs(parseFloat(t.pnl)), 0);
  const pf = losses > 0 ? (gains / losses).toFixed(2) : '∞';

  console.log(`\n=== RIEPILOGO SIMULAZIONE OTTIMIZZATA ===`);
  console.log(`Capitale iniziale: 1.000,00 €`);
  console.log(`Capitale finale:   ${capital.toFixed(2)} € (${(totalPnl>=0?'+':'')}${totalPnl.toFixed(2)} €)`);
  console.log(`Rendimento:        ${((capital/1000-1)*100).toFixed(2)}%`);
  console.log(`Trade totali:      ${total}`);
  console.log(`Vittorie:          ${wins} (${wr}%)`);
  console.log(`Profit Factor:     ${pf}`);
  console.log(`Trade con aggiunte: ${closedTrades.filter((t: any) => t.additions > 0).length}`);

  console.log(`\nUltimi 10 trade:`);
  closedTrades.slice(-10).forEach((t: any) => {
    console.log(`${t.entry.toISOString().slice(0,16)} | ${t.type.padEnd(20)} | ${t.dir} ${t.horizon} | ${t.ret} | P&L: ${t.pnl}€ | Capital: ${t.capital}€ | Add:${t.additions}`);
  });
}

main().catch(console.error);
