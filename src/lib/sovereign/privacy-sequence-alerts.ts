// ============================================================
// SONAR — Privacy Sequence Alert Candidate Engine
// ============================================================
// Internal candidate derivation for sequence-aware alerting.
// Deterministic, replay-safe, additive.
// This does NOT emit user-facing alerts yet.
// ============================================================


export interface PrivacySequenceAlertCandidateSource {
  sequence_id:         string;
  start_event_id:      string;
  end_event_id:        string;

  token_mint:          string | null;
  token_symbol:        string | null;
  shadow_family_id:    string | null;

  start_stage:         string;
  end_stage:           string;
  stage_path:          string[];

  sequence_confidence: number;
  elapsed_seconds:     number | null;
  sequence_reason:     string | null;
  end_event_time:      string;
  methodology_version: string;
}

export interface PrivacySequenceAlertCandidateInsert {
  candidate_id:         string;
  sequence_id:          string;
  start_event_id:       string;
  end_event_id:         string;

  token_mint:           string | null;
  token_symbol:         string | null;
  shadow_family_id:     string | null;

  start_stage:          string;
  end_stage:            string;
  stage_path:           string[];

  candidate_type:       string;
  candidate_priority:   'critical' | 'high' | 'medium' | 'low';
  candidate_confidence: number;
  candidate_reason:     string | null;
  candidate_evidence:   string[];

  elapsed_seconds:      number | null;
  end_event_time:       string;
  methodology_version:  string;
}

function makeCandidateId(seq: PrivacySequenceAlertCandidateSource, candidateType: string): string {
  return `${seq.sequence_id}::${candidateType}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function derivePrivacySequenceAlertCandidates(
  sequences: ReadonlyArray<PrivacySequenceAlertCandidateSource>,
): PrivacySequenceAlertCandidateInsert[] {
  const out: PrivacySequenceAlertCandidateInsert[] = [];

  for (const seq of sequences) {
    let candidateType: string | null = null;
    let priority: PrivacySequenceAlertCandidateInsert['candidate_priority'] = 'medium';
    let reason: string | null = null;
    const evidence: string[] = [];

    if (
      seq.start_stage === 'bridgehead_birth' &&
      seq.end_stage === 'public_reemergence'
    ) {
      candidateType = 'bridgehead_to_reemergence';
      priority = 'high';
      reason = 'privacy bridgehead progressed into visible public re-emergence';
      evidence.push('bridgehead birth followed by public re-emergence');
    } else if (
      seq.start_stage === 'public_reemergence' &&
      seq.end_stage === 'downstream_after_reemergence'
    ) {
      candidateType = 'reemergence_to_downstream';
      priority = 'medium';
      reason = 'public re-emergence continued into downstream visible flow';
      evidence.push('re-emergence followed by downstream continuation');
    } else if (
      seq.end_stage === 'family_privacy_reemergence'
    ) {
      candidateType = 'family_reemergence';
      priority = 'high';
      reason = 'family-level privacy re-emergence became operationally visible';
      evidence.push('family-linked privacy re-emergence detected');
    } else if (
      seq.start_stage === 'privacy_staging' &&
      seq.end_stage === 'public_reemergence'
    ) {
      candidateType = 'staging_to_public_reemergence';
      priority = 'high';
      reason = 'extension-sensitive privacy staging transitioned into public re-emergence';
      evidence.push('privacy staging preceded public-side return');
    }

    if (!candidateType) continue;

    if (seq.shadow_family_id) {
      evidence.push('shadow family context present');
    }
    if (seq.token_symbol) {
      evidence.push(`token=${seq.token_symbol}`);
    }
    if (typeof seq.elapsed_seconds === 'number') {
      evidence.push(`elapsed_seconds=${seq.elapsed_seconds}`);
    }

    const confidenceBase = seq.sequence_confidence;
    const confidenceBonus =
      candidateType === 'family_reemergence' ? 10 :
      candidateType === 'bridgehead_to_reemergence' ? 8 :
      candidateType === 'staging_to_public_reemergence' ? 8 :
      5;

    const candidateConfidence = clamp(confidenceBase + confidenceBonus, 0, 100);

    out.push({
      candidate_id:         makeCandidateId(seq, candidateType),
      sequence_id:          seq.sequence_id,
      start_event_id:       seq.start_event_id,
      end_event_id:         seq.end_event_id,

      token_mint:           seq.token_mint,
      token_symbol:         seq.token_symbol,
      shadow_family_id:     seq.shadow_family_id,

      start_stage:          seq.start_stage,
      end_stage:            seq.end_stage,
      stage_path:           seq.stage_path,

      candidate_type:       candidateType,
      candidate_priority:   priority,
      candidate_confidence: candidateConfidence,
      candidate_reason:     reason,
      candidate_evidence:   evidence,

      elapsed_seconds:      seq.elapsed_seconds,
      end_event_time:       seq.end_event_time,
      methodology_version:  'privacy_sequence_alert_candidates_v1',
    });
  }

  return out;
}
