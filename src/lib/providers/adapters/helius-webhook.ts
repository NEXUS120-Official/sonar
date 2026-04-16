// ============================================================
// SONAR — HeliusWebhookProcessor
// ============================================================
// Owns the full push-ingestion pipeline for Helius webhook events:
//   archiveRaw → decode → normalize → persist → hot alerts
//
// Design note: this does NOT implement ChainStreamProvider.
// ChainStreamProvider uses AsyncIterable<RawTransactionEvent> —
// the correct model for pull/subscription streams (Geyser/Yellowstone).
// Helius webhook is push-based: Helius calls us.  When the sovereign
// Geyser provider is built, it will implement ChainStreamProvider and
// feed the same decoder/normalizer pipeline from a pull stream.
//
// Usage (from webhook HTTP route):
//   const db      = createAdminClient();
//   const [whales, solPrice] = await Promise.all([
//     processor.fetchWhaleAddresses(db),
//     resolveSolPriceUsd(),
//   ]);
//   processor.archiveRaw(txns, db).catch(...);          // fire-and-forget
//   const receipt = await processor.processBatch(txns, { whaleAddressSet: whales, solPriceUsd: solPrice }, db);
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import { txToRawRow, type RawTxPayload } from '@/lib/decoder';
import { normalizeRawTx, type NormalizedOutput } from '@/lib/normalizer';
import { resolveTokenMetadataBatch } from '@/lib/helius/token-metadata';
import { sendMessage } from '@/lib/telegram/bot';
import { formatFlowAlert } from '@/lib/telegram/formatter';
import type { MovementRow, TokenMovementRow, AlertRow } from '@/lib/supabase/types';

// ── Types ─────────────────────────────────────────────────────

type Db = ReturnType<typeof createAdminClient>;

export interface WebhookProcessingContext {
  solPriceUsd:     number;
  whaleAddressSet: Set<string>;
}

export interface WebhookProcessingReceipt {
  received:         number;
  classified:       number;
  inserted:         number;
  skipped:          number;
  token_classified: number;
  token_inserted:   number;
  token_skipped:    number;
}

// ── Module-level state ────────────────────────────────────────
// Shared across warm serverless instances (best-effort cooldown).

const HOT_ALERT_THRESHOLD_USD = 200_000;
const HOT_ALERT_COOLDOWN_MS   = 30 * 60_000;
const _lastHotAlert            = new Map<string, number>();

// ── Logging ───────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', msg: string, ctx?: unknown) {
  const ts     = new Date().toISOString();
  const prefix = `[HeliusWebhookProcessor][${ts}]`;
  if (level === 'error') console.error(prefix, msg, ctx ?? '');
  else if (level === 'warn')  console.warn(prefix, msg, ctx ?? '');
  else console.log(prefix, msg, ctx ?? '');
}

// ── Processor ─────────────────────────────────────────────────

export class HeliusWebhookProcessor {
  readonly name = 'helius_webhook';

  // ── Context helpers ────────────────────────────────────────

  async fetchWhaleAddresses(db: Db): Promise<Set<string>> {
    try {
      const { data } = await db
        .from('whales')
        .select('address')
        .eq('is_active', true)
        .limit(500);
      if (!data) return new Set();
      return new Set((data as { address: string }[]).map(w => w.address));
    } catch {
      return new Set();
    }
  }

  // ── Raw archive ────────────────────────────────────────────
  // Immutable append-only log — written before decode so even
  // unparseable payloads are captured.

  async archiveRaw(txns: RawTxPayload[], db: Db): Promise<void> {
    if (txns.length === 0) return;
    const rows = txns
      .filter(tx => (tx as any)?.signature)
      .map(tx => txToRawRow(tx, 'helius_webhook'));
    if (rows.length === 0) return;
    await (db as any)
      .from('raw_transactions')
      .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true });
  }

  // ── Main pipeline ──────────────────────────────────────────

  async processBatch(
    txns:    RawTxPayload[],
    ctx:     WebhookProcessingContext,
    db:      Db,
  ): Promise<WebhookProcessingReceipt> {

    // 1. Decode + normalize via the sovereign pipeline
    const normalized: NormalizedOutput[] = txns.map((tx) => {
      try {
        return normalizeRawTx(txToRawRow(tx, 'helius_webhook'), ctx);
      } catch (err) {
        log('warn', `Normalize failed for tx ${(tx as any)?.signature ?? 'unknown'}`, err);
        return {
          signature:        (tx as any)?.signature ?? '',
          movement:         null,
          tokenMovement:    null,
          whaleAddressHint: null,
          skipped:          true,
        };
      }
    });

    const classified      = normalized.filter(out => out.movement      !== null).length;
    const tokenClassified = normalized.filter(out => out.tokenMovement !== null).length;
    log('info', `Classified ${classified}/${txns.length} movements, ${tokenClassified} token movements`);

    // 2. Persist SOL/USDC movements
    const movements = normalized.map(out => out.movement);
    const { inserted, skipped } = await this.persistMovements(movements, db);
    log('info', `Persisted ${inserted} movements (${skipped} skipped/duplicate)`);

    // 3. Hot-path alerts — fire-and-forget, < 5 s latency
    this.fireHotAlerts(movements, ctx.solPriceUsd, db).catch(err =>
      log('warn', 'Hot alert pipeline error', err),
    );

    // 4. Persist token movements (needs movement IDs from step 2)
    let tokenInserted = 0;
    let tokenSkipped  = 0;

    if (tokenClassified > 0) {
      const sigs = txns
        .map(tx => (tx as any).signature as string)
        .filter(Boolean);

      const { data: movRows } = await db
        .from('movements')
        .select('id, signature, whale_id')
        .in('signature', sigs);

      const sigToMovId   = new Map<string, string>();
      const sigToWhaleId = new Map<string, string>();
      for (const row of movRows ?? []) {
        const r = row as { id: string; signature: string; whale_id: string | null };
        sigToMovId.set(r.signature, r.id);
        if (r.whale_id) sigToWhaleId.set(r.signature, r.whale_id);
      }

      const result = await this.persistTokenMovements(
        normalized, sigToMovId, sigToWhaleId, db,
      );
      tokenInserted = result.inserted;
      tokenSkipped  = result.skipped;
      log('info', `Persisted ${tokenInserted} token_movements (${tokenSkipped} skipped/duplicate)`);
    }

    return {
      received:         txns.length,
      classified,
      inserted,
      skipped,
      token_classified: tokenClassified,
      token_inserted:   tokenInserted,
      token_skipped:    tokenSkipped,
    };
  }

  // ── Private: persist SOL/USDC movements ───────────────────

  private async persistMovements(
    movements: (Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> | null)[],
    db:        Db,
  ): Promise<{ inserted: number; skipped: number }> {
    const valid = movements.filter((m): m is NonNullable<typeof m> => m !== null);
    if (valid.length === 0) return { inserted: 0, skipped: 0 };

    // Resolve whale_id for from/to addresses in one batch query
    const addresses = [...new Set(valid.flatMap(m => [m.from_address, m.to_address]))];
    const { data: whales } = await db
      .from('whales')
      .select('id, address')
      .in('address', addresses);

    const whaleMap = new Map<string, string>(
      ((whales ?? []) as { id: string; address: string }[]).map(w => [w.address, w.id]),
    );

    const rows = valid.map(m => ({
      ...m,
      whale_id: whaleMap.get(m.from_address) ?? whaleMap.get(m.to_address) ?? null,
    } satisfies Omit<MovementRow, 'id' | 'processed_at' | 'created_at'>));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error } = await (db as any)
      .from('movements')
      .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true })
      .select('id');

    if (error) {
      log('error', 'Failed to upsert movements', error);
      return { inserted: 0, skipped: valid.length };
    }

    return {
      inserted: inserted?.length ?? 0,
      skipped:  valid.length - (inserted?.length ?? 0),
    };
  }

  // ── Private: persist SPL token movements ──────────────────

  private async persistTokenMovements(
    normalized:            NormalizedOutput[],
    signatureToMovementId: Map<string, string>,
    sigToWhaleId:          Map<string, string>,
    db:                    Db,
  ): Promise<{ inserted: number; skipped: number }> {
    type ValidOut = NormalizedOutput & { tokenMovement: NonNullable<NormalizedOutput['tokenMovement']> };
    const valid = normalized.filter((out): out is ValidOut => out.tokenMovement !== null);
    if (valid.length === 0) return { inserted: 0, skipped: 0 };

    // Address-based whale_id fallback for SWAPs (no parent movements row)
    const hintAddresses = [...new Set(
      valid.map(out => out.whaleAddressHint).filter((a): a is string => !!a),
    )];

    const addrToWhaleId = new Map<string, string>(sigToWhaleId);
    if (hintAddresses.length > 0) {
      const { data: tmWhales } = await db
        .from('whales')
        .select('id, address')
        .in('address', hintAddresses);
      for (const w of (tmWhales ?? []) as { id: string; address: string }[]) {
        addrToWhaleId.set(w.address, w.id);
      }
    }

    const rows = valid.map(out => ({
      ...out.tokenMovement,
      movement_id: signatureToMovementId.get(out.signature) ?? null,
      whale_id:    sigToWhaleId.get(out.signature)
        ?? (out.whaleAddressHint ? addrToWhaleId.get(out.whaleAddressHint) ?? null : null),
    } satisfies Omit<TokenMovementRow, 'id' | 'created_at'>));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: inserted, error } = await (db as any)
      .from('token_movements')
      .upsert(rows, { onConflict: 'signature', ignoreDuplicates: true })
      .select('id');

    if (error) {
      log('error', 'Failed to upsert token_movements', error);
      return { inserted: 0, skipped: valid.length };
    }

    // Metadata enrichment — fire-and-forget
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
        .catch(err => log('warn', 'Token metadata enrichment failed', err));
    }

    return {
      inserted: inserted?.length ?? 0,
      skipped:  valid.length - (inserted?.length ?? 0),
    };
  }

  // ── Private: hot-path large-move alerts ───────────────────
  // Bypasses the 5-min process-flows cron for whale_large_move alerts.

  private async fireHotAlerts(
    movements: (Omit<MovementRow, 'id' | 'processed_at' | 'created_at'> | null)[],
    solPrice:  number,
    db:        Db,
  ): Promise<void> {
    const HOT_TYPES = new Set([
      'exchange_deposit', 'exchange_withdrawal',
      'stake', 'unstake',
      'defi_deposit', 'defi_withdrawal',
    ]);

    const candidates = movements.filter(
      (m): m is NonNullable<typeof m> =>
        m !== null &&
        HOT_TYPES.has(m.flow_type) &&
        (m.amount_usd ?? 0) >= HOT_ALERT_THRESHOLD_USD,
    );
    if (candidates.length === 0) return;

    const addrs = [...new Set(candidates.flatMap(m => [m.from_address, m.to_address]))];
    const { data: whaleRows } = await db
      .from('whales')
      .select('id, address, label, reputation_score, smart_money_flag')
      .in('address', addrs)
      .eq('is_active', true);

    type WhaleInfo = { id: string; label: string | null; reputation_score: number | null; smart_money_flag: boolean | null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const whaleByAddr = new Map<string, WhaleInfo>(
      ((whaleRows ?? []) as any[]).map((w: any) => [w.address, w as WhaleInfo]),
    );

    const freeChannel    = process.env.TELEGRAM_CHANNEL_ID         ?? '';
    const premiumChannel = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? '';
    if (!freeChannel) return;

    const fmtUsd = (v: number) =>
      v >= 1e9 ? `$${(v/1e9).toFixed(2)}B` :
      v >= 1e6 ? `$${(v/1e6).toFixed(2)}M` :
      v >= 1e3 ? `$${(v/1e3).toFixed(0)}K` : `$${v.toFixed(0)}`;

    const dirLabel = (flowType: string) =>
      flowType === 'exchange_withdrawal' ? 'withdrawn from exchange' :
      flowType === 'exchange_deposit'    ? 'deposited to exchange'   :
      flowType === 'stake'               ? 'staked'                  :
      flowType === 'unstake'             ? 'unstaked'                :
      flowType === 'defi_deposit'        ? 'moved to DeFi'           :
      flowType === 'defi_withdrawal'     ? 'withdrawn from DeFi'     : 'moved';

    const signalDir = (flowType: string): 'bullish' | 'bearish' | 'neutral' =>
      ['exchange_withdrawal', 'defi_deposit', 'unstake'].includes(flowType) ? 'bullish' :
      ['exchange_deposit', 'defi_withdrawal', 'stake'].includes(flowType)   ? 'bearish' : 'neutral';

    for (const m of candidates) {
      const whale       = whaleByAddr.get(m.from_address) ?? whaleByAddr.get(m.to_address);
      const whaleId     = whale?.id ?? null;
      const cooldownKey = whaleId ?? m.from_address;

      const lastFired = _lastHotAlert.get(cooldownKey) ?? 0;
      if (Date.now() - lastFired < HOT_ALERT_COOLDOWN_MS) continue;

      const amtUsd   = m.amount_usd ?? 0;
      const action   = dirLabel(m.flow_type);
      const severity =
        amtUsd >= 2_000_000 ? 'major'       :
        amtUsd >= 500_000   ? 'significant' :
        amtUsd >= 200_000   ? 'notable'     : 'info';

      const smartBadge = whale?.smart_money_flag ? ' ⭐ Smart Money' : '';
      const repBadge   = whale?.reputation_score ? ` [rep ${whale.reputation_score}]` : '';
      const title      = `Whale ${action} ${fmtUsd(amtUsd)}${smartBadge}`;
      const body       = [
        whale?.label
          ? `Wallet: ${whale.label}${repBadge}`
          : `Address: ${m.from_address.slice(0, 8)}…`,
        `Action: ${action}`,
        m.exchange ? `Exchange: ${m.exchange}` : m.protocol ? `Protocol: ${m.protocol}` : null,
        `Amount: ${fmtUsd(amtUsd)} SOL @ $${solPrice.toFixed(2)}`,
      ].filter(Boolean).join('\n');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: alertInserted, error: insertErr } = await (db as any)
        .from('alerts')
        .insert({
          alert_type:            'whale_large_move',
          severity,
          title,
          body,
          data:                  { amount_usd: amtUsd, flow_type: m.flow_type, exchange: m.exchange, protocol: m.protocol, whale_id: whaleId, smart_money: whale?.smart_money_flag ?? false },
          movement_ids:          null,
          ai_analysis:           null,
          sent_telegram_free:    false,
          sent_telegram_premium: false,
          sent_at:               null,
        })
        .select('id')
        .single();

      if (insertErr || !alertInserted) continue;

      const alertRow: AlertRow = {
        id:                    (alertInserted as any).id,
        alert_type:            'whale_large_move',
        severity,
        title,
        body,
        data:                  { amount_usd: amtUsd },
        ai_analysis:           null,
        movement_ids:          null,
        sent_telegram_free:    false,
        sent_telegram_premium: false,
        sent_at:               null,
        created_at:            new Date().toISOString(),
      };

      const text     = formatFlowAlert(alertRow);
      const sendFree = ['significant', 'major'].includes(severity);

      const [freeOk, premOk] = await Promise.all([
        sendFree
          ? sendMessage({ chatId: freeChannel,    text }).then(r => r.ok).catch(() => false)
          : Promise.resolve(true),
        premiumChannel
          ? sendMessage({ chatId: premiumChannel, text }).then(r => r.ok).catch(() => false)
          : Promise.resolve(false),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).from('alerts').update({
        sent_telegram_free:    sendFree ? freeOk : false,
        sent_telegram_premium: premOk,
        sent_at:               new Date().toISOString(),
      }).eq('id', (alertInserted as any).id);

      _lastHotAlert.set(cooldownKey, Date.now());
      log('info', `Hot alert fired: ${title} (free=${sendFree && freeOk}, premium=${premOk})`);

      if (whaleId) {
        try {
          const { data: movRow } = await db
            .from('movements')
            .select('id')
            .eq('signature', m.signature)
            .maybeSingle();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (db as any).from('whale_signal_outcomes').insert({
            whale_id:         whaleId,
            movement_id:      (movRow as any)?.id ?? null,
            alert_id:         (alertInserted as any).id,
            signal_direction: signalDir(m.flow_type),
            signal_time:      new Date().toISOString(),
            price_at_signal:  solPrice,
            resolved:         false,
          });
        } catch (err) {
          log('warn', 'Failed to record signal outcome for hot alert', err);
        }
      }
    }
  }
}
