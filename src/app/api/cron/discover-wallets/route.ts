// ============================================================
// SONAR — Discover Wallets Cron
// GET /api/cron/discover-wallets
// ============================================================
// Triggered on schedule (or manually).
// Runs the discovery engine and reports the run summary.
//
// Auth: Authorization: Bearer {CRON_SECRET}

import { type NextRequest, NextResponse } from 'next/server';
import { runDiscovery } from '@/lib/discovery/engine';

// ── Auth helper ───────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth     = req.headers.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return provided === secret;
}

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[cron/discover-wallets][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix,  msg, ctx ?? '');
  else                        console.log(prefix,   msg, ctx ?? '');
}

// ── Route handler ─────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    log('warn', 'Unauthorized attempt');
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  log('info', 'Discovery cron triggered');

  let summary;
  try {
    summary = await runDiscovery();
  } catch (err) {
    log('error', 'Discovery engine threw', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }

  log('info', 'Discovery run complete', {
    walletsAnalyzed: summary.walletsAnalyzed,
    autoRejected:    summary.autoRejected,
    manualReview:    summary.manualReview,
    autoApproved:    summary.autoApproved,
    promoted:        summary.promoted,
    webhookSynced:   summary.webhookSynced,
  });

  // Print source breakdown
  const sourceLines = Object.entries(summary.sourceBreakdown)
    .filter(([, n]) => n > 0)
    .map(([src, n]) => `  ${src}: ${n}`)
    .join('\n');
  if (sourceLines) log('info', `Source breakdown:\n${sourceLines}`);

  // Print skip reasons (truncate to first 20 for log hygiene)
  if (summary.skipReasons.length > 0) {
    const reasons = summary.skipReasons.slice(0, 20);
    log('info', `Skip reasons (${summary.skipReasons.length} total):\n` +
      reasons.map((r) => `  ${r.address.slice(0, 8)}… ${r.reason}`).join('\n'));
  }

  return NextResponse.json({
    ok: true,
    ...summary,
  });
}
