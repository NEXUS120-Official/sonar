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
      className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors hover:bg-[#1A1A24]"
      style={{
        color:      active ? '#F0F0F8' : '#8888AA',
        background: active ? '#1A1A24' : 'transparent',
        fontFamily: 'var(--font-body)',
      }}
    >
      <span className="text-base w-5 text-center">{icon}</span>
      {label}
    </Link>
  );
}
