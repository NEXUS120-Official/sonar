import { NextRequest, NextResponse } from 'next/server';

interface SignalRule {
  direction: 'LONG' | 'SHORT';
  horizon_minutes: number;
  win_rate: number;
  profit_factor: number;
  avg_return: number;
  sample_size: number;
  note: string;
}

const BASE_MATRIX: Record<string, SignalRule[]> = {
  'distribution_wave': [
    { direction: 'SHORT', horizon_minutes: 5, win_rate: 0.667, profit_factor: 1.5, avg_return: 0.002, sample_size: 15, note: 'Scalping 5min' },
    { direction: 'LONG', horizon_minutes: 240, win_rate: 0.667, profit_factor: 1.5, avg_return: 0.008, sample_size: 15, note: 'Intraday 4h' },
    { direction: 'LONG', horizon_minutes: 1440, win_rate: 1.0, profit_factor: 999, avg_return: 0.024, sample_size: 15, note: 'Swing 24h' },
  ],
  'accumulation_wave': [
    { direction: 'LONG', horizon_minutes: 5, win_rate: 0.607, profit_factor: 1.3, avg_return: 0.001, sample_size: 28, note: 'Scalping 5min' },
    { direction: 'LONG', horizon_minutes: 240, win_rate: 0.821, profit_factor: 2.1, avg_return: 0.012, sample_size: 28, note: 'Intraday 4h' },
    { direction: 'LONG', horizon_minutes: 1440, win_rate: 0.964, profit_factor: 5.4, avg_return: 0.020, sample_size: 28, note: 'Swing 24h' },
  ],
  'flow_reversal': [
    { direction: 'SHORT', horizon_minutes: 30, win_rate: 0.750, profit_factor: 2.0, avg_return: 0.003, sample_size: 8, note: 'Reversal SHORT 30min' },
    { direction: 'LONG', horizon_minutes: 240, win_rate: 1.0, profit_factor: 999, avg_return: 0.004, sample_size: 8, note: 'Reversal LONG 4h' },
  ],
  'accumulation_medium': [
    { direction: 'SHORT', horizon_minutes: 15, win_rate: 1.0, profit_factor: 999, avg_return: -0.002, sample_size: 4, note: 'SHORT 15min' },
  ],
  'accumulation_strong': [
    { direction: 'SHORT', horizon_minutes: 15, win_rate: 1.0, profit_factor: 999, avg_return: -0.002, sample_size: 4, note: 'SHORT 15min' },
  ],
  'default': [
    { direction: 'LONG', horizon_minutes: 1440, win_rate: 0.80, profit_factor: 2.0, avg_return: 0.015, sample_size: 50, note: 'Default LONG 24h' },
  ],
};

function horizonLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  if (minutes < 1440) return `${minutes / 60}h`;
  return `${minutes / 1440}d`;
}

function getBestRule(alertType: string): SignalRule {
  const rules = BASE_MATRIX[alertType] || BASE_MATRIX['default'];
  const reliable = rules.filter(r => r.sample_size >= 10 && r.profit_factor >= 1.5);
  if (reliable.length > 0) {
    return reliable.reduce((best, r) => r.profit_factor > best.profit_factor ? r : best);
  }
  return rules.reduce((best, r) => r.sample_size > best.sample_size ? r : best);
}

function calculatePosition(rule: SignalRule, capital: number): number {
  if (rule.win_rate <= 0 || rule.profit_factor <= 1) return 0;
  const winLossRatio = rule.profit_factor / (1 - rule.win_rate + 0.001);
  const kelly = rule.win_rate - (1 - rule.win_rate) / winLossRatio;
  return capital * Math.max(0.02, Math.min(kelly / 2, 0.25));
}

export async function GET(req: NextRequest) {
  const alertType = req.nextUrl.searchParams.get('type') || 'distribution_wave';
  const capital = parseFloat(req.nextUrl.searchParams.get('capital') || '10000');

  const rule = getBestRule(alertType);
  const positionSize = calculatePosition(rule, capital);

  const signal = {
    alert_type: alertType,
    direction: rule.direction,
    horizon_minutes: rule.horizon_minutes,
    horizon_label: horizonLabel(rule.horizon_minutes),
    entry_price: 'market',
    position_size_eur: positionSize.toFixed(2),
    win_rate: (rule.win_rate * 100).toFixed(1) + '%',
    profit_factor: rule.profit_factor >= 999 ? '∞' : rule.profit_factor.toFixed(2),
    avg_return: (rule.avg_return * 100).toFixed(2) + '%',
    sample_size: rule.sample_size,
    note: rule.note,
    timestamp: new Date().toISOString(),
    methodology: 'adaptive_signal_dispatcher_v1',
  };

  return NextResponse.json({ signal });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const alertType = body.alert_type || 'default';
    const capital = body.capital || 10000;

    const rule = getBestRule(alertType);
    const positionSize = calculatePosition(rule, capital);

    const signal = {
      alert_type: alertType,
      direction: rule.direction,
      horizon_minutes: rule.horizon_minutes,
      horizon_label: horizonLabel(rule.horizon_minutes),
      position_size_eur: positionSize.toFixed(2),
      win_rate: (rule.win_rate * 100).toFixed(1) + '%',
      profit_factor: rule.profit_factor >= 999 ? '∞' : rule.profit_factor.toFixed(2),
      sample_size: rule.sample_size,
      note: rule.note,
      timestamp: new Date().toISOString(),
    };

    return NextResponse.json({ signal });
  } catch (error) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
