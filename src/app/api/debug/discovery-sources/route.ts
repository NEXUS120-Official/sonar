// ============================================================
// SONAR — Discovery Source Diagnostics (CRON-SECRET GATED)
// GET /api/debug/discovery-sources
// ============================================================
// Temporary diagnostic endpoint — tests each source adapter
// and returns raw HTTP status + response fragment.
// Remove or disable after debugging is complete.

import { type NextRequest, NextResponse } from 'next/server';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth     = req.headers.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  return provided === secret;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const birdeyeKey = process.env.BIRDEYE_API_KEY;
  const results: Record<string, unknown> = {
    birdeye_key_set: !!birdeyeKey,
    birdeye_key_length: birdeyeKey?.length ?? 0,
  };

  // Test Birdeye 1W
  for (const type of ['1W', 'today']) {
    try {
      const res = await fetch(
        `https://public-api.birdeye.so/trader/gainers-losers?type=${type}&sort_by=PnL&sort_type=desc&offset=0&limit=3`,
        { headers: { 'X-API-KEY': birdeyeKey ?? '', 'x-chain': 'solana' } },
      );
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
      results[`birdeye_${type}`] = { status: res.status, body: parsed };
    } catch (err) {
      results[`birdeye_${type}`] = { error: String(err) };
    }
  }

  // Test DEXScreener
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/latest/v1');
    const text = await res.text();
    let parsed: unknown;
    try {
      const arr = JSON.parse(text);
      parsed = { count: Array.isArray(arr) ? arr.length : 'not-array', sample: Array.isArray(arr) ? arr[0] : arr };
    } catch { parsed = text.slice(0, 200); }
    results['dexscreener'] = { status: res.status, body: parsed };
  } catch (err) {
    results['dexscreener'] = { error: String(err) };
  }

  return NextResponse.json({ ok: true, ...results });
}
