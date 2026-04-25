import type { createAdminClient } from '@/lib/supabase/server';
import type { MovementRow, TokenMovementRow } from '@/lib/supabase/types';
import type { RawTxRow } from '@/lib/ingest/ingest-rpc';
import type { NormalizedOutput } from '@/lib/normalizer';
import { envelopeFromRawTxRow } from '@/lib/sovereign/ingest-envelope';
import { normalizeProviderEnvelopes } from '@/lib/sovereign/provider-normalization';
import { resolveAddressBatch } from '@/lib/entity-graph';
import { resolveTokenMetadataBatch } from '@/lib/helius/token-metadata';

type Db = ReturnType<typeof createAdminClient>;

export interface RawReplayBridgeReceipt {
  raw_rows: number;
  classified: number;
  token_classified: number;
  inserted_movements: number;
  skipped_movements: number;
  inserted_token_movements: number;
  skipped_token_movements: number;
}

async function persistMovements(
  movements: (Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> | null)[],
  db: Db,
): Promise<{ inserted: number; skipped: number }> {
  const valid = movements.filter((m): m is NonNullable<typeof m> => m !== null);
  if (valid.length === 0) return { inserted: 0, skipped: 0 };

  const addresses = [...new Set(valid.flatMap(m => [m.from_address, m.to_address]).filter(Boolean))];

  const [whaleResult, entityMap] = await Promise.all([
    db.from('whales').select('id, address').in('address', addresses),
    resolveAddressBatch(addresses, db),
  ]);

  const whaleMap = new Map<string, string>(
    ((whaleResult.data ?? []) as { id: string; address: string }[]).map(w => [w.address, w.id]),
  );

  const rows = valid.map(m => {
    const fromEntity = entityMap.get(m.from_address);
    const toEntity   = entityMap.get(m.to_address);

    return {
      ...m,
      whale_id:  whaleMap.get(m.from_address) ?? whaleMap.get(m.to_address) ?? null,
      from_label: m.from_label ?? fromEntity?.label ?? fromEntity?.canonical_name ?? null,
      to_label:   m.to_label   ?? toEntity?.label   ?? toEntity?.canonical_name   ?? null,
    } satisfies Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await (db as any)
    .from('movements')
    .upsert(rows as any, { onConflict: 'signature', ignoreDuplicates: true })
    .select('id');

  if (error) {
    throw error;
  }

  return {
    inserted: inserted?.length ?? 0,
    skipped: valid.length - (inserted?.length ?? 0),
  };
}

async function persistTokenMovements(
  normalized: NormalizedOutput[],
  db: Db,
): Promise<{ inserted: number; skipped: number }> {
  type ValidOut = NormalizedOutput & { tokenMovement: NonNullable<NormalizedOutput['tokenMovement']> };
  const valid = normalized.filter((out): out is ValidOut => out.tokenMovement !== null);
  if (valid.length === 0) return { inserted: 0, skipped: 0 };

  const sigs = [...new Set(valid.map(v => v.signature).filter(Boolean))];

  const [{ data: movRows }, { data: whales }] = await Promise.all([
    db.from('movements').select('id, signature, whale_id').in('signature', sigs),
    db.from('whales').select('id, address').in(
      'address',
      [...new Set(valid.map(v => v.whaleAddressHint).filter((x): x is string => !!x))]
    ),
  ]);

  const sigToMovId = new Map<string, string>();
  const sigToWhaleId = new Map<string, string>();
  for (const row of (movRows ?? []) as { id: string; signature: string; whale_id: string | null }[]) {
    sigToMovId.set(row.signature, row.id);
    if (row.whale_id) sigToWhaleId.set(row.signature, row.whale_id);
  }

  const addrToWhaleId = new Map<string, string>();
  for (const row of (whales ?? []) as { id: string; address: string }[]) {
    addrToWhaleId.set(row.address, row.id);
  }

  const rows = valid.map(out => ({
    ...out.tokenMovement,
    movement_id: sigToMovId.get(out.signature) ?? null,
    whale_id: sigToWhaleId.get(out.signature)
      ?? (out.whaleAddressHint ? addrToWhaleId.get(out.whaleAddressHint) ?? null : null),
  } satisfies Omit<TokenMovementRow, 'id' | 'created_at'>));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: inserted, error } = await (db as any)
    .from('token_movements')
    .upsert(rows as any, { onConflict: 'signature', ignoreDuplicates: true })
    .select('id');

  if (error) {
    throw error;
  }

  if ((inserted?.length ?? 0) > 0) {
    const mints = [...new Set(valid.map(out => out.tokenMovement.token_mint))];
    resolveTokenMetadataBatch(mints)
      .then(async metaMap => {
        for (const [mint, meta] of metaMap) {
          if (!meta.symbol && !meta.name) continue;
          await (db as any)
            .from('token_movements')
            .update({ token_symbol: meta.symbol, token_name: meta.name })
            .eq('token_mint', mint)
            .is('token_symbol', null);
        }
      })
      .catch(() => {});
  }

  return {
    inserted: inserted?.length ?? 0,
    skipped: valid.length - (inserted?.length ?? 0),
  };
}

export async function replayRawTransactionsIntoMovements(
  db: Db,
  rows: RawTxRow[],
): Promise<RawReplayBridgeReceipt> {
  const envelopes = rows.map((row) => envelopeFromRawTxRow(row, 'raw_transactions_replay'));

  const normalization = normalizeProviderEnvelopes(envelopes, {
    whaleAddressSet: new Set<string>(),
    solPriceUsd: 0,
  });

  const movements = normalization.normalized.map((out) => out.movement);

  const movementReceipt = await persistMovements(movements, db);
  const tokenReceipt = await persistTokenMovements(normalization.normalized, db);

  return {
    raw_rows: rows.length,
    classified: normalization.classified,
    token_classified: normalization.token_classified,
    inserted_movements: movementReceipt.inserted,
    skipped_movements: movementReceipt.skipped,
    inserted_token_movements: tokenReceipt.inserted,
    skipped_token_movements: tokenReceipt.skipped,
  };
}
