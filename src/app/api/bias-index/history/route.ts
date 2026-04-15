// ============================================================
// SONAR v2.0 — GET /api/bias-index/history
// ============================================================
// Query params:
//   days=7  → one point per hour
//   days=30 → one point per 4 hours
// ============================================================

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { BiasIndexHistoryRow } from '@/lib/supabase/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const days  = Math.min(Number(new URL(req.url).searchParams.get('days') ?? 7), 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const db = createAdminClient();

    const { data, error } = await db
      .from('bias_index_history')
      .select('score, bias, confidence, components, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // For 30d view, downsample to one per 4h bucket to reduce payload
    let points = (data ?? []) as Pick<BiasIndexHistoryRow, 'score' | 'bias' | 'confidence' | 'components' | 'created_at'>[];
    if (days > 7) {
      const buckets = new Map<string, typeof points[number]>();
      for (const p of points) {
        const slot = Math.floor(new Date(p.created_at).getTime() / (4 * 60 * 60 * 1000));
        buckets.set(String(slot), p); // last wins per bucket
      }
      points = Array.from(buckets.values());
    }

    return NextResponse.json({
      ok:    true,
      days,
      count: points.length,
      data:  points,
    });
  } catch (err) {
    console.error('[api/bias-index/history]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
