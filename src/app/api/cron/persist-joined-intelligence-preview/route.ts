import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { getSovereignFlowJoinerPreview } from '@/lib/sovereign/sovereign-flow-joiner-preview';
import { joinSovereignMovement } from '@/lib/sovereign/sovereign-flow-joiner';
import { persistJoinedIntelligenceBatch } from '@/lib/sovereign/sovereign-persistence-manager';

function verifyCronSecret(req: NextRequest): boolean {
  const got = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  return !!expected && got === expected;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db = createAdminClient();

  try {
    const preview = await getSovereignFlowJoinerPreview(db, 25);

    const joined = preview.map((row) =>
      joinSovereignMovement(
        {
          signature: row.signature,
          flow_type: row.flow_type,
          token_mint: row.asset_key,
          token_symbol: row.token_symbol,
          token_program_type: row.token_program_type,
          privacy_signal: row.privacy_signal,
          source_exchange: row.exchange_lineage_band !== 'unknown' ? 'derived_exchange_context' : null,
          token_risk_flags: [],
        },
        {
          valuation: {
            valuation_status: row.valuation_status,
            effective_confidence: row.valuation_confidence,
            value_usd: null,
          },
          exchange_lineage: {
            confidence_score: row.attribution_confidence,
            evidence_count: 1,
            source_exchange: row.exchange_lineage_band !== 'unknown' ? 'derived_exchange_context' : null,
          },
          cluster: {
            cluster_id: null,
            cluster_confidence: null,
          },
        }
      )
    );

    const result = await persistJoinedIntelligenceBatch(db, joined);

    return NextResponse.json({
      ok: true,
      ...result,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
