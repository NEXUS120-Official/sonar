import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { decodeSovereignMovement } from '../src/lib/decoder/sovereign';
import { decodeSovereignTokenMovement } from '../src/lib/decoder/sovereign-token';
import type { SolanaTransactionResult } from '../src/lib/sovereign/rpc-client';
import { buildEmptyRegistry } from '../src/lib/sovereign/token-registry';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const SOL_PRICE = 95;

async function main() {
  const { data: whales } = await supabase.from('whales').select('address');
  if (!whales || whales.length === 0) { console.log('Nessuna whale'); return; }
  const whaleSet = new Set(whales.map(w => w.address));
  console.log(`Whale: ${whaleSet.size}`);

  // Leggi TUTTE le righe da raw_transactions
  const { data: rows } = await supabase
    .from('raw_transactions')
    .select('*')
    .eq('source', 'sovereign_rpc_manual')
    .order('created_at', { ascending: false });

  if (!rows || rows.length === 0) { console.log('Nessuna raw transaction'); return; }
  console.log(`Raw rows da processare: ${rows.length}`);

  const registry = buildEmptyRegistry();
  let solUpdated = 0;
  let solInserted = 0;
  let tokenInserted = 0;

  for (const row of rows) {
    try {
      const tx = row.raw_json as SolanaTransactionResult;
      if (!tx?.meta || tx.meta.err !== null) continue;

      // --- Movimento SOL ---
      const mov = decodeSovereignMovement(tx, whaleSet, SOL_PRICE);
      if (mov && mov.from_address && mov.to_address) {
        const { data: existing } = await supabase
          .from('movements')
          .select('id')
          .eq('signature', mov.signature)
          .limit(1);

        const payload = {
          signature: mov.signature,
          from_address: mov.from_address,
          to_address: mov.to_address,
          token: mov.token,
          amount_token: mov.amount_token,
          amount_usd: mov.amount_usd,
          flow_type: mov.flow_type,
          flow_direction: mov.flow_direction,
          exchange: mov.exchange ?? null,
          protocol: mov.protocol ?? null,
          block_time: mov.block_time,
          from_label: mov.from_label ?? null,
          to_label: mov.to_label ?? null,
        };

        if (existing && existing.length > 0) {
          const { error } = await supabase
            .from('movements')
            .update(payload)
            .eq('signature', mov.signature);
          if (error) console.log(`Errore update SOL ${mov.signature}: ${error.message}`);
          else solUpdated++;
        } else {
          const { error } = await supabase.from('movements').insert(payload);
          if (error) console.log(`Errore insert SOL ${mov.signature}: ${error.message}`);
          else solInserted++;
        }
      }

      // --- Token movement ---
      const tok = decodeSovereignTokenMovement(tx, whaleSet, SOL_PRICE, registry);
      if (tok) {
        const { data: existingTok } = await supabase
          .from('token_movements')
          .select('id')
          .eq('signature', tok.signature)
          .limit(1);

        if (!existingTok || existingTok.length === 0) {
          const { error } = await supabase.from('token_movements').insert({
            signature: tok.signature,
            block_time: tok.block_time,
            token_mint: tok.token_mint,
            token_symbol: tok.token_symbol,
            token_name: tok.token_name,
            action: tok.action,
            amount_token: tok.amount_token,
            amount_sol: tok.amount_sol,
            amount_usd: tok.amount_usd,
            price_per_token: tok.price_per_token,
            protocol: tok.protocol,
            pool_address: tok.pool_address,
            is_new_token: tok.is_new_token,
          });
          if (error) console.log(`Errore insert token ${tok.signature}: ${error.message}`);
          else tokenInserted++;
        }
      }
    } catch (e: any) {
      console.log(`Errore su ${row.signature}: ${e.message}`);
    }
  }

  console.log(`\n=== RIEPILOGO ===`);
  console.log(`✅ SOL movements aggiornati: ${solUpdated}`);
  console.log(`✅ SOL movements inseriti:  ${solInserted}`);
  console.log(`✅ Token movements inseriti: ${tokenInserted}`);
}

main().catch(console.error);
