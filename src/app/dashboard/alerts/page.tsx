// ============================================================
// Alert History Page — v2
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import type { AlertRow } from '@/lib/supabase/types';

// ── Meta maps ────────────────────────────────────────────────

const SEVERITY_COLOR: Record<string, string> = {
  major:       '#ff4757',
  significant: '#ffd60a',
  notable:     '#00b8ff',
  info:        '#6b6b80',
};

const SEVERITY_ICON: Record<string, string> = {
  major:       '🚨',
  significant: '⚡',
  notable:     '📊',
  info:        'ℹ️',
};

const TYPE_META: Record<string, { label: string; icon: string }> = {
  accumulation_wave:  { label: 'Accumulation Wave',  icon: '🟢' },
  distribution_wave:  { label: 'Distribution Wave',  icon: '🔴' },
  exchange_spike:     { label: 'Exchange Spike',      icon: '📈' },
  staking_shift:      { label: 'Staking Shift',       icon: '🔒' },
  flow_reversal:      { label: 'Flow Reversal',       icon: '↩️' },
  defi_rotation:      { label: 'DeFi Rotation',       icon: '⚡' },
  stablecoin_flow:    { label: 'Stablecoin Flow',     icon: '💵' },
  whale_large_move:   { label: 'Whale Large Move',    icon: '🐋' },
  weekly_report:      { label: 'Weekly Report',       icon: '📋' },
};

// ── Helpers ───────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString())     return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ── Data ──────────────────────────────────────────────────────

type AlertPick = Pick<
  AlertRow,
  'id' | 'alert_type' | 'severity' | 'title' | 'body' |
  'sent_telegram_free' | 'sent_telegram_premium' | 'sent_at' | 'created_at'
>;

async function getData() {
  const db = createAdminClient();

  const [recentRes, statsRes] = await Promise.all([
    db.from('alerts')
      .select('id, alert_type, severity, title, body, sent_telegram_free, sent_telegram_premium, sent_at, created_at')
      .order('created_at', { ascending: false })
      .limit(100),

    db.from('alerts')
      .select('severity, alert_type, sent_telegram_free'),
  ]);

  const alerts = (recentRes.data ?? []) as AlertPick[];
  const all    = (statsRes.data  ?? []) as any[];

  // Aggregate stats
  const bySev: Record<string, number>  = {};
  const byType: Record<string, number> = {};
  let totalSent = 0;

  for (const a of all) {
    bySev[a.severity]    = (bySev[a.severity]    ?? 0) + 1;
    byType[a.alert_type] = (byType[a.alert_type] ?? 0) + 1;
    if (a.sent_telegram_free) totalSent++;
  }

  // Group by day
  const grouped: { day: string; items: AlertPick[] }[] = [];
  for (const a of alerts) {
    const day = dayLabel(a.created_at);
    const last = grouped[grouped.length - 1];
    if (!last || last.day !== day) grouped.push({ day, items: [a] });
    else last.items.push(a);
  }

  return { grouped, bySev, byType, total: all.length, totalSent };
}

// ── Components ───────────────────────────────────────────────

function StatPill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 16px', background: '#12121a', border: `1px solid ${color}30`, borderRadius: 10 }}>
      <span style={{ fontSize: 20, fontWeight: 800, color, fontFamily: 'var(--font-heading)' }}>{value}</span>
      <span style={{ fontSize: 10, color: '#6b6b80', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 2 }}>{label}</span>
    </div>
  );
}

function DeliveryBadge({ sent, sentAt }: { sent: boolean; sentAt: string | null }) {
  if (sent && sentAt) {
    return (
      <span style={{ fontSize: 10, color: '#00e599', fontFamily: 'var(--font-mono)' }}>
        ✈ {new Date(sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </span>
    );
  }
  return (
    <span style={{ fontSize: 10, color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
      — not sent
    </span>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default async function AlertsPage() {
  const { grouped, bySev, byType, total, totalSent } = await getData();

  const topTypes = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="p-6 lg:p-8 flex flex-col gap-8">

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>
            Alert History
          </h1>
          <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>
            {total} total · {totalSent} sent to Telegram
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Free tier: significant + major only
          </p>
          <p className="text-xs mt-0.5" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
            Cooldown: accumulation/distribution 2h · others 4h
          </p>
        </div>
      </div>

      {/* Stats row */}
      <div className="flex gap-3 flex-wrap">
        <StatPill label="Major"       value={bySev.major       ?? 0} color="#ff4757" />
        <StatPill label="Significant" value={bySev.significant ?? 0} color="#ffd60a" />
        <StatPill label="Notable"     value={bySev.notable     ?? 0} color="#00b8ff" />
        <StatPill label="Info"        value={bySev.info        ?? 0} color="#6b6b80" />

        <div style={{ width: 1, background: '#1e1e2e', margin: '0 4px' }} />

        {topTypes.map(([type, count]) => {
          const meta = TYPE_META[type] ?? { label: type, icon: '●' };
          return (
            <div key={type} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '10px 14px', background: '#12121a', border: '1px solid #1e1e2e', borderRadius: 10 }}>
              <span style={{ fontSize: 16 }}>{meta.icon}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: '#e0e0f0', fontFamily: 'var(--font-heading)' }}>{count}</span>
              <span style={{ fontSize: 9, color: '#4b4b60', fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 1, textAlign: 'center', maxWidth: 64 }}>{meta.label}</span>
            </div>
          );
        })}
      </div>

      {/* Alert feed — grouped by day */}
      {grouped.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
          <p className="text-base font-semibold">No alerts generated yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>
            Alerts appear once the process-flows cron detects anomalies.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {grouped.map(({ day, items }) => (
            <div key={day}>
              {/* Day separator */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                  {day}
                </span>
                <div className="flex-1 h-px" style={{ background: '#1e1e2e' }} />
                <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                  {items.length} alert{items.length !== 1 ? 's' : ''}
                </span>
              </div>

              <div className="flex flex-col gap-2">
                {items.map(a => {
                  const color  = SEVERITY_COLOR[a.severity] ?? '#6b6b80';
                  const sevIcon = SEVERITY_ICON[a.severity] ?? '●';
                  const typeMeta = TYPE_META[a.alert_type] ?? { label: a.alert_type, icon: '●' };

                  return (
                    <div
                      key={a.id}
                      className="rounded-xl border p-4"
                      style={{ background: '#12121a', borderColor: color + '35' }}
                    >
                      {/* Top row */}
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Severity badge */}
                          <span style={{
                            fontSize:     10,
                            padding:      '2px 8px',
                            borderRadius: 4,
                            color,
                            background:   color + '18',
                            fontFamily:   'var(--font-mono)',
                            fontWeight:   700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                          }}>
                            {sevIcon} {a.severity}
                          </span>
                          {/* Type badge */}
                          <span style={{ fontSize: 11, color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
                            {typeMeta.icon} {typeMeta.label}
                          </span>
                        </div>

                        {/* Right: delivery + time */}
                        <div className="flex items-center gap-3 shrink-0">
                          <DeliveryBadge sent={a.sent_telegram_free} sentAt={a.sent_at} />
                          <span style={{ fontSize: 10, color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                            {timeAgo(a.created_at)}
                          </span>
                        </div>
                      </div>

                      {/* Title */}
                      <p className="font-semibold text-sm mb-1" style={{ color: '#e8e8ef' }}>
                        {a.title}
                      </p>

                      {/* Body */}
                      <p className="text-xs leading-relaxed" style={{ color: '#9b9bb0' }}>
                        {a.body}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
