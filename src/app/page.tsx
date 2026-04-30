// ============================================================
// SONAR v2.0 — Landing Page
// ============================================================

import Image from 'next/image';
import Link from 'next/link';
import { createAdminClient } from '@/lib/supabase/server';
import { FlowGauge } from '@/components/FlowGauge';
import type { FlowSnapshotRow } from '@/lib/supabase/types';

async function getBias() {
  try {
    const db = createAdminClient();
    const { data } = await db
      .from('flow_snapshots')
      .select('bias_score, market_bias, snapshot_time')
      .eq('window_hours', 24)
      .order('snapshot_time', { ascending: false })
      .limit(1)
      .maybeSingle();
    const s = data as Pick<FlowSnapshotRow, 'bias_score' | 'market_bias' | 'snapshot_time'> | null;
    return { score: s?.bias_score ?? null, label: s?.market_bias ?? null, time: s?.snapshot_time ?? null };
  } catch {
    return { score: null, label: null, time: null };
  }
}

export default async function Home() {
  const bias = await getBias();

  return (
    <main className="flex flex-col min-h-screen" style={{ background: '#0A0A0F', color: '#F0F0F8' }}>

      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-4 bg-black/30 backdrop-blur-xl border-b border-white/5 transition-all duration-300">
        <Image src="/sonar-logo.svg" alt="SONAR" width={100} height={28} priority />
        <div className="flex items-center gap-8">
            <Link href="/dashboard" className="text-sm font-medium text-gray-400 hover:text-white transition-colors duration-200">Dashboard</Link>
            <Link href="/dashboard/whales" className="text-sm font-medium text-gray-400 hover:text-white transition-colors duration-200">Whales</Link>
            <Link href="/docs" className="text-sm font-medium text-gray-400 hover:text-white transition-colors duration-200">Docs</Link>
            <a href="https://t.me/+XE4ANzPt9YFlOGE8" target="_blank" rel="noopener noreferrer" className="relative px-5 py-2.5 rounded-lg text-sm font-semibold text-black bg-[#00D4FF] hover:shadow-[0_0_30px_rgba(0,212,255,0.4)] transition-all duration-300">
                Launch App
            </a>
        </div>
    </nav>

      {/* Hero */}
      <section className="relative flex flex-col items-center justify-center min-h-screen px-6 text-center pt-20">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-black to-black opacity-70"></div>

      <div className="max-w-4xl mx-auto space-y-8">
        <h1 className="text-6xl lg:text-8xl font-bold tracking-tighter leading-tight bg-clip-text text-transparent bg-gradient-to-b from-white to-gray-500">
          Where Smart Money <br/> Moves First
        </h1>
        <p className="text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed">
          Real-time exchange flows, staking shifts and whale movements — aggregated into a single, <span className="text-[#00D4FF] font-semibold">living market bias signal</span> for Solana.
        </p>
        
        <div className="flex flex-col items-center gap-8 pt-8">
          <div className="p-8 rounded-3xl border border-white/10 bg-white/[0.02] backdrop-blur-xl shadow-2xl shadow-black/50">
            <p className="text-xs uppercase tracking-[0.2em] mb-4 text-gray-500">24h Bias Index · Live</p>
            <FlowGauge score={bias.score} label={bias.label} size={260} />
            {bias.time && (
                <p className="text-xs mt-4 text-gray-600 font-mono">
                  Updated {new Date(bias.time).toLocaleTimeString()}
                </p>
            )}
          </div>

          <div className="flex items-center gap-6">
            <Link href="/dashboard" className="px-8 py-4 rounded-xl font-semibold text-sm bg-white text-black hover:bg-gray-200 transition-all duration-300 shadow-lg">
              Open Dashboard →
            </Link>
            <a href="https://t.me/+XE4ANzPt9YFlOGE8" target="_blank" rel="noopener noreferrer" className="px-8 py-4 rounded-xl font-semibold text-sm border border-[#00D4FF]/30 text-[#00D4FF] hover:bg-[#00D4FF]/10 hover:border-[#00D4FF] transition-all duration-300">
              Get Alerts on Telegram
            </a>
          </div>
        </div>
      </div>
    </section>

      {/* Feature cards */}
      <section className="px-8 py-24 max-w-7xl mx-auto w-full">
        <div className="mb-12 text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white">Intelligence Layer</h2>
            <p className="text-gray-500 mt-2">Real-time signals, processed and exposed with radical transparency.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            
            <div className="group relative p-6 rounded-2xl border border-[#2A2A3A] bg-[#0A0A0F] hover:border-[#00D4FF]/30 transition-all duration-500 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[#00D4FF]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-4">
                        <span className="text-2xl">⇄</span>
                        <span className="text-xs uppercase tracking-widest text-gray-400">Exchange Flows</span>
                    </div>
                    <div className="flex items-baseline gap-2 mt-6 mb-2">
                        <span className="text-3xl font-bold text-white">$18.7M</span>
                        <span className="text-xs text-[#FF4D6A] font-semibold">Net Inflow ▼</span>
                    </div>
                    <p className="text-sm text-gray-500">Track net SOL deposits vs. withdrawals across major CEXs in real time.</p>
                </div>
            </div>

            <div className="group relative p-6 rounded-2xl border border-[#2A2A3A] bg-[#0A0A0F] hover:border-[#00E5A0]/30 transition-all duration-500">
                <div className="absolute inset-0 bg-gradient-to-br from-[#00E5A0]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-4">
                        <span className="text-2xl">◎</span>
                        <span className="text-xs uppercase tracking-widest text-gray-400">Staking Signals</span>
                    </div>
                    <div className="flex items-baseline gap-2 mt-6 mb-2">
                        <span className="text-3xl font-bold text-white">+$0.8M</span>
                        <span className="text-xs text-[#00E5A0] font-semibold">Net Staked ▲</span>
                    </div>
                    <p className="text-sm text-gray-500">Monitor Marinade and Jito flows. A sudden rise in unstaking signals de-risking.</p>
                </div>
            </div>

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

      {/* Footer */}
      <footer
        className="border-t px-8 py-6 flex items-center justify-between text-xs"
        style={{ borderColor: '#2A2A3A', color: '#8888AA' }}
      >
        <span style={{ fontFamily: 'var(--font-mono)' }}>SONAR v2.0</span>
        <span>Built by <span style={{ color: '#F0F0F8' }}>NEXUS Finance</span></span>
      </footer>
    </main>
  );
}


