// ============================================================
// Dashboard Layout — sidebar navigation (desktop) + mobile drawer
// ============================================================

import Link from 'next/link';
import type { ReactNode } from 'react';
import { MobileNav } from '@/components/MobileNav';

const NAV = [
  { href: '/dashboard',               label: 'Overview',       icon: '◈' },
  { href: '/dashboard/exchange-flow', label: 'Exchange Flow',  icon: '⇄' },
  { href: '/dashboard/staking-flow',  label: 'Staking',        icon: '◎' },
  { href: '/dashboard/whales',        label: 'Whales',         icon: '🐋' },
  { href: '/dashboard/intel',         label: 'Intel',          icon: '◉' },
  { href: '/dashboard/alerts',        label: 'Alerts',         icon: '⚡' },
  { href: '/dashboard/settings',      label: 'Settings',       icon: '⚙' },
];

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex flex-col lg:flex-row min-h-screen"
      style={{ background: '#0a0a0f', color: '#e8e8ef' }}
    >
      {/* ── Mobile top bar + slide-in drawer ───────────────── */}
      <MobileNav />

      {/* ── Desktop sidebar (hidden on mobile) ─────────────── */}
      <aside
        className="hidden lg:flex w-56 shrink-0 flex-col border-r"
        style={{ background: '#0d0d14', borderColor: '#1e1e2e' }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b" style={{ borderColor: '#1e1e2e' }}>
          <Link
            href="/"
            className="text-base font-bold tracking-tight hover:opacity-80 transition-opacity"
            style={{ fontFamily: 'var(--font-heading)', color: '#00e599' }}
          >
            SONAR
          </Link>
          <p className="text-xs mt-0.5" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Flow Intelligence
          </p>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-1 p-3 flex-1">
          {NAV.map(n => (
            <Link
              key={n.href}
              href={n.href}
              className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-[#1e1e2e]"
              style={{ color: '#6b6b80', fontFamily: 'var(--font-body)' }}
            >
              <span className="text-base w-5 text-center">{n.icon}</span>
              {n.label}
            </Link>
          ))}
        </nav>

        {/* Footer link */}
        <div className="p-4 border-t" style={{ borderColor: '#1e1e2e' }}>
          <a
            href="https://t.me/sonar_nexus"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg font-semibold transition-opacity hover:opacity-80"
            style={{ background: '#00e59918', color: '#00e599', border: '1px solid #00e59930' }}
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
