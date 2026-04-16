// ============================================================
// SONAR — GMGN Provider Adapter
// ============================================================
// Wraps GMGN smart money feed behind WalletIntelProvider.
//
// CRITICAL BUG NOTE (from PRD):
//   GMGN's `account_address` field returns the SPL Token ATA
//   (Associated Token Account), NOT the wallet owner address.
//   ALWAYS use `maker` field for actual wallet addresses.
//
// This adapter enforces that rule: only `maker` is returned.
// ============================================================

import type { WalletIntelProvider, DiscoveredWallet, WalletBalances, WalletProfile } from '../interfaces';
import { ProviderError } from '../interfaces';

const GMGN_BASE = 'https://gmgn.ai/api/v1';

// ── GMGN response shape ───────────────────────────────────────

interface GMGNTrade {
  maker:           string;   // ← actual wallet address — always use this
  account_address: string;   // ← ATA / token account — NEVER use for wallet identity
  token_address:   string;
  amount_usd:      number;
  timestamp:       number;
  tx_hash:         string;
}

interface GMGNResponse {
  code:    number;
  reason:  string;
  data: {
    activities: GMGNTrade[];
  };
}

// ── GMGN Wallet Intelligence Provider ────────────────────────

export class GMGNWalletProvider implements WalletIntelProvider {
  readonly name = 'gmgn';

  /**
   * Fetch recent smart money activity from GMGN.
   * Returns unique wallets from `maker` field only — never `account_address`.
   * Filters: amount_usd >= min_value_usd, excludes pump.fun tokens.
   */
  async discoverWhales(
    opts: { min_value_usd?: number; limit?: number } = {},
  ): Promise<DiscoveredWallet[]> {
    const minValue = opts.min_value_usd ?? 50_000;
    const limit    = opts.limit ?? 20;

    try {
      const res = await fetch(
        `${GMGN_BASE}/signals/smart_money_on_chain?limit=100&chain=sol`,
        {
          headers: {
            Accept:       'application/json',
            'User-Agent': 'SONAR/2.0 (NEXUS Finance)',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!res.ok) {
        throw new ProviderError('gmgn', `HTTP_${res.status}`, 'Smart money fetch failed');
      }

      const json = (await res.json()) as GMGNResponse;
      if (json.code !== 0) {
        throw new ProviderError('gmgn', 'API_ERROR', json.reason ?? 'Unknown GMGN error');
      }

      const activities = json.data?.activities ?? [];

      // Deduplicate by maker address, apply filters
      const seen    = new Set<string>();
      const wallets: DiscoveredWallet[] = [];

      for (const activity of activities) {
        // CRITICAL: use maker, never account_address
        const address = activity.maker;
        if (!address || seen.has(address)) continue;
        if (activity.amount_usd < minValue)    continue;

        // Exclude pump.fun token address pattern
        if (activity.token_address?.endsWith('pump')) continue;

        seen.add(address);
        wallets.push({
          address,
          total_value_usd:  activity.amount_usd, // trade size as proxy — balance unknown
          sol_balance:      0,   // will be filled by balance check
          usdc_balance:     0,
          discovery_method: 'gmgn_feed',
        });

        if (wallets.length >= limit) break;
      }

      return wallets;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError('gmgn', 'FETCH_ERROR', String(err), err);
    }
  }

  async getWalletBalances(_address: string): Promise<WalletBalances> {
    // GMGN doesn't expose a balance endpoint — delegate to Helius adapter
    throw new ProviderError('gmgn', 'NOT_IMPLEMENTED', 'Use HeliusWalletProvider for balances');
  }

  async getWalletProfile(_address: string): Promise<WalletProfile | null> {
    return null;
  }
}

// ── GMGN authenticated client (for private API) ───────────────

export interface GMGNAuthConfig {
  private_key_pem: string;
  api_key:         string;
}

export function getGMGNAuthConfig(): GMGNAuthConfig | null {
  const pk  = process.env.GMGN_PRIVATE_KEY;
  const key = process.env.GMGN_API_KEY;
  if (!pk || !key) return null;
  return { private_key_pem: pk, api_key: key };
}
