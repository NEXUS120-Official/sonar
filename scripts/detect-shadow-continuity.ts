import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { loadContinuityContext, detectContinuity } from '../src/lib/sovereign/shadow-continuity';
import type { ShadowFamilyRecord, ShadowContinuityRecord } from '../src/lib/sovereign/shadow-continuity';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function deduplicateFamilies(families: ShadowFamilyRecord[]): ShadowFamilyRecord[] {
  const seen = new Set<string>();
  return families.filter(f => {
    if (seen.has(f.root_wallet)) return false;
    seen.add(f.root_wallet);
    return true;
  });
}

function deduplicateHops(hops: ShadowContinuityRecord[]): ShadowContinuityRecord[] {
  const seen = new Set<string>();
  return hops.filter(h => {
    const key = `${h.parent_wallet}::${h.child_wallet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function safePersistFamilies(families: ShadowFamilyRecord[]): Promise<number> {
  let count = 0;
  for (const f of deduplicateFamilies(families)) {
    const { error } = await supabase
      .from('shadow_families')
      .upsert({
        family_id: f.family_id,
        root_wallet: f.root_wallet,
        source_exchange: f.source_exchange,
        source_exchange_wallet: f.source_exchange_wallet,
        member_wallets: f.member_wallets,
        total_members: f.total_members,
        hop_depth: f.hop_depth,
        patterns: f.patterns,
        continuity_reasons: f.continuity_reasons,
        evidence: f.evidence,
        confidence: f.confidence,
        confidence_tier: f.confidence_tier,
        has_privacy_activation: f.has_privacy_activation,
        has_token2022_activity: f.has_token2022_activity,
        has_gas_funding: f.has_gas_funding,
        has_fan_out: f.has_fan_out,
        has_fan_in: f.has_fan_in,
        has_temporal_correlation: f.has_temporal_correlation,
        earliest_activity: f.earliest_activity,
        latest_activity: f.latest_activity,
        methodology_version: f.methodology_version,
      }, { onConflict: 'root_wallet' });
    if (!error) count++;
  }
  return count;
}

async function safePersistHops(hops: ShadowContinuityRecord[]): Promise<number> {
  let count = 0;
  for (const h of deduplicateHops(hops)) {
    const { error } = await supabase
      .from('shadow_continuity')
      .upsert({
        family_id: h.family_id,
        parent_wallet: h.parent_wallet,
        child_wallet: h.child_wallet,
        hop_depth: h.hop_depth,
        pattern: h.pattern,
        transfer_signature: h.transfer_signature,
        transfer_time: h.transfer_time,
        transfer_amount_sol: h.transfer_amount_sol,
        transfer_amount_usd: h.transfer_amount_usd,
        is_gas_topup: h.is_gas_topup,
        parent_has_shadow_link: h.parent_has_shadow_link,
        parent_shadow_exchange: h.parent_shadow_exchange,
        parent_shadow_confidence: h.parent_shadow_confidence,
        child_privacy_activated: h.child_privacy_activated,
        child_token2022_active: h.child_token2022_active,
        evidence: h.evidence,
        linkage_reason: h.linkage_reason,
        confidence: h.confidence,
        confidence_tier: h.confidence_tier,
        methodology_version: h.methodology_version,
      }, { onConflict: 'parent_wallet,child_wallet' });
    if (!error) count++;
  }
  return count;
}

async function main() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = await loadContinuityContext(supabase as any, {
    lookbackDays: 30,
    maxSeeds: 500,
    maxOutgoing: 10000,
    minSeedConfidence: 15,
  });

  const { families, hops } = detectContinuity(ctx);

  console.log(`✅ Multi-Hop Detection completato.`);
  console.log(`   Seed processati: ${ctx.shadowLinks.length}`);
  console.log(`   Famiglie rilevate: ${families.length}`);
  console.log(`   Hop rilevati: ${hops.length}`);

  const familiesPersisted = await safePersistFamilies(families);
  const hopsPersisted = await safePersistHops(hops);

  console.log(`   Famiglie persistite: ${familiesPersisted}`);
  console.log(`   Hop persistiti: ${hopsPersisted}`);
  console.log(`   Gas funding: ${families.filter(f => f.has_gas_funding).length}`);
  console.log(`   Privacy: ${families.filter(f => f.has_privacy_activation).length}`);
  console.log(`   Fan-out: ${families.filter(f => f.has_fan_out).length}`);
  console.log(`   Temporal correlation: ${families.filter(f => f.has_temporal_correlation).length}`);
}

main().catch(console.error);
