import { createAdminClient } from '@/lib/supabase/server';
import { loadPriceCandidates } from '@/lib/sovereign/sovereign-price-runtime';
import { selectEffectiveSovereignPrice } from '@/lib/sovereign/sovereign-price-merge-policy';

export default async function PriceMergePage() {
  const db = createAdminClient();

  const assets = ['SOL', 'USDC', 'USDT'];
  const results = await Promise.all(
    assets.map(async (asset) => {
      const candidates = await loadPriceCandidates(db, asset);
      return {
        asset,
        ...selectEffectiveSovereignPrice(candidates),
      };
    })
  );

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Price Merge Policy</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Deterministic effective price selection, ranked candidate visibility, and source-quality auditability.
          </p>
        </div>

        {results.map((result) => (
          <section key={result.asset} className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">{result.asset}</h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Effective price source selection for sovereign valuation.
                </p>
              </div>
              <div className="text-sm text-cyan-300">
                {result.effective?.price_usd ?? '—'}
              </div>
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Source</th>
                    <th className="py-2 text-right font-medium">Price</th>
                    <th className="py-2 text-right font-medium">Confidence</th>
                    <th className="py-2 text-right font-medium">Merge Score</th>
                    <th className="py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.ranked_candidates.map((row, idx) => (
                    <tr key={`${result.asset}-${idx}`} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.price_source_mode}</td>
                      <td className="py-3 text-right text-zinc-300">{row.price_usd ?? '—'}</td>
                      <td className="py-3 text-right text-zinc-300">{row.price_confidence}</td>
                      <td className="py-3 text-right text-emerald-300">{row.merge_score}</td>
                      <td className="py-3 text-zinc-400">{row.merge_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
