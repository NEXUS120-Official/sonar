// LEGACY HISTORY NOTICE:
// Any Helius transaction-history usage should now be treated as
// legacy compatibility only.
// Strategic direction:
//   sovereign-history-runtime
//   raw_transactions replay
//   source-agnostic backfill paths
//
// Do not expand Helius-bound replay logic further.

// ============================================================
// SONAR — Helius API Client (Solana)
// ============================================================
// Wraps Helius REST API v0 and enhanced transaction parsing.
// Rate limited to stay within free tier defaults.

import { checkRateLimit, RateLimiters } from '@/lib/utils/rate-limiter';
import { HELIUS_API_REST } from '@/lib/utils/constants';

// ── Types ────────────────────────────────────────────────────

export interface HeliusTokenTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  fromTokenAccount: string;
  toTokenAccount: string;
  tokenAmount: number;
  mint: string;
  tokenStandard: string;
}

export interface HeliusNativeTransfer {
  fromUserAccount: string;
  toUserAccount: string;
  amount: number; // lamports
}

export interface HeliusSwapTokenAmount {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: {
    tokenAmount: string;
    decimals: number;
  };
}

export interface HeliusSwapNativeAmount {
  account: string;
  amount: string; // lamports as string
}

export interface HeliusSwapEvent {
  nativeInput: HeliusSwapNativeAmount | null;
  nativeOutput: HeliusSwapNativeAmount | null;
  tokenInputs: HeliusSwapTokenAmount[];
  tokenOutputs: HeliusSwapTokenAmount[];
  tokenFees: HeliusSwapTokenAmount[];
  nativeFees: HeliusSwapNativeAmount[];
  innerSwaps: Array<{
    programInfo: { source: string; account: string; programName: string; instructionName: string };
    tokenInputs: HeliusSwapTokenAmount[];
    tokenOutputs: HeliusSwapTokenAmount[];
    nativeInput: HeliusSwapNativeAmount | null;
    nativeOutput: HeliusSwapNativeAmount | null;
  }>;
}

export interface HeliusEnhancedTransaction {
  description: string;
  type: string;               // 'SWAP', 'TRANSFER', 'NFT_SALE', etc.
  source: string;             // 'JUPITER', 'RAYDIUM', 'ORCA', etc.
  fee: number;                // lamports
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;          // Unix seconds
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: Array<{
      userAccount: string;
      tokenAccount: string;
      mint: string;
      rawTokenAmount: { tokenAmount: string; decimals: number };
    }>;
  }>;
  transactionError: string | null;
  events: {
    swap?: HeliusSwapEvent;
    nft?: unknown;
    compressed?: unknown;
  };
}

export interface HeliusWebhookConfig {
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: 'enhanced' | 'raw' | 'discord';
  encoding?: 'jsonParsed' | 'base58' | 'base64';
  authHeader?: string;
}

export interface HeliusWebhook extends HeliusWebhookConfig {
  webhookID: string;
  wallet: string;
}

// ── Internal helpers ─────────────────────────────────────────

function apiUrl(path: string, apiKey: string): string {
  // Use '&' if the path already carries query params, '?' otherwise.
  const sep = path.includes('?') ? '&' : '?';
  return `${HELIUS_API_REST}${path}${sep}api-key=${apiKey}`;
}

function getApiKey(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('[helius/client] Missing HELIUS_API_KEY env var');
  return key;
}

async function heliusFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const apiKey = getApiKey();

  if (!checkRateLimit('helius', RateLimiters.helius)) {
    throw new Error('[helius/client] Rate limit exceeded — retry after backoff');
  }

  const url = apiUrl(path, apiKey);
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `[helius/client] HTTP ${res.status} on ${path}: ${body.slice(0, 200)}`,
    );
  }

  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Parse up to 100 transaction signatures into enhanced Helius objects.
 */
export async function parseTransactions(
  signatures: string[],
): Promise<HeliusEnhancedTransaction[]> {
  if (signatures.length === 0) return [];
  if (signatures.length > 100) {
    throw new Error('[helius/client] parseTransactions: max 100 signatures per call');
  }

  return heliusFetch<HeliusEnhancedTransaction[]>('/transactions', {
    method: 'POST',
    body: JSON.stringify({ transactions: signatures }),
  });
}

/**
 * Fetch recent transactions for a single address (max 100).
 */
export async function getAddressTransactions(
  address: string,
  options: {
    type?: string;
    before?: string;
    until?: string;
    limit?: number;
  } = {},
): Promise<HeliusEnhancedTransaction[]> {
  const params = new URLSearchParams();
  if (options.type) params.set('type', options.type);
  if (options.before) params.set('before', options.before);
  if (options.until) params.set('until', options.until);
  if (options.limit) params.set('limit', String(options.limit));

  const query = params.toString() ? `&${params.toString()}` : '';
  return heliusFetch<HeliusEnhancedTransaction[]>(
    `/addresses/${address}/transactions${query ? `?${params.toString()}` : ''}`,
  );
}

/**
 * List all registered webhooks for this API key.
 */
export async function listWebhooks(): Promise<HeliusWebhook[]> {
  return heliusFetch<HeliusWebhook[]>('/webhooks');
}

/**
 * Create a new webhook.
 */
export async function createWebhook(
  config: HeliusWebhookConfig,
): Promise<HeliusWebhook> {
  return heliusFetch<HeliusWebhook>('/webhooks', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

/**
 * Update an existing webhook (replace address list, URL, etc.).
 */
export async function updateWebhook(
  webhookId: string,
  config: Partial<HeliusWebhookConfig>,
): Promise<HeliusWebhook> {
  return heliusFetch<HeliusWebhook>(`/webhooks/${webhookId}`, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
}

/**
 * Delete a webhook by ID.
 */
export async function deleteWebhook(webhookId: string): Promise<void> {
  await heliusFetch<unknown>(`/webhooks/${webhookId}`, { method: 'DELETE' });
}

/**
 * Verify an incoming webhook request using the shared secret.
 * Returns true if the Authorization header matches HELIUS_WEBHOOK_SECRET.
 */
export function verifyWebhookSecret(authHeader: string | null): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  if (!secret) return true; // Secret not configured — skip verification in dev
  return authHeader === secret;
}

// ── PRD-interface aliases ─────────────────────────────────────

/**
 * Alias for getAddressTransactions — PRD documented name.
 * Fetches paginated transaction history for a tracked whale address.
 */
export const getTransactionHistory = getAddressTransactions;

/**
 * Fetch and parse a single transaction signature into an enhanced Helius object.
 * PRD documented name for single-signature lookups.
 */
export async function getEnhancedTransaction(
  signature: string,
): Promise<HeliusEnhancedTransaction | null> {
  const results = await parseTransactions([signature]);
  return results[0] ?? null;
}
