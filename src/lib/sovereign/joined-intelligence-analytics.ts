// ============================================================
// SONAR — Joined Intelligence Analytics
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { JoinedIntelligenceRecordRow } from '@/lib/supabase/types';

type Db = ReturnType<typeof createAdminClient>;

export async function getRecentJoinedIntelligence(
  db: Db,
  limit: number = 50,
): Promise<JoinedIntelligenceRecordRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (db as any)
      .from('joined_intelligence_records')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      const msg = String(error.message ?? '');
      const code = String(error.code ?? '');
      if (code === 'PGRST205' || msg.includes('schema cache') || msg.includes('Could not find the table')) {
        return [];
      }
      throw error;
    }

    return (data ?? []) as JoinedIntelligenceRecordRow[];
  } catch {
    return [];
  }
}
