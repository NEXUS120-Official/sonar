'use client';

// ============================================================
// MobileNav — hamburger + slide-in drawer for small screens
// Visible only below lg breakpoint.
// ============================================================

import { useState, useEffect } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

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

export function MobileNav() {
  const [open, setOpen]   = useState(false);
  const pathname          = usePathname();

  // Close drawer on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  // Prevent body scroll while drawer is open
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <>
      {/* ── Top bar (mobile only) ───────────────────────────── */}
      <div
        className="lg:hidden flex items-center justify-between px-4 py-3 border-b shrink-0"
        style={{ background: '#0d0d14', borderColor: '#2A2A3A' }}
      >
        <Link href="/" className="hover:opacity-80 transition-opacity">
          <Image src="/sonar-logo.svg" alt="SONAR" width={90} height={24} style={{ height: 24, width: 'auto' }} />
        </Link>

        {/* Hamburger */}
        <button
          onClick={() => setOpen(o => !o)}
          aria-label="Toggle menu"
          style={{
            display:     'flex',
            flexDirection: 'column',
            gap:         5,
            padding:     8,
            background:  'transparent',
            border:      'none',
            cursor:      'pointer',
          }}
        >
          {[0, 1, 2].map(i => (
            <span
              key={i}
              style={{
                display:         'block',
                width:           22,
                height:          2,
                background:      '#F0F0F8',
                borderRadius:    1,
                transition:      'transform 0.2s, opacity 0.2s',
                transformOrigin: 'center',
                transform:
                  open && i === 0 ? 'translateY(7px) rotate(45deg)'  :
                  open && i === 1 ? 'scaleX(0)'                       :
                  open && i === 2 ? 'translateY(-7px) rotate(-45deg)' :
                  'none',
                opacity: open && i === 1 ? 0 : 1,
              }}
            />
          ))}
        </button>
      </div>

      {/* ── Backdrop ────────────────────────────────────────── */}
      {open && (
        <div
          className="lg:hidden fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Slide-in drawer ─────────────────────────────────── */}
      <div
        className="lg:hidden fixed top-0 left-0 h-full z-50 flex flex-col border-r"
        style={{
          width:      260,
          background: '#0d0d14',
          borderColor:'#2A2A3A',
          transform:  open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Logo */}
        <div className="px-5 py-5 border-b" style={{ borderColor: '#2A2A3A' }}>
          <Link
            href="/"
            className="hover:opacity-80 transition-opacity inline-block"
            onClick={() => setOpen(false)}
          >
            <Image src="/sonar-logo.svg" alt="SONAR" width={100} height={28} style={{ height: 28, width: 'auto' }} />
          </Link>
          <p className="text-xs mt-1.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Flow Intelligence
          </p>
        </div>

        {/* Nav */}
        <nav className="flex flex-col gap-1 p-3 flex-1 overflow-y-auto">
          {NAV.map(n => {
            const active = pathname === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors"
                style={{
                  color:      active ? '#F0F0F8' : '#8888AA',
                  background: active ? '#1A1A24' : 'transparent',
                  fontFamily: 'var(--font-body)',
                }}
              >
                <span className="text-base w-5 text-center">{n.icon}</span>
                {n.label}
              </Link>
            );
          })}
        </nav>

        {/* Telegram CTA */}
        <div className="p-4 border-t" style={{ borderColor: '#2A2A3A' }}>
          <a
            href="https://t.me/+XE4ANzPt9YFlOGE8"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg font-semibold"
            style={{ background: '#7B61FF18', color: '#7B61FF', border: '1px solid #7B61FF30' }}
          >
            <span>✈</span> Telegram
          </a>
        </div>
      </div>
    </>
  );
}
