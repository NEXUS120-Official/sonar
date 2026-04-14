// ============================================================
// SONAR v2.0 — GET /api/alerts
// ============================================================
// Returns latest 50 alerts ordered by created_at DESC.
// Includes Telegram delivery status for UI display.
// ============================================================

import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { AlertRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function log(msg: string, ctx?: unknown) {
  console.log(`[api/alerts] ${msg}`, ctx ?? '');
}

const ALERT_LIMIT = 50;

export async function GET(): Promise<NextResponse> {
  try {
    const db = createAdminClient();

    const { data: alertsRaw, error } = await db
      .from('alerts')
      .select('id, alert_type, severity, title, body, ai_analysis, data, sent_telegram_free, sent_telegram_premium, sent_at, created_at')
      .order('created_at', { ascending: false })
      .limit(ALERT_LIMIT);

    if (error) {
      log('DB error', error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const alerts = (alertsRaw ?? []) as Pick<
      AlertRow,
      'id' | 'alert_type' | 'severity' | 'title' | 'body' | 'ai_analysis' |
      'data' | 'sent_telegram_free' | 'sent_telegram_premium' | 'sent_at' | 'created_at'
    >[];

    return NextResponse.json({
      ok:    true,
      count: alerts.length,
      alerts: alerts.map(a => ({
        id:                   a.id,
        alert_type:           a.alert_type,
        severity:             a.severity,
        title:                a.title,
        body:                 a.body,
        ai_analysis:          a.ai_analysis,
        data:                 a.data,
        telegram: {
          sent_free:    a.sent_telegram_free,
          sent_premium: a.sent_telegram_premium,
          sent_at:      a.sent_at,
        },
        created_at:           a.created_at,
      })),
    });
  } catch (err) {
    log('Unhandled error', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
