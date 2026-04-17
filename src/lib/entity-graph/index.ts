// ============================================================
// SONAR — Entity Graph Layer
// ============================================================
// Internal identity and context resolution for Solana addresses.
// This is SONAR's intelligence moat: address → entity → context,
// built entirely on our own data, with no external API dependency.
//
// Data model (from migration 009):
//   entity_addresses      — maps address → entity_id (many-to-one)
//   entities              — canonical entity records
//   wallet_clusters       — behavioral groups (future: accumulator, staker, ...)
//   wallet_cluster_members — address → cluster membership
//
// Resolution rules:
//   - resolveAddress() / resolveAddressBatch() return null / absent key
//     for unknown addresses — never fabricate identity
//   - callers must handle null / missing entries explicitly
//   - cluster fields are in the output shape; null when tables are empty
//
// Integration note:
//   resolveAddressBatch() is wired into HeliusWebhookProcessor.persistMovements()
//   to supplement from_label/to_label for addresses not covered by the
//   in-memory constants cache (whale addresses, custom entities).
//   It supplements null labels only — never overrides existing ones.
//
// Future integration points (not yet wired):
//   - fireHotAlerts: entity context in alert title/body
//   - /api/flow/* routes: entity type badges on movement summaries
//   - process-flows anomaly detection: entity-aware signal weighting
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { WalletProfile }      from '@/lib/providers/interfaces';

type Db = ReturnType<typeof createAdminClient>;

// ── Output types ──────────────────────────────────────────────

export interface ResolvedEntity {
  entity_id:      string;
  entity_type:    string;        // 'exchange' | 'protocol' | 'whale' | 'bridge' | 'unknown' | ...
  canonical_name: string | null;
  label:          string | null; // address-specific role from entity_addresses.label
  confidence:     number;        // 0-100; min of entity + address confidence
  verified:       boolean;
  tags:           string[];      // derived from entity_type, label, verified, cluster
  source:         string;        // how this mapping was established
  // Cluster fields — present in shape; null until wallet_clusters is populated
  cluster_id:     string | null;
  cluster_type:   string | null;
}

/** Full entity record with all its mapped addresses. */
export interface EntityWithAddresses {
  entity_id:      string;
  entity_type:    string;
  canonical_name: string | null;
  description:    string | null;
  confidence:     number;
  verified:       boolean;
  source:         string | null;
  tags:           string[];
  addresses: Array<{
    address:    string;
    label:      string | null;
    confidence: number;
    is_active:  boolean;
  }>;
}

// ── Helpers ───────────────────────────────────────────────────

const VALID_WALLET_PROFILE_TYPES = [
  'exchange', 'protocol', 'whale', 'market_maker', 'bridge', 'unknown',
] as const;

type WalletProfileEntityType = typeof VALID_WALLET_PROFILE_TYPES[number];

function safeEntityType(raw: string): WalletProfileEntityType {
  return (VALID_WALLET_PROFILE_TYPES as readonly string[]).includes(raw)
    ? raw as WalletProfileEntityType
    : 'unknown';
}

function deriveTags(
  entity_type:  string,
  label:        string | null,
  verified:     boolean,
  cluster_type: string | null,
): string[] {
  const tags: string[] = [entity_type];
  if (verified) tags.push('verified');
  if (label && label !== entity_type) tags.push(label);
  if (cluster_type) tags.push(`cluster:${cluster_type}`);
  return tags;
}

// ── Single-address resolution ─────────────────────────────────

/**
 * Resolve a Solana address to its entity context.
 *
 * Lookup path:
 *   entity_addresses (address + chain='solana' + is_active=true) → JOIN entities
 *   → secondary: wallet_cluster_members → wallet_clusters
 *
 * Returns null for any address not in the entity graph.
 * Never fabricates identity — null means unknown.
 */
export async function resolveAddress(
  address: string,
  db:      Db,
): Promise<ResolvedEntity | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const { data, error } = await dba
    .from('entity_addresses')
    .select(`
      label,
      confidence,
      source,
      entities (
        id,
        entity_type,
        canonical_name,
        confidence,
        verified,
        source
      )
    `)
    .eq('address', address)
    .eq('chain', 'solana')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.entities) return null;

  const ent = data.entities as {
    id: string; entity_type: string; canonical_name: string | null;
    confidence: number; verified: boolean; source: string | null;
  };

  // Cluster lookup (empty tables → null cleanly)
  const { data: clusterData } = await dba
    .from('wallet_cluster_members')
    .select('cluster_id, wallet_clusters ( cluster_type )')
    .eq('address', address)
    .limit(1)
    .maybeSingle();

  const cluster_id   = clusterData?.cluster_id ?? null;
  const cluster_type = (clusterData?.wallet_clusters as { cluster_type?: string } | null)?.cluster_type ?? null;

  const confidence = Math.min(
    typeof data.confidence === 'number' ? data.confidence : 50,
    typeof ent.confidence  === 'number' ? ent.confidence  : 50,
  );

  return {
    entity_id:      ent.id,
    entity_type:    ent.entity_type,
    canonical_name: ent.canonical_name,
    label:          data.label ?? null,
    confidence,
    verified:       ent.verified ?? false,
    tags:           deriveTags(ent.entity_type, data.label, ent.verified ?? false, cluster_type),
    source:         data.source ?? ent.source ?? 'entity_graph',
    cluster_id,
    cluster_type,
  };
}

// ── Batch resolution ──────────────────────────────────────────

type RawAddressRow = {
  address:    string;
  label:      string | null;
  confidence: number | null;
  source:     string | null;
  entities: {
    id: string;
    entity_type: string;
    canonical_name: string | null;
    confidence: number | null;
    verified: boolean | null;
    source: string | null;
  } | null;
};

type RawClusterRow = {
  address:         string;
  cluster_id:      string;
  wallet_clusters: { cluster_type: string } | null;
};

/**
 * Resolve multiple addresses in two batch queries (entity + cluster).
 * Returns a Map containing only found addresses — absent keys are unknown.
 * Never fabricates identity for missing entries.
 *
 * Cluster fields are populated when wallet_cluster_members is populated.
 * Until then they are null — no caller change required when clusters arrive.
 */
export async function resolveAddressBatch(
  addresses: string[],
  db:        Db,
): Promise<Map<string, ResolvedEntity>> {
  const validAddresses = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (validAddresses.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // Query 1: entity_addresses → entities
  const { data: addrRows, error } = await dba
    .from('entity_addresses')
    .select(`
      address,
      label,
      confidence,
      source,
      entities (
        id,
        entity_type,
        canonical_name,
        confidence,
        verified,
        source
      )
    `)
    .in('address', validAddresses)
    .eq('chain', 'solana')
    .eq('is_active', true);

  if (error || !addrRows) return new Map();

  // Query 2: cluster membership (single IN query — empty tables return [])
  const { data: clusterRows } = await dba
    .from('wallet_cluster_members')
    .select('address, cluster_id, wallet_clusters ( cluster_type )')
    .in('address', validAddresses);

  const clusterMap = new Map<string, { cluster_id: string; cluster_type: string | null }>();
  for (const row of (clusterRows ?? []) as RawClusterRow[]) {
    clusterMap.set(row.address, {
      cluster_id:   row.cluster_id,
      cluster_type: row.wallet_clusters?.cluster_type ?? null,
    });
  }

  const result = new Map<string, ResolvedEntity>();

  for (const row of addrRows as RawAddressRow[]) {
    if (!row.entities) continue;
    const ent     = row.entities;
    const cluster = clusterMap.get(row.address) ?? null;

    const confidence = Math.min(
      typeof row.confidence === 'number' ? row.confidence : 50,
      typeof ent.confidence  === 'number' ? ent.confidence  : 50,
    );

    const cluster_type = cluster?.cluster_type ?? null;

    result.set(row.address, {
      entity_id:      ent.id,
      entity_type:    ent.entity_type,
      canonical_name: ent.canonical_name,
      label:          row.label ?? null,
      confidence,
      verified:       ent.verified ?? false,
      tags:           deriveTags(ent.entity_type, row.label, ent.verified ?? false, cluster_type),
      source:         row.source ?? ent.source ?? 'entity_graph',
      cluster_id:     cluster?.cluster_id ?? null,
      cluster_type,
    });
  }

  return result;
}

// ── Entity-first lookups ──────────────────────────────────────

/**
 * Load a full entity record with all its mapped addresses.
 * Useful for building exchange/protocol summaries and entity admin views.
 * Returns null if the entity_id does not exist.
 */
export async function getEntityById(
  entityId: string,
  db:       Db,
): Promise<EntityWithAddresses | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [{ data: entity, error }, { data: addrRows }] = await Promise.all([
    dba.from('entities').select('id, entity_type, canonical_name, description, confidence, verified, source').eq('id', entityId).maybeSingle(),
    dba.from('entity_addresses').select('address, label, confidence, is_active').eq('entity_id', entityId).order('is_active', { ascending: false }),
  ]);

  if (error || !entity) return null;

  const tags = deriveTags(entity.entity_type, null, entity.verified ?? false, null);

  return {
    entity_id:      entity.id,
    entity_type:    entity.entity_type,
    canonical_name: entity.canonical_name ?? null,
    description:    entity.description    ?? null,
    confidence:     entity.confidence     ?? 50,
    verified:       entity.verified       ?? false,
    source:         entity.source         ?? null,
    tags,
    addresses: ((addrRows ?? []) as Array<{
      address: string; label: string | null; confidence: number | null; is_active: boolean;
    }>).map(r => ({
      address:    r.address,
      label:      r.label ?? null,
      confidence: r.confidence ?? 50,
      is_active:  r.is_active,
    })),
  };
}

/**
 * Get all addresses mapped to an entity.
 * opts.activeOnly defaults to true — pass false to include inactive addresses.
 */
export async function getAddressesForEntity(
  entityId:  string,
  db:        Db,
  opts:      { activeOnly?: boolean } = {},
): Promise<Array<{ address: string; label: string | null; confidence: number; is_active: boolean }>> {
  const activeOnly = opts.activeOnly ?? true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = (db as any)
    .from('entity_addresses')
    .select('address, label, confidence, is_active')
    .eq('entity_id', entityId)
    .eq('chain', 'solana')
    .order('is_active', { ascending: false });

  if (activeOnly) q = q.eq('is_active', true);

  const { data } = await q;

  return ((data ?? []) as Array<{
    address: string; label: string | null; confidence: number | null; is_active: boolean;
  }>).map(r => ({
    address:    r.address,
    label:      r.label ?? null,
    confidence: r.confidence ?? 50,
    is_active:  r.is_active,
  }));
}

// ── WalletProfile adapter ─────────────────────────────────────

/**
 * Converts a ResolvedEntity to the WalletProfile interface shape.
 * Only call after resolveAddress() returns non-null.
 *
 * For unknown addresses (null from resolveAddress), return null at
 * the call site. Do not synthesise a WalletProfile for unknown addresses —
 * build a display-layer adapter at the call site if needed.
 */
export function toWalletProfile(
  address: string,
  entity:  ResolvedEntity,
): WalletProfile {
  return {
    address,
    entity_type:      safeEntityType(entity.entity_type),
    label:            entity.label ?? entity.canonical_name,
    tags:             entity.tags,
    discovery_source: entity.source,
  };
}
