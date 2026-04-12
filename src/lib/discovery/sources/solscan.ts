// ============================================================
// SONAR — Discovery Source: Solscan
// ============================================================
// Wallet enrichment via Solscan Pro API.
// Used to enrich candidate metrics after initial discovery.
//
// Requires: SOLSCAN_API_KEY env var (Pro tier)
// If not set, returns null gracefully — engine continues without it.
//
// Arkham Intelligence: interface stubbed here for future integration.
// Activate by setting ARKHAM_API_KEY and implementing fetchArkhamData().

import type { CandidateMetrics } from '../types';

const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';

// Solscan Pro response shapes
interface SolscanActivity {
  block_time?: number;       // Unix seconds
  activity_type?: string;    // ACTIVITY_TOKEN_SWAP etc.
  routers?: { token1?: string; token2?: string };
  amount?: number;
  value?: number;
}

interface SolscanActivityResponse {
  data?: SolscanActivity[];
  success?: boolean;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Enrich a candidate's metrics using Solscan wallet activity.
 * Returns a partial CandidateMetrics overlay (merge with source metrics).
 * Returns null if API key is missing or call fails.
 */
export async function enrichWithSolscan(
  address: string,
): Promise<Partial<CandidateMetrics> | null> {
  const apiKey = process.env.SOLSCAN_API_KEY;
  if (!apiKey) return null;

  try {
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

    const params = new URLSearchParams({
      address,
      activity_type: 'ACTIVITY_TOKEN_SWAP',
      block_time:    `${since},${Math.floor(Date.now() / 1000)}`,
      page:          '1',
      page_size:     '100',
    });

    const res = await fetch(
      `${SOLSCAN_BASE}/account/activity?${params.toString()}`,
      {
        headers: {
          token: apiKey,
          Accept: 'application/json',
        },
      },
    );

    if (!res.ok) return null;

    const json = await res.json() as SolscanActivityResponse;
    const activities = json.data ?? [];

    if (activities.length === 0) return null;

    return extractMetrics(address, activities);
  } catch (err) {
    console.error(`[discovery/solscan] Enrichment failed for ${address.slice(0, 8)}:`, err);
    return null;
  }
}

// ── Internal ──────────────────────────────────────────────────

function extractMetrics(
  address: string,
  activities: SolscanActivity[],
): Partial<CandidateMetrics> {
  const swaps = activities.filter((a) =>
    a.activity_type?.includes('SWAP'),
  );

  const uniqueTokens = new Set<string>();
  let lastTime: Date | null = null;
  let totalValue = 0;
  let count = 0;

  for (const a of swaps) {
    if (a.routers?.token1) uniqueTokens.add(a.routers.token1);
    if (a.routers?.token2) uniqueTokens.add(a.routers.token2);
    if (a.block_time) {
      const t = new Date(a.block_time * 1000);
      if (!lastTime || t > lastTime) lastTime = t;
    }
    if (a.value) { totalValue += a.value; count++; }
  }

  return {
    address,
    source:            'solscan',
    tradeCount30d:     swaps.length || null,
    tokenDiversity30d: uniqueTokens.size || null,
    lastActiveAt:      lastTime,
    totalVolume30d:    totalValue || null,
    avgTradeSizeUsd:   count > 0 ? totalValue / count : null,
  };
}

// ── Arkham stub ───────────────────────────────────────────────

/**
 * Stub for future Arkham Intelligence integration.
 * Arkham provides entity labels and risk profiles for known wallets.
 * Activate when ARKHAM_API_KEY is available.
 */
export async function enrichWithArkham(
  _address: string,
): Promise<{ isLabeled: boolean; label?: string; riskFlags?: string[] } | null> {
  const apiKey = process.env.ARKHAM_API_KEY;
  if (!apiKey) return null;

  // TODO: implement when Arkham API access is available
  // Endpoint: https://api.arkhamintelligence.com/intelligence/address/{address}
  console.warn('[discovery/arkham] ARKHAM_API_KEY set but integration not yet implemented');
  return null;
}
