// ============================================================
// Alert History Page
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import type { AlertRow } from '@/lib/supabase/types';

const SEVERITY_COLORS: Record<string, string> = {
  info:        '#6b6b80',
  notable:     '#00b8ff',
  significant: '#ffd60a',
  major:       '#ff4757',
};

const TYPE_LABELS: Record<string, string> = {
  exchange_spike:      'Exchange Spike',
  accumulation_wave:   'Accumulation Wave',
  distribution_wave:   'Distribution Wave',
  staking_shift:       'Staking Shift',
  defi_rotation:       'DeFi Rotation',
  stablecoin_flow:     'Stablecoin Flow',
  whale_large_move:    'Whale Large Move',
  weekly_report:       'Weekly Report',
};

async function getData() {
  const db = createAdminClient();
  const { data } = await db
    .from('alerts')
    .select('id, alert_type, severity, title, body, ai_analysis, sent_telegram_free, sent_telegram_premium, sent_at, created_at')
    .order('created_at', { ascending: false })
    .limit(50);
  return (data ?? []) as Pick<
    AlertRow,
    'id' | 'alert_type' | 'severity' | 'title' | 'body' | 'ai_analysis' |
    'sent_telegram_free' | 'sent_telegram_premium' | 'sent_at' | 'created_at'
  >[];
}

export default async function AlertsPage() {
  const alerts = await getData();

  return (
    <div className="p-8 flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>Alert History</h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>Last {alerts.length} alerts</p>
      </div>

      {alerts.length === 0 ? (
        <div className="rounded-xl border p-10 text-center" style={{ background: '#12121a', borderColor: '#1e1e2e', color: '#6b6b80' }}>
          <p className="text-base font-semibold">No alerts generated yet.</p>
          <p className="text-sm mt-2" style={{ color: '#4b4b60' }}>Alerts are created by the process-flows cron when anomalies are detected.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {alerts.map(a => {
            const color = SEVERITY_COLORS[a.severity] ?? '#6b6b80';
            return (
              <div
                key={a.id}
                className="rounded-xl border p-5 flex flex-col gap-3"
                style={{ background: '#12121a', borderColor: color + '40' }}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span
                      className="text-xs font-semibold px-2 py-0.5 rounded uppercase tracking-wider"
                      style={{ color, background: color + '18', fontFamily: 'var(--font-mono)' }}
                    >
                      {a.severity}
                    </span>
                    <span className="text-xs" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
                      {TYPE_LABELS[a.alert_type] ?? a.alert_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {/* Telegram status */}
                    <span
                      className="text-xs"
                      style={{ color: a.sent_telegram_free ? '#00e599' : '#4b4b60', fontFamily: 'var(--font-mono)' }}
                      title={a.sent_telegram_free ? 'Sent to Telegram' : 'Not sent to Telegram'}
                    >
                      ✈ {a.sent_telegram_free ? 'sent' : 'pending'}
                    </span>
                    <span className="text-xs" style={{ color: '#4b4b60', fontFamily: 'var(--font-mono)' }}>
                      {new Date(a.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>

                {/* Title */}
                <h3 className="font-semibold text-sm" style={{ color: '#e8e8ef' }}>{a.title}</h3>

                {/* Body */}
                <p className="text-sm leading-relaxed" style={{ color: '#6b6b80' }}>{a.body}</p>

                {/* AI analysis */}
                {a.ai_analysis && (
                  <div
                    className="rounded-lg p-3 text-xs leading-relaxed border"
                    style={{ background: '#0a0a0f', borderColor: '#1e1e2e', color: '#6b6b80', fontFamily: 'var(--font-mono)' }}
                  >
                    <span style={{ color: '#00b8ff' }}>AI: </span>
                    {a.ai_analysis}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
