// ============================================================
// SONAR — SovereignFlowJoiner Preview
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { SovereignJoinedMovementPreviewRow } from '@/lib/supabase/types';
import { joinSovereignMovement } from '@/lib/sovereign/sovereign-flow-joiner';

type Db = ReturnType<typeof createAdminClient>;

export async function getSovereignFlowJoinerPreview(
  db: Db,
  limit: number = 50,
): Promise<SovereignJoinedMovementPreviewRow[]> {
  try {
    // recent privacy events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: events } = await (db as any)
      .from('privacy_lifecycle_events')
      .select('tx_signature, token_mint, token_symbol, privacy_lifecycle_stage, is_public_side, shadow_source_exchange, amount_usd, event_time')
      .order('event_time', { ascending: false })
      .limit(200);

    const rows = (events ?? []) as Array<{
      tx_signature: string;
      token_mint: string | null;
      token_symbol: string | null;
      privacy_lifecycle_stage: string | null;
      is_public_side: boolean | null;
      shadow_source_exchange: string | null;
      amount_usd: number | null;
      event_time: string;
    }>;

    const out: SovereignJoinedMovementPreviewRow[] = [];

    for (const row of rows.slice(0, limit)) {
      const joined = joinSovereignMovement(
        {
          signature: row.tx_signature,
          flow_type: row.is_public_side ? 'public_side' : 'privacy_side',
          token_mint: row.token_mint,
          token_symbol: row.token_symbol,
          token_program_type: 'unknown',
          amount_usd: row.amount_usd,
          source_exchange: row.shadow_source_exchange,
          privacy_signal: true,
          token_risk_flags: [],
        },
        {
          valuation: {
            valuation_status: row.amount_usd ? 'partial' : 'unknown',
            effective_confidence: row.amount_usd ? 'medium' : 'unknown',
            value_usd: row.amount_usd,
          },
          exchange_lineage: {
            confidence_score: row.shadow_source_exchange ? 75 : 35,
            evidence_count: row.shadow_source_exchange ? 2 : 1,
            source_exchange: row.shadow_source_exchange,
          },
          cluster: {
            cluster_id: null,
            cluster_confidence: null,
          },
        }
      );

      out.push({
        signature: joined.signature,
        asset_key: joined.asset_key,
        flow_type: joined.flow_type,
        token_symbol: joined.token_context.token_symbol,
        token_program_type: joined.token_context.token_program_type,
        valuation_status: joined.valuation_context.valuation_status,
        valuation_confidence: joined.valuation_context.effective_confidence,
        privacy_signal: joined.privacy_context.privacy_signal,
        exchange_lineage_band: joined.exchange_lineage_context.lineage_band,
        attribution_confidence: joined.attribution_confidence,
        linkage_reason: joined.linkage_reason,
        methodology_version: joined.methodology_version,
      });
    }

    return out;
  } catch {
    return [];
  }
}
