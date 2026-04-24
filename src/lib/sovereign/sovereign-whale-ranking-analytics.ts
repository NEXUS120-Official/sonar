// ============================================================
// SONAR — Sovereign Whale Ranking Analytics
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { SovereignWhaleCandidateRankingPreviewRow } from '@/lib/supabase/types';
import { scoreSovereignWhaleCandidate } from '@/lib/sovereign/sovereign-whale-ranking-doctrine';

type Db = ReturnType<typeof createAdminClient>;

export async function getRankedSovereignWhaleCandidates(
  db: Db,
  limit: number = 50,
): Promise<SovereignWhaleCandidateRankingPreviewRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('sovereign_whale_candidates')
      .select('address, estimated_balance_usd, confidence_score, valuation_completeness_ratio, valuation_status, source_exchange, evidence_count, first_seen_at')
      .order('first_seen_at', { ascending: false })
      .limit(500);

    if (error) {
      const msg = String(error.message ?? '');
      const code = String(error.code ?? '');
      if (code === 'PGRST205' || msg.includes('schema cache') || msg.includes('Could not find the table')) {
        return [];
      }
      throw error;
    }

    const rows = (data ?? []) as Array<{
      address: string;
      estimated_balance_usd: number | null;
      confidence_score: number;
      valuation_completeness_ratio: number;
      valuation_status: string;
      source_exchange: string | null;
      evidence_count: number;
      first_seen_at: string;
    }>;

    return rows
      .map((row) => {
        const ranked = scoreSovereignWhaleCandidate(row);
        return {
          address: row.address,
          estimated_balance_usd: row.estimated_balance_usd,
          confidence_score: row.confidence_score,
          valuation_completeness_ratio: row.valuation_completeness_ratio,
          valuation_status: row.valuation_status,
          source_exchange: row.source_exchange,
          evidence_count: row.evidence_count,
          ranking_score: ranked.ranking_score,
          ranking_band: ranked.ranking_band,
          ranking_reason: ranked.ranking_reason,
        };
      })
      .sort((a, b) => b.ranking_score - a.ranking_score)
      .slice(0, limit);
  } catch {
    return [];
  }
}
