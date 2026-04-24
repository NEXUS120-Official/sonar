// ============================================================
// SONAR — Alert Doctrine Intel Surface
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const db = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('alerts')
    .select('alert_type, severity, title, body, data, created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    alert_type: string;
    severity: string;
    title: string;
    body: string;
    data: Record<string, unknown> | null;
    created_at: string;
  }>;

  const doctrineTagged = rows.filter((r) =>
    !!r.data && typeof r.data['valuation_doctrine_reason'] === 'string'
  );

  const staleTagged = doctrineTagged.filter((r) =>
    !!r.data && r.data['valuation_is_stale_price'] === true
  );

  return NextResponse.json({
    ok: true,
    count: rows.length,
    doctrine_tagged_count: doctrineTagged.length,
    stale_tagged_count: staleTagged.length,
    rows,
    source_mode: 'sovereign_alert_valuation_doctrine_v1',
  });
}
