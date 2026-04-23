// ============================================================
// SONAR — Sovereign Whale Candidates Intel Route
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { mergeSovereignWhaleCandidates } from '@/lib/providers/adapters/sovereign-whale-discovery-runtime';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();
  const candidates = await mergeSovereignWhaleCandidates(db);

  return NextResponse.json({
    ok: true,
    count: candidates.length,
    candidates: candidates.slice(0, 100),
    source_mode: 'sovereign_whale_discovery_v1',
  });
}
