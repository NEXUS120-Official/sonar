// ============================================================
// SONAR — Unified Privacy Alert Doctrine
// ============================================================
// Pure consolidation layer across privacy lifecycle alerts and
// privacy sequence-aware alerts.
// Goal: one sovereign policy for high-signal privacy semantics.
// ============================================================

import type { AlertInsert } from '@/lib/flow-engine/anomaly-detector';

type AlertWithData = AlertInsert & {
  data?: Record<string, unknown> | null;
};

function severityRank(sev: string | null | undefined): number {
  if (sev === 'major') return 4;
  if (sev === 'significant') return 3;
  if (sev === 'notable') return 2;
  if (sev === 'info') return 1;
  return 0;
}

function confidenceOf(alert: AlertWithData): number {
  const d = alert.data ?? {};
  const v =
    d['candidate_confidence'] ??
    d['intel_score'] ??
    d['signal_score'] ??
    d['confidence_score'];
  return typeof v === 'number' ? v : 0;
}

function tokenOf(alert: AlertWithData): string {
  const d = alert.data ?? {};
  const v = d['token_mint'];
  return typeof v === 'string' ? v : 'no_token';
}

function familyOf(alert: AlertWithData): string {
  const d = alert.data ?? {};
  const v = d['shadow_family_id'];
  return typeof v === 'string' ? v : 'no_family';
}

function archetypeFamily(alertType: string): string {
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

function doctrineKey(alert: AlertWithData): string {
  return [
    archetypeFamily(alert.alert_type),
    tokenOf(alert),
    familyOf(alert),
  ].join('::');
}

function evidenceLen(alert: AlertWithData): number {
  const d = alert.data ?? {};
  const ev =
    d['candidate_evidence'] ??
    d['evidence'] ??
    d['fog_piercing_notes'];
  return Array.isArray(ev) ? ev.length : 0;
}

function chooseBetter(a: AlertWithData, b: AlertWithData): AlertWithData {
  const aConf = confidenceOf(a);
  const bConf = confidenceOf(b);
  if (aConf !== bConf) return aConf > bConf ? a : b;

  const aSev = severityRank(a.severity);
  const bSev = severityRank(b.severity);
  if (aSev !== bSev) return aSev > bSev ? a : b;

  const aEv = evidenceLen(a);
  const bEv = evidenceLen(b);
  if (aEv !== bEv) return aEv > bEv ? a : b;

  return a;
}

export function unifyPrivacyAlertDoctrine(
  alerts: ReadonlyArray<AlertInsert>,
): AlertInsert[] {
  const out = new Map<string, AlertWithData>();

  for (const raw of alerts as AlertWithData[]) {
    const key = doctrineKey(raw);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, raw);
      continue;
    }
    out.set(key, chooseBetter(prev, raw));
  }

  return [...out.values()];
}
