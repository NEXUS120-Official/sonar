// ============================================================
// LP Monitor — Liquidity pool add/remove events
// Shell page — data pipeline coming soon
// ============================================================

export default function LpMonitorPage() {
  const PLACEHOLDER_EVENTS = [
    { pool: '[POOL_A]', protocol: 'Raydium', type: 'ADD',    amountUsd: '—', wallet: '[whale]', time: '—' },
    { pool: '[POOL_B]', protocol: 'Orca',    type: 'REMOVE', amountUsd: '—', wallet: '[whale]', time: '—' },
    { pool: '[POOL_C]', protocol: 'Meteora', type: 'ADD',    amountUsd: '—', wallet: '[whale]', time: '—' },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              LP Monitor
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#FFB80020', color: '#FFB800', border: '1px solid #FFB80040', fontFamily: 'var(--font-mono)' }}
            >
              Coming Soon
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            Surface LP add/remove events from tracked wallets. Detect potential rug signals (large LP removal) and new market construction (LP creation).
          </p>
        </div>
      </div>

      {/* Signal cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border p-5" style={{ background: '#111118', borderColor: '#FF4D6A40' }}>
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: '#FF4D6A' }}>⚠</span>
            <p className="text-sm font-semibold" style={{ color: '#FF4D6A' }}>Rug Signal Detection</p>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>
            Large LP removals from newly created pools by non-whale wallets are flagged as potential rug signals. Alert threshold configurable per pool age and LP %.
          </p>
        </div>
        <div className="rounded-xl border p-5" style={{ background: '#111118', borderColor: '#00E5A040' }}>
          <div className="flex items-center gap-2 mb-2">
            <span style={{ color: '#00E5A0' }}>◈</span>
            <p className="text-sm font-semibold" style={{ color: '#00E5A0' }}>Market Construction Signal</p>
          </div>
          <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>
            Whale wallets adding LP to new pools is a bullish construction signal. Track size, pool pair, and whether the whale has prior history with the token.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'LP Events (24h)',        value: '—' },
          { label: 'Rug Signals Flagged',    value: '—' },
          { label: 'New Pools (Whale)',       value: '—' },
          { label: 'Total LP Value Tracked', value: '—' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#F0F0F8' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Event feed */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>LP Event Feed</h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: '#1A1A24', color: '#8888AA', fontFamily: 'var(--font-mono)' }}
          >
            Placeholder — not live data
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Pool', 'Protocol', 'Event', 'Amount USD', 'Wallet', 'Time'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PLACEHOLDER_EVENTS.map((e, i) => (
              <tr
                key={i}
                style={{ borderBottom: i < PLACEHOLDER_EVENTS.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-4 font-medium">{e.pool}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA' }}>{e.protocol}</td>
                <td className="px-5 py-4">
                  <span
                    className="text-xs px-2 py-0.5 rounded font-bold"
                    style={{
                      background: e.type === 'ADD' ? '#00E5A010' : '#FF4D6A10',
                      color:      e.type === 'ADD' ? '#00E5A0'   : '#FF4D6A',
                      border:     `1px solid ${e.type === 'ADD' ? '#00E5A030' : '#FF4D6A30'}`,
                    }}
                  >
                    {e.type}
                  </span>
                </td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{e.amountUsd}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{e.wallet}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{e.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
