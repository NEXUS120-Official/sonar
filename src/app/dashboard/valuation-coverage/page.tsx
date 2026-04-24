import { createAdminClient } from '@/lib/supabase/server';
import { buildValuationCoverageOverview } from '@/lib/sovereign/valuation-coverage-overview';

export default async function ValuationCoveragePage() {
  const db = createAdminClient();
  const overview = await buildValuationCoverageOverview(db, 25);

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Valuation Coverage</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Sovereign price freshness, coverage quality, partial valuation gaps, and doctrine observability.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Total Assets</div>
            <div className="mt-2 text-3xl font-semibold">{overview.coverage_stats.total_price_assets}</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Fresh</div>
            <div className="mt-2 text-3xl font-semibold text-emerald-300">{overview.coverage_stats.fresh_assets}</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Stale</div>
            <div className="mt-2 text-3xl font-semibold text-amber-300">{overview.coverage_stats.stale_assets}</div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Unknown Confidence</div>
            <div className="mt-2 text-3xl font-semibold text-fuchsia-300">{overview.coverage_stats.unknown_confidence_assets}</div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Top Stale Assets</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Asset</th>
                    <th className="py-2 text-right font-medium">Age (s)</th>
                    <th className="py-2 text-right font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.top_stale_assets.map((row) => (
                    <tr key={row.asset_key} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.asset_key}</td>
                      <td className="py-3 text-right text-amber-300">{row.price_age_seconds ?? '—'}</td>
                      <td className="py-3 text-right text-zinc-300">{row.effective_confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Unknown Price Queue</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Asset</th>
                    <th className="py-2 text-left font-medium">Status</th>
                    <th className="py-2 text-right font-medium">Sightings</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.unknown_price_assets.map((row) => (
                    <tr key={row.asset_key} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.asset_key}</td>
                      <td className="py-3 text-zinc-300">{row.status}</td>
                      <td className="py-3 text-right text-fuchsia-300">{row.sighting_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Alert Doctrine Stats</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Recent Alerts</div>
              <div className="mt-2 text-2xl font-semibold">{overview.alert_doctrine_stats.total_alerts}</div>
            </div>
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Doctrine Tagged</div>
              <div className="mt-2 text-2xl font-semibold text-cyan-300">{overview.alert_doctrine_stats.doctrine_tagged}</div>
            </div>
            <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
              <div className="text-xs uppercase tracking-wide text-zinc-500">Stale Tagged</div>
              <div className="mt-2 text-2xl font-semibold text-amber-300">{overview.alert_doctrine_stats.stale_tagged}</div>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Partial Account Valuations</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="py-2 text-left font-medium">Address</th>
                  <th className="py-2 text-right font-medium">SOL</th>
                  <th className="py-2 text-right font-medium">USDC</th>
                  <th className="py-2 text-left font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {overview.partial_account_valuations.map((row) => (
                  <tr key={`${row.address}-${row.fetched_at}`} className="border-b border-zinc-900">
                    <td className="py-3 text-zinc-200">{row.address}</td>
                    <td className="py-3 text-right text-zinc-300">{row.sol_balance}</td>
                    <td className="py-3 text-right text-zinc-300">{row.usdc_balance}</td>
                    <td className="py-3 text-zinc-400">{row.source_mode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
