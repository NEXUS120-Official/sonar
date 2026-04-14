// ============================================================
// SONAR v2.0 — GET /api/reports/weekly
// ============================================================
// Returns the latest weekly intelligence report.
//
// Query params:
//   week  optional ISO week label e.g. "2026-W15"
//         if omitted, returns the most recent report
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { AlertRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const db   = createAdminClient();
    const url  = new URL(req.url);
    const week = url.searchParams.get('week');

    let query = db
      .from('alerts')
      .select('*')
      .eq('alert_type', 'weekly_report')
      .order('created_at', { ascending: false })
      .limit(1);

    // If a specific week is requested, filter by it via the data->>'week' JSON path
    if (week) {
      // The `data` column is JSONB and contains a `week` key e.g. "2026-W15"
      query = (db
        .from('alerts')
        .select('*')
        .eq('alert_type', 'weekly_report')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('data->>week' as any, week)
        .order('created_at', { ascending: false })
        .limit(1)) as typeof query;
    }

    const { data, error } = await query.maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, error: week ? `no report found for week ${week}` : 'no weekly report available yet' },
        { status: 404 },
      );
    }

    const row = data as AlertRow;

    return NextResponse.json({
      ok:           true,
      report_id:    row.id,
      generated_at: row.created_at,
      title:        row.title,
      publish_text: row.body,
      data:         row.data,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
