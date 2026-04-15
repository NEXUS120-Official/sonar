// ============================================================
// DEX Intelligence — Whale interactions with Solana DEXs
// Shell page — data pipeline coming soon
// ============================================================

export default function DexIntelligencePage() {
  const DEX_LIST = [
    { name: 'Raydium',  icon: '⬡', volume: '—', whales: '—', trend: 'neutral' },
    { name: 'Orca',     icon: '◎', volume: '—', whales: '—', trend: 'neutral' },
    { name: 'Meteora',  icon: '◈', volume: '—', whales: '—', trend: 'neutral' },
    { name: 'Phoenix',  icon: '◬', volume: '—', whales: '—', trend: 'neutral' },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              DEX Intelligence
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40', fontFamily: 'var(--font-mono)' }}
            >
              Coming Soon
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            Track whale interactions with Raydium, Orca, Meteora, and Phoenix. See which DEXs smart money is using and when.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Whale DEX Txns (24h)', value: '—' },
          { label: 'Total Volume Tracked', value: '—' },
          { label: 'Most Active DEX',       value: '—' },
          { label: 'Unique Whales',          value: '—' },
        ].map(s => (
          <div key={s.label} className="rounded-xl border p-4" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs mb-1" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.label}</p>
            <p className="text-xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#F0F0F8' }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* DEX breakdown table */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>DEX Activity Breakdown</h2>
          <span className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>24h window</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Protocol', 'Whale Volume', 'Active Whales', 'Trend'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DEX_LIST.map((dex, i) => (
              <tr
                key={dex.name}
                style={{ borderBottom: i < DEX_LIST.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span style={{ color: '#7B61FF' }}>{dex.icon}</span>
                    <span className="font-medium">{dex.name}</span>
                  </div>
                </td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{dex.volume}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{dex.whales}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA' }}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Placeholder notice */}
      <div
        className="rounded-xl border p-6 text-center"
        style={{ background: '#111118', borderColor: '#2A2A3A' }}
      >
        <p className="text-sm font-medium mb-1" style={{ color: '#7B61FF' }}>Pipeline under construction</p>
        <p className="text-xs" style={{ color: '#8888AA' }}>
          DEX interaction indexing is being wired to the Helius webhook stream. Data will populate automatically once live.
        </p>
      </div>

    </div>
  );
}
