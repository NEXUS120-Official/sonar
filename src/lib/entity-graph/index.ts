// ============================================================
// SONAR — Entity Graph Layer
// ============================================================
// Internal identity and context resolution for Solana addresses.
// This is SONAR's intelligence moat: address → entity → context,
// built entirely on our own data, with no external API dependency.
//
// Data model (from migration 009):
//   entity_addresses  — maps address → entity_id (many-to-one)
//   entities          — canonical entity records (exchange, protocol, whale, ...)
//   wallet_clusters   — behavioral groups (future: accumulator, staker, ...)
//   wallet_cluster_members — address membership in clusters
//
// Resolution rules:
//   - resolveAddress() returns null for unknown addresses — never fabricates
//   - unknown addresses must be handled explicitly by callers
//   - cluster fields are present in the output shape but null in this first
//     pass (wallet_clusters is not yet populated)
//
// Future: when wallet_clusters is populated, resolveAddress() will begin
// returning cluster_id + cluster_type for addresses that are cluster members.
// No caller changes are required at that point — the field is already in the
// output shape.
//
// Consumer note: if you need a safe "unknown address" profile for display
// purposes, build an adapter at the call site rather than here. The entity
// graph layer is strictly identity resolution — it does not invent context.
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { WalletProfile }      from '@/lib/providers/interfaces';

type Db = ReturnType<typeof createAdminClient>;

// ── Output types ──────────────────────────────────────────────

export interface ResolvedEntity {
  entity_id:      string;
  entity_type:    string;       // 'exchange' | 'protocol' | 'whale' | 'bridge' | 'unknown' | ...
  canonical_name: string | null;
  label:          string | null; // address-specific role from entity_addresses.label
  confidence:     number;        // 0-100; min of entity + address confidence
  verified:       boolean;
  tags:           string[];      // derived from entity_type, label, verified, cluster
  source:         string;        // how this mapping was established
  // Cluster fields — present in shape but null until wallet_clusters is populated
  cluster_id:     string | null;
  cluster_type:   string | null;
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
  entity_type: string,
  label:       string | null,
  verified:    boolean,
  cluster_type: string | null,
): string[] {
  const tags: string[] = [entity_type];
  if (verified) tags.push('verified');
  if (label && label !== entity_type) tags.push(label);
  if (cluster_type) tags.push(`cluster:${cluster_type}`);
  return tags;
}

// ── Core resolution ───────────────────────────────────────────

/**
 * Resolve a Solana address to its entity context.
 *
 * Lookup path:
 *   entity_addresses (address + chain='solana' + is_active=true)
 *   → JOIN entities
 *   → secondary lookup in wallet_cluster_members → wallet_clusters
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

  // Primary lookup: entity_addresses → entities (FK join via PostgREST)
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
    id: string;
    entity_type: string;
    canonical_name: string | null;
    confidence: number;
    verified: boolean;
    source: string | null;
  };

  // Secondary lookup: wallet_cluster_members → wallet_clusters
  // Tables are empty in first pass — this will return null cleanly.
  const { data: clusterData } = await dba
    .from('wallet_cluster_members')
    .select('cluster_id, wallet_clusters ( cluster_type )')
    .eq('address', address)
    .limit(1)
    .maybeSingle();

  const cluster_id   = clusterData?.cluster_id   ?? null;
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

/**
 * Resolve multiple addresses in a single IN query.
 * Returns only found addresses — absent entries are unknown.
 *
 * Note: cluster fields are null in batch results in this first pass.
 * Add a cluster batch lookup here once wallet_cluster_members is populated.
 */
export async function resolveAddressBatch(
  addresses: string[],
  db:        Db,
): Promise<Map<string, ResolvedEntity>> {
  if (addresses.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (db as any)
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
    .in('address', addresses)
    .eq('chain', 'solana')
    .eq('is_active', true);

  if (error || !data) return new Map();

  const result = new Map<string, ResolvedEntity>();

  for (const row of data as Array<{
    address: string;
    label: string | null;
    confidence: number | null;
    source: string | null;
    entities: {
      id: string;
      entity_type: string;
      canonical_name: string | null;
      confidence: number | null;
      verified: boolean | null;
      source: string | null;
    } | null;
  }>) {
    if (!row.entities) continue;
    const ent = row.entities;

    const confidence = Math.min(
      typeof row.confidence === 'number' ? row.confidence : 50,
      typeof ent.confidence  === 'number' ? ent.confidence  : 50,
    );

    result.set(row.address, {
      entity_id:      ent.id,
      entity_type:    ent.entity_type,
      canonical_name: ent.canonical_name,
      label:          row.label ?? null,
      confidence,
      verified:       ent.verified ?? false,
      tags:           deriveTags(ent.entity_type, row.label, ent.verified ?? false, null),
      source:         row.source ?? ent.source ?? 'entity_graph',
      cluster_id:     null,   // TODO: batch cluster lookup once wallet_clusters is populated
      cluster_type:   null,
    });
  }

  return result;
}

// ── WalletProfile adapter ─────────────────────────────────────

/**
 * Converts a ResolvedEntity to the WalletProfile interface shape.
 * Call this after resolveAddress() returns non-null.
 *
 * For unknown addresses (null from resolveAddress), return null at
 * the call site rather than calling this function. Do not invent a
 * synthetic WalletProfile for unresolved addresses.
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
