#!/usr/bin/env tsx
// Seed one fresh unsent alert of each type for send-alerts E2E test
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function main() {
  const alerts = [
    {
      alert_type: 'accumulation_wave',
      severity: 'significant',
      title: 'Accumulation wave — $600K net exchange outflow',
      body: 'Smart money withdrew $600K from exchanges vs deposited $50K — net outflow of $550K. This pattern suggests large holders are accumulating off exchange.',
      ai_analysis: 'Two distinct wallets withdrew $300K each from Binance within the same hour, a pattern consistent with coordinated accumulation ahead of a catalyst.',
      data: { net_outflow_usd: 550000, inflow_usd: 50000, outflow_usd: 600000 },
      movement_ids: null,
      sent_telegram_free: false,
      sent_telegram_premium: false,
      sent_at: null,
    },
  ];

  const { data, error } = await (db as any)
    .from('alerts')
    .insert(alerts)
    .select('id, alert_type, severity');

  if (error) { console.error('❌', error.message); process.exit(1); }
  const rows = data as any[];
  console.log(`✅ Seeded ${rows.length} alert(s):`);
  rows.forEach((r: any) => console.log(`  ${r.id}  ${r.alert_type} (${r.severity})`));
}

main().catch(console.error);
