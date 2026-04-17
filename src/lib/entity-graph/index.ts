// ============================================================
// SONAR — Entity Graph Layer
// ============================================================
// Internal identity and context resolution for Solana addresses.
// SONAR's intelligence moat: address → entity → context, built
// entirely on our own data with no external API dependency.
//
// Data model (from migration 009):
//   entity_addresses      — maps address → entity_id (many-to-one)
//   entities              — canonical entity records
//   wallet_clusters       — behavioral groups (future)
//   wallet_cluster_members — address → cluster membership
//
// Resolution rules:
//   - resolveAddress / resolveAddressBatch return null / absent key
//     for unknown addresses — never fabricate identity
//   - callers must handle null / absent entries explicitly
//   - cluster fields null until wallet_cluster_members is populated
//
// Behavior tags (deriveAddressTags):
//   - purely observational — derived from movement history
//   - do NOT create entity records for unknown addresses
//   - unknown addresses can have behavior context without identity
//   - tags require ≥ minObservations of a type (default 3)
//
// Live integration points:
//   resolveAddressBatch() → helius-webhook persistMovements:
//     supplements from_label/to_label where constants decoder returned null
//   resolveAddressBatch() → helius-webhook fireHotAlerts:
//     entity context in alert body (fallback) + alert data JSONB
//
// Future integration points (not yet wired):
//   - /api/flow/* routes: entity type badges on movement summaries
//   - process-flows anomaly detection: entity-aware signal weighting
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { WalletProfile }      from '@/lib/providers/interfaces';
import { getUnmappedWhaleCount, getUnmappedKnownAddressCount } from './seeding';

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

/**
 * Behavior context derived from observed movement history.
 * Distinct from ResolvedEntity — does not assert identity, only
 * describes what we observed about an address's on-chain behavior.
 * Unknown addresses (absent from entity graph) can still have behavior context.
 */
export interface AddressBehaviorContext {
  address:            string;
  observation_window_h: number;   // how far back we looked (hours)
  tags:               string[];   // e.g. ['accumulator', 'staker']
  movement_counts:    Record<string, number>; // flow_type → count
  total_movements:    number;
  total_volume_usd:   number;
}

/** Entity graph coverage statistics for internal audit. */
export interface EntityCoverageStats {
  total_entities:           number;
  by_entity_type:           Record<string, number>;
  by_source:                Record<string, number>; // entity_addresses rows by source field
  total_addresses:          number;  // total entity_addresses rows
  active_addresses:         number;
  // Quality signals
  unverified_entities:      number;  // entities where verified=false
  low_confidence_mappings:  number;  // entity_addresses where confidence < 70
  // Gap signals — how many rows exist in trusted sources but are not yet mapped
  unmapped_whales:          number;
  unmapped_known_addresses: number;
  // Top from_addresses in recent movements not covered by entity_addresses
  uncovered_hot: Array<{
    address:          string;
    movement_count:   number;
    total_volume_usd: number;
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
 * Returns null for unknown addresses. Never fabricates identity.
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
    id: string; entity_type: string; canonical_name: string | null;
    confidence: number | null; verified: boolean | null; source: string | null;
  } | null;
};

type RawClusterRow = {
  address:         string;
  cluster_id:      string;
  wallet_clusters: { cluster_type: string } | null;
};

/**
 * Resolve multiple addresses in two batch queries (entity + cluster).
 * Returns a Map — absent keys are unknown, not fabricated.
 * Cluster fields populated when wallet_cluster_members has rows; null until then.
 */
export async function resolveAddressBatch(
  addresses: string[],
  db:        Db,
): Promise<Map<string, ResolvedEntity>> {
  const valid = addresses.filter(a => typeof a === 'string' && a.length > 0);
  if (valid.length === 0) return new Map();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [{ data: addrRows, error }, { data: clusterRows }] = await Promise.all([
    dba.from('entity_addresses').select(`
      address, label, confidence, source,
      entities ( id, entity_type, canonical_name, confidence, verified, source )
    `).in('address', valid).eq('chain', 'solana').eq('is_active', true),
    dba.from('wallet_cluster_members')
      .select('address, cluster_id, wallet_clusters ( cluster_type )')
      .in('address', valid),
  ]);

  if (error || !addrRows) return new Map();

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
    const cluster_type = cluster?.cluster_type ?? null;

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
 * Returns null if entity_id does not exist.
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

  return {
    entity_id:      entity.id,
    entity_type:    entity.entity_type,
    canonical_name: entity.canonical_name ?? null,
    description:    entity.description    ?? null,
    confidence:     entity.confidence     ?? 50,
    verified:       entity.verified       ?? false,
    source:         entity.source         ?? null,
    tags:           deriveTags(entity.entity_type, null, entity.verified ?? false, null),
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
 * opts.activeOnly defaults to true.
 */
export async function getAddressesForEntity(
  entityId: string,
  db:       Db,
  opts:     { activeOnly?: boolean } = {},
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
 * For unknown addresses, return null — do not synthesise a profile.
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

// ── Behavior-derived tags ─────────────────────────────────────

const BEHAVIOR_TAG_MIN_OBSERVATIONS = 3; // minimum movements of a type to emit a tag

/**
 * Derive behavioral tags for an address from observed movement history.
 *
 * This does NOT create entity records. Tags describe what we observed —
 * they are not identity assertions. Unknown addresses (absent from entity
 * graph) can have behavior context without being assigned an identity.
 *
 * Tags emitted (each requires ≥ minObservations):
 *   'accumulator'    — exchange_withdrawal count > exchange_deposit * 1.5
 *   'distributor'    — exchange_deposit count > exchange_withdrawal * 1.5
 *   'staker'         — stake movements ≥ minObservations
 *   'defi_active'    — defi_deposit movements ≥ minObservations
 *   'high_frequency' — total movements ≥ 20 in window
 */
export async function deriveAddressTags(
  address:  string,
  db:       Db,
  opts:     { windowHours?: number; minObservations?: number } = {},
): Promise<AddressBehaviorContext> {
  const windowHours    = opts.windowHours    ?? 168;
  const minObservations = opts.minObservations ?? BEHAVIOR_TAG_MIN_OBSERVATIONS;
  const cutoff         = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const { data: movRows } = await (db as any)
    .from('movements')
    .select('flow_type, amount_usd')
    .or(`from_address.eq.${address},to_address.eq.${address}`)
    .gte('block_time', cutoff)
    .order('block_time', { ascending: false })
    .limit(500);

  const rows = (movRows ?? []) as Array<{ flow_type: string; amount_usd: number | null }>;

  const counts: Record<string, number> = {};
  let totalVolume = 0;
  for (const r of rows) {
    counts[r.flow_type] = (counts[r.flow_type] ?? 0) + 1;
    totalVolume += r.amount_usd ?? 0;
  }

  const tags: string[] = [];

  const deposits    = counts['exchange_deposit']    ?? 0;
  const withdrawals = counts['exchange_withdrawal'] ?? 0;
  const stakes      = counts['stake']               ?? 0;
  const defiDeposits = counts['defi_deposit']       ?? 0;

  if (withdrawals >= minObservations && withdrawals > deposits * 1.5) tags.push('accumulator');
  if (deposits    >= minObservations && deposits > withdrawals * 1.5)  tags.push('distributor');
  if (stakes      >= minObservations)                                   tags.push('staker');
  if (defiDeposits >= minObservations)                                  tags.push('defi_active');
  if (rows.length >= 20)                                                tags.push('high_frequency');

  return {
    address,
    observation_window_h: windowHours,
    tags,
    movement_counts:  counts,
    total_movements:  rows.length,
    total_volume_usd: Math.round(totalVolume),
  };
}

// ── Coverage audit ────────────────────────────────────────────

/**
 * Entity graph coverage statistics for internal audit.
 *
 * uncovered_hot: top from_addresses in recent movements not in entity_addresses.
 * Useful for identifying high-activity addresses that should be seeded.
 * Uses a JS-side aggregation of sampled movements (no GROUP BY migration needed).
 */
export async function getEntityCoverage(
  db:   Db,
  opts: { topUncoveredN?: number; movementSampleSize?: number } = {},
): Promise<EntityCoverageStats> {
  const topN        = opts.topUncoveredN      ?? 20;
  const sampleSize  = opts.movementSampleSize ?? 5_000;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [
    { data: entityRows },
    { data: addrCountRows },
    { data: activeAddrRows },
    { data: recentMovs },
    { data: unverifiedRows },
    { data: sourceRows },
    { data: lowConfRows },
    unmapped_whales,
    unmapped_known_addresses,
  ] = await Promise.all([
    dba.from('entities').select('entity_type'),
    dba.from('entity_addresses').select('id', { count: 'exact', head: true }),
    dba.from('entity_addresses').select('id', { count: 'exact', head: true }).eq('is_active', true),
    dba.from('movements')
      .select('from_address, amount_usd')
      .not('from_address', 'is', null)
      .order('block_time', { ascending: false })
      .limit(sampleSize),
    // Quality: unverified entities
    dba.from('entities').select('id', { count: 'exact', head: true }).eq('verified', false),
    // Quality: entity_addresses by source (for by_source breakdown)
    dba.from('entity_addresses').select('source'),
    // Quality: low-confidence address mappings
    dba.from('entity_addresses').select('id', { count: 'exact', head: true }).lt('confidence', 70),
    // Gap: unmapped whales + known_addresses (uses seeding.ts helpers)
    getUnmappedWhaleCount(db),
    getUnmappedKnownAddressCount(db),
  ]);

  // Count entities by type
  const by_entity_type: Record<string, number> = {};
  for (const row of (entityRows ?? []) as Array<{ entity_type: string }>) {
    by_entity_type[row.entity_type] = (by_entity_type[row.entity_type] ?? 0) + 1;
  }

  // Count entity_addresses by source
  const by_source: Record<string, number> = {};
  for (const row of (sourceRows ?? []) as Array<{ source: string | null }>) {
    const src = row.source ?? 'unknown';
    by_source[src] = (by_source[src] ?? 0) + 1;
  }

  // Group movements by from_address in JS
  const addrStats = new Map<string, { count: number; volume: number }>();
  for (const m of (recentMovs ?? []) as Array<{ from_address: string | null; amount_usd: number | null }>) {
    const addr = m.from_address;
    if (!addr) continue;
    const s = addrStats.get(addr) ?? { count: 0, volume: 0 };
    s.count++;
    s.volume += m.amount_usd ?? 0;
    addrStats.set(addr, s);
  }

  // Top from_addresses by movement count
  const topAddrs = [...addrStats.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN * 3)  // over-fetch to account for covered ones
    .map(([addr]) => addr);

  // Check which are covered in entity_addresses
  const { data: coveredRows } = topAddrs.length > 0
    ? await dba.from('entity_addresses').select('address').in('address', topAddrs)
    : { data: [] };

  const coveredSet = new Set(
    ((coveredRows ?? []) as Array<{ address: string }>).map(r => r.address),
  );

  const uncovered_hot = [...addrStats.entries()]
    .filter(([addr]) => !coveredSet.has(addr))
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, topN)
    .map(([address, s]) => ({
      address,
      movement_count:   s.count,
      total_volume_usd: Math.round(s.volume),
    }));

  return {
    total_entities:           entityRows?.length ?? 0,
    by_entity_type,
    by_source,
    total_addresses:          (addrCountRows as any)?.count ?? 0,
    active_addresses:         (activeAddrRows as any)?.count ?? 0,
    unverified_entities:      (unverifiedRows as any)?.count ?? 0,
    low_confidence_mappings:  (lowConfRows as any)?.count ?? 0,
    unmapped_whales,
    unmapped_known_addresses,
    uncovered_hot,
  };
}
