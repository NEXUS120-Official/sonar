// ============================================================
// SONAR — Privacy Alert Cooldown Policy
// ============================================================
// Deterministic cooldown windows by privacy alert family.
// Keeps suppression policy explicit, replayable, and easy to tune.
// ============================================================

export type PrivacyAlertFamily =
  | 'reemergence'
  | 'downstream'
  | 'family_reemergence'
  | string;

export interface PrivacyAlertCooldownPolicy {
  family: PrivacyAlertFamily;
  cooldown_hours: number;
  methodology_version: string;
}

const DEFAULT_POLICY_VERSION = 'privacy_alert_cooldown_v1';

const POLICY: Record<string, PrivacyAlertCooldownPolicy> = {
  reemergence: {
    family: 'reemergence',
    cooldown_hours: 6,
    methodology_version: DEFAULT_POLICY_VERSION,
  },
  downstream: {
    family: 'downstream',
    cooldown_hours: 3,
    methodology_version: DEFAULT_POLICY_VERSION,
  },
  family_reemergence: {
    family: 'family_reemergence',
    cooldown_hours: 12,
    methodology_version: DEFAULT_POLICY_VERSION,
  },
};

export function getPrivacyAlertCooldownPolicy(
  family: PrivacyAlertFamily,
): PrivacyAlertCooldownPolicy {
  return POLICY[family] ?? {
    family,
    cooldown_hours: 4,
    methodology_version: DEFAULT_POLICY_VERSION,
  };
}
