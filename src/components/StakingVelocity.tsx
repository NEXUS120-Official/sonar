'use client';
// ============================================================
// StakingVelocity — current week staking net + velocity indicator
// ============================================================

interface ProtocolItem {
  protocol:    string;
  staked_usd:  number;
  unstaked_usd: number;
  net_usd:     number;
}

interface StakingVelocityProps {
  totalStaked:   number;
  totalUnstaked: number;
  netUsd:        number;
  velocityPct:   number | null;
  velocityInterp: string | null;
  byProtocol:    ProtocolItem[];
  windowHours?:  number;
}

function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000)     return `$${Math.round(abs / 1_000)}K`;
  return `$${Math.round(abs)}`;
}

function accelEmoji(interp: string | null): string {
  if (!interp) return '●';
  if (interp === 'surge')                  return '🚀';
  if (interp === 'strongly accelerating')  return '⬆️⬆️';
  if (interp === 'accelerating')           return '⬆️';
  if (interp === 'stable')                 return '→';
  if (interp === 'decelerating')           return '⬇️';
  if (interp === 'strongly decelerating')  return '⬇️⬇️';
  if (interp === 'collapse')               return '🔻';
  return '●';
}

function accelColor(interp: string | null, net: number): string {
  if (!interp) return '#6b6b80';
  if (net > 0 && (interp.includes('acceler') || interp === 'surge')) return '#00e599';
  if (net < 0 || interp.includes('decel') || interp === 'collapse')  return '#ff4757';
  return '#ffd60a';
}

export function StakingVelocity({
  totalStaked,
  totalUnstaked,
  netUsd,
  velocityPct,
  velocityInterp,
  byProtocol,
  windowHours = 24,
}: StakingVelocityProps) {
  const netColor   = netUsd > 0 ? '#00e599' : netUsd < 0 ? '#ff4757' : '#6b6b80';
  const velColor   = accelColor(velocityInterp, netUsd);
  const velEmoji   = accelEmoji(velocityInterp);
  const velDisplay = velocityPct !== null
    ? `${velocityPct >= 0 ? '+' : ''}${velocityPct.toFixed(0)}%`
    : 'n/a';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Top row: net + velocity */}
      <div style={{ display: 'flex', gap: 16 }}>
        {/* Net staking */}
        <div style={{ flex: 1, padding: 16, background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 12 }}>
          <p style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
            Net Staking ({windowHours}h)
          </p>
          <p style={{ fontSize: 26, fontWeight: 800, color: netColor, fontFamily: 'var(--font-heading)', margin: '6px 0 4px' }}>
            {netUsd >= 0 ? '+' : ''}{fmtUsd(netUsd)}
          </p>
          <p style={{ fontSize: 11, color: '#4b4b60', margin: 0, fontFamily: 'var(--font-mono)' }}>
            ↑ {fmtUsd(totalStaked)} staked · ↓ {fmtUsd(totalUnstaked)} unstaked
          </p>
        </div>

        {/* Velocity */}
        <div style={{ flex: 1, padding: 16, background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 12 }}>
          <p style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: 0 }}>
            Velocity
          </p>
          <p style={{ fontSize: 26, fontWeight: 800, color: velColor, fontFamily: 'var(--font-heading)', margin: '6px 0 4px' }}>
            {velEmoji} {velDisplay}
          </p>
          <p style={{ fontSize: 11, color: '#4b4b60', margin: 0, fontFamily: 'var(--font-mono)' }}>
            {velocityInterp ?? 'no prior data'}
          </p>
        </div>
      </div>

      {/* Per-protocol breakdown */}
      {byProtocol.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <p style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            By Protocol
          </p>
          {byProtocol.map(p => {
            const pNet   = p.net_usd;
            const pColor = pNet > 0 ? '#00e599' : pNet < 0 ? '#ff4757' : '#6b6b80';
            return (
              <div key={p.protocol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #1e1e2e' }}>
                <span style={{ fontSize: 13, color: '#c0c0d8', textTransform: 'capitalize' }}>{p.protocol}</span>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: pColor, fontFamily: 'var(--font-mono)' }}>
                    {pNet >= 0 ? '+' : ''}{fmtUsd(pNet)}
                  </span>
                  <span style={{ fontSize: 10, color: '#4b4b60', marginLeft: 8 }}>
                    ↑{fmtUsd(p.staked_usd)} ↓{fmtUsd(p.unstaked_usd)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
