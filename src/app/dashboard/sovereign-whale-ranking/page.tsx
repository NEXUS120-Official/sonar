import { createAdminClient } from '@/lib/supabase/server';
import { getRankedSovereignWhaleCandidates } from '@/lib/sovereign/sovereign-whale-ranking-analytics';

export default async function SovereignWhaleRankingPage() {
  const db = createAdminClient();
  const rows = await getRankedSovereignWhaleCandidates(db, 50);

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Sovereign Whale Ranking</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Confidence-aware, completeness-aware ranked whale candidate intelligence.
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-sm text-zinc-400">
            No ranked sovereign whale candidates available yet.
          </div>
        ) : (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Address</th>
                    <th className="py-2 text-right font-medium">Rank</th>
                    <th className="py-2 text-left font-medium">Band</th>
                    <th className="py-2 text-right font-medium">Confidence</th>
                    <th className="py-2 text-right font-medium">Completeness</th>
                    <th className="py-2 text-right font-medium">Evidence</th>
                    <th className="py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.address} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.address}</td>
                      <td className="py-3 text-right text-cyan-300">{row.ranking_score}</td>
                      <td className="py-3 text-zinc-300">{row.ranking_band}</td>
                      <td className="py-3 text-right text-zinc-300">{row.confidence_score}</td>
                      <td className="py-3 text-right text-amber-300">{row.valuation_completeness_ratio}</td>
                      <td className="py-3 text-right text-emerald-300">{row.evidence_count}</td>
                      <td className="py-3 text-zinc-400">{row.ranking_reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
