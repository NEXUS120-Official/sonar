import { createAdminClient } from '@/lib/supabase/server';

function fmtUsd(v: number | null) {
  if (v == null) return '$0.0M';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return '$' + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return '$' + (abs / 1_000).toFixed(0) + 'K';
  return '$' + abs.toFixed(0);
}

async function getFlowData() {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from('flow_snapshots')
      .select('*')
      .eq('window_hours', 24)
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data as any;
  } catch {
    return null;
  }
}

export async function HeroCards() {
  const snap = await getFlowData();
  const netExchange = snap?.sol_net_exchange_flow_usd ?? null;
  const netStaking = snap?.net_staking_flow_usd ?? null;

  return (
    <section className="px-8 py-24 max-w-7xl mx-auto w-full">
      <div className="mb-12 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white">Intelligence Layer</h2>
        <p className="text-gray-500 mt-2">Real-time signals, processed and exposed with radical transparency.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Exchange Flow Card */}
        <div className="group relative p-6 rounded-2xl border border-[#2A2A3A] bg-[#0A0A0F] hover:border-[#00D4FF]/30 transition-all duration-500 overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-br from-[#00D4FF]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">⇄</span>
              <span className="text-xs uppercase tracking-widest text-gray-400">Exchange Flows</span>
            </div>
            <div className="flex items-baseline gap-2 mt-6 mb-2">
              <span className="text-3xl font-bold text-white">{netExchange != null ? fmtUsd(netExchange) : '$0.0M'}</span>
              <span className={netExchange != null && netExchange > 0 ? "text-xs text-[#FF4D6A] font-semibold" : netExchange != null && netExchange < 0 ? "text-xs text-[#00E5A0] font-semibold" : "text-xs text-gray-500 font-semibold"}>
                {netExchange != null && netExchange > 0 ? 'Net Inflow ▼' : netExchange != null && netExchange < 0 ? 'Net Outflow ▲' : 'Balanced'}
              </span>
            </div>
            <p className="text-sm text-gray-500">Track net SOL deposits vs. withdrawals across major CEXs in real time.</p>
          </div>
        </div>

        {/* Staking Card */}
        <div className="group relative p-6 rounded-2xl border border-[#2A2A3A] bg-[#0A0A0F] hover:border-[#00E5A0]/30 transition-all duration-500">
          <div className="absolute inset-0 bg-gradient-to-br from-[#00E5A0]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">◎</span>
              <span className="text-xs uppercase tracking-widest text-gray-400">Staking Signals</span>
            </div>
            <div className="flex items-baseline gap-2 mt-6 mb-2">
              <span className="text-3xl font-bold text-white">{netStaking != null ? (netStaking > 0 ? '+' : '') + fmtUsd(netStaking) : '+$0.0M'}</span>
              <span className={netStaking != null && netStaking > 0 ? "text-xs text-[#00E5A0] font-semibold" : netStaking != null && netStaking < 0 ? "text-xs text-[#FF4D6A] font-semibold" : "text-xs text-gray-500 font-semibold"}>
                {netStaking != null && netStaking > 0 ? 'Net Staked ▲' : netStaking != null && netStaking < 0 ? 'Net Unstaked ▼' : 'Balanced'}
              </span>
            </div>
            <p className="text-sm text-gray-500">Monitor Marinade and Jito flows. A sudden rise in unstaking signals de-risking.</p>
          </div>
        </div>

        {/* DeFi Rotation Card */}
        <div className="group relative p-6 rounded-2xl border border-[#2A2A3A] bg-[#0A0A0F] hover:border-[#7B61FF]/30 transition-all duration-500">
          <div className="absolute inset-0 bg-gradient-to-br from-[#7B61FF]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <span className="text-2xl">⬡</span>
              <span className="text-xs uppercase tracking-widest text-gray-400">DeFi Rotation</span>
            </div>
            <div className="flex items-baseline gap-2 mt-6 mb-2">
              <span className="text-3xl font-bold text-white">Drift ↗</span>
              <span className="text-xs text-[#7B61FF] font-semibold">Capital Shift</span>
            </div>
            <p className="text-sm text-gray-500">See where smart money is moving across Raydium, Orca, Marginfi, and Drift.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
