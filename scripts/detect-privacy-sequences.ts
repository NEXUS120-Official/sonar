import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { derivePrivacyLifecycleSequencesFromEvents } from '../src/lib/sovereign/privacy-sequence-engine';
import type { PrivacyLifecycleEventInsert } from '../src/lib/sovereign/persistence-manager';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🔍 Rilevazione eventi di privacy lifecycle...');

  // 1. Carica i wallet che hanno shadow link (confermati exchange-funded)
  const { data: shadowWallets } = await supabase
    .from('shadow_links')
    .select('target_wallet, source_exchange, confidence, privacy_activated')
    .gte('confidence', 25);

  if (!shadowWallets || shadowWallets.length === 0) {
    console.log('Nessuno shadow link trovato.');
    return;
  }

  const shadowSet = new Set(shadowWallets.map(s => s.target_wallet));
  console.log(`Wallet shadow: ${shadowSet.size}`);

  // 2. Carica i movimenti recenti che coinvolgono questi wallet
  const { data: movements } = await supabase
    .from('movements')
    .select('*')
    .or(
      [...shadowSet].map(a => `from_address.eq.${a}`).join(',') + ',' +
      [...shadowSet].map(a => `to_address.eq.${a}`).join(',')
    )
    .order('block_time', { ascending: false })
    .limit(1000);

  if (!movements || movements.length === 0) {
    console.log('Nessun movimento trovato per wallet shadow.');
    return;
  }

  console.log(`Movimenti rilevanti: ${movements.length}`);

  // 3. Carica i movimenti token associati (per privacy signal)
  const { data: tokenMovements } = await supabase
    .from('token_movements')
    .select('*')
    .or(
      [...shadowSet].map(a => `whale_id.eq.${a}`).join(',')
    )
    .order('block_time', { ascending: false })
    .limit(1000);

  // 4. Carica le famiglie shadow
  const { data: families } = await supabase
    .from('shadow_families')
    .select('family_id, root_wallet, member_wallets');

  const walletToFamily = new Map<string, string>();
  if (families) {
    for (const f of families) {
      for (const m of f.member_wallets) {
        walletToFamily.set(m, f.family_id);
      }
    }
  }

  // 5. Carica i mint arricchiti (per Token-2022 detection)
  const { data: enrichedMints } = await supabase
    .from('sovereign_mint_enrichments')
    .select('mint, is_token_2022, has_confidential_transfer')
    .eq('is_token_2022', true);

  const token2022Set = new Set(enrichedMints?.map(m => m.mint) ?? []);
  const confidentialSet = new Set(enrichedMints?.filter(m => m.has_confidential_transfer).map(m => m.mint) ?? []);

  // 6. Costruisci eventi di privacy lifecycle
  const events: PrivacyLifecycleEventInsert[] = [];

  for (const m of movements) {
    const wallet = shadowSet.has(m.from_address) ? m.from_address : 
                   shadowSet.has(m.to_address) ? m.to_address : null;
    if (!wallet) continue;

    const isPublicSide = m.flow_type === 'exchange_withdrawal' || m.flow_type === 'exchange_deposit';
    const isPrivacyToken = token2022Set.has(m.token);
    const isConfidential = confidentialSet.has(m.token);

    if (!isPrivacyToken && !isConfidential && !isPublicSide) continue;

    const stage = isConfidential ? 'privacy_active' :
                  isPrivacyToken ? 'privacy_staging' :
                  isPublicSide ? 'bridgehead_birth' : 'none';
    if (stage === 'none') continue;

    const shadowInfo = shadowWallets.find(s => s.target_wallet === wallet);
    const familyId = walletToFamily.get(wallet) ?? null;

    events.push({
      event_id: `evt_${m.signature}_${stage}`,
      signature: m.signature,
      event_time: m.block_time,
      event_type: stage,
      privacy_lifecycle_stage: stage,
      event_confidence: shadowInfo?.confidence ?? 50,
      event_reason: `${m.flow_type} ${m.token} ${m.amount_token}`,
      token_mint: m.token !== 'SOL' ? m.token : null,
      token_symbol: null,
      amount_usd: m.amount_usd,
      is_public_side: isPublicSide,
      shadow_source_exchange: shadowInfo?.source_exchange ?? null,
      shadow_family_id: familyId,
      family_member_role: familyId ? 'member' : 'unknown',
      family_coordination_posture: 'unknown',
      family_structure_strength: familyId ? 70 : 0,
      methodology_version: 'privacy_lifecycle_v1',
    });
  }

  // Aggiungi eventi da token movements
  if (tokenMovements) {
    for (const tm of tokenMovements) {
      if (!token2022Set.has(tm.token_mint)) continue;
      const wallet = tm.whale_id;
      if (!wallet || !shadowSet.has(wallet)) continue;

      const isConfidential = confidentialSet.has(tm.token_mint);
      const shadowInfo = shadowWallets.find(s => s.target_wallet === wallet);
      const familyId = walletToFamily.get(wallet) ?? null;

      events.push({
        event_id: `evt_${tm.signature}_privacy`,
        signature: tm.signature,
        event_time: tm.block_time,
        event_type: isConfidential ? 'privacy_active' : 'privacy_staging',
        privacy_lifecycle_stage: isConfidential ? 'privacy_active' : 'privacy_staging',
        event_confidence: shadowInfo?.confidence ?? 50,
        event_reason: `${tm.action} ${tm.amount_token} of ${tm.token_mint}`,
        token_mint: tm.token_mint,
        token_symbol: tm.token_symbol,
        amount_usd: tm.amount_usd,
        is_public_side: false,
        shadow_source_exchange: shadowInfo?.source_exchange ?? null,
        shadow_family_id: familyId,
        family_member_role: familyId ? 'member' : 'unknown',
        family_coordination_posture: 'unknown',
        family_structure_strength: familyId ? 70 : 0,
        methodology_version: 'privacy_lifecycle_v1',
      });
    }
  }

  console.log(`Eventi di privacy lifecycle generati: ${events.length}`);

  if (events.length === 0) {
    console.log('Nessun evento di privacy da persistere.');
    return;
  }

  // 7. Persisti eventi (upsert per idempotenza)
  const { error: eventErr } = await supabase
    .from('privacy_lifecycle_events')
    .upsert(events.map(e => ({
      event_id: e.event_id,
      signature: e.signature,
      event_time: e.event_time,
      event_type: e.event_type,
      privacy_lifecycle_stage: e.privacy_lifecycle_stage,
      event_confidence: e.event_confidence,
      event_reason: e.event_reason,
      token_mint: e.token_mint,
      token_symbol: e.token_symbol,
      amount_usd: e.amount_usd,
      is_public_side: e.is_public_side,
      shadow_source_exchange: e.shadow_source_exchange,
      shadow_family_id: e.shadow_family_id,
      family_member_role: e.family_member_role,
      family_coordination_posture: e.family_coordination_posture,
      family_structure_strength: e.family_structure_strength,
      methodology_version: e.methodology_version,
    })), { onConflict: 'event_id' });

  if (eventErr) {
    console.log('Errore persistenza eventi:', eventErr.message);
    return;
  }

  console.log(`✅ ${events.length} eventi persistiti.`);

  // 8. Deriva sequenze
  const sequences = derivePrivacyLifecycleSequencesFromEvents(events);
  console.log(`Sequenze derivate: ${sequences.length}`);

  if (sequences.length > 0) {
    const { error: seqErr } = await supabase
      .from('privacy_lifecycle_sequences')
      .upsert(sequences.map(s => ({
        sequence_id: s.sequence_id,
        start_event_id: s.start_event_id,
        end_event_id: s.end_event_id,
        start_signature: s.start_signature,
        end_signature: s.end_signature,
        token_mint: s.token_mint,
        token_symbol: s.token_symbol,
        shadow_family_id: s.shadow_family_id,
        start_stage: s.start_stage,
        end_stage: s.end_stage,
        stage_path: s.stage_path,
        sequence_confidence: s.sequence_confidence,
        elapsed_seconds: s.elapsed_seconds,
        sequence_reason: s.sequence_reason,
        start_event_time: s.start_event_time,
        end_event_time: s.end_event_time,
        methodology_version: s.methodology_version,
      })), { onConflict: 'sequence_id' });

    if (seqErr) {
      console.log('Errore persistenza sequenze:', seqErr.message);
    } else {
      console.log(`✅ ${sequences.length} sequenze persistite.`);
    }
  }

  console.log('\n✅ Privacy Lifecycle Engine completato.');
}

main().catch(console.error);
