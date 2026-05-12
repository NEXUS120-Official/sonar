import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function fetchJson(method: string, params: any[]) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

async function main() {
  console.log('🔍 Backfill arricchito via Alchemy RPC');

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { data: whales } = await supabase
    .from('whales')
    .select('address')
    .eq('is_active', true)
    .limit(10);

  if (!whales || whales.length === 0) {
    console.log('❌ Nessuna whale trovata');
    return;
  }

  console.log(`🐋 ${whales.length} whale da controllare`);
  let inserted = 0;

  for (const whale of whales) {
    try {
      const sigs = await fetchJson('getSignaturesForAddress', [whale.address, { limit: 10 }]);
      if (!sigs.result || sigs.result.length === 0) {
        console.log(`  ${whale.address.slice(0,8)}... — 0 tx recenti`);
        continue;
      }

      console.log(`  ${whale.address.slice(0,8)}... — ${sigs.result.length} tx trovate`);

      for (const sig of sigs.result) {
        if (sig.err) continue;

        // Controlla se esiste già
        const { count } = await supabase
          .from('movements')
          .select('*', { count: 'exact', head: true })
          .eq('signature', sig.signature);

        if (count && count > 0) continue;

        // Recupera dettaglio transazione
        const tx = await fetchJson('getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
        ]);

        if (!tx.result) continue;

        const transaction = tx.result;
        const accountKeys = transaction.transaction?.message?.accountKeys || [];
        const fromAddr = accountKeys[0]?.pubkey || 'unknown';
        const toAddr = accountKeys[1]?.pubkey || 'unknown';
        const blockTime = sig.blockTime
          ? new Date(sig.blockTime * 1000).toISOString()
          : new Date().toISOString();

        // Estrai amount SOL dalle variazioni di lamports (approssimativo)
        let amountToken = 0;
        if (transaction.meta?.preBalances && transaction.meta?.postBalances) {
          amountToken = Math.abs(transaction.meta.postBalances[0] - transaction.meta.preBalances[0]) / 1e9;
        }

        const { error } = await supabase.from('movements').insert({
          signature: sig.signature,
          from_address: fromAddr,
          to_address: toAddr,
          token: 'SOL',
          amount_token: amountToken || 0,
          amount_usd: 0,
          flow_type: 'unknown',
          flow_direction: 'internal',
          block_time: blockTime
        });

        if (error) {
          console.log(`  ❌ Errore inserimento: ${error.message}`);
        } else {
          console.log(`  ✅ Inserito: ${sig.signature.slice(0,12)}... (${amountToken.toFixed(2)} SOL)`);
          inserted++;
        }
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e: any) {
      console.log(`  ❌ Errore: ${e.message}`);
    }
  }
  console.log(`\n✅ Backfill arricchito completato. ${inserted} nuovi movimenti.`);
}
main().catch(console.error);
