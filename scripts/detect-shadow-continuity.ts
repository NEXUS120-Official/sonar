import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { runShadowContinuityDetection } from '../src/lib/sovereign/shadow-continuity';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const result = await runShadowContinuityDetection(supabase as any, {
    lookbackDays: 30,
    maxSeeds: 200,
    minSeedConfidence: 25,
    minConfidenceToPersist: 20,
  });

  console.log(`✅ Shadow continuity detection completato.`);
  console.log(`   Seed processati: ${result.seeds_processed}`);
  console.log(`   Famiglie rilevate: ${result.families_detected}`);
  console.log(`   Hop rilevati: ${result.hops_detected}`);
  console.log(`   Famiglie persistite: ${result.families_persisted}`);
  console.log(`   Hop persistiti: ${result.hops_persisted}`);
  console.log(`   Errori: ${result.errors}`);
  console.log(`   Gas funding: ${result.has_gas_funding}`);
  console.log(`   Privacy: ${result.has_privacy}`);
  console.log(`   Fan-out: ${result.has_fan_out}`);
  console.log(`   Temporal correlation: ${result.has_temporal_corr}`);
}

main().catch(console.error);
