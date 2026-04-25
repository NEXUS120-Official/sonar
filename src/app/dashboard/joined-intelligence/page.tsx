import { createAdminClient } from '@/lib/supabase/server';
import { getRecentJoinedIntelligence } from '@/lib/sovereign/joined-intelligence-analytics';

export default async function JoinedIntelligencePage() {
  const db = createAdminClient();
  const rows = await getRecentJoinedIntelligence(db, 50);

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Joined Intelligence</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Persisted canonical joined intelligence records for replay and analytics.
          </p>
        </div>

        {rows.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5 text-sm text-zinc-400">
            No joined intelligence records persisted yet.
          </div>
        ) : (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="py-2 text-left font-medium">Signature</th>
                    <th className="py-2 text-left font-medium">Asset</th>
                    <th className="py-2 text-left font-medium">Flow</th>
                    <th className="py-2 text-left font-medium">Valuation</th>
                    <th className="py-2 text-left font-medium">Lineage</th>
                    <th className="py-2 text-right font-medium">Attribution</th>
                    <th className="py-2 text-left font-medium">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.record_id} className="border-b border-zinc-900">
                      <td className="py-3 text-zinc-200">{row.tx_signature}</td>
                      <td className="py-3 text-zinc-300">{row.token_symbol ?? row.asset_key ?? 'unknown'}</td>
                      <td className="py-3 text-zinc-300">{row.flow_type ?? 'unknown'}</td>
                      <td className="py-3 text-zinc-300">{row.valuation_status} / {row.valuation_confidence}</td>
                      <td className="py-3 text-zinc-300">{row.exchange_lineage_band}</td>
                      <td className="py-3 text-right text-cyan-300">{row.attribution_confidence}</td>
                      <td className="py-3 text-zinc-400">{row.linkage_reason}</td>
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
