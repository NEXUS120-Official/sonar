// ============================================================
// ProGate — server component
// Shows children to authenticated (Pro/admin) users.
// Shows a blurred teaser + upgrade CTA to anonymous visitors.
// ============================================================

import { createClient } from '@/lib/supabase/server';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Short label shown on the blur overlay, e.g. "What Would Whales Do?" */
  featureName?: string;
  /** Telegram upgrade link */
  ctaHref?: string;
  ctaLabel?: string;
}

export async function ProGate({
  children,
  featureName = 'Pro Feature',
  ctaHref = 'https://t.me/sonar_nexus',
  ctaLabel = 'Join Pro on Telegram',
}: Props) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const isPro = !!user;

  if (isPro) return <>{children}</>;

  return (
    <div style={{ position: 'relative' }}>
      {/* Blurred preview */}
      <div style={{ filter: 'blur(6px)', pointerEvents: 'none', userSelect: 'none', opacity: 0.5 }}>
        {children}
      </div>

      {/* Overlay */}
      <div
        style={{
          position:       'absolute',
          inset:          0,
          display:        'flex',
          flexDirection:  'column',
          alignItems:     'center',
          justifyContent: 'center',
          gap:            12,
          background:     'rgba(10,10,15,0.72)',
          borderRadius:   12,
          backdropFilter: 'blur(2px)',
        }}
      >
        {/* Pro badge */}
        <span style={{
          fontSize:      10,
          fontWeight:    800,
          letterSpacing: '0.12em',
          padding:       '3px 10px',
          borderRadius:  4,
          background:    '#ffd60a20',
          color:         '#ffd60a',
          border:        '1px solid #ffd60a40',
          fontFamily:    'var(--font-mono)',
          textTransform: 'uppercase',
        }}>
          PRO
        </span>

        <p style={{ color: '#e8e8ef', fontWeight: 700, fontSize: 15, textAlign: 'center', margin: 0 }}>
          {featureName}
        </p>
        <p style={{ color: '#6b6b80', fontSize: 12, textAlign: 'center', margin: 0, maxWidth: 220 }}>
          Available to Pro subscribers. Upgrade to unlock real-time whale signals.
        </p>

        <a
          href={ctaHref}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display:       'flex',
            alignItems:    'center',
            gap:           6,
            marginTop:     4,
            padding:       '8px 18px',
            borderRadius:  8,
            background:    '#00e59918',
            border:        '1px solid #00e59940',
            color:         '#00e599',
            fontSize:      13,
            fontWeight:    700,
            textDecoration:'none',
            transition:    'opacity 0.15s',
          }}
        >
          <span>✈</span> {ctaLabel}
        </a>
      </div>
    </div>
  );
}
