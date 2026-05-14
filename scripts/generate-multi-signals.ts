import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

interface AlertData {
  inflow_usd: number;
  outflow_usd: number;
  net_flow_usd: number;
  signal_tier: 'weak' | 'medium' | 'strong';
  threshold_used: number;
}

async function generateMultiSignals() {
  console.log('🔔 Generazione segnali multi-soglia...\n');

  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: movements } = await supabase
    .from('movements')
    .select('*')
    .in('flow_type', ['exchange_deposit', 'exchange_withdrawal'])
    .gte('block_time', since)
    .order('block_time', { ascending: false });

  if (!movements || movements.length === 0) {
    console.log('  Nessun movimento recente trovato.');
    return;
  }

  console.log(`  Movimenti trovati: ${movements.length}`);

  const windows: Record<string, { inflow: number; outflow: number }> = {};

  for (const m of movements) {
    const blockTime = new Date(m.block_time);
    const windowKey = new Date(
      Math.floor(blockTime.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000)
    ).toISOString();

    if (!windows[windowKey]) {
      windows[windowKey] = { inflow: 0, outflow: 0 };
    }

    if (m.flow_type === 'exchange_deposit') {
      windows[windowKey].inflow += m.amount_usd || 0;
    } else if (m.flow_type === 'exchange_withdrawal') {
      windows[windowKey].outflow += m.amount_usd || 0;
    }
  }

  console.log(`  Finestre di 5 minuti: ${Object.keys(windows).length}`);

  const thresholds = [
    { tier: 'weak' as const, amount: 25000 },
    { tier: 'medium' as const, amount: 100000 },
    { tier: 'strong' as const, amount: 500000 },
  ];

  let alertsCreated = 0;

  for (const [windowKey, data] of Object.entries(windows)) {
    const net = data.outflow - data.inflow;

    for (const threshold of thresholds) {
      if (Math.abs(net) > threshold.amount) {
        const direction = net > 0 ? 'distribution' : 'accumulation';
        const alertType = `${direction}_${threshold.tier}`;
        
        const alertData: AlertData = {
          inflow_usd: data.inflow,
          outflow_usd: data.outflow,
          net_flow_usd: net,
          signal_tier: threshold.tier,
          threshold_used: threshold.amount,
        };

        const title = net > 0 
          ? `Distribution ${threshold.tier} — $${(net / 1e6).toFixed(2)}M net exchange inflow`
          : `Accumulation ${threshold.tier} — $${(Math.abs(net) / 1e6).toFixed(2)}M net exchange outflow`;
        
        const body = `Smart money ${net > 0 ? 'deposited' : 'withdrew'} $${(Math.abs(net) / 1e6).toFixed(2)}M. Tier: ${threshold.tier}.`;

        // Deduplica
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { count: existingCount } = await supabase
          .from('alerts')
          .select('*', { count: 'exact', head: true })
          .eq('alert_type', alertType)
          .gte('created_at', fiveMinAgo);

        if (existingCount && existingCount > 0) continue;

        // 1. Crea l'alert
        const { error: alertErr, data: insertedAlert } = await supabase
          .from('alerts')
          .insert({
            alert_type: alertType,
            severity: threshold.tier === 'strong' ? 'major' : threshold.tier === 'medium' ? 'significant' : 'notable',
            title,
            body,
            data: alertData,
            sent_telegram_free: true,
            created_at: new Date().toISOString(),
          })
          .select('id, alert_type')
          .single();

        if (alertErr) {
          console.log(`  ❌ Errore creazione alert: ${alertErr.message}`);
          continue;
        }

        // 2. Chiama l'API dei segnali per ottenere la raccomandazione
        try {
          const signalRes = await fetch(`${BASE_URL}/api/signals`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ alert_type: alertType, capital: 10000 }),
          });
          
          if (signalRes.ok) {
            const { signal: tradeSignal } = await signalRes.json();
            
            // 3. Salva il trade signal nel database (nella stessa tabella alerts o in una nuova)
            const { error: signalErr } = await supabase
              .from('alerts')
              .update({
                data: {
                  ...alertData,
                  trade_signal: tradeSignal,
                },
              })
              .eq('id', insertedAlert.id);

            if (!signalErr) {
              console.log(`  ✅ ${threshold.tier}: ${title}`);
              console.log(`     → TRADE SIGNAL: ${tradeSignal.direction} ${tradeSignal.horizon_label} | WR: ${tradeSignal.win_rate} | Size: €${tradeSignal.position_size_eur}`);
              alertsCreated++;
            }
          }
        } catch (e) {
          console.log(`  ⚠️ Errore chiamata signal API: ${e}`);
        }
      }
    }
  }

  console.log(`\n✅ Totale alert con trade signal: ${alertsCreated}`);
}

generateMultiSignals().catch(console.error);
