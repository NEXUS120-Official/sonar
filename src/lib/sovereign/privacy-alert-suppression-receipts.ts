// ============================================================
// SONAR — Privacy Alert Suppression Receipts
// ============================================================
// Audit-grade explainability for suppressed privacy alerts.
// Pure receipt builder + persistence helper.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { AlertInsert } from '@/lib/flow-engine/anomaly-detector';
import { getPrivacyAlertCooldownPolicy } from './privacy-alert-cooldown-policy';
import { buildPrivacyFingerprintFromAlert } from './privacy-alert-fingerprint-store';

type Db = ReturnType<typeof createAdminClient>;

export interface PrivacySuppressionCandidate {
  alert: AlertInsert;
  fingerprint: string;
  alert_family: string;
  suppression_reason: string;
  cooldown_hours: number | null;
  last_seen_at: string | null;
}

export interface PrivacyAlertSuppressionReceiptInsert {
  receipt_id: string;
  fingerprint: string;
  alert_family: string;
  candidate_alert_type: string;
  token_mint: string | null;
  shadow_family_id: string | null;
  suppression_reason: string;
  cooldown_hours: number | null;
  last_seen_at: string | null;
  suppressed_at: string;
  methodology_version: string;
}

function tokenOf(data: Record<string, unknown> | null | undefined): string | null {
  const v = data?.['token_mint'];
  return typeof v === 'string' ? v : null;
}

function familyIdOf(data: Record<string, unknown> | null | undefined): string | null {
  const v = data?.['shadow_family_id'];
  return typeof v === 'string' ? v : null;
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

export function makePrivacySuppressionReceiptId(
  candidate: PrivacySuppressionCandidate,
): string {
  return [
    candidate.fingerprint,
    candidate.suppression_reason,
    candidate.alert.alert_type,
    candidate.last_seen_at ?? 'no_last_seen',
  ].join('::');
}

export function buildPrivacySuppressionReceipt(
  candidate: PrivacySuppressionCandidate,
): PrivacyAlertSuppressionReceiptInsert {
  const data = (candidate.alert.data ?? null) as Record<string, unknown> | null;
  const now = new Date().toISOString();

  return {
    receipt_id: makePrivacySuppressionReceiptId(candidate),
    fingerprint: candidate.fingerprint,
    alert_family: candidate.alert_family,
    candidate_alert_type: candidate.alert.alert_type,
    token_mint: tokenOf(data),
    shadow_family_id: familyIdOf(data),
    suppression_reason: candidate.suppression_reason,
    cooldown_hours: candidate.cooldown_hours,
    last_seen_at: candidate.last_seen_at,
    suppressed_at: now,
    methodology_version: 'privacy_alert_suppression_receipt_v1',
  };
}

export function buildPrivacyCooldownSuppressionCandidate(
  alert: AlertInsert,
  lastSeenAt: string | null,
): PrivacySuppressionCandidate {
  const family = normalizeAlertFamily(alert.alert_type);
  const policy = getPrivacyAlertCooldownPolicy(family);

  return {
    alert,
    fingerprint: buildPrivacyFingerprintFromAlert(alert),
    alert_family: family,
    suppression_reason: 'cooldown_window_active',
    cooldown_hours: policy.cooldown_hours,
    last_seen_at: lastSeenAt,
  };
}

export function buildPrivacyBatchDuplicateSuppressionCandidate(
  alert: AlertInsert,
): PrivacySuppressionCandidate {
  const family = normalizeAlertFamily(alert.alert_type);

  return {
    alert,
    fingerprint: buildPrivacyFingerprintFromAlert(alert),
    alert_family: family,
    suppression_reason: 'duplicate_inside_batch',
    cooldown_hours: null,
    last_seen_at: null,
  };
}

export async function insertPrivacySuppressionReceipts(
  db: Db,
  candidates: ReadonlyArray<PrivacySuppressionCandidate>,
): Promise<number> {
  if (candidates.length === 0) return 0;

  const rows = candidates.map(buildPrivacySuppressionReceipt);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
    .from('privacy_alert_suppression_receipts')
    .upsert(rows as any, { onConflict: 'receipt_id' })
    .select('receipt_id');

  if (error) throw error;
  return data?.length ?? 0;
}
