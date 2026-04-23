import { createAdminClient } from '@/lib/supabase/server';
import { buildPrivacyLifecycleOverview } from '@/lib/sovereign/privacy-lifecycle-overview';

function fmtUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(2)}`;
}

export const dynamic = 'force-dynamic';

export default async function PrivacyLifecyclePage() {
  const db = createAdminClient();
  const overview = await buildPrivacyLifecycleOverview(db, 24 * 7, 25);

  return (
    <main className="min-h-screen bg-black text-zinc-100 p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Privacy Lifecycle Intelligence</h1>
              <p className="text-sm text-zinc-400">
                7d overview of lifecycle events, sequences, exchange-origin context, and family re-emergence.
              </p>
            </div>
            <div className="text-xs text-zinc-500">
              Generated at: {new Date(overview.generated_at).toLocaleString()}
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Total Events</div>
            <div className="mt-2 text-3xl font-semibold">
              {overview.event_stage_stats.total_events.toLocaleString()}
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">Public-Side Events</div>
            <div className="mt-2 text-3xl font-semibold">
              {overview.event_stage_stats.public_side_count.toLocaleString()}
            </div>
          </div>
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="text-xs uppercase tracking-wide text-zinc-500">High-Confidence Sequences</div>
            <div className="mt-2 text-3xl font-semibold">
              {overview.sequence_stats.high_confidence_count.toLocaleString()}
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Event Stage Distribution</h2>
            <div className="mt-4 space-y-3">
              {overview.event_stage_stats.by_stage.map((row) => (
                <div key={row.stage} className="flex items-center justify-between rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                  <div className="text-sm text-zinc-200">{row.stage}</div>
                  <div className="text-sm font-medium text-cyan-300">{row.count.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Sequence Pair Distribution</h2>
            <div className="mt-4 space-y-3">
              {overview.sequence_stats.by_stage_pair.length === 0 ? (
                <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-400">
                  No lifecycle sequences detected in this window.
                </div>
              ) : (
                overview.sequence_stats.by_stage_pair.map((row) => (
                  <div key={row.pair} className="flex items-center justify-between rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                    <div className="text-sm text-zinc-200">{row.pair}</div>
                    <div className="text-sm font-medium text-emerald-300">{row.count.toLocaleString()}</div>
                  </div>
                ))
              )}
            </div>
            <div className="mt-4 text-xs text-zinc-500">
              Avg elapsed seconds: {overview.sequence_stats.avg_elapsed_seconds.toLocaleString()}
            </div>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Token Leaderboard</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Token</th>
                    <th className="py-2 text-right font-medium">Events</th>
                    <th className="py-2 text-right font-medium">Total USD</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.event_token_leaderboard.map((row, i) => (
                    <tr key={`${row.token_mint ?? 'unknown'}-${i}`} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">
                        {row.token_symbol ?? (row.token_mint ? row.token_mint.slice(0, 8) + '…' : 'unknown')}
                      </td>
                      <td className="py-3 text-right text-cyan-300">{row.event_count.toLocaleString()}</td>
                      <td className="py-3 text-right text-zinc-300">{fmtUsd(row.total_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Exchange-Origin Stats</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Exchange</th>
                    <th className="py-2 text-right font-medium">Events</th>
                    <th className="py-2 text-right font-medium">Public-Side</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.event_exchange_stats.map((row) => (
                    <tr key={row.source_exchange} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.source_exchange}</td>
                      <td className="py-3 text-right text-emerald-300">{row.event_count.toLocaleString()}</td>
                      <td className="py-3 text-right text-zinc-300">{row.public_side_count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Family Leaderboard</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="py-2 text-left font-medium">Family</th>
                  <th className="py-2 text-right font-medium">Events</th>
                  <th className="py-2 text-right font-medium">Total USD</th>
                </tr>
              </thead>
              <tbody>
                {overview.event_family_leaderboard.map((row) => (
                  <tr key={row.shadow_family_id} className="border-b border-zinc-900">
                    <td className="py-3 text-zinc-200">{row.shadow_family_id}</td>
                    <td className="py-3 text-right text-fuchsia-300">{row.event_count.toLocaleString()}</td>
                    <td className="py-3 text-right text-zinc-300">{fmtUsd(row.total_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>


        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Sequence Alert Candidates</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Total Candidates</div>
                <div className="mt-2 text-2xl font-semibold">{overview.candidate_stats.total_candidates.toLocaleString()}</div>
              </div>
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">High Confidence</div>
                <div className="mt-2 text-2xl font-semibold text-cyan-300">{overview.candidate_stats.high_confidence_count.toLocaleString()}</div>
              </div>
              <div className="rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                <div className="text-xs uppercase tracking-wide text-zinc-500">Top Type</div>
                <div className="mt-2 text-base font-semibold text-emerald-300">
                  {overview.candidate_stats.by_type[0]?.candidate_type ?? 'none'}
                </div>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {overview.candidate_stats.by_type.map((row) => (
                <div key={row.candidate_type} className="flex items-center justify-between rounded-xl border border-zinc-900 bg-zinc-900/50 px-4 py-3">
                  <div className="text-sm text-zinc-200">{row.candidate_type}</div>
                  <div className="text-sm font-medium text-cyan-300">{row.count.toLocaleString()}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <h2 className="text-lg font-semibold">Candidate Leaderboard</h2>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Type</th>
                    <th className="py-2 text-left font-medium">Token</th>
                    <th className="py-2 text-right font-medium">Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.candidate_leaderboard.map((row) => (
                    <tr key={row.candidate_id} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.candidate_type}</td>
                      <td className="py-3 text-zinc-300">
                        {row.token_symbol ?? (row.token_mint ? row.token_mint.slice(0, 8) + '…' : 'unknown')}
                      </td>
                      <td className="py-3 text-right text-emerald-300">{row.candidate_confidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Candidate Family Stats</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500">
                <tr className="border-b border-zinc-800">
                  <th className="py-2 text-left font-medium">Family</th>
                  <th className="py-2 text-right font-medium">Candidates</th>
                  <th className="py-2 text-right font-medium">Max Confidence</th>
                </tr>
              </thead>
              <tbody>
                {overview.candidate_family_stats.map((row) => (
                  <tr key={row.shadow_family_id} className="border-b border-zinc-900">
                    <td className="py-3 text-zinc-200">{row.shadow_family_id}</td>
                    <td className="py-3 text-right text-fuchsia-300">{row.candidate_count.toLocaleString()}</td>
                    <td className="py-3 text-right text-zinc-300">{row.max_confidence}</td>
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
