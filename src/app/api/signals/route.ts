import { NextRequest, NextResponse } from 'next/server';

const MATRIX: Record<string, { direction: string; horizon: number; wr: number; pf: number; note: string }> = {
  'distribution_wave': { direction: 'SHORT', horizon: 240, wr: 0.763, pf: 2.17, note: 'Segnale più forte. Funziona su 5 asset.' },
  'accumulation_wave': { direction: 'SHORT', horizon: 1440, wr: 0.526, pf: 1.71, note: 'SHORT a 24h su accumulation è profittevole' },
  'exchange_spike': { direction: 'SHORT', horizon: 240, wr: 0.25, pf: 3.91, note: 'Dati insufficienti (4 trade). Usare con cautela.' },
  'flow_reversal': { direction: 'LONG', horizon: 240, wr: 1.0, pf: Infinity, note: 'Dati insufficienti (8 trade). Monitorare.' },
};

export async function GET(req: NextRequest) {
  const alertType = req.nextUrl.searchParams.get('type') || 'distribution_wave';
  const entryPrice = parseFloat(req.nextUrl.searchParams.get('entry') || '95.0');
  const capital = parseFloat(req.nextUrl.searchParams.get('capital') || '1000');
  
  const rule = MATRIX[alertType] || MATRIX['distribution_wave'];
  
  const kellyFraction = 0.445;
  const positionSize = capital * kellyFraction;
  const expectedReturn = positionSize * (rule.wr * (rule.pf / (rule.pf + 1)) - (1 - rule.wr));
  
  const signal = {
    alert_type: alertType,
    direction: rule.direction,
    horizon_minutes: rule.horizon,
    entry_price: entryPrice,
    position_size_eur: positionSize.toFixed(2),
    expected_return_eur: expectedReturn.toFixed(2),
    win_rate: (rule.wr * 100).toFixed(1) + '%',
    profit_factor: rule.pf === Infinity ? '∞' : rule.pf.toFixed(2),
    note: rule.note,
    timestamp: new Date().toISOString(),
  };
  
  return NextResponse.json({ signal });
}
