// ============================================================
// SONAR — Privacy Alert Fingerprint Store
// ============================================================
// Deterministic fingerprint memory for recent-history privacy dedup.
// Keeps doctrine replay-safe and avoids scanning generic alerts.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { AlertInsert } from '@/lib/flow-engine/anomaly-detector';
import { getPrivacyAlertCooldownPolicy } from './privacy-alert-cooldown-policy';
import {
  buildPrivacyBatchDuplicateSuppressionCandidate,
  buildPrivacyCooldownSuppressionCandidate,
  type PrivacySuppressionCandidate,
} from './privacy-alert-suppression-receipts';

type Db = ReturnType<typeof createAdminClient>;

export interface PrivacyFingerprintRecord {
  fingerprint: string;
  alert_family: string;
  token_mint: string | null;
  shadow_family_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  suppression_count: number;
  methodology_version: string;
}

function normalizeAlertFamily(alertType: string): string {
  if (
    alertType === 'privacy_exit_to_public_flow' ||
    alertType === 'privacy_sequence_bridgehead_reemergence'
  ) return 'reemergence';

  if (
    alertType === 'post_privacy_downstream_move' ||
    alertType === 'privacy_sequence_downstream_continuation'
  ) return 'downstream';

  if (
    alertType === 'family_privacy_reemergence' ||
    alertType === 'privacy_sequence_family_reemergence'
  ) return 'family_reemergence';

  return alertType;
}

function tokenOf(data: Record<string, unknown> | null | undefined): string | null {
  const v = data?.['token_mint'];
  return typeof v === 'string' ? v : null;
}

function familyOf(data: Record<string, unknown> | null | undefined): string | null {
  const v = data?.['shadow_family_id'];
  return typeof v === 'string' ? v : null;
}

export function buildPrivacyFingerprintFromAlert(alert: AlertInsert): string {
  return [
    normalizeAlertFamily(alert.alert_type),
    tokenOf((alert.data ?? null) as Record<string, unknown> | null) ?? 'no_token',
    familyOf((alert.data ?? null) as Record<string, unknown> | null) ?? 'no_family',
  ].join('::');
}

export function buildPrivacyFingerprintRecord(alert: AlertInsert): PrivacyFingerprintRecord {
  const data = (alert.data ?? null) as Record<string, unknown> | null;
  const now = new Date().toISOString();

  return {
    fingerprint: buildPrivacyFingerprintFromAlert(alert),
    alert_family: normalizeAlertFamily(alert.alert_type),
    token_mint: tokenOf(data),
    shadow_family_id: familyOf(data),
    first_seen_at: now,
    last_seen_at: now,
    suppression_count: 0,
    methodology_version: 'privacy_alert_fingerprint_v1',
  };
}

export async function loadRecentPrivacyFingerprints(
  db: Db,
  hours: number = 24,
): Promise<Array<{
  fingerprint: string;
  alert_family: string;
  last_seen_at: string;
}>> {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('privacy_alert_fingerprints')
    .select('fingerprint, alert_family, last_seen_at')
    .gte('last_seen_at', cutoff)
    .limit(1000);

  return (data ?? []) as Array<{
    fingerprint: string;
    alert_family: string;
    last_seen_at: string;
  }>;
}

export function suppressFingerprintKnownAlerts(
  alerts: ReadonlyArray<AlertInsert>,
  knownRows: ReadonlyArray<{
    fingerprint: string;
    alert_family: string;
    last_seen_at: string;
  }>,
): {
  kept: AlertInsert[];
  suppressedFingerprints: string[];
  suppressionCandidates: PrivacySuppressionCandidate[];
} {
  const kept: AlertInsert[] = [];
  const suppressedFingerprints: string[] = [];
  const suppressionCandidates: PrivacySuppressionCandidate[] = [];
  const nowMs = Date.now();

  const knownMap = new Map(
    knownRows.map((row) => [row.fingerprint, row] as const)
  );

  const batchSeen = new Set<string>();

  for (const alert of alerts) {
    const fp = buildPrivacyFingerprintFromAlert(alert);
    const row = knownMap.get(fp);

    if (row) {
      const policy = getPrivacyAlertCooldownPolicy(row.alert_family);
      const ageHours = (nowMs - new Date(row.last_seen_at).getTime()) / 3_600_000;

      if (ageHours < policy.cooldown_hours) {
        suppressedFingerprints.push(fp);
        suppressionCandidates.push(
          buildPrivacyCooldownSuppressionCandidate(alert, row.last_seen_at)
        );
        continue;
      }
    }

    if (batchSeen.has(fp)) {
      suppressedFingerprints.push(fp);
      suppressionCandidates.push(
        buildPrivacyBatchDuplicateSuppressionCandidate(alert)
      );
      continue;
    }

    batchSeen.add(fp);
    kept.push(alert);
  }

  return { kept, suppressedFingerprints, suppressionCandidates };
}

export async function upsertPrivacyFingerprintRecords(
  db: Db,
  alerts: ReadonlyArray<AlertInsert>,
): Promise<number> {
  if (alerts.length === 0) return 0;

  const rows = alerts.map(buildPrivacyFingerprintRecord);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('privacy_alert_fingerprints')
    .upsert(rows as any, { onConflict: 'fingerprint' })
    .select('fingerprint');

  if (error) throw error;
  return data?.length ?? 0;
}

export async function bumpSuppressedPrivacyFingerprints(
  db: Db,
  fingerprints: ReadonlyArray<string>,
): Promise<void> {
  if (fingerprints.length === 0) return;

  const unique = [...new Set(fingerprints)];

  // read current rows
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (db as any)
    .from('privacy_alert_fingerprints')
    .select('fingerprint, alert_family, token_mint, shadow_family_id, first_seen_at, suppression_count, methodology_version')
    .in('fingerprint', unique as any);

  const now = new Date().toISOString();
  const rows = ((data ?? []) as Array<{
    fingerprint: string;
    alert_family: string;
    token_mint: string | null;
    shadow_family_id: string | null;
    first_seen_at: string;
    suppression_count: number | null;
    methodology_version: string | null;
  }>).map((r) => ({
    fingerprint: r.fingerprint,
    alert_family: r.alert_family,
    token_mint: r.token_mint,
    shadow_family_id: r.shadow_family_id,
    first_seen_at: r.first_seen_at,
    last_seen_at: now,
    suppression_count: (r.suppression_count ?? 0) + 1,
    methodology_version: r.methodology_version ?? 'privacy_alert_fingerprint_v1',
  }));

  if (rows.length === 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any)
    .from('privacy_alert_fingerprints')
    .upsert(rows as any, { onConflict: 'fingerprint' });
}
