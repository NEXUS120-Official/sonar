// ============================================================
// Dashboard Layout — sidebar navigation (desktop) + mobile drawer
// ============================================================

import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { MobileNav } from '@/components/MobileNav';
import { NavLink } from '@/components/NavLink';

const NAV = [
  { href: '/dashboard',                    label: 'Overview',        icon: '◈' },
  { href: '/dashboard/exchange-flow',      label: 'Exchange Flow',   icon: '⇄' },
  { href: '/dashboard/staking-flow',       label: 'Staking',         icon: '◎' },
  { href: '/dashboard/whales',             label: 'Whales',          icon: '🐋' },
  { href: '/dashboard/intel',              label: 'Intel',           icon: '◉' },
  { href: '/dashboard/dex-intelligence',   label: 'DEX Intel',       icon: '⬡' },
  { href: '/dashboard/pumpfun-radar',      label: 'Pump.fun Radar',  icon: '◎' },
  { href: '/dashboard/whale-copy-signals', label: 'Copy Signals',    icon: '⟳' },
  { href: '/dashboard/lp-monitor',         label: 'LP Monitor',      icon: '⬟' },
  { href: '/dashboard/price-prediction',   label: 'Price Intel',     icon: '◬' },
  { href: '/dashboard/alerts',             label: 'Alerts',          icon: '⚡' },
  { href: '/dashboard/settings',           label: 'Settings',        icon: '⚙' },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col lg:flex-row min-h-screen"
      style={{ background: '#0A0A0F', color: '#F0F0F8' }}
    >
      {/* ── Mobile top bar + slide-in drawer ───────────────── */}
      <MobileNav />

      {/* ── Desktop sidebar (hidden on mobile) ─────────────── */}
      <aside
        className="hidden lg:flex w-60 shrink-0 flex-col border-r"
        style={{ background: '#0d0d14', borderColor: '#2A2A3A' }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b" style={{ borderColor: '#2A2A3A' }}>
          <Link href="/" className="hover:opacity-80 transition-opacity inline-block">
            <Image src="/sonar-logo.svg" alt="SONAR" width={100} height={28} style={{ height: 28, width: 'auto' }} />
          </Link>
          <p className="text-xs mt-1.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Flow Intelligence
          </p>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-1 p-3 flex-1">
          {NAV.map(n => (
            <NavLink key={n.href} href={n.href} icon={n.icon} label={n.label} />
          ))}
        </nav>

        {/* Footer link */}
        <div className="p-4 border-t" style={{ borderColor: '#2A2A3A' }}>
          <a
            href="https://t.me/+XE4ANzPt9YFlOGE8"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg font-semibold transition-opacity hover:opacity-80"
            style={{ background: '#7B61FF18', color: '#7B61FF', border: '1px solid #7B61FF30' }}
          >
            <span>✈</span> Telegram
          </a>
        </div>
      </aside>

      {/* ── Main content ────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
