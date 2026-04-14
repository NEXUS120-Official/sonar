// ============================================================
// SONAR v2.0 — Whale Balance Checker
// ============================================================
// Shared RPC balance + qualification logic.
// Reused by: discover-whales cron, scripts/discover-whales.ts
//
// Qualification threshold: $500K total (SOL + USDC).
// ============================================================

import { USDC_MINT, FLOW_THRESHOLDS } from '@/lib/utils/constants';

// ── Constants ─────────────────────────────────────────────────

const LAMPORTS_PER_SOL      = 1_000_000_000;
const SOL_PRICE_FALLBACK    = 130;
const SOL_NATIVE_ADDRESS    = 'So11111111111111111111111111111111111111112';
const JUPITER_PRICE_URL     = `https://api.jup.ag/price/v2?ids=${SOL_NATIVE_ADDRESS}`;

// ── Helius RPC ────────────────────────────────────────────────

function heliusRpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[balance-checker] Missing HELIUS_API_KEY');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const url = heliusRpcUrl();
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RPC ${method} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

// ── Balance fetchers ──────────────────────────────────────────

export async function getSolBalance(address: string): Promise<number> {
  const result = await rpcCall<{ value: number }>('getBalance', [
    address,
    { commitment: 'confirmed' },
  ]);
  return result.value / LAMPORTS_PER_SOL;
}

export async function getUsdcBalance(address: string): Promise<number> {
  interface TokenAccountValue {
    account: {
      data: {
        parsed: {
          info: { tokenAmount: { uiAmount: number | null } };
        };
      };
    };
  }
  const result = await rpcCall<{ value: TokenAccountValue[] }>(
    'getTokenAccountsByOwner',
    [address, { mint: USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  );
  const accounts = result.value ?? [];
  return accounts.reduce((sum, acct) => {
    const ui = acct.account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    return sum + ui;
  }, 0);
}

export async function getSolPriceUsd(): Promise<number> {
  try {
    const res = await fetch(JUPITER_PRICE_URL, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as {
      data: Record<string, { price: string }>;
    };
    const priceStr = json.data[SOL_NATIVE_ADDRESS]?.price;
    const price    = priceStr ? parseFloat(priceStr) : 0;
    if (price > 0) return price;
    throw new Error('Zero price returned');
  } catch {
    return SOL_PRICE_FALLBACK;
  }
}

// ── Qualification check ───────────────────────────────────────

export interface WhaleQualification {
  sol_balance:    number;
  usdc_balance:   number;
  total_value_usd: number;
}

/**
 * Fetch balances for an address and check if it meets the whale threshold.
 * Returns null if total_value_usd < FLOW_THRESHOLDS.whale.min_total_value_usd ($500K).
 * Throws on RPC error — caller must catch.
 */
export async function checkWhaleQualification(
  address:     string,
  solPriceUsd: number,
): Promise<WhaleQualification | null> {
  const [sol_balance, usdc_balance] = await Promise.all([
    getSolBalance(address),
    getUsdcBalance(address),
  ]);
  const total_value_usd = sol_balance * solPriceUsd + usdc_balance;
  if (total_value_usd < FLOW_THRESHOLDS.whale.min_total_value_usd) {
    return null;
  }
  return { sol_balance, usdc_balance, total_value_usd };
}
