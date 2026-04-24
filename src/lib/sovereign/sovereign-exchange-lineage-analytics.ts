// ============================================================
// SONAR — Sovereign Exchange Lineage Analytics
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { SovereignExchangeLineagePreviewRow } from '@/lib/supabase/types';
import { scoreExchangeLineage } from '@/lib/sovereign/sovereign-exchange-lineage-doctrine';

type Db = ReturnType<typeof createAdminClient>;

export async function getExchangeLineagePreview(
  db: Db,
  limit: number = 50,
): Promise<SovereignExchangeLineagePreviewRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('sovereign_whale_candidates')
      .select('address, source_exchange, valuation_status, confidence_score, evidence_count')
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
      source_exchange: string | null;
      valuation_status: string;
      confidence_score: number;
      evidence_count: number;
    }>;

    return rows
      .map((row) => {
        const lineage = scoreExchangeLineage({
          source_exchange: row.source_exchange,
          valuation_status: row.valuation_status,
          confidence_score: row.confidence_score,
          evidence_count: row.evidence_count,
          hop_count: row.source_exchange ? 1 : null,
          downstream_evidence_count: row.evidence_count,
        });

        return {
          address: row.address,
          source_exchange: row.source_exchange,
          valuation_status: row.valuation_status,
          confidence_score: row.confidence_score,
          evidence_count: row.evidence_count,
          lineage_confidence: lineage.lineage_confidence,
          lineage_band: lineage.lineage_band,
          lineage_reason: lineage.lineage_reason,
        };
      })
      .sort((a, b) => b.lineage_confidence - a.lineage_confidence)
      .slice(0, limit);
  } catch {
    return [];
  }
}
