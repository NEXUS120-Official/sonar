// ============================================================
// SONAR — Multi-Threshold Signal Generator
// Genera segnali a 3 soglie ($25K, $100K, $500K)
// + Pair Trade SOL-BTC
// Da eseguire ogni 30 minuti
// ============================================================

import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

interface AlertData {
  inflow_usd: number;
  outflow_usd: number;
  net_flow_usd: number;
  signal_tier: 'weak' | 'medium' | 'strong';
  threshold_used: number;
}

async function generateMultiSignals() {
  console.log('🔔 Generazione segnali multi-soglia...\n');

  // 1. Prendi i movimenti exchange degli ultimi 30 minuti
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

  // 2. Aggrega per finestra di 5 minuti
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

  // 3. Per ogni finestra, genera segnali a 3 soglie
  const thresholds = [
    { tier: 'weak' as const, amount: 25000 },
    { tier: 'medium' as const, amount: 100000 },
    { tier: 'strong' as const, amount: 500000 },
  ];

  let alertsCreated = 0;

  for (const [windowKey, data] of Object.entries(windows)) {
    const net = data.outflow - data.inflow;
    
    for (const threshold of thresholds) {
      // Distribution wave: net positivo > soglia
      if (net > threshold.amount) {
        const alertData: AlertData = {
          inflow_usd: data.inflow,
          outflow_usd: data.outflow,
          net_flow_usd: net,
          signal_tier: threshold.tier,
          threshold_used: threshold.amount,
        };

        const title = `Distribution ${threshold.tier} — $${(net / 1e6).toFixed(2)}M net exchange inflow`;
        const body = `Smart money deposited $${(data.inflow / 1e6).toFixed(2)}M to exchanges vs withdrew $${(data.outflow / 1e6).toFixed(2)}M — net inflow of $${(net / 1e6).toFixed(2)}M. Tier: ${threshold.tier}.`;

        // Controlla se esiste già un alert simile
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { count: existingCount } = await supabase
          .from('alerts')
          .select('*', { count: 'exact', head: true })
          .eq('alert_type', `distribution_${threshold.tier}`)
          .gte('created_at', fiveMinAgo);

        if (!existingCount || existingCount === 0) {
          const { error } = await supabase.from('alerts').insert({
            alert_type: `distribution_${threshold.tier}`,
            severity: threshold.tier === 'strong' ? 'major' : threshold.tier === 'medium' ? 'significant' : 'notable',
            title,
            body,
            data: alertData,
            sent_telegram_free: true,
            created_at: new Date().toISOString(),
          });

          if (!error) {
            console.log(`  ✅ ${threshold.tier}: ${title}`);
            alertsCreated++;
          }
        }
      }

      // Accumulation wave: net negativo < -soglia
      if (net < -threshold.amount) {
        const alertData: AlertData = {
          inflow_usd: data.inflow,
          outflow_usd: data.outflow,
          net_flow_usd: net,
          signal_tier: threshold.tier,
          threshold_used: threshold.amount,
        };

        const title = `Accumulation ${threshold.tier} — $${(Math.abs(net) / 1e6).toFixed(2)}M net exchange outflow`;
        const body = `Smart money withdrew $${(data.outflow / 1e6).toFixed(2)}M from exchanges vs deposited $${(data.inflow / 1e6).toFixed(2)}M — net outflow of $${(Math.abs(net) / 1e6).toFixed(2)}M. Tier: ${threshold.tier}.`;

        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { count: existingCount } = await supabase
          .from('alerts')
          .select('*', { count: 'exact', head: true })
          .eq('alert_type', `accumulation_${threshold.tier}`)
          .gte('created_at', fiveMinAgo);

        if (!existingCount || existingCount === 0) {
          const { error } = await supabase.from('alerts').insert({
            alert_type: `accumulation_${threshold.tier}`,
            severity: threshold.tier === 'strong' ? 'major' : threshold.tier === 'medium' ? 'significant' : 'notable',
            title,
            body,
            data: alertData,
            sent_telegram_free: true,
            created_at: new Date().toISOString(),
          });

          if (!error) {
            console.log(`  ✅ ${threshold.tier}: ${title}`);
            alertsCreated++;
          }
        }
      }
    }
  }

  console.log(`\n✅ Totale alert creati: ${alertsCreated}`);
}

generateMultiSignals().catch(console.error);
