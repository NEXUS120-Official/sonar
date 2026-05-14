import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

async function main() {
  console.log('🔄 Backfill trade signals per vecchi alert...\n');

  // Prendi tutti gli alert di trading (escludi weekly_report) che NON hanno già un trade_signal
  const { data: alerts } = await supabase
    .from('alerts')
    .select('id, alert_type, data')
    .neq('alert_type', 'weekly_report')
    .is('data->trade_signal', null)
    .order('created_at', { ascending: true });

  if (!alerts || alerts.length === 0) {
    console.log('✅ Tutti gli alert hanno già un trade signal.');
    return;
  }

  console.log(`Trovati ${alerts.length} alert senza trade signal.`);

  let updated = 0;
  for (const alert of alerts) {
    try {
      const signalRes = await fetch(`${BASE_URL}/api/signals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alert_type: alert.alert_type, capital: 10000 }),
      });

      if (!signalRes.ok) {
        console.log(`  ⚠️ Errore API per ${alert.alert_type}: HTTP ${signalRes.status}`);
        continue;
      }

      const { signal: tradeSignal } = await signalRes.json();

      const existingData = alert.data || {};
      const newData = { ...existingData, trade_signal: tradeSignal };

      const { error } = await supabase
        .from('alerts')
        .update({ data: newData })
        .eq('id', alert.id);

      if (error) {
        console.log(`  ❌ Errore update: ${error.message}`);
      } else {
        updated++;
        console.log(`  ✅ ${alert.alert_type}: ${tradeSignal.direction} ${tradeSignal.horizon_label} (WR: ${tradeSignal.win_rate})`);
      }
    } catch (e) {
      console.log(`  ❌ Errore su ${alert.alert_type}: ${e}`);
    }
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`\n✅ Aggiornati ${updated} alert su ${alerts.length}.`);
}

main().catch(console.error);
