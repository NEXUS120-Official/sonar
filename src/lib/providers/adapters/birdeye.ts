// ============================================================
// SONAR — Birdeye Price Provider Adapter
// ============================================================
// Wraps Birdeye API behind PriceProvider interface.
// Future replacement: InternalPriceEngine (pool TWAP + oracle)
// ============================================================

import type { PriceProvider, PriceQuote } from '../interfaces';
import { ProviderError } from '../interfaces';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const SOL_MINT     = 'So11111111111111111111111111111111111111112';

function apiKey(): string {
  const key = process.env.BIRDEYE_API_KEY;
  if (!key) throw new ProviderError('birdeye', 'MISSING_KEY', 'BIRDEYE_API_KEY not set');
  return key;
}

export class BirdeyePriceProvider implements PriceProvider {
  readonly name = 'birdeye';

  async getTokenPrice(mint: string, _at?: Date): Promise<PriceQuote | null> {
    try {
      const res = await fetch(
        `${BIRDEYE_BASE}/defi/price?address=${mint}`,
        {
          headers: {
            'X-API-KEY': apiKey(),
            Accept:      'application/json',
          },
          signal: AbortSignal.timeout(8_000),
        },
      );

      if (!res.ok) return null;

      const json = (await res.json()) as {
        success: boolean;
        data: { value: number; updateUnixTime: number } | null;
      };

      if (!json.success || !json.data?.value) return null;

      return {
        mint,
        price_usd:   json.data.value,
        source:      'birdeye',
        confidence:  80,
        observed_at: json.data.updateUnixTime
          ? new Date(json.data.updateUnixTime * 1000)
          : new Date(),
      };
    } catch {
      return null;
    }
  }

  async getSolPrice(_at?: Date): Promise<PriceQuote | null> {
    return this.getTokenPrice(SOL_MINT);
  }

  async getMultipleTokenPrices(mints: string[]): Promise<Map<string, PriceQuote>> {
    const results = new Map<string, PriceQuote>();

    // Birdeye multi-price endpoint (up to 100 at once)
    const BATCH = 100;
    for (let i = 0; i < mints.length; i += BATCH) {
      const batch = mints.slice(i, i + BATCH);
      try {
        const res = await fetch(
          `${BIRDEYE_BASE}/defi/multi_price?list_address=${batch.join(',')}`,
          {
            headers: { 'X-API-KEY': apiKey(), Accept: 'application/json' },
            signal:  AbortSignal.timeout(10_000),
          },
        );

        if (!res.ok) continue;

        const json = (await res.json()) as {
          success: boolean;
          data: Record<string, { value: number; updateUnixTime: number } | null>;
        };

        if (!json.success) continue;

        for (const mint of batch) {
          const entry = json.data?.[mint];
          if (!entry?.value) continue;
          results.set(mint, {
            mint,
            price_usd:   entry.value,
            source:      'birdeye',
            confidence:  80,
            observed_at: new Date(entry.updateUnixTime * 1000),
          });
        }
      } catch { /* skip batch */ }

      if (i + BATCH < mints.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return results;
  }
}
