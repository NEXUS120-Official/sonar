import type { PrivacyLifecycleEventInsert } from './persistence-manager';

export interface PrivacyLifecycleSequenceInsert {
  sequence_id:          string;
  start_event_id:       string;
  end_event_id:         string;

  start_signature:      string;
  end_signature:        string;

  token_mint:           string | null;
  token_symbol:         string | null;
  shadow_family_id:     string | null;

  start_stage:          string;
  end_stage:            string;
  stage_path:           string[];

  sequence_confidence:  number;
  elapsed_seconds:      number | null;
  sequence_reason:      string | null;

  start_event_time:     string;
  end_event_time:       string;

  methodology_version:  string;
}

const METHOD_VERSION = 'privacy_sequence_engine_v1';

const NEXT_STAGE_MAP: Record<string, string[]> = {
  bridgehead_birth: ['privacy_active', 'public_reemergence', 'downstream_after_reemergence'],
  privacy_staging: ['privacy_active', 'public_reemergence', 'downstream_after_reemergence'],
  privacy_active: ['public_reemergence', 'downstream_after_reemergence', 'family_privacy_reemergence'],
  public_reemergence: ['downstream_after_reemergence'],
  family_privacy_reemergence: ['downstream_after_reemergence'],
};

function toTsMs(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function makeSequenceId(
  a: PrivacyLifecycleEventInsert,
  b: PrivacyLifecycleEventInsert,
): string {
  return [
    a.event_id,
    b.event_id,
    a.privacy_lifecycle_stage,
    b.privacy_lifecycle_stage,
  ].join('::');
}

function sameContext(
  a: PrivacyLifecycleEventInsert,
  b: PrivacyLifecycleEventInsert,
): boolean {
  if (a.token_mint && b.token_mint && a.token_mint === b.token_mint) return true;
  if (a.shadow_family_id && b.shadow_family_id && a.shadow_family_id === b.shadow_family_id) return true;
  if (
    a.shadow_source_exchange &&
    b.shadow_source_exchange &&
    a.shadow_source_exchange === b.shadow_source_exchange &&
    a.token_symbol &&
    b.token_symbol &&
    a.token_symbol === b.token_symbol
  ) return true;

  return false;
}

function isForwardProgression(
  a: PrivacyLifecycleEventInsert,
  b: PrivacyLifecycleEventInsert,
): boolean {
  const allowedNext = NEXT_STAGE_MAP[a.privacy_lifecycle_stage] ?? [];
  return allowedNext.includes(b.privacy_lifecycle_stage);
}

function deriveSequenceReason(
  a: PrivacyLifecycleEventInsert,
  b: PrivacyLifecycleEventInsert,
): string {
  return [
    `privacy lifecycle progressed from ${a.privacy_lifecycle_stage} to ${b.privacy_lifecycle_stage}`,
    a.token_symbol ? `token=${a.token_symbol}` : null,
    a.shadow_family_id ? `family=${a.shadow_family_id}` : null,
    a.shadow_source_exchange ? `exchange=${a.shadow_source_exchange}` : null,
  ].filter(Boolean).join('; ');
}

function deriveSequenceConfidence(
  a: PrivacyLifecycleEventInsert,
  b: PrivacyLifecycleEventInsert,
  elapsedSeconds: number | null,
): number {
  let score = Math.round((a.event_confidence + b.event_confidence) / 2);

  if (a.shadow_family_id && b.shadow_family_id && a.shadow_family_id === b.shadow_family_id) score += 10;
  if (a.token_mint && b.token_mint && a.token_mint === b.token_mint) score += 10;
  if (b.is_public_side) score += 5;

  if (elapsedSeconds !== null) {
    if (elapsedSeconds <= 3_600) score += 10;
    else if (elapsedSeconds <= 86_400) score += 5;
    else if (elapsedSeconds > 7 * 86_400) score -= 10;
  }

  return Math.max(0, Math.min(100, score));
}

export function derivePrivacyLifecycleSequencesFromEvents(
  events: ReadonlyArray<PrivacyLifecycleEventInsert>,
): PrivacyLifecycleSequenceInsert[] {
  if (events.length < 2) return [];

  const sorted = [...events].sort((a, b) => toTsMs(a.event_time) - toTsMs(b.event_time));
  const out: PrivacyLifecycleSequenceInsert[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    if (start.privacy_lifecycle_stage === 'none') continue;

    for (let j = i + 1; j < sorted.length; j++) {
      const end = sorted[j];
      if (end.privacy_lifecycle_stage === 'none') continue;

      if (!sameContext(start, end)) continue;
      if (!isForwardProgression(start, end)) continue;

      const elapsed = Math.max(0, Math.floor((toTsMs(end.event_time) - toTsMs(start.event_time)) / 1000));
      const sequenceId = makeSequenceId(start, end);
      if (seen.has(sequenceId)) continue;
      seen.add(sequenceId);

      out.push({
        sequence_id:         sequenceId,
        start_event_id:      start.event_id,
        end_event_id:        end.event_id,
        start_signature:     start.signature,
        end_signature:       end.signature,
        token_mint:          end.token_mint ?? start.token_mint,
        token_symbol:        end.token_symbol ?? start.token_symbol,
        shadow_family_id:    end.shadow_family_id ?? start.shadow_family_id,
        start_stage:         start.privacy_lifecycle_stage,
        end_stage:           end.privacy_lifecycle_stage,
        stage_path:          [start.privacy_lifecycle_stage, end.privacy_lifecycle_stage],
        sequence_confidence: deriveSequenceConfidence(start, end, elapsed),
        elapsed_seconds:     elapsed,
        sequence_reason:     deriveSequenceReason(start, end),
        start_event_time:    start.event_time,
        end_event_time:      end.event_time,
        methodology_version: METHOD_VERSION,
      });

      break;
    }
  }

  return out;
}
