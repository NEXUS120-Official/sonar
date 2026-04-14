// ============================================================
// SONAR v2.0 — Landing Page
// ============================================================

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
    <main className="flex flex-col min-h-screen" style={{ background: '#0a0a0f', color: '#e8e8ef' }}>

      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b" style={{ borderColor: '#1e1e2e' }}>
        <span className="text-lg font-bold tracking-tight" style={{ fontFamily: 'var(--font-heading)', color: '#00e599' }}>
          SONAR
        </span>
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="text-sm hover:opacity-80 transition-opacity" style={{ color: '#6b6b80' }}>
            Dashboard
          </Link>
          <a
            href="https://t.me/sonar_nexus"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold px-4 py-2 rounded-lg transition-opacity hover:opacity-80"
            style={{ background: '#00e599', color: '#0a0a0f' }}
          >
            Join Telegram
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center justify-center flex-1 px-6 py-24 text-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <span
            className="text-xs uppercase tracking-widest px-3 py-1 rounded-full border"
            style={{ color: '#00e599', borderColor: '#00e59930', background: '#00e59910', fontFamily: 'var(--font-mono)' }}
          >
            Smart Money Flow Intelligence · Solana
          </span>
          <h1
            className="text-5xl font-bold tracking-tight max-w-2xl leading-tight"
            style={{ fontFamily: 'var(--font-heading)' }}
          >
            Where Smart Money<br />Moves First
          </h1>
          <p className="text-lg max-w-xl" style={{ color: '#6b6b80' }}>
            Real-time exchange flows, staking shifts, and whale movements — aggregated into a single market bias signal.
          </p>
        </div>

        {/* Live gauge */}
        <div
          className="flex flex-col items-center gap-2 p-8 rounded-2xl border"
          style={{ background: '#12121a', borderColor: '#1e1e2e', minWidth: 280 }}
        >
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            24h Bias Index · Live
          </p>
          <FlowGauge score={bias.score} label={bias.label} size={220} />
          {bias.time && (
            <p className="text-xs mt-1" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
              Updated {new Date(bias.time).toLocaleTimeString()}
            </p>
          )}
        </div>

        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="px-6 py-3 rounded-lg font-semibold text-sm transition-opacity hover:opacity-80"
            style={{ background: '#1e1e2e', color: '#e8e8ef' }}
          >
            Open Dashboard →
          </Link>
          <a
            href="https://t.me/sonar_nexus"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 rounded-lg font-semibold text-sm transition-opacity hover:opacity-80"
            style={{ background: '#00e599', color: '#0a0a0f' }}
          >
            Get Alerts on Telegram
          </a>
        </div>
      </section>

      {/* Feature cards */}
      <section className="px-8 py-16 max-w-5xl mx-auto w-full">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <FeatureCard
            icon="⇄"
            title="Exchange Flows"
            desc="Track net SOL deposits vs. withdrawals across Binance, Coinbase, OKX, Kraken, and Bybit in real time."
            color="#00e599"
          />
          <FeatureCard
            icon="◎"
            title="Staking Signals"
            desc="Monitor liquid staking flows through Marinade and Jito — rising stake = conviction. Unstaking = risk-off."
            color="#00b8ff"
          />
          <FeatureCard
            icon="⬡"
            title="DeFi Rotation"
            desc="See when smart money enters or exits Raydium, Orca, Marginfi, and Drift — before the market reacts."
            color="#ffd60a"
          />
        </div>
      </section>

      {/* Footer */}
      <footer
        className="border-t px-8 py-6 flex items-center justify-between text-xs"
        style={{ borderColor: '#1e1e2e', color: '#4b4b60' }}
      >
        <span style={{ fontFamily: 'var(--font-mono)' }}>SONAR v2.0</span>
        <span>Built by <span style={{ color: '#6b6b80' }}>NEXUS Finance</span></span>
      </footer>
    </main>
  );
}

function FeatureCard({ icon, title, desc, color }: { icon: string; title: string; desc: string; color: string }) {
  return (
    <div
      className="rounded-xl border p-6 flex flex-col gap-3"
      style={{ background: '#12121a', borderColor: '#1e1e2e' }}
    >
      <span className="text-2xl" style={{ color }}>{icon}</span>
      <h3 className="font-semibold text-base" style={{ fontFamily: 'var(--font-heading)' }}>{title}</h3>
      <p className="text-sm leading-relaxed" style={{ color: '#6b6b80' }}>{desc}</p>
    </div>
  );
}
