import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const RPC_URL = process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function fetchJson(method: string, params: any[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

async function main() {
  console.log('🔍 Backfill orario transazioni recenti delle whale...');

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: whales } = await supabase
    .from('whales')
    .select('address')
    .eq('is_active', true)
    .limit(100); // max 100 whale per esecuzione

  if (!whales || whales.length === 0) {
    console.log('❌ Nessuna whale trovata');
    return;
  }

  console.log(`🐋 Processo ${whales.length} whale...`);
  let inserted = 0;

  for (const whale of whales) {
    try {
      const sigs = await fetchJson('getSignaturesForAddress', [whale.address, { limit: 5 }]); // solo 5 tx
      if (!sigs.result || sigs.result.length === 0) continue;

      for (const sig of sigs.result) {
        if (sig.err) continue;

        // Controlla se già presente in raw_transactions
        const { count } = await supabase
          .from('raw_transactions')
          .select('*', { count: 'exact', head: true })
          .eq('signature', sig.signature);

        if (count && count > 0) continue;

        // Recupera dettaglio transazione
        const tx = await fetchJson('getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
        ]);
        if (!tx.result) continue;

        const blockTime = sig.blockTime ? new Date(sig.blockTime * 1000).toISOString() : new Date().toISOString();
        const { error } = await supabase.from('raw_transactions').insert({
          signature: sig.signature,
          raw_json: tx.result,
          source: 'sovereign_rpc_manual',
          block_time: blockTime,
          slot: tx.result.slot ?? null,
          status: tx.result.meta?.err ? 'failed' : 'success',
          fee: tx.result.meta?.fee ?? null,
          is_vote: false,
        });
        if (!error) inserted++;
      }
      await new Promise(r => setTimeout(r, 200)); // rate limit
    } catch (e: any) {
      console.log(`  ⚠️ Errore: ${e.message}`);
    }
  }
  console.log(`✅ Inserite ${inserted} nuove raw_transactions.`);
}

main().catch(console.error);
