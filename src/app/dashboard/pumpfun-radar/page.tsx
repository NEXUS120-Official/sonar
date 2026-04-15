// ============================================================
// Pump.fun Radar — Whale activity on pump.fun tokens
// Shell page — data pipeline coming soon
// ============================================================

export default function PumpfunRadarPage() {
  const PLACEHOLDER_TOKENS = [
    { symbol: '[TOKEN_A]', address: 'placeholder...', whaleBuys: '—', volume: '—', lastActivity: '—' },
    { symbol: '[TOKEN_B]', address: 'placeholder...', whaleBuys: '—', volume: '—', lastActivity: '—' },
    { symbol: '[TOKEN_C]', address: 'placeholder...', whaleBuys: '—', volume: '—', lastActivity: '—' },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Pump.fun Radar
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#00D4FF20', color: '#00D4FF', border: '1px solid #00D4FF40', fontFamily: 'var(--font-mono)' }}
            >
              Beta
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            Real-time tracking of whale activity on pump.fun tokens. Surface which tokens whales are accumulating and at what volumes.
          </p>
        </div>
      </div>

      {/* Alert banner */}
      <div
        className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm"
        style={{ background: '#00D4FF08', borderColor: '#00D4FF30', color: '#00D4FF' }}
      >
        <span>◎</span>
        <span>Monitoring pump.fun program for tracked whale wallet interactions. Signal latency target: &lt;30s.</span>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Tokens Radar Active',    value: '—' },
          { label: 'Whale Buys (1h)',         value: '—' },
          { label: 'Largest Single Buy',      value: '—' },
          { label: 'Unique Whales Spotted',   value: '—' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#F0F0F8' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Token feed */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Whale Token Activity Feed</h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: '#1A1A24', color: '#8888AA', fontFamily: 'var(--font-mono)' }}
          >
            Placeholder data — not live
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Token', 'Whale Buys', 'Volume (USD)', 'Last Activity'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PLACEHOLDER_TOKENS.map((t, i) => (
              <tr
                key={t.symbol}
                style={{ borderBottom: i < PLACEHOLDER_TOKENS.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-4">
                  <div>
                    <p className="font-medium" style={{ color: '#F0F0F8' }}>{t.symbol}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{t.address}</p>
                  </div>
                </td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{t.whaleBuys}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{t.volume}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{t.lastActivity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
