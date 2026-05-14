import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';
import { unifyPrivacyAlertDoctrine } from '../src/lib/sovereign/privacy-alert-doctrine';
import type { AlertInsert } from '../src/lib/flow-engine/anomaly-detector';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🧠 Generazione Intelligence Alerts...\n');

  const allAlerts: AlertInsert[] = [];

  // ──────────────────────────────────────────────
  // 1. Nuove famiglie shadow (rilevate nell'ultima ora)
  // ──────────────────────────────────────────────
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: newFamilies } = await supabase
    .from('shadow_families')
    .select('*')
    .gte('first_detected_at', oneHourAgo)
    .order('confidence', { ascending: false })
    .limit(5);

  if (newFamilies && newFamilies.length > 0) {
    console.log(`Nuove famiglie shadow: ${newFamilies.length}`);
    for (const fam of newFamilies) {
      allAlerts.push({
        alert_type: 'shadow_family_detected',
        severity: fam.confidence >= 75 ? 'major' : fam.confidence >= 55 ? 'significant' : 'notable',
        title: `Nuova famiglia shadow: ${fam.total_members} wallet da ${fam.source_exchange}`,
        body: [
          `Radice: ${fam.root_wallet.slice(0, 8)}...`,
          `Exchange: ${fam.source_exchange}`,
          `Membri: ${fam.total_members}`,
          `Pattern: ${fam.patterns.join(', ')}`,
          `Confidence: ${fam.confidence} (${fam.confidence_tier})`,
          fam.has_gas_funding ? '✓ Gas funding' : '',
          fam.has_fan_out ? '✓ Fan-out' : '',
          fam.has_temporal_correlation ? '✓ Correlazione temporale' : '',
        ].filter(Boolean).join(' | '),
        data: {
          family_id: fam.family_id,
          root_wallet: fam.root_wallet,
          source_exchange: fam.source_exchange,
          total_members: fam.total_members,
          patterns: fam.patterns,
          confidence: fam.confidence,
        },
      });
    }
  }

  // ──────────────────────────────────────────────
  // 2. Attivazioni di privacy recenti
  // ──────────────────────────────────────────────
  const { data: privacyEvents } = await supabase
    .from('privacy_lifecycle_events')
    .select('*')
    .in('privacy_lifecycle_stage', ['privacy_active', 'privacy_staging'])
    .gte('event_time', oneHourAgo)
    .order('event_confidence', { ascending: false })
    .limit(10);

  if (privacyEvents && privacyEvents.length > 0) {
    console.log(`Eventi di privacy recenti: ${privacyEvents.length}`);
    for (const ev of privacyEvents) {
      const exchange = ev.shadow_source_exchange || 'exchange sconosciuto';
      allAlerts.push({
        alert_type: 'privacy_activation',
        severity: ev.event_confidence >= 70 ? 'major' : 'significant',
        title: `Attivazione privacy: ${ev.privacy_lifecycle_stage} da ${exchange}`,
        body: [
          `Token: ${ev.token_mint?.slice(0, 12) ?? 'n/d'}...`,
          `Exchange origin: ${exchange}`,
          `Family: ${ev.shadow_family_id?.slice(0, 8) ?? 'nessuna'}...`,
          ev.is_public_side ? 'Lato pubblico' : 'Lato privacy',
          `Confidence: ${ev.event_confidence}`,
        ].join(' | '),
        data: {
          event_id: ev.event_id,
          token_mint: ev.token_mint,
          shadow_source_exchange: ev.shadow_source_exchange,
          shadow_family_id: ev.shadow_family_id,
          privacy_lifecycle_stage: ev.privacy_lifecycle_stage,
          event_confidence: ev.event_confidence,
        },
      });
    }
  }

  // ──────────────────────────────────────────────
  // 3. Sequenze di privacy completate
  // ──────────────────────────────────────────────
  const { data: sequences } = await supabase
    .from('privacy_lifecycle_sequences')
    .select('*')
    .gte('end_event_time', oneHourAgo)
    .order('sequence_confidence', { ascending: false })
    .limit(10);

  if (sequences && sequences.length > 0) {
    console.log(`Sequenze privacy recenti: ${sequences.length}`);
    for (const seq of sequences) {
      allAlerts.push({
        alert_type: 'privacy_sequence_completed',
        severity: seq.sequence_confidence >= 70 ? 'major' : 'significant',
        title: `Sequenza privacy: ${seq.start_stage} → ${seq.end_stage}`,
        body: [
          `Token: ${seq.token_symbol ?? seq.token_mint?.slice(0, 12) ?? 'n/d'}`,
          `Tempo: ${seq.elapsed_seconds ? Math.round(seq.elapsed_seconds / 60) + ' min' : 'n/d'}`,
          `Confidence: ${seq.sequence_confidence}`,
          seq.shadow_family_id ? `Family: ${seq.shadow_family_id.slice(0, 8)}...` : '',
        ].filter(Boolean).join(' | '),
        data: {
          sequence_id: seq.sequence_id,
          token_mint: seq.token_mint,
          token_symbol: seq.token_symbol,
          shadow_family_id: seq.shadow_family_id,
          start_stage: seq.start_stage,
          end_stage: seq.end_stage,
          sequence_confidence: seq.sequence_confidence,
          elapsed_seconds: seq.elapsed_seconds,
        },
      });
    }
  }

  if (allAlerts.length === 0) {
    console.log('Nessun nuovo intelligence alert da generare.');
    return;
  }

  // ──────────────────────────────────────────────
  // 4. Deduplica e consolida
  // ──────────────────────────────────────────────
  const unified = unifyPrivacyAlertDoctrine(allAlerts);
  console.log(`Alert generati: ${allAlerts.length}, dopo deduplica: ${unified.length}`);

  // ──────────────────────────────────────────────
  // 5. Persisti nella tabella alerts
  // ──────────────────────────────────────────────
  let inserted = 0;
  for (const alert of unified) {
    // Controlla se esiste già un alert simile nelle ultime 24 ore
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: existingCount } = await supabase
      .from('alerts')
      .select('*', { count: 'exact', head: true })
      .eq('alert_type', alert.alert_type)
      .gte('created_at', oneDayAgo)
      .eq('title', alert.title);

    if (existingCount && existingCount > 0) {
      console.log(`  ⏭️  Saltato (già esistente): ${alert.title}`);
      continue;
    }

    const { error } = await supabase.from('alerts').insert({
      alert_type: alert.alert_type,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      data: alert.data as any,
      sent_telegram_free: false,
      created_at: new Date().toISOString(),
    });

    if (error) {
      console.log(`  ❌ Errore insert: ${error.message}`);
    } else {
      console.log(`  ✅ ${alert.severity}: ${alert.title}`);
      inserted++;
    }
  }

  console.log(`\n✅ Intelligence alerts persistiti: ${inserted}`);
}

main().catch(console.error);
