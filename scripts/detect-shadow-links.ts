import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { runShadowLinkDetection } from '../src/lib/sovereign/shadow-linker';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await runShadowLinkDetection(supabase as any, {
    lookbackDays: 30,
    maxFundingEvents: 500,
    minConfidenceToPersist: 15,
  });

  console.log(`✅ Shadow link detection completato.`);
  console.log(`   Eventi scansionati: ${result.funding_events_scanned}`);
  console.log(`   Link rilevati: ${result.links_detected}`);
  console.log(`   Link persistiti: ${result.links_persisted}`);
  console.log(`   Errori: ${result.errors}`);
  console.log(`   Privacy activated: ${result.privacy_activated}`);
  console.log(`   Novel wallets: ${result.novel_wallets}`);
}

main().catch(console.error);
