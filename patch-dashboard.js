const fs = require("fs");
const path = "src/app/dashboard/page.tsx";
let c = fs.readFileSync(path, "utf8");

// 1. Sostituisci l'header con versione glass
c = c.replace(
  /<div className="flex items-start justify-between">[\s\S]*?<\/div>\s*<\/div>\s*{/,
  `<div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
              Flow Overview
            </h1>
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-[#00D4FF]/15 text-[#00D4FF] border border-[#00D4FF]/20 animate-pulse">
              Live
            </span>
          </div>
          <p className="text-sm" style={{ color: '#6b6b80' }}>
            24-hour smart money activity · Solana
          </p>
        </div>
        {snap?.snapshot_time && (
          <p className="text-xs px-3 py-1.5 rounded-lg border border-white/5 bg-white/[0.02] backdrop-blur-sm" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Last snapshot: {new Date(snap.snapshot_time).toLocaleTimeString()}
          </p>
        )}
      </div>

      {/* ── Hero: Bias Gauge + WWWD ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-8">{`
);

// 2. Migliora le card Bias Gauge e WWWD con effetto glass
c = c.replace(
  /className="lg:col-span-2 flex flex-col p-6 rounded-xl border" style={{ background: '#12121a', borderColor: '#1e1e2e' }}/,
  `className="lg:col-span-2 flex flex-col p-6 rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm shadow-2xl shadow-black/30 relative overflow-hidden"`
);

c = c.replace(
  /<div className="lg:col-span-3 flex flex-col justify-center">/,
  `<div className="lg:col-span-3 flex flex-col justify-center rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm p-6 shadow-2xl shadow-black/30">`
);

// 3. Migliora il contenitore del BiasChart
c = c.replace(
  /className="rounded-xl border p-5" style={{ background: '#12121a', borderColor: '#1e1e2e' }}/,
  `className="rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm p-6 shadow-2xl shadow-black/30"`
);

// 4. Migliora il contenitore dei movimenti
c = c.replace(
  /className="rounded-xl border p-8 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}/,
  `className="rounded-2xl border border-white/5 bg-white/[0.02] backdrop-blur-sm p-8 text-center shadow-2xl shadow-black/30"`
);

fs.writeFileSync(path, c);
console.log("✅ Dashboard patch applicata");
