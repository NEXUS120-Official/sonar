// ============================================================
// SONAR — Privacy Sequence Alert Promotion
// ============================================================
// Promotes high-signal privacy sequence candidates into alert rows.
// Deterministic, replay-safe, additive.
// ============================================================

import type { AlertInsert } from '@/lib/flow-engine/anomaly-detector';
import type { PrivacySequenceAlertCandidateRow, AlertType, AlertSeverity } from '@/lib/supabase/types';

function mapPriorityToSeverity(priority: string): AlertSeverity {
  if (priority === 'critical') return 'major';
  if (priority === 'high') return 'significant';
  if (priority === 'medium') return 'notable';
  return 'info';
}

function mapCandidateTypeToAlertType(candidateType: string): AlertType | null {
  if (candidateType === 'bridgehead_to_reemergence') {
    return 'privacy_sequence_bridgehead_reemergence';
  }
  if (
    candidateType === 'reemergence_to_downstream' ||
    candidateType === 'staging_to_public_reemergence'
  ) {
    return 'privacy_sequence_downstream_continuation';
  }
  if (candidateType === 'family_reemergence') {
    return 'privacy_sequence_family_reemergence';
  }
  return null;
}

function titleFor(row: PrivacySequenceAlertCandidateRow): string {
  const token = row.token_symbol ?? (row.token_mint ? row.token_mint.slice(0, 8) + '…' : 'unknown token');

  if (row.candidate_type === 'bridgehead_to_reemergence') {
    return `Privacy Sequence: Bridgehead → Re-Emergence (${token})`;
  }
  if (row.candidate_type === 'reemergence_to_downstream') {
    return `Privacy Sequence: Re-Emergence → Downstream (${token})`;
  }
  if (row.candidate_type === 'staging_to_public_reemergence') {
    return `Privacy Sequence: Staging → Public Re-Emergence (${token})`;
  }
  if (row.candidate_type === 'family_reemergence') {
    return `Privacy Sequence: Family Re-Emergence (${token})`;
  }
  return `Privacy Sequence Candidate (${token})`;
}

function bodyFor(row: PrivacySequenceAlertCandidateRow): string {
  const parts: string[] = [];

  parts.push(`${row.start_stage} → ${row.end_stage}`);
  parts.push(`confidence=${row.candidate_confidence}`);
  if (row.shadow_family_id) parts.push(`family=${row.shadow_family_id}`);
  if (typeof row.elapsed_seconds === 'number') parts.push(`elapsed=${row.elapsed_seconds}s`);
  if (row.candidate_reason) parts.push(row.candidate_reason);

  return parts.join(' | ');
}

export function promotePrivacySequenceCandidatesToAlerts(
  rows: ReadonlyArray<PrivacySequenceAlertCandidateRow>,
  minConfidence: number = 70,
): AlertInsert[] {
  const out: AlertInsert[] = [];

  for (const row of rows) {
    if (row.candidate_confidence < minConfidence) continue;

    const alertType = mapCandidateTypeToAlertType(row.candidate_type);
    if (!alertType) continue;

    out.push({
      alert_type: alertType,
      severity: mapPriorityToSeverity(row.candidate_priority),
      title: titleFor(row),
      body: bodyFor(row),
      ai_analysis: null,
      data: {
        candidate_id: row.candidate_id,
        sequence_id: row.sequence_id,
        candidate_type: row.candidate_type,
        candidate_priority: row.candidate_priority,
        candidate_confidence: row.candidate_confidence,
        start_stage: row.start_stage,
        end_stage: row.end_stage,
        stage_path: row.stage_path,
        token_mint: row.token_mint,
        token_symbol: row.token_symbol,
        shadow_family_id: row.shadow_family_id,
        elapsed_seconds: row.elapsed_seconds,
        candidate_reason: row.candidate_reason,
        candidate_evidence: row.candidate_evidence,
        methodology_version: row.methodology_version,
      },
      movement_ids: [],
      sent_telegram_free: false,
      sent_telegram_premium: false,
      sent_at: null,
    });
  }

  return out;
}
