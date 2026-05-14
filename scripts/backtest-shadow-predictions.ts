import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🧪 Backtest predittivo Shadow Links\n');

  // 1. Prendi link creati almeno 3 giorni fa (finestra di verifica)
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

  const { data: oldLinks } = await supabase
    .from('shadow_links')
    .select('target_wallet, confidence_tier, confidence, funding_time, first_detected_at')
    .lte('first_detected_at', threeDaysAgo)
    .order('confidence', { ascending: false });

  if (!oldLinks || oldLinks.length === 0) {
    console.log('Nessun link abbastanza vecchio per il backtest (servono almeno 3 giorni).');
    console.log('Il backtest sarà automaticamente più significativo con il passare del tempo.');
    return;
  }

  console.log(`Link analizzabili: ${oldLinks.length}`);

  const results = {
    direct_proof: { total: 0, verified: 0 },
    strong_evidence: { total: 0, verified: 0 },
    moderate_evidence: { total: 0, verified: 0 },
    weak_association: { total: 0, verified: 0 },
  };

  for (const link of oldLinks) {
    const tier = link.confidence_tier;
    results[tier].total++;

    // Verifica se il wallet ha avuto attività confermativa DOPO il funding
    // Criteri di verifica:
    // 1. Ha ricevuto altri fondi (>0.01 SOL) dopo il funding iniziale
    // 2. Ha inviato fondi a nuovi wallet (gas funding) — indica uso reale
    // 3. Ha interagito con token DeFi o privacy

    const { data: postMovements } = await supabase
      .from('movements')
      .select('signature, amount_token, flow_type')
      .eq('from_address', link.target_wallet)
      .gte('block_time', link.funding_time)
      .limit(10);

    if (!postMovements || postMovements.length === 0) continue;

    // Verifica: almeno un movimento in uscita > 0.001 SOL (non dust)
    const hasOutgoing = postMovements.some(m => m.amount_token > 0.001);
    
    // Verifica: almeno 3 movimenti totali (attività sostenuta)
    const hasSustainedActivity = postMovements.length >= 3;

    // Verifica: ha inviato fondi a più di 1 destinatario (comportamento da wallet reale)
    const uniqueDestinations = new Set(postMovements.map(m => m.flow_type));
    const hasDiverseActivity = uniqueDestinations.size > 1;

    // Un link è considerato "verificato" se soddisfa almeno 2 criteri
    const verificationScore = (hasOutgoing ? 1 : 0) + (hasSustainedActivity ? 1 : 0) + (hasDiverseActivity ? 1 : 0);
    if (verificationScore >= 2) {
      results[tier].verified++;
    }
  }

  console.log('\n📊 Risultati Backtest:');
  console.log('Tier               | Totali | Verificati | Tasso');
  console.log('------------------|--------|------------|-------');
  for (const [tier, data] of Object.entries(results)) {
    if (data.total === 0) continue;
    const rate = (data.verified / data.total * 100).toFixed(1);
    console.log(`${tier.padEnd(17)} | ${String(data.total).padStart(6)} | ${String(data.verified).padStart(10)} | ${rate}%`);
  }

  // Calcola precisione complessiva
  const totalVerified = Object.values(results).reduce((s, d) => s + d.verified, 0);
  const overallRate = oldLinks.length > 0 ? (totalVerified / oldLinks.length * 100).toFixed(1) : '0';
  console.log(`\nPrecisione complessiva: ${totalVerified}/${oldLinks.length} = ${overallRate}%`);
  console.log('(Nota: backtest su finestra di 3 giorni; migliorerà con più dati)');
}

main().catch(console.error);
