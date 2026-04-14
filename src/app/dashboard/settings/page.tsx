// ============================================================
// SONAR v2.0 — Settings Page
// ============================================================

import { createAdminClient } from '@/lib/supabase/server';
import type { WhaleRow, FlowSnapshotRow } from '@/lib/supabase/types';

async function getSystemState() {
  const db = createAdminClient();

  const [whaleRes, snapRes, alertRes] = await Promise.all([
    db.from('whales').select('id, is_active, discovery_method, balance_updated_at').limit(200),
    db.from('flow_snapshots').select('snapshot_time, window_hours').order('snapshot_time', { ascending: false }).limit(4),
    db.from('alerts').select('id, created_at, sent_telegram_free').order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const whales    = (whaleRes.data   ?? []) as Pick<WhaleRow, 'id' | 'is_active' | 'discovery_method' | 'balance_updated_at'>[];
  const snapshots = (snapRes.data    ?? []) as Pick<FlowSnapshotRow, 'snapshot_time' | 'window_hours'>[];
  const lastAlert = whaleRes.error ? null : alertRes.data as { id: string; created_at: string; sent_telegram_free: boolean } | null;

  const activeWhales   = whales.filter(w => w.is_active).length;
  const inactiveWhales = whales.filter(w => !w.is_active).length;
  const lastSnapshot   = snapshots[0]?.snapshot_time ?? null;
  const lastBalUpdate  = whales.find(w => w.balance_updated_at)?.balance_updated_at ?? null;

  const methodBreakdown: Record<string, number> = {};
  for (const w of whales) {
    const k = w.discovery_method ?? 'unknown';
    methodBreakdown[k] = (methodBreakdown[k] ?? 0) + 1;
  }

  return { activeWhales, inactiveWhales, lastSnapshot, lastBalUpdate, lastAlert, methodBreakdown };
}

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full"
      style={{ background: ok ? '#00e599' : '#ff4757' }}
    />
  );
}

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b" style={{ borderColor: '#1e1e2e' }}>
      <span className="text-sm" style={{ color: '#6b6b80' }}>{label}</span>
      <span
        className="text-sm text-right"
        style={{ color: '#e8e8ef', fontFamily: mono ? 'var(--font-mono)' : undefined, maxWidth: '60%', wordBreak: 'break-all' }}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ background: '#12121a', borderColor: '#1e1e2e' }}>
      <div className="px-5 py-3 border-b" style={{ borderColor: '#1e1e2e', background: '#0f0f18' }}>
        <h2 className="text-sm font-semibold uppercase tracking-widest" style={{ color: '#6b6b80', fontFamily: 'var(--font-mono)' }}>
          {title}
        </h2>
      </div>
      <div className="px-5 py-1">{children}</div>
    </div>
  );
}

export default async function SettingsPage() {
  const { activeWhales, inactiveWhales, lastSnapshot, lastBalUpdate, lastAlert, methodBreakdown } = await getSystemState();

  const telegramFree    = process.env.TELEGRAM_CHANNEL_ID ?? null;
  const telegramPremium = process.env.TELEGRAM_PREMIUM_CHANNEL_ID ?? null;
  const heliusKey       = !!process.env.HELIUS_API_KEY;
  const anthropicKey    = !!process.env.ANTHROPIC_API_KEY;
  const cronSecret      = !!process.env.CRON_SECRET;

  function fmtTime(ts: string | null) {
    if (!ts) return <span style={{ color: '#4b4b60' }}>Never</span>;
    return new Date(ts).toLocaleString();
  }

  return (
    <div className="p-8 flex flex-col gap-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold" style={{ fontFamily: 'var(--font-heading)' }}>Settings</h1>
        <p className="text-sm mt-0.5" style={{ color: '#6b6b80' }}>System status and configuration overview</p>
      </div>

      {/* Whale Layer */}
      <Section title="Whale Layer">
        <Row label="Active whales"   value={<span style={{ color: activeWhales > 0 ? '#00e599' : '#ff4757' }}>{activeWhales}</span>} />
        <Row label="Inactive whales" value={inactiveWhales} />
        <Row label="Qualification threshold" value="$500,000 total value" />
        <Row label="Last balance update" value={fmtTime(lastBalUpdate)} />
        {Object.entries(methodBreakdown).map(([method, count]) => (
          <Row key={method} label={`  → ${method}`} value={count} mono />
        ))}
      </Section>

      {/* Data Pipeline */}
      <Section title="Data Pipeline">
        <Row label="Last flow snapshot" value={fmtTime(lastSnapshot)} />
        <Row label="Last alert" value={fmtTime(lastAlert?.created_at ?? null)} />
        <Row label="Last alert sent Telegram" value={
          lastAlert ? (
            <span style={{ color: lastAlert.sent_telegram_free ? '#00e599' : '#6b6b80' }}>
              {lastAlert.sent_telegram_free ? 'Yes' : 'No'}
            </span>
          ) : <span style={{ color: '#4b4b60' }}>—</span>
        } />
      </Section>

      {/* Telegram */}
      <Section title="Telegram">
        <Row label="Free channel" value={
          <span style={{ color: telegramFree ? '#00e599' : '#ff4757', fontFamily: 'var(--font-mono)' }}>
            {telegramFree ? telegramFree : 'Not configured'}
          </span>
        } />
        <Row label="Premium channel" value={
          <span style={{ color: telegramPremium ? '#00e599' : '#6b6b80', fontFamily: 'var(--font-mono)' }}>
            {telegramPremium ? telegramPremium : 'Not configured'}
          </span>
        } />
        <Row label="Auth" value={<span style={{ color: '#6b6b80' }}>Dashboard is public · no user login required</span>} />
      </Section>

      {/* API Keys */}
      <Section title="Environment">
        <Row label="HELIUS_API_KEY" value={<span className="flex items-center gap-2"><StatusDot ok={heliusKey} /> {heliusKey ? 'Set' : 'Missing'}</span>} />
        <Row label="ANTHROPIC_API_KEY" value={<span className="flex items-center gap-2"><StatusDot ok={anthropicKey} /> {anthropicKey ? 'Set' : 'Missing'}</span>} />
        <Row label="CRON_SECRET" value={<span className="flex items-center gap-2"><StatusDot ok={cronSecret} /> {cronSecret ? 'Set' : 'Missing (cron unprotected)'}</span>} />
        <Row label="TELEGRAM_BOT_TOKEN" value={<span className="flex items-center gap-2"><StatusDot ok={!!process.env.TELEGRAM_BOT_TOKEN} /> {process.env.TELEGRAM_BOT_TOKEN ? 'Set' : 'Missing'}</span>} />
      </Section>

      {/* Cron Schedule */}
      <Section title="Cron Schedule (Vercel)">
        <Row label="process-flows" value="Every 5 minutes" />
        <Row label="send-alerts" value="Every 2 minutes" />
        <Row label="update-balances" value="Every 60 minutes" />
        <Row label="discover-whales" value="Every 6 hours" />
        <Row label="Config" value={<span style={{ fontFamily: 'var(--font-mono)', color: '#6b6b80', fontSize: '0.75rem' }}>vercel.json → crons</span>} />
      </Section>

      {/* Auth status */}
      <Section title="Auth">
        <Row label="Mode" value="Public dashboard — no login required" />
        <Row label="Admin login" value={<a href="/login" style={{ color: '#00b8ff' }}>/login</a>} />
        <Row
          label="Gate dashboard"
          value={
            <span style={{ color: '#6b6b80', fontSize: '0.75rem' }}>
              Uncomment gate in <code style={{ fontFamily: 'var(--font-mono)' }}>src/middleware.ts</code> to restrict access
            </span>
          }
        />
      </Section>
    </div>
  );
}
