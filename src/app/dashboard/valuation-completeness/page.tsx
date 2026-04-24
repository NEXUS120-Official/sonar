import { createAdminClient } from '@/lib/supabase/server';

export default async function ValuationCompletenessPage() {
  const db = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: whales } = await (db as any)
    .from('sovereign_whale_candidates')
    .select('address, estimated_balance_usd, priced_component_count, unpriced_component_count, valuation_completeness_ratio, valuation_status')
    .order('first_seen_at', { ascending: false })
    .limit(100);

  const rows = (whales ?? []) as Array<{
    address: string;
    estimated_balance_usd: number | null;
    priced_component_count: number;
    unpriced_component_count: number;
    valuation_completeness_ratio: number;
    valuation_status: string;
  }>;

  return (
    <main className="min-h-screen bg-black text-white p-6 md:p-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Valuation Completeness</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Priced vs unpriced components across whale candidates and sovereign valuation propagation.
          </p>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-5">
          <h2 className="text-lg font-semibold">Whale Candidate Valuation Status</h2>
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
                {rows.map((row) => (
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
        </section>
      </div>
    </main>
  );
}
