// ============================================================
// Whale Copy Signals — Token-level whale tracking with confidence scores
// Shell page — signal engine coming soon
// ============================================================

export default function WhaleCopySignalsPage() {
  const SIGNAL_EXAMPLES = [
    { whale: '[Whale Alpha]', token: '[TOKEN]', action: 'BUY', confidence: '—', decay: '—', timeframe: '—' },
    { whale: '[Whale Beta]',  token: '[TOKEN]', action: 'BUY', confidence: '—', decay: '—', timeframe: '—' },
    { whale: '[Whale Gamma]', token: '[TOKEN]', action: 'BUY', confidence: '—', decay: '—', timeframe: '—' },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Whale Copy Signals
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40', fontFamily: 'var(--font-mono)' }}
            >
              Coming Soon
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            When whale X buys token Y, surface it as a tradeable signal with a confidence score and time-decay. Prioritize signals by whale track record.
          </p>
        </div>
      </div>

      {/* How it works */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[
          { step: '01', title: 'Whale buys token',       desc: 'On-chain buy detected via Helius webhook for a tracked whale address.' },
          { step: '02', title: 'Confidence scored',      desc: 'Signal scored by whale track record, size relative to position, and market context.' },
          { step: '03', title: 'Time-decay applied',     desc: 'Signal strength decays as time passes — freshest signals have highest action priority.' },
        ].map(s => (
          <div key={s.step} className="rounded-xl border p-5" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
            <p className="text-xs font-bold mb-2" style={{ color: '#7B61FF', fontFamily: 'var(--font-mono)' }}>STEP {s.step}</p>
            <p className="font-semibold text-sm mb-1" style={{ fontFamily: 'var(--font-heading)' }}>{s.title}</p>
            <p className="text-xs leading-relaxed" style={{ color: '#8888AA' }}>{s.desc}</p>
          </div>
        ))}
      </div>

      {/* Signal feed */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Live Signal Feed</h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: '#1A1A24', color: '#8888AA', fontFamily: 'var(--font-mono)' }}
          >
            Placeholder — signal engine not yet active
          </span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Whale', 'Token', 'Action', 'Confidence', 'Timeframe', 'Signal Decay'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SIGNAL_EXAMPLES.map((s, i) => (
              <tr
                key={i}
                style={{ borderBottom: i < SIGNAL_EXAMPLES.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-4 font-medium" style={{ color: '#F0F0F8' }}>{s.whale}</td>
                <td className="px-5 py-4" style={{ color: '#00D4FF', fontFamily: 'var(--font-mono)' }}>{s.token}</td>
                <td className="px-5 py-4">
                  <span className="text-xs px-2 py-0.5 rounded font-bold" style={{ background: '#00E5A010', color: '#00E5A0', border: '1px solid #00E5A030' }}>
                    {s.action}
                  </span>
                </td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.confidence}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.timeframe}</td>
                <td className="px-5 py-4" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.decay}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
