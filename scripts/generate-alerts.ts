// ============================================================
// SONAR — Alert Generator (basato su movimenti esistenti)
// ============================================================
// Replica la logica originale degli alert usando i movimenti
// già classificati nel database.
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
  net_outflow_usd: number;
  ratio?: string;
  current_volume_usd?: number;
  baseline_volume_usd?: number;
}

async function generateAlerts() {
  console.log('🔔 Generazione alert dai movimenti esistenti...\n');

  // 1. Prendi i movimenti exchange degli ultimi 30 minuti non ancora processati
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
  const windows: Record<string, { inflow: number; outflow: number; movements: typeof movements }> = {};

  for (const m of movements) {
    const blockTime = new Date(m.block_time);
    const windowKey = new Date(
      Math.floor(blockTime.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000)
    ).toISOString();

    if (!windows[windowKey]) {
      windows[windowKey] = { inflow: 0, outflow: 0, movements: [] };
    }

    if (m.flow_type === 'exchange_deposit') {
      windows[windowKey].inflow += m.amount_usd || 0;
    } else if (m.flow_type === 'exchange_withdrawal') {
      windows[windowKey].outflow += m.amount_usd || 0;
    }
    windows[windowKey].movements.push(m);
  }

  console.log(`  Finestre di 5 minuti: ${Object.keys(windows).length}`);

  // 3. Per ogni finestra, genera alert se il net flow supera la soglia
  let alertsCreated = 0;

  for (const [windowKey, data] of Object.entries(windows)) {
    const net = data.outflow - data.inflow;
    
    // Logica originale: distribution_wave se net > $100K
    if (net > 100000) {
      const alertData: AlertData = {
        inflow_usd: data.inflow,
        outflow_usd: data.outflow,
        net_outflow_usd: net,
      };

      const title = `Distribution wave — $${(net / 1e6).toFixed(2)}M net exchange inflow`;
      const body = `Smart money deposited $${(data.inflow / 1e6).toFixed(2)}M to exchanges vs withdrew $${(data.outflow / 1e6).toFixed(2)}M — net inflow of $${(net / 1e6).toFixed(2)}M. This pattern suggests large holders are moving assets to exchanges, potentially preparing to sell.`;

      // Controlla se esiste già un alert simile negli ultimi 5 minuti
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { count: existingCount } = await supabase
        .from('alerts')
        .select('*', { count: 'exact', head: true })
        .eq('alert_type', 'distribution_wave')
        .gte('created_at', fiveMinAgo);

      if (existingCount && existingCount > 0) {
        continue; // Già inviato un alert simile
      }

      const { error } = await supabase.from('alerts').insert({
        alert_type: 'distribution_wave',
        severity: net > 500000 ? 'significant' : 'notable',
        title,
        body,
        data: alertData,
        sent_telegram_free: true,
        created_at: new Date().toISOString(),
      });

      if (error) {
        console.log(`  ⚠️  Errore inserimento alert: ${error.message}`);
      } else {
        console.log(`  ✅ Alert creato: ${title}`);
        alertsCreated++;
      }
    }

    // Logica originale: accumulation_wave se net < -$100K
    if (net < -100000) {
      const alertData: AlertData = {
        inflow_usd: data.inflow,
        outflow_usd: data.outflow,
        net_outflow_usd: net,
      };

      const title = `Accumulation wave — $${(Math.abs(net) / 1e6).toFixed(2)}M net exchange outflow`;
      const body = `Smart money withdrew $${(data.outflow / 1e6).toFixed(2)}M from exchanges vs deposited $${(data.inflow / 1e6).toFixed(2)}M — net outflow of $${(Math.abs(net) / 1e6).toFixed(2)}M. This pattern suggests large holders are accumulating off exchange.`;

      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const { count: existingCount } = await supabase
        .from('alerts')
        .select('*', { count: 'exact', head: true })
        .eq('alert_type', 'accumulation_wave')
        .gte('created_at', fiveMinAgo);

      if (existingCount && existingCount > 0) {
        continue;
      }

      const { error } = await supabase.from('alerts').insert({
        alert_type: 'accumulation_wave',
        severity: Math.abs(net) > 500000 ? 'significant' : 'notable',
        title,
        body,
        data: alertData,
        sent_telegram_free: true,
        created_at: new Date().toISOString(),
      });

      if (error) {
        console.log(`  ⚠️  Errore inserimento alert: ${error.message}`);
      } else {
        console.log(`  ✅ Alert creato: ${title}`);
        alertsCreated++;
      }
    }
  }

  console.log(`\n✅ Totale alert creati: ${alertsCreated}`);
}

generateAlerts().catch(console.error);
