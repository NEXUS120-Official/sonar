import { createAdminClient } from '@/lib/supabase/server';
import { buildValuationClusterOverview } from '@/lib/sovereign/valuation-cluster-overview';

export default async function ValuationClustersPage() {
  const db = createAdminClient();
  const overview = await buildValuationClusterOverview(db, 25);

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Valuation Clusters</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Token-level and exchange / cluster-level valuation completeness intelligence.
          </p>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Top Token Valuation Gaps</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Asset</th>
                    <th className="py-2 text-right font-medium">Sightings</th>
                    <th className="py-2 text-right font-medium">Unpriced</th>
                    <th className="py-2 text-right font-medium">Priced Ratio</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.token_gap_leaderboard.map((row) => (
                    <tr key={row.asset_key} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.asset_key}</td>
                      <td className="py-3 text-right text-zinc-300">{row.sightings}</td>
                      <td className="py-3 text-right text-amber-300">{row.unpriced_count}</td>
                      <td className="py-3 text-right text-cyan-300">{row.priced_ratio}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Exchange Completeness</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Exchange</th>
                    <th className="py-2 text-right font-medium">Wallets</th>
                    <th className="py-2 text-right font-medium">Avg Ratio</th>
                    <th className="py-2 text-right font-medium">Partial</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.exchange_completeness.map((row) => (
                    <tr key={row.source_exchange} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.source_exchange}</td>
                      <td className="py-3 text-right text-zinc-300">{row.wallets}</td>
                      <td className="py-3 text-right text-cyan-300">{row.avg_completeness_ratio}</td>
                      <td className="py-3 text-right text-amber-300">{row.partial_wallets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Whale Candidate Completeness</h2>

          {overview.whale_completeness.length === 0 ? (
            <div className="mt-4 rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-4 text-sm text-zinc-400">
              Whale candidate persistence is not initialized yet, or no sovereign whale candidates have been written so far.
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Address</th>
                    <th className="py-2 text-right font-medium">Est. USD</th>
                    <th className="py-2 text-right font-medium">Priced</th>
                    <th className="py-2 text-right font-medium">Unpriced</th>
                    <th className="py-2 text-right font-medium">Ratio</th>
                    <th className="py-2 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.whale_completeness.map((row) => (
                    <tr key={row.address} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.address}</td>
                      <td className="py-3 text-right text-zinc-300">{row.estimated_balance_usd ?? '—'}</td>
                      <td className="py-3 text-right text-emerald-300">{row.priced_component_count}</td>
                      <td className="py-3 text-right text-amber-300">{row.unpriced_component_count}</td>
                      <td className="py-3 text-right text-cyan-300">{row.valuation_completeness_ratio}</td>
                      <td className="py-3 text-zinc-400">{row.valuation_status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
