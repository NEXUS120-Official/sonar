// ============================================================
// SONAR — Helius Provider Adapters
// ============================================================
// Wraps all Helius API calls behind the HistoricalProvider and
// WalletIntelProvider interfaces. When the sovereign Agave RPC
// node is ready, swap these adapters for SovereignSolanaProvider.
//
// Credit cost reference (Helius free: 1M credits/month):
//   Enhanced TX history: 100 credits/call
//   getMultipleAccounts: ~1 credit
//   getTokenAccountsByOwner: ~1 credit
//   DAS getAssetsByOwner: 10 credits/call ← avoid on bulk ops
// ============================================================

import type {
  HistoricalProvider,
  WalletIntelProvider,
  AddressHistory,
  RawTransactionEvent,
  DiscoveredWallet,
  WalletBalances,
  WalletProfile,
  SubscribeTransactionsOptions,
} from '../interfaces';
import { ProviderError } from '../interfaces';
import { getBatchSolBalances, getUsdcBalance, getSolPriceUsd } from '@/lib/whale-discovery/balance-checker';
import type { HeliusEnhancedTx } from '@/lib/helius/parse-movement';

// ── Config ────────────────────────────────────────────────────

function apiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new ProviderError('helius', 'MISSING_KEY', 'HELIUS_API_KEY not set');
  return key;
}

function enhancedTxUrl(address: string, params: URLSearchParams): string {
  return `https://api.helius.xyz/v0/addresses/${address}/transactions?${params}`;
}

// ── Helius Historical Provider ────────────────────────────────

export class HeliusHistoricalProvider implements HistoricalProvider {
  readonly name = 'helius';

  async getAddressHistory(
    address: string,
    opts: { limit?: number; before?: string; type?: string } = {},
  ): Promise<AddressHistory[]> {
    const params = new URLSearchParams({
      'api-key': apiKey(),
      limit: String(opts.limit ?? 100),
    });
    if (opts.before) params.set('before', opts.before);
    if (opts.type)   params.set('type', opts.type);

    const res = await fetch(enhancedTxUrl(address, params), {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderError('helius', `HTTP_${res.status}`, body.slice(0, 200));
    }

    const txns = (await res.json()) as HeliusEnhancedTx[];
    return txns.map(tx => ({
      signature:  tx.signature,
      block_time: new Date(tx.timestamp * 1000),
      slot:       tx.slot ?? 0,
      raw:        tx,
      source:     'helius',
    }));
  }

  async getTransaction(signature: string): Promise<RawTransactionEvent | null> {
    const res = await fetch(
      `https://api.helius.xyz/v0/transactions?api-key=${apiKey()}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ transactions: [signature] }),
        signal:  AbortSignal.timeout(15_000),
      },
    );

    if (!res.ok) return null;
    const data = (await res.json()) as HeliusEnhancedTx[];
    const tx   = data[0];
    if (!tx) return null;

    return {
      signature:  tx.signature,
      slot:       tx.slot ?? 0,
      block_time: new Date(tx.timestamp * 1000),
      fee:        tx.fee ?? 0,
      success:    !tx.transactionError,
      raw:        tx,
      source:     'helius',
    };
  }

  async getMultipleTransactions(signatures: string[]): Promise<(RawTransactionEvent | null)[]> {
    if (signatures.length === 0) return [];

    const BATCH = 100;
    const results: (RawTransactionEvent | null)[] = [];

    for (let i = 0; i < signatures.length; i += BATCH) {
      const batch = signatures.slice(i, i + BATCH);
      const res = await fetch(
        `https://api.helius.xyz/v0/transactions?api-key=${apiKey()}`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ transactions: batch }),
          signal:  AbortSignal.timeout(20_000),
        },
      );

      if (!res.ok) {
        results.push(...batch.map(() => null));
        continue;
      }

      const data = (await res.json()) as HeliusEnhancedTx[];
      const bySignature = new Map(data.map(tx => [tx.signature, tx]));

      for (const sig of batch) {
        const tx = bySignature.get(sig);
        results.push(tx ? {
          signature:  tx.signature,
          slot:       tx.slot ?? 0,
          block_time: new Date(tx.timestamp * 1000),
          fee:        tx.fee ?? 0,
          success:    !tx.transactionError,
          raw:        tx,
          source:     'helius',
        } : null);
      }

      if (i + BATCH < signatures.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    return results;
  }
}

// ── Helius Wallet Intelligence Provider ───────────────────────

export class HeliusWalletProvider implements WalletIntelProvider {
  readonly name = 'helius';

  async getWalletBalances(address: string): Promise<WalletBalances> {
    const solPrice = await getSolPriceUsd();
    const [solMap, usdc_balance] = await Promise.all([
      getBatchSolBalances([address]),
      getUsdcBalance(address),
    ]);
    const sol_balance    = solMap.get(address) ?? 0;
    const total_value_usd = sol_balance * solPrice + usdc_balance;

    return {
      address,
      sol_balance,
      usdc_balance,
      total_value_usd,
      token_count: 0,          // SOL+USDC only — no DAS credits spent
      refreshed_at: new Date(),
    };
  }

  async getWalletProfile(address: string): Promise<WalletProfile | null> {
    // Helius doesn't expose a direct profiling endpoint on free tier.
    // Labels are resolved from known_addresses table in DB.
    return null;
  }

  async discoverWhales(
    opts: { min_value_usd?: number; limit?: number } = {},
  ): Promise<DiscoveredWallet[]> {
    // Discovery via Helius DAS is 10 credits/call — reserved for small batches.
    // Primary discovery runs via discover-whales cron. This is a stub.
    throw new ProviderError(
      'helius',
      'NOT_IMPLEMENTED',
      'Whale discovery delegated to discover-whales cron',
    );
  }
}

// ── Webhook signature verification ───────────────────────────

export function verifyHeliusSignature(
  payload: string,
  headerSignature: string,
): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET ?? '';
  if (!secret) return true; // dev mode

  const crypto  = require('crypto') as typeof import('crypto');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(headerSignature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}

// ── Build webhook subscription config ────────────────────────

export function buildWebhookConfig(opts: {
  url:      string;
  secret:   string;
  addresses: string[];
  types?:   string[];
}) {
  return {
    webhookURL:       opts.url,
    transactionTypes: opts.types ?? ['TRANSFER', 'SWAP', 'ADD_LIQUIDITY', 'WITHDRAW_LIQUIDITY'],
    accountAddresses: opts.addresses,
    webhookType:      'enhanced',
    authHeader:       `Bearer ${opts.secret}`,
  };
}

// ── Re-create webhook via Helius API ─────────────────────────

export async function createHeliusWebhook(opts: {
  url:       string;
  secret:    string;
  addresses: string[];
}): Promise<{ webhookID: string; created: boolean }> {
  const key = apiKey();
  const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${key}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(buildWebhookConfig(opts)),
    signal:  AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError('helius', `WEBHOOK_CREATE_${res.status}`, body.slice(0, 300));
  }

  const data = (await res.json()) as { webhookID: string };
  return { webhookID: data.webhookID, created: true };
}
