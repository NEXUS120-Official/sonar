// ============================================================
// SONAR — Jupiter Price Provider Adapter
// ============================================================
// Wraps Jupiter price API behind PriceProvider interface.
// Jupiter is a fallback after Birdeye. Future: internal price engine.
// ============================================================

import type { PriceProvider, PriceQuote } from '../interfaces';

const JUPITER_BASE = process.env.JUPITER_API_BASE ?? 'https://price.jup.ag/v6';
const SOL_MINT     = 'So11111111111111111111111111111111111111112';

export class JupiterPriceProvider implements PriceProvider {
  readonly name = 'jupiter';

  async getTokenPrice(mint: string, _at?: Date): Promise<PriceQuote | null> {
    try {
      const res = await fetch(`${JUPITER_BASE}/price?ids=${mint}`, {
        headers: { Accept: 'application/json' },
        signal:  AbortSignal.timeout(8_000),
      });

      if (!res.ok) return null;

      const json = (await res.json()) as {
        data: Record<string, { price: string } | null>;
      };

      const entry = json.data?.[mint];
      if (!entry?.price) return null;

      const price = parseFloat(entry.price);
      if (!price || price <= 0) return null;

      return {
        mint,
        price_usd:   price,
        source:      'jupiter',
        confidence:  75,
        observed_at: new Date(),
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
    if (mints.length === 0) return results;

    // Jupiter supports multiple ids in one request
    const BATCH = 50;
    for (let i = 0; i < mints.length; i += BATCH) {
      const batch = mints.slice(i, i + BATCH);
      try {
        const res = await fetch(
          `${JUPITER_BASE}/price?ids=${batch.join(',')}`,
          {
            headers: { Accept: 'application/json' },
            signal:  AbortSignal.timeout(10_000),
          },
        );

        if (!res.ok) continue;

        const json = (await res.json()) as {
          data: Record<string, { price: string } | null>;
        };

        for (const mint of batch) {
          const entry = json.data?.[mint];
          const price = entry?.price ? parseFloat(entry.price) : 0;
          if (!price) continue;
          results.set(mint, {
            mint,
            price_usd:   price,
            source:      'jupiter',
            confidence:  75,
            observed_at: new Date(),
          });
        }
      } catch { /* skip batch */ }

      if (i + BATCH < mints.length) {
        await new Promise(r => setTimeout(r, 150));
      }
    }

    return results;
  }
}
