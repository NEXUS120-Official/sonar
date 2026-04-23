// ============================================================
// SONAR — Privacy Alert Recent-History Dedup
// ============================================================
// Pure-ish helper layer for suppressing near-duplicate privacy alerts
// across recent cron runs.
// Doctrine:
// - deterministic grouping key
// - short recent-history suppression window
// - keep noise low without deleting new intelligence families
// ============================================================

import type { AlertInsert } from '@/lib/flow-engine/anomaly-detector';

export interface ExistingAlertFingerprint {
  alert_type: string;
  title: string;
  created_at: string;
  data: Record<string, unknown> | null;
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

function tokenOf(data: Record<string, unknown> | null | undefined): string {
  const v = data?.['token_mint'];
  return typeof v === 'string' ? v : 'no_token';
}

function familyOf(data: Record<string, unknown> | null | undefined): string {
  const v = data?.['shadow_family_id'];
  return typeof v === 'string' ? v : 'no_family';
}

export function buildPrivacyAlertFingerprint(
  alertType: string,
  data: Record<string, unknown> | null | undefined,
): string {
  return [
    normalizeAlertFamily(alertType),
    tokenOf(data),
    familyOf(data),
  ].join('::');
}

export function suppressRecentDuplicatePrivacyAlerts(
  candidates: ReadonlyArray<AlertInsert>,
  existing: ReadonlyArray<ExistingAlertFingerprint>,
): AlertInsert[] {
  const seen = new Set(
    existing.map((row) => buildPrivacyAlertFingerprint(row.alert_type, row.data))
  );

  const out: AlertInsert[] = [];
  for (const alert of candidates) {
    const fp = buildPrivacyAlertFingerprint(
      alert.alert_type,
      (alert.data ?? null) as Record<string, unknown> | null,
    );
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push(alert);
  }

  return out;
}
