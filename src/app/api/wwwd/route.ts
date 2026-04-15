// ============================================================
// SONAR v2.0 — GET /api/wwwd — "What Would Whales Do?" (Innovation 8)
// ============================================================
// Synthesises the current Bias Index + cohort distribution into
// a plain-language directional signal with confidence tier.
//
// Response shape:
// {
//   ok: true,
//   signal:     'accumulate' | 'distribute' | 'hold' | 'rotate_to_defi' | 'reduce_defi',
//   confidence: 'high' | 'medium' | 'low',
//   score:      number,         // bias score -100..+100
//   bias:       string,
//   headline:   string,         // one-liner for display
//   rationale:  string[],       // 2-4 bullet points
//   cohort_distribution: { accumulator: N, distributor: N, staker: N, ... }
// }
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type WWWDSignal = 'accumulate' | 'distribute' | 'hold' | 'rotate_to_defi' | 'reduce_defi';
type ConfidenceTier = 'high' | 'medium' | 'low';

interface WWWDResponse {
  ok:                    boolean;
  signal:                WWWDSignal;
  confidence:            ConfidenceTier;
  score:                 number;
  bias:                  string;
  headline:              string;
  rationale:             string[];
  cohort_distribution:   Record<string, number>;
  generated_at:          string;
}

function deriveTier(confidence: number): ConfidenceTier {
  if (confidence >= 75) return 'high';
  if (confidence >= 50) return 'medium';
  return 'low';
}

function deriveSignal(
  score: number,
  components: Record<string, { score: number; interpretation: string }>,
  cohortDist: Record<string, number>,
): { signal: WWWDSignal; headline: string; rationale: string[] } {

  const rationale: string[] = [];
  const accCount = cohortDist.accumulator ?? 0;
  const disCount = cohortDist.distributor ?? 0;
  const defiCount = cohortDist.defi_user ?? 0;
  const stakerCount = cohortDist.staker ?? 0;
  const totalActive = accCount + disCount + defiCount + stakerCount + (cohortDist.opportunist ?? 0);

  const exchInterp  = components.exchange?.interpretation ?? '';
  const stakeInterp = components.staking?.interpretation  ?? '';
  const defiInterp  = components.defi?.interpretation     ?? '';

  if (score >= 40) {
    // Bullish: check if DeFi is the dominant signal
    if (defiCount > 0 && defiCount / (totalActive || 1) > 0.35 && defiInterp.includes('risk-on')) {
      rationale.push(`${defiCount} whales rotating capital into DeFi protocols`);
      rationale.push(`Exchange signal: ${exchInterp}`);
      if (stakerCount > 0) rationale.push(`${stakerCount} whales adding to staking positions`);
      return { signal: 'rotate_to_defi', headline: 'Whales rotating into DeFi — risk-on mode', rationale };
    }
    if (accCount > disCount) rationale.push(`${accCount} accumulators vs ${disCount} distributors`);
    rationale.push(`Exchange: ${exchInterp}`);
    if (stakeInterp !== 'flat') rationale.push(`Staking: ${stakeInterp}`);
    rationale.push(`Bias score ${score > 0 ? '+' : ''}${score} — ${score >= 60 ? 'extreme bullish' : 'bullish'}`);
    return { signal: 'accumulate', headline: 'Smart money accumulating — bullish bias confirmed', rationale };
  }

  if (score <= -40) {
    // Bearish
    if (defiInterp.includes('risk-off')) {
      rationale.push(`DeFi outflows detected: ${defiInterp}`);
      rationale.push(`${disCount} whale${disCount !== 1 ? 's' : ''} distributing to exchanges`);
      return { signal: 'reduce_defi', headline: 'Whales de-risking DeFi positions', rationale };
    }
    if (disCount > accCount) rationale.push(`${disCount} distributors vs ${accCount} accumulators`);
    rationale.push(`Exchange: ${exchInterp}`);
    if (stakeInterp !== 'flat') rationale.push(`Staking: ${stakeInterp}`);
    rationale.push(`Bias score ${score} — ${score <= -60 ? 'extreme bearish' : 'bearish'}`);
    return { signal: 'distribute', headline: 'Smart money distributing — bearish bias confirmed', rationale };
  }

  // Neutral / mixed
  rationale.push(`Bias score ${score > 0 ? '+' : ''}${score} — neutral zone`);
  rationale.push(`Cohort split: ${accCount} acc / ${disCount} dist / ${defiCount} defi`);
  if (exchInterp !== 'balanced') rationale.push(`Exchange leaning: ${exchInterp}`);
  return { signal: 'hold', headline: 'Mixed signals — whales in wait-and-see mode', rationale };
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    // 1. Latest bias index entry
    const { data: biasRowRaw, error: biasErr } = await db
      .from('bias_index_history')
      .select('score, bias, confidence, components, created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    const biasRow = biasRowRaw as any;

    if (biasErr || !biasRow) {
      return NextResponse.json({
        ok: false,
        error: biasErr?.message ?? 'No bias data yet',
      }, { status: 404 });
    }

    // 2. Cohort distribution — count active whales per cohort from last 24h
    //    We re-use what's already in the whales table (whale_type column)
    const { data: whaleTypes, error: whaleErr } = await db
      .from('whales')
      .select('whale_type')
      .eq('is_active', true)
      .not('whale_type', 'is', null);

    if (whaleErr) {
      console.warn('[api/wwwd] could not fetch whale types:', whaleErr.message);
    }

    const cohortDist: Record<string, number> = {};
    for (const w of (whaleTypes ?? []) as any[]) {
      const t = (w.whale_type as string) ?? 'unknown';
      cohortDist[t] = (cohortDist[t] ?? 0) + 1;
    }

    const components = (biasRow.components as Record<string, { score: number; interpretation: string }>) ?? {};
    const { signal, headline, rationale } = deriveSignal(biasRow.score, components, cohortDist);

    const response: WWWDResponse = {
      ok:                   true,
      signal,
      confidence:           deriveTier(biasRow.confidence ?? 0),
      score:                biasRow.score,
      bias:                 biasRow.bias,
      headline,
      rationale,
      cohort_distribution:  cohortDist,
      generated_at:         new Date().toISOString(),
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error('[api/wwwd]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
