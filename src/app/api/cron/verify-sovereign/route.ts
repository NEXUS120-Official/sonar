// ============================================================
// SONAR — Sovereign Path Verification
// POST /api/cron/verify-sovereign
// ============================================================
// Audit-grade end-to-end probe of the sovereign data path.
// No DB writes — normalization runs entirely in memory.
//
// Exercises in order:
//   1. Provider manifest + SOVEREIGN_RPC_URL presence check
//   2. getTransaction()      — single tx fetch + decode
//   3. getAddressHistory()   — batch fetch + historyToRawRow()
//   4. getWalletBalances()   — live balance read
//   5. normalizeRawTxBatch() — sovereign decoder dispatch
//
// Required query params:
//   address   — Solana wallet address to probe
//   signature — transaction signature to probe
//   limit     — (optional) history page size, 1–20, default 5
//
// Missing params → 400, never invented test values.
// Provider config errors → surfaced explicitly, never swallowed.
//
// Protected by CRON_SECRET (same pattern as all SONAR crons).
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { SovereignSolanaProvider }        from '@/lib/providers/adapters/sovereign';
import { getProviderManifest }             from '@/lib/providers';
import { historyToRawRow }                 from '@/lib/ingest/ingest-rpc';
import { normalizeRawTx }                      from '@/lib/normalizer';
import { decodeSovereignMovement }         from '@/lib/decoder/sovereign';
import { resolveSolPriceUsd }              from '@/lib/price-engine';
import type { AddressHistory, WalletBalances, RawTransactionEvent } from '@/lib/providers/interfaces';

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const prefix = `[cron/verify-sovereign][${new Date().toISOString()}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Auth ──────────────────────────────────────────────────────

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'CRON_SECRET not set — running unauthenticated (dev mode)');
    return true;
  }
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

// ── Stage result shape ────────────────────────────────────────

interface StageOk<T>   { status: 'ok';     duration_ms: number; detail: T }
interface StageSkip    { status: 'skipped'; reason: string }
interface StageFail    { status: 'error';  duration_ms: number; error: string }
type StageResult<T>    = StageOk<T> | StageSkip | StageFail;

async function runStage<T>(
  name:    string,
  fn:      () => Promise<T>,
): Promise<StageResult<T>> {
  const t = Date.now();
  try {
    const detail = await fn();
    return { status: 'ok', duration_ms: Date.now() - t, detail };
  } catch (err) {
    const msg = String(err);
    log('error', `Stage [${name}] failed: ${msg}`);
    return { status: 'error', duration_ms: Date.now() - t, error: msg };
  }
}

// ── Stage detail types ────────────────────────────────────────

interface TransactionStageDetail {
  found:             boolean;
  source:            string | null;
  slot:              number | null;
  block_time_iso:    string | null;
  has_meta:          boolean;
  meta_err:          unknown;
  account_key_count: number;
  fee_lamports:      number | null;
  decoded_movement:  string | null;   // flow_type if decoded, null otherwise
}

interface HistoryStageDetail {
  requested_limit:   number;
  fetched:           number;
  confirmed:         number;          // err === null items from getSignaturesForAddress
  raw_rows_built:    number;
  source_tag:        string | null;   // source field on first row
}

interface BalancesStageDetail {
  sol_balance:     number;
  usdc_balance:    number;
  total_value_usd: number;
  token_count:     number;
}

interface NormalizationStageDetail {
  input_rows:       number;
  decoded:          number;
  skipped:          number;
  null_movement:    number;
  token_movement_null_count: number;  // should equal decoded (deferred)
  flow_types:       string[];         // unique flow_types seen
  sample_movements: SampleMovement[];
}

interface SampleMovement {
  signature:      string;
  flow_type:      string;
  token:          string;
  amount_usd:     number | null;
  from_label:     string | null;
  to_label:       string | null;
}

// ── Full receipt ──────────────────────────────────────────────

interface SovereignVerificationReceipt {
  ok:                   boolean;
  run_at:               string;
  duration_ms:          number;
  provider_manifest:    ReturnType<typeof getProviderManifest>;
  sovereign_rpc_url_set: boolean;
  params: {
    address:   string;
    signature: string;
    limit:     number;
  };
  stages: {
    get_transaction:    StageResult<TransactionStageDetail>;
    get_address_history: StageResult<HistoryStageDetail>;
    get_wallet_balances: StageResult<BalancesStageDetail>;
    normalization:       StageResult<NormalizationStageDetail>;
  };
  errors: string[];
}

// ── Main handler ──────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const runAt   = new Date();
  const startMs = Date.now();
  const errors: string[] = [];

  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // ── 1. Parse and validate params ─────────────────────────────
  const url       = req.nextUrl;
  const address   = url.searchParams.get('address')   ?? null;
  const signature = url.searchParams.get('signature') ?? null;
  const limitRaw  = url.searchParams.get('limit');
  const limit     = Math.min(20, Math.max(1, limitRaw ? parseInt(limitRaw, 10) : 5));

  if (!address || !signature) {
    return NextResponse.json({
      ok:    false,
      error: 'Missing required params: address and signature must be provided. ' +
             'Example: ?address=<pubkey>&signature=<tx-sig>&limit=5',
    }, { status: 400 });
  }

  log('info', `Verifying sovereign path — address=${address} sig=${signature.slice(0, 20)}... limit=${limit}`);

  // ── 2. Manifest + RPC presence check ─────────────────────────
  const manifest          = getProviderManifest();
  const sovereignRpcSet   = Boolean(process.env.SOVEREIGN_RPC_URL);
  const provider          = new SovereignSolanaProvider();

  log('info', `Provider mode: ${manifest.mode} | SOVEREIGN_RPC_URL set: ${sovereignRpcSet}`);

  if (!sovereignRpcSet) {
    errors.push('SOVEREIGN_RPC_URL is not set — all sovereign stages will fail with NOT_OPERATIONAL');
  }

  // ── 3. Resolve SOL price (needed for normalizer) ─────────────
  let solPriceUsd = 0;
  try {
    solPriceUsd = await resolveSolPriceUsd(300);
    log('info', `SOL price: $${solPriceUsd}`);
  } catch (err) {
    const msg = `resolveSolPriceUsd failed: ${String(err)} — normalization will use $0`;
    log('warn', msg);
    errors.push(msg);
  }

  // ── Stage A: getTransaction ───────────────────────────────────
  let rawTxEvent: RawTransactionEvent | null = null;

  const stageGetTx = await runStage<TransactionStageDetail>('getTransaction', async () => {
    rawTxEvent = await provider.getTransaction(signature);

    if (!rawTxEvent) {
      return {
        found:             false,
        source:            null,
        slot:              null,
        block_time_iso:    null,
        has_meta:          false,
        meta_err:          null,
        account_key_count: 0,
        fee_lamports:      null,
        decoded_movement:  null,
      };
    }

    // Introspect the native payload shape
    const raw  = rawTxEvent.raw as Record<string, unknown>;
    const meta = raw?.meta as Record<string, unknown> | null | undefined;
    const msg  = (raw?.transaction as Record<string, unknown>)?.message as Record<string, unknown>;
    const keys = (msg?.accountKeys as unknown[]) ?? [];

    // Quick single-tx decode (same path normalizer would take)
    let decodedFlowType: string | null = null;
    try {
      const m = decodeSovereignMovement(raw, new Set([address]), solPriceUsd);
      decodedFlowType = m?.flow_type ?? null;
    } catch { /* decode error — leave null */ }

    return {
      found:             true,
      source:            rawTxEvent.source,
      slot:              rawTxEvent.slot,
      block_time_iso:    rawTxEvent.block_time instanceof Date
                           ? rawTxEvent.block_time.toISOString()
                           : String(rawTxEvent.block_time),
      has_meta:          meta !== null && meta !== undefined,
      meta_err:          meta?.err ?? null,
      account_key_count: keys.length,
      fee_lamports:      typeof meta?.fee === 'number' ? meta.fee : null,
      decoded_movement:  decodedFlowType,
    };
  });

  // ── Stage B: getAddressHistory ────────────────────────────────
  let historyItems: AddressHistory[] = [];
  let rawRows: ReturnType<typeof historyToRawRow>[] = [];

  const stageHistory = await runStage<HistoryStageDetail>('getAddressHistory', async () => {
    historyItems = await provider.getAddressHistory(address, { limit });

    const confirmed = historyItems.filter(h => {
      const raw = h.raw as Record<string, unknown> | null;
      // Items built from sigInfo have err === null; items from full tx have meta.err
      if (raw && 'err' in raw) return raw.err === null;
      return true;   // full SolanaTransactionResult — already filtered upstream
    });

    rawRows = historyItems
      .filter(h => h.signature)
      .map(historyToRawRow);

    return {
      requested_limit:  limit,
      fetched:          historyItems.length,
      confirmed:        confirmed.length,
      raw_rows_built:   rawRows.length,
      source_tag:       rawRows[0]?.source ?? null,
    };
  });

  // ── Stage C: getWalletBalances ────────────────────────────────
  let balances: WalletBalances | null = null;

  const stageBalances = await runStage<BalancesStageDetail>('getWalletBalances', async () => {
    balances = await provider.getWalletBalances(address);
    return {
      sol_balance:     balances.sol_balance,
      usdc_balance:    balances.usdc_balance,
      total_value_usd: balances.total_value_usd,
      token_count:     balances.token_count,
    };
  });

  // ── Stage D: normalizeRawTxBatch ──────────────────────────────
  // Pure in-memory — no DB writes.
  const stageNorm = await runStage<NormalizationStageDetail>('normalization', async () => {
    if (rawRows.length === 0) {
      return {
        input_rows:               0,
        decoded:                  0,
        skipped:                  0,
        null_movement:            0,
        token_movement_null_count: 0,
        flow_types:               [],
        sample_movements:         [],
      };
    }

    // Use the probed address as the sole whale — same logic as backfill.
    const whaleSet   = new Set([address]);
    const allOutputs = rawRows.map(row =>
      normalizeRawTx(row, { whaleAddressSet: whaleSet, solPriceUsd }),
    );

    const decoded      = allOutputs.filter(o => !o.skipped && o.movement !== null);
    const skipped      = allOutputs.filter(o => o.skipped);
    const nullMovement = allOutputs.filter(o => !o.skipped && o.movement === null);

    const flowTypes = [...new Set(decoded.map(o => o.movement!.flow_type as string))];

    const sample: SampleMovement[] = decoded.slice(0, 3).map(o => ({
      signature:  o.signature,
      flow_type:  o.movement!.flow_type as string,
      token:      o.movement!.token as string,
      amount_usd: o.movement!.amount_usd as number | null,
      from_label: o.movement!.from_label as string | null,
      to_label:   o.movement!.to_label as string | null,
    }));

    return {
      input_rows:               rawRows.length,
      decoded:                  decoded.length,
      skipped:                  skipped.length,
      null_movement:            nullMovement.length,
      token_movement_null_count: allOutputs.filter(o => !o.skipped && o.tokenMovement === null).length,
      flow_types:               flowTypes,
      sample_movements:         sample,
    };
  });

  // ── Collect top-level errors ──────────────────────────────────
  for (const stage of [stageGetTx, stageHistory, stageBalances, stageNorm]) {
    if (stage.status === 'error') errors.push(stage.error);
  }

  const receipt: SovereignVerificationReceipt = {
    ok:                    errors.length === 0,
    run_at:                runAt.toISOString(),
    duration_ms:           Date.now() - startMs,
    provider_manifest:     manifest,
    sovereign_rpc_url_set: sovereignRpcSet,
    params: { address, signature, limit },
    stages: {
      get_transaction:     stageGetTx,
      get_address_history: stageHistory,
      get_wallet_balances: stageBalances,
      normalization:       stageNorm,
    },
    errors,
  };

  log('info', `Verification complete — ok=${receipt.ok} stages_errored=${errors.length}`);
  return NextResponse.json(receipt);
}

export const GET = POST;
