'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Props {
  href: string;
  icon: string;
  label: string;
}

export function NavLink({ href, icon, label }: Props) {
  const pathname = usePathname();
  const active   = pathname === href;

  return (
    <Link
      href={href}
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-[#1e1e2e]"
      style={{
        color:      active ? '#e8e8ef' : '#6b6b80',
        background: active ? '#1e1e2e' : 'transparent',
        fontFamily: 'var(--font-body)',
      }}
    >
      <span className="text-base w-5 text-center">{icon}</span>
      {label}
    </Link>
  );
}
