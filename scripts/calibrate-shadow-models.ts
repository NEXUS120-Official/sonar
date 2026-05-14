import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function main() {
  console.log('🔬 Calibrazione modelli Shadow & Privacy\n');

  // ────────── 1. Analisi distribuzione confidence shadow links ──────────
  const { data: links } = await supabase
    .from('shadow_links')
    .select('confidence, confidence_tier, privacy_activated, is_novel_wallet, has_confidential_transfer');

  if (!links || links.length === 0) {
    console.log('Nessun shadow link da analizzare.');
    return;
  }

  const scores = links.map(l => l.confidence).sort((a, b) => a - b);
  const tiers = { direct_proof: 0, strong_evidence: 0, moderate_evidence: 0, weak_association: 0, unknown: 0 };
  links.forEach(l => tiers[l.confidence_tier]++);

  console.log(`Totale shadow links: ${links.length}`);
  console.log(`Distribuzione tier: ${JSON.stringify(tiers)}`);
  console.log(`Min confidence: ${scores[0]}, Max: ${scores[scores.length-1]}`);
  console.log(`Mediana: ${scores[Math.floor(scores.length/2)]}`);

  // Percentili per suggerire soglie
  const p25 = scores[Math.floor(scores.length * 0.25)];
  const p50 = scores[Math.floor(scores.length * 0.50)];
  const p75 = scores[Math.floor(scores.length * 0.75)];
  const p90 = scores[Math.floor(scores.length * 0.90)];

  console.log('\nPercentili:');
  console.log(`  25°: ${p25}`);
  console.log(`  50°: ${p50}`);
  console.log(`  75°: ${p75}`);
  console.log(`  90°: ${p90}`);

  console.log('\nSoglie suggerite per confidence_tier:');
  console.log(`  direct_proof:       >= ${Math.min(95, p90)}`);
  console.log(`  strong_evidence:    >= ${Math.min(85, p75)}`);
  console.log(`  moderate_evidence:  >= ${p50}`);
  console.log(`  weak_association:   >= ${p25}`);
  console.log(`  unknown:            < ${p25}`);

  // ────────── 2. Analisi wallet con attività anomala (possibili falsi positivi) ──────────
  const { data: highActivity } = await supabase
    .from('movements')
    .select('from_address')
    .in('from_address', links.map(l => l.target_wallet))
    .order('block_time', { ascending: false })
    .limit(5000);

  const activityCounts = new Map<string, number>();
  if (highActivity) {
    highActivity.forEach(m => activityCounts.set(m.from_address, (activityCounts.get(m.from_address) || 0) + 1));
  }

  const noisyWallets = [...activityCounts.entries()]
    .filter(([_, count]) => count > 20)
    .map(([addr]) => addr);

  if (noisyWallets.length > 0) {
    console.log(`\n⚠️  Wallet con >20 movimenti in uscita (possibili bot/exchange): ${noisyWallets.length}`);
    // Riduci la confidence per questi wallet
    console.log('   Suggerimento: ridurre confidence del 10-15% per wallet ad alta attività.');
  }

  // ────────── 3. Analisi correlazione privacy_activated (se presente) ──────────
  const privacyLinks = links.filter(l => l.privacy_activated);
  if (privacyLinks.length > 0) {
    const avgConfPrivacy = privacyLinks.reduce((s, l) => s + l.confidence, 0) / privacyLinks.length;
    const avgConfNonPrivacy = links.filter(l => !l.privacy_activated).reduce((s, l) => s + l.confidence, 0) / (links.length - privacyLinks.length);
    console.log(`\nConfidence media link con privacy: ${avgConfPrivacy.toFixed(1)}`);
    console.log(`Confidence media link senza privacy: ${avgConfNonPrivacy.toFixed(1)}`);
    if (avgConfPrivacy > avgConfNonPrivacy) {
      console.log('✅ I link con privacy hanno confidenza più alta — il modello segnala correttamente.');
    }
  }

  // ────────── 4. Report finale ──────────
  console.log('\n=== RACCOMANDAZIONI ===');
  if (scores.length > 0 && p50 < 70) {
    console.log('• La confidenza mediana è sotto 70: possibile migliorare la qualità dei segnali aumentando la soglia di novelty o richiedendo più evidenze.');
  }
  if (tiers.weak_association > links.length * 0.3) {
    console.log('• Più del 30% dei link sono "weak_association": valutare se aumentare la soglia minima per ridurre il rumore.');
  }
  if (noisyWallets.length > 0) {
    console.log(`• ${noisyWallets.length} wallet sembrano bot/exchange: applicare un filtro per ridurre la confidenza su wallet con alta attività.`);
  }
  console.log('• Eseguire questo script periodicamente per monitorare la deriva del modello.');
}

main().catch(console.error);
