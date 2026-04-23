// ============================================================
// SONAR — Privacy Sequence Alert Consolidation
// ============================================================
// Pure consolidation / de-dup layer for promoted privacy sequence alerts.
// Keeps only the strongest alert per semantic group inside a batch.
// Deterministic, replay-safe, source-agnostic.
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

function toGroupKey(alert: AlertWithData): string {
  const d = alert.data ?? {};
  const token = typeof d['token_mint'] === 'string' ? d['token_mint'] : 'no_token';
  const fam   = typeof d['shadow_family_id'] === 'string' ? d['shadow_family_id'] : 'no_family';
  return [alert.alert_type, token, fam].join('::');
}

function confidenceOf(alert: AlertWithData): number {
  const d = alert.data ?? {};
  const v = d['candidate_confidence'];
  return typeof v === 'number' ? v : 0;
}

function elapsedOf(alert: AlertWithData): number {
  const d = alert.data ?? {};
  const v = d['elapsed_seconds'];
  return typeof v === 'number' ? v : Number.MAX_SAFE_INTEGER;
}

function evidenceLen(alert: AlertWithData): number {
  const d = alert.data ?? {};
  const ev = d['candidate_evidence'];
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

  const aElapsed = elapsedOf(a);
  const bElapsed = elapsedOf(b);
  if (aElapsed !== bElapsed) return aElapsed < bElapsed ? a : b;

  return a;
}

export function consolidatePrivacySequencePromotedAlerts(
  alerts: ReadonlyArray<AlertInsert>,
): AlertInsert[] {
  const grouped = new Map<string, AlertWithData>();

  for (const raw of alerts as AlertWithData[]) {
    const key = toGroupKey(raw);
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, raw);
      continue;
    }
    grouped.set(key, chooseBetter(prev, raw));
  }

  return [...grouped.values()];
}
