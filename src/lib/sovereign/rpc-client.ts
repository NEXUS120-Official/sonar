// ============================================================
// SONAR — Sovereign RPC Client
// ============================================================
// Minimal JSON-RPC 2.0 client for any Solana-compatible RPC node.
// Targets standard Solana JSON-RPC spec (getTransaction,
// getSignaturesForAddress, getAccountInfo, getTokenAccountsByOwner).
//
// Design constraints:
//   - No Solana SDK dependency — raw fetch only
//   - Only fields SONAR actually reads are strongly typed; the
//     rest of each response is `unknown` to avoid false safety
//   - Factory (getSovereignRpcClient) returns null when
//     SOVEREIGN_RPC_URL is unset; callers throw NOT_OPERATIONAL
//   - Compatible with Agave, self-hosted nodes, and any future
//     Frankendancer / Firedancer RPC surface that speaks the
//     standard JSON-RPC spec
//
// Source tag written by this client: 'sovereign_rpc'
// ============================================================

import { ProviderError } from '@/lib/providers/interfaces';

export const SOVEREIGN_SOURCE = 'sovereign_rpc' as const;

// ── Solana RPC response types ─────────────────────────────────
// Only the fields SONAR reads are typed. Full response objects
// are accepted via `unknown` to avoid coupling to spec revisions.

export interface SolanaSignatureInfo {
  signature:          string;
  slot:               number;
  err:                unknown | null;         // null = success
  memo:               string | null;
  blockTime:          number | null;          // unix seconds
  confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
}

export interface SolanaTransactionMeta {
  err:              unknown | null;
  fee:              number;
  preBalances:      number[];
  postBalances:     number[];
  logMessages:      string[] | null;
  innerInstructions: unknown[] | null;
  preTokenBalances:  SolanaTokenBalance[];
  postTokenBalances: SolanaTokenBalance[];
}

export interface SolanaTokenBalance {
  accountIndex: number;
  mint:         string;
  owner:        string | null;
  /**
   * Token program owning this account — present in jsonParsed responses.
   * 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' = legacy SPL
   * 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' = Token-2022
   */
  programId?:   string;
  uiTokenAmount: {
    amount:         string;
    decimals:       number;
    uiAmount:       number | null;
    uiAmountString: string;
  };
}

export interface SolanaTransactionResult {
  slot:      number;
  blockTime: number | null;
  transaction: {
    message: {
      accountKeys: string[] | Array<{ pubkey: string; signer: boolean; writable: boolean }>;
      instructions: unknown[];
      recentBlockhash: string;
    };
    signatures: string[];
  };
  meta:    SolanaTransactionMeta | null;
  version: 'legacy' | number | null;
}

export interface SolanaAccountInfo {
  lamports:   number;
  owner:      string;
  data:       unknown;        // encoding-dependent; we only use lamports
  executable: boolean;
  rentEpoch:  number;
}

// ── JSON-parsed mint account types ───────────────────────────
// Returned by getAccountInfo(mint, encoding='jsonParsed') when the
// account is owned by SPL Token or Token-2022 program.

export interface SolanaMintExtension {
  /** Extension discriminator string, e.g. 'transferFeeConfig', 'confidentialTransferMint'. */
  extension: string;
  /** Extension-specific state — parsed selectively by the mint enricher. */
  state:     Record<string, unknown>;
}

export interface SolanaParsedMintInfo {
  decimals:        number;
  freezeAuthority: string | null;
  isInitialized:   boolean;
  mintAuthority:   string | null;
  supply:          string;
  /** Present on Token-2022 mints that have extensions installed. */
  extensions?:     SolanaMintExtension[];
}

export interface SolanaJsonParsedMintAccount {
  lamports:   number;
  /** Token program address — definitive program distinction signal. */
  owner:      string;
  data: {
    parsed: {
      info: SolanaParsedMintInfo;
      type: string;            // 'mint'
    };
    /** 'spl-token' | 'spl-token-2022' */
    program: string;
    space:   number;
  };
  executable: boolean;
  rentEpoch:  number;
}

export interface SolanaTokenAccount {
  pubkey: string;
  account: {
    data: {
      parsed: {
        info: {
          mint:  string;
          owner: string;
          tokenAmount: {
            amount:         string;
            decimals:       number;
            uiAmount:       number | null;
            uiAmountString: string;
          };
        };
        type: string;
      };
      program: string;
      space:   number;
    };
    lamports:   number;
    owner:      string;
    executable: boolean;
    rentEpoch:  number;
  };
}

// ── JSON-RPC error shape ──────────────────────────────────────

interface RpcError {
  code:    number;
  message: string;
  data?:   unknown;
}

interface RpcResponse<T> {
  jsonrpc: string;
  id:      number;
  result?: T;
  error?:  RpcError;
}

// ── SovereignRpcClient ────────────────────────────────────────

export class SovereignRpcClient {
  private readonly url:        string;
  private readonly commitment: string;
  private          _callId     = 1;

  constructor(url: string, commitment: 'finalized' | 'confirmed' = 'finalized') {
    this.url        = url;
    this.commitment = commitment;
  }

  // ── Base JSON-RPC call ──────────────────────────────────────

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = this._callId++;
    let res: Response;
    try {
      res = await fetch(this.url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal:  AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError('sovereign_rpc', 'NETWORK_ERROR', `${method}: ${String(err)}`, err);
    }

    if (!res.ok) {
      throw new ProviderError(
        'sovereign_rpc', `HTTP_${res.status}`,
        `${method} returned HTTP ${res.status}`,
      );
    }

    const body = await res.json() as RpcResponse<T>;

    if (body.error) {
      throw new ProviderError(
        'sovereign_rpc', `RPC_${body.error.code}`,
        `${method}: ${body.error.message}`,
      );
    }

    return body.result as T;
  }

  // ── getTransaction ──────────────────────────────────────────
  // Uses jsonParsed encoding + maxSupportedTransactionVersion=0
  // for broadest compatibility (versioned txns, lookup tables).
  // Returns null when the transaction is not found or not yet
  // at the requested commitment level.

  async getTransaction(signature: string): Promise<SolanaTransactionResult | null> {
    return this.call<SolanaTransactionResult | null>('getTransaction', [
      signature,
      {
        encoding:                     'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment:                    this.commitment,
      },
    ]);
  }

  // ── getSignaturesForAddress ─────────────────────────────────
  // Returns up to `limit` (max 1000) confirmed signatures for the
  // address, ordered newest-first. `before` enables pagination.

  async getSignaturesForAddress(
    address: string,
    opts: {
      limit?:      number;
      before?:     string;
      until?:      string;
      commitment?: string;
    } = {},
  ): Promise<SolanaSignatureInfo[]> {
    const config: Record<string, unknown> = {
      commitment: opts.commitment ?? this.commitment,
    };
    if (opts.limit  !== undefined) config['limit']  = opts.limit;
    if (opts.before !== undefined) config['before'] = opts.before;
    if (opts.until  !== undefined) config['until']  = opts.until;

    return this.call<SolanaSignatureInfo[]>('getSignaturesForAddress', [address, config]);
  }

  // ── getAccountInfo ──────────────────────────────────────────
  // Used to read native SOL lamports. `data` is base64-encoded
  // account data; SONAR only reads `lamports`.

  async getAccountInfo(pubkey: string): Promise<SolanaAccountInfo | null> {
    const result = await this.call<{ value: SolanaAccountInfo | null }>(
      'getAccountInfo',
      [pubkey, { encoding: 'base64', commitment: this.commitment }],
    );
    return result?.value ?? null;
  }

  // ── getMintAccountInfo ──────────────────────────────────────
  // Fetches the mint account with jsonParsed encoding to extract
  // decimals, token program, and Token-2022 extension presence.
  // Returns null when the mint account does not exist.

  async getMintAccountInfo(mint: string): Promise<SolanaJsonParsedMintAccount | null> {
    const result = await this.call<{ value: SolanaJsonParsedMintAccount | null }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: this.commitment }],
    );
    return result?.value ?? null;
  }

  // ── getTokenAccountsByOwner ─────────────────────────────────
  // Returns all SPL token accounts owned by `owner` for the given
  // mint. Used to read USDC (and future SPL) balances.

  async getTokenAccountsByOwner(
    owner: string,
    mint:  string,
  ): Promise<SolanaTokenAccount[]> {
    const result = await this.call<{ value: SolanaTokenAccount[] }>(
      'getTokenAccountsByOwner',
      [owner, { mint }, { encoding: 'jsonParsed', commitment: this.commitment }],
    );
    return result?.value ?? [];
  }
}

// ── Factory ───────────────────────────────────────────────────
// Returns null when SOVEREIGN_RPC_URL is not configured so that
// callers can throw NOT_OPERATIONAL rather than fail silently.

export function getSovereignRpcClient(): SovereignRpcClient | null {
  const url = process.env.SOVEREIGN_RPC_URL;
  if (!url) return null;
  return new SovereignRpcClient(url);
}
