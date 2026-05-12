'use client';

interface FlowGaugeProps {
  score: number | null;
  label: string | null;
  size?: number;
}

export function FlowGauge({ score, label, size = 220 }: FlowGaugeProps) {
  const percentage = score != null ? ((score + 100) / 200) * 100 : 50;
  const isBullish = score != null && score > 20;
  const isBearish = score != null && score < -20;
  const accentColor = isBullish ? '#00E5A0' : isBearish ? '#FF4D6A' : '#7B61FF';
  const bars = 42;

  return (
    <div
      className="relative flex flex-col items-center justify-center"
      style={{ width: size, height: size }}
    >
      {/* Effetto Glow posteriore */}
      <div
        className="absolute inset-0 rounded-full opacity-15 blur-3xl"
        style={{ background: accentColor }}
      />

      {/* Barre Equalizer monocromatiche */}
      <div className="absolute inset-0 flex items-end justify-center gap-[3px] opacity-25">
        {Array.from({ length: bars }).map((_, i) => {
          const distance = Math.abs(i - bars / 2);
          const maxDistance = bars / 2;
          const intensity = 1 - distance / maxDistance;
          const active = intensity > 0.3 && Math.abs(score || 0) > distance * 3;
          return (
            <div
              key={i}
              className="w-[3px] rounded-full transition-all duration-1000 ease-out"
              style={{
                height: active ? `${20 + intensity * 50}%` : `${8 + intensity * 10}%`,
                background: accentColor,
                opacity: active ? 0.8 : 0.3,
              }}
            />
          );
        })}
      </div>

      {/* Anello esterno (Semicerchio Radar) */}
      <svg
        viewBox="0 0 200 100"
        className="absolute top-0 left-0 w-full h-full"
        style={{ transform: 'rotate(180deg)' }}
      >
        <defs>
          <linearGradient id="gaugeGradientNew" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#FF4D6A" />
            <stop offset="50%" stopColor={accentColor} />
            <stop offset="100%" stopColor="#00E5A0" />
          </linearGradient>
        </defs>
        {/* Sfondo anello */}
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke="url(#gaugeGradientNew)"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.2"
        />
        {/* Barra attiva */}
        <path
          d="M 20 100 A 80 80 0 0 1 180 100"
          fill="none"
          stroke="url(#gaugeGradientNew)"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={`${percentage * 2.5} 250`}
          style={{ transition: 'stroke-dasharray 1.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
        />
        {/* Indicatore luminoso */}
        <circle
          cx={20 + (percentage / 100) * 160}
          cy={20 + Math.sin((percentage / 100) * Math.PI) * 80}
          r="5"
          fill="white"
          stroke={accentColor}
          strokeWidth="2"
          style={{ transition: 'all 1.5s cubic-bezier(0.4, 0, 0.2, 1)' }}
        />
      </svg>

      {/* Valore Centrale */}
      <div className="relative z-10 flex flex-col items-center">
        <span
          className="text-5xl font-bold tracking-tighter transition-colors duration-500"
          style={{ color: accentColor, textShadow: `0 0 25px ${accentColor}60` }}
        >
          {score != null ? score : '--'}
        </span>
        <span className="text-xs uppercase tracking-[0.2em] mt-2 text-gray-400 font-semibold">
          {label || 'NEUTRAL'}
        </span>
      </div>
    </div>
  );
}
