// ============================================================
// Price Prediction — Intelligence layer combining on-chain signals
// Shell page — model training in progress
// ============================================================

export default function PricePredictionPage() {
  const SIGNAL_INPUTS = [
    { label: 'Exchange Net Flow (24h)',   status: 'active',  weight: '—' },
    { label: 'Staking Velocity',          status: 'active',  weight: '—' },
    { label: 'Whale Buy/Sell Ratio',      status: 'active',  weight: '—' },
    { label: 'DEX Liquidity Delta',       status: 'pending', weight: '—' },
    { label: 'Pump.fun Whale Activity',   status: 'pending', weight: '—' },
    { label: 'LP Construction Signal',    status: 'pending', weight: '—' },
  ];

  return (
    <div className="p-6 lg:p-8 space-y-6" style={{ color: '#F0F0F8' }}>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Price Prediction
            </h1>
            <span
              className="text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wider"
              style={{ background: '#7B61FF20', color: '#7B61FF', border: '1px solid #7B61FF40', fontFamily: 'var(--font-mono)' }}
            >
              Model Training
            </span>
          </div>
          <p style={{ color: '#8888AA', fontSize: 14 }}>
            The SONAR intelligence layer — combining on-chain signals into a directional bias with confidence score, timeframe, and supporting signal breakdown.
          </p>
        </div>
      </div>

      {/* Current prediction card */}
      <div
        className="rounded-xl border p-6"
        style={{ background: '#111118', borderColor: '#2A2A3A' }}
      >
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-widest mb-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
              Current Directional Bias
            </p>
            <div className="flex items-center gap-4">
              <span className="text-5xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#7B61FF' }}>—</span>
              <div>
                <p className="text-sm font-medium mb-0.5">Awaiting signal calibration</p>
                <p className="text-xs" style={{ color: '#8888AA' }}>Confidence: — · Timeframe: —</p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 text-right">
            <p className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>Model Accuracy (30d)</p>
            <p className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)', color: '#F0F0F8' }}>—</p>
            <p className="text-xs" style={{ color: '#8888AA' }}>Baseline: —</p>
          </div>
        </div>
      </div>

      {/* Signal inputs */}
      <div className="rounded-xl border overflow-hidden" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: '#2A2A3A' }}>
          <h2 className="text-sm font-semibold" style={{ fontFamily: 'var(--font-heading)' }}>Signal Inputs</h2>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid #2A2A3A' }}>
              {['Signal', 'Status', 'Model Weight', 'Current Reading'].map(h => (
                <th key={h} className="px-5 py-3 text-left text-xs font-medium" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SIGNAL_INPUTS.map((s, i) => (
              <tr
                key={s.label}
                style={{ borderBottom: i < SIGNAL_INPUTS.length - 1 ? '1px solid #2A2A3A' : 'none' }}
              >
                <td className="px-5 py-3 font-medium" style={{ color: '#F0F0F8' }}>{s.label}</td>
                <td className="px-5 py-3">
                  <span
                    className="text-xs px-2 py-0.5 rounded font-bold"
                    style={{
                      background: s.status === 'active' ? '#00E5A010' : '#FFB80010',
                      color:      s.status === 'active' ? '#00E5A0'   : '#FFB800',
                      border:     `1px solid ${s.status === 'active' ? '#00E5A030' : '#FFB80030'}`,
                    }}
                  >
                    {s.status === 'active' ? 'ACTIVE' : 'PENDING'}
                  </span>
                </td>
                <td className="px-5 py-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>{s.weight}</td>
                <td className="px-5 py-3" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>—</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Accuracy history placeholder */}
      <div className="rounded-xl border p-6" style={{ background: '#111118', borderColor: '#2A2A3A' }}>
        <h2 className="text-sm font-semibold mb-4" style={{ fontFamily: 'var(--font-heading)' }}>Prediction Accuracy History</h2>
        <div
          className="h-32 rounded-lg flex items-center justify-center"
          style={{ background: '#0A0A0F', border: '1px dashed #2A2A3A' }}
        >
          <p className="text-xs" style={{ color: '#8888AA', fontFamily: 'var(--font-mono)' }}>
            Accuracy chart — awaiting model predictions
          </p>
        </div>
      </div>

    </div>
  );
}
