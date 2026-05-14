import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { SovereignRpcClient } from '../src/lib/sovereign/rpc-client';
import { GLOBAL_MINT_ENRICHMENT_QUEUE, persistEnrichmentBatchToDb } from '../src/lib/sovereign/mint-enricher';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🔬 Token-2022 Deep Readiness — Arricchimento proattivo di tutti i mint...');

  // 1. Raccogli TUTTI i mint distinti da movements e token_movements
  const { data: movMints } = await supabase
    .from('movements')
    .select('token')
    .not('token', 'eq', 'SOL')
    .not('token', 'eq', 'USDC')
    .order('block_time', { ascending: false })
    .limit(2000);

  const { data: tokMints } = await supabase
    .from('token_movements')
    .select('token_mint')
    .order('created_at', { ascending: false })
    .limit(2000);

  const allMints = [
    ...(movMints ?? []).map(r => r.token),
    ...(tokMints ?? []).map(r => r.token_mint),
  ];
  const uniqueMints = [...new Set(allMints)].filter(Boolean);

  // 2. Escludi quelli già arricchiti
  const { data: enriched } = await supabase
    .from('sovereign_mint_enrichments')
    .select('mint');

  const enrichedSet = new Set((enriched ?? []).map(r => r.mint));
  const toEnrich = uniqueMints.filter(m => !enrichedSet.has(m));

  console.log(`Mint totali: ${uniqueMints.length}`);
  console.log(`Già arricchiti: ${enrichedSet.size}`);
  console.log(`Da arricchire: ${toEnrich.length}`);

  if (toEnrich.length === 0) {
    console.log('✅ Tutti i mint sono già arricchiti.');
    return;
  }

  // 3. Inserisci nella coda globale
  for (const mint of toEnrich) {
    GLOBAL_MINT_ENRICHMENT_QUEUE.enqueue(mint);
  }

  // 4. Usa la RPC pubblica per l'ispezione (Alchemy free non supporta jsonParsed su getAccountInfo)
  const RPC_URL = 'https://api.mainnet-beta.solana.com';
  const client = new SovereignRpcClient(RPC_URL);

  // 5. Svuota la coda con delay adeguato (500ms per non sovraccaricare la RPC pubblica)
  const { enriched: results, errors } = await GLOBAL_MINT_ENRICHMENT_QUEUE.drainAndEnrich(client, 500);

  console.log(`\n✅ Arricchiti ${results.length} mint, errori: ${errors}`);

  // 6. Persisti nel database
  await persistEnrichmentBatchToDb(results);
  console.log('✅ Persistiti nel DB.');

  // 7. Mostra quanti sono Token-2022
  const token2022 = results.filter(r => r.token_program === 'token_2022');
  console.log(`Token-2022 rilevati: ${token2022.length}`);
  token2022.forEach(t => console.log(`   ${t.mint.slice(0,12)}... fee:${t.has_transfer_fee} conf:${t.has_confidential_transfer} hook:${t.has_transfer_hook}`));
}

main().catch(console.error);
