import { createAdminClient } from '@/lib/supabase/server';
import { getExchangeLineagePreview } from '@/lib/sovereign/sovereign-exchange-lineage-analytics';

export default async function ExchangeLineagePage() {
  const db = createAdminClient();
  const rows = await getExchangeLineagePreview(db, 50);

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Exchange Lineage</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Confidence-scored exchange-origin / CEX-to-shadow lineage intelligence.
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-sm text-zinc-400">
            No exchange-lineage candidates available yet.
          </div>
        ) : (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Address</th>
                    <th className="py-2 text-left font-medium">Exchange</th>
                    <th className="py-2 text-right font-medium">Lineage</th>
                    <th className="py-2 text-left font-medium">Band</th>
                    <th className="py-2 text-right font-medium">Candidate Conf.</th>
                    <th className="py-2 text-right font-medium">Evidence</th>
                    <th className="py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.address} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.address}</td>
                      <td className="py-3 text-zinc-300">{row.source_exchange ?? 'unknown'}</td>
                      <td className="py-3 text-right text-cyan-300">{row.lineage_confidence}</td>
                      <td className="py-3 text-zinc-300">{row.lineage_band}</td>
                      <td className="py-3 text-right text-zinc-300">{row.confidence_score}</td>
                      <td className="py-3 text-right text-emerald-300">{row.evidence_count}</td>
                      <td className="py-3 text-zinc-400">{row.lineage_reason}</td>
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
