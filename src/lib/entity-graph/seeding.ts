// ============================================================
// SONAR — Entity Graph Seeding Helpers
// ============================================================
// Canonical, reusable helpers for seeding entities +
// entity_addresses from trusted internal sources.
//
// Trusted sources (in priority order):
//   known_addresses — manually curated; confidence=90, verified=true
//   whales          — programmatic discovery; confidence=70, verified=false
//
// Safety rules:
//   - never fabricate identity
//   - unknown addresses remain unknown (no inference)
//   - all inserts are idempotent: SELECT before INSERT for entities,
//     UPSERT ON CONFLICT (address, chain) for entity_addresses
//   - provenance/source recorded on every row
//
// Whale canonical_name strategy:
//   whale.label when present (operator-assigned or GMGN-derived)
//   fallback: "whale_<first8>" — deterministic, address-anchored,
//   does NOT imply verification or a real-world identity
// ============================================================

import type { createAdminClient } from '@/lib/supabase/server';
import type { KnownAddressRow } from '@/lib/supabase/types';

type Db = ReturnType<typeof createAdminClient>;

// ── upsertEntityWithAddress ───────────────────────────────────

export interface UpsertEntityPayload {
  entity_type:    string;
  canonical_name: string;
  description?:   string | null;
  confidence:     number;
  verified:       boolean;
  source:         string;
  address:        string;
  chain:          string;
  label:          string | null;
}

export interface UpsertEntityResult {
  entity_id:       string;
  entity_created:  boolean;
  address_created: boolean;
}

/**
 * Find-or-create an entity by (canonical_name, entity_type), then
 * upsert its address on (address, chain) conflict.
 *
 * Entity lookup key: canonical_name + entity_type.
 * Address conflict resolution: update label and source (never silent-ignore).
 * Never creates duplicate entities or duplicate address rows.
 */
export async function upsertEntityWithAddress(
  db:      Db,
  payload: UpsertEntityPayload,
): Promise<UpsertEntityResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // ── 1. Find or create entity ──────────────────────────────────
  let entityId: string;
  let entity_created = false;

  const { data: existing } = await dba
    .from('entities')
    .select('id')
    .eq('canonical_name', payload.canonical_name)
    .eq('entity_type', payload.entity_type)
    .maybeSingle();

  if (existing?.id) {
    entityId = existing.id as string;
  } else {
    const { data: inserted, error: insertErr } = await dba
      .from('entities')
      .insert({
        entity_type:    payload.entity_type,
        canonical_name: payload.canonical_name,
        description:    payload.description ?? null,
        confidence:     payload.confidence,
        verified:       payload.verified,
        source:         payload.source,
      })
      .select('id')
      .single();

    if (insertErr || !inserted?.id) {
      throw new Error(`Entity insert failed for "${payload.canonical_name}": ${insertErr?.message ?? 'no id returned'}`);
    }

    entityId = inserted.id as string;
    entity_created = true;
  }

  // ── 2. Upsert entity_address ──────────────────────────────────
  // ON CONFLICT (address, chain): update label/source so re-seeding
  // a known address with a better label is safe.
  let address_created = false;

  const { error: addrErr, data: addrData } = await dba
    .from('entity_addresses')
    .upsert(
      {
        entity_id:  entityId,
        address:    payload.address,
        chain:      payload.chain,
        label:      payload.label,
        confidence: payload.confidence,
        is_active:  true,
        source:     payload.source,
      },
      { onConflict: 'address,chain', ignoreDuplicates: false },
    )
    .select('id');

  if (addrErr) {
    throw new Error(`Address upsert failed for ${payload.address}: ${addrErr.message}`);
  }

  address_created = Array.isArray(addrData) && addrData.length > 0;

  return { entity_id: entityId, entity_created, address_created };
}

// ── seedWhalesToEntityGraph ───────────────────────────────────

export interface SeedWhalesResult {
  processed: number;
  created:   number;
  skipped:   number;
  errors:    string[];
}

/**
 * Seed active whale addresses into the entity graph.
 *
 * Canonical name strategy:
 *   whale.label if present → use as-is (operator/GMGN-assigned)
 *   otherwise: "whale_<first8>" — deterministic, address-anchored,
 *   never implies a real-world identity or verification
 *
 * Idempotent: pre-filters via a single batch query to skip already-mapped
 * addresses. Does NOT issue one SELECT per whale.
 */
export async function seedWhalesToEntityGraph(
  db:   Db,
  opts: { batchSize?: number } = {},
): Promise<SeedWhalesResult> {
  const batchSize = opts.batchSize ?? 50;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  // ── 1. Load all active whales ────────────────────────────────
  const { data: whaleRows, error: whaleErr } = await db
    .from('whales')
    .select('id, address, label, is_active')
    .eq('is_active', true)
    .limit(2000);

  if (whaleErr || !whaleRows) {
    return { processed: 0, created: 0, skipped: 0, errors: [whaleErr?.message ?? 'failed to load whales'] };
  }

  const whales = whaleRows as Array<{ id: string; address: string; label: string | null; is_active: boolean }>;
  if (whales.length === 0) return { processed: 0, created: 0, skipped: 0, errors: [] };

  // ── 2. Batch pre-filter: which addresses are already mapped ──
  const allAddrs = whales.map(w => w.address);
  const { data: mappedRows } = await dba
    .from('entity_addresses')
    .select('address')
    .in('address', allAddrs)
    .eq('chain', 'solana');

  const mappedSet = new Set(
    ((mappedRows ?? []) as Array<{ address: string }>).map(r => r.address),
  );

  const unmapped = whales.filter(w => !mappedSet.has(w.address));

  // ── 3. Process unmapped whales in batches ────────────────────
  let created = 0;
  const errors: string[] = [];

  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    for (const whale of batch) {
      try {
        const canonicalName = whale.label?.trim()
          ? whale.label.trim()
          : `whale_${whale.address.slice(0, 8)}`;

        await upsertEntityWithAddress(db, {
          entity_type:    'whale',
          canonical_name: canonicalName,
          confidence:     70,
          verified:       false,
          source:         'whale_table_seed',
          address:        whale.address,
          chain:          'solana',
          label:          'whale_wallet',
        });

        created++;
      } catch (err) {
        errors.push(`whale ${whale.address.slice(0, 8)}: ${String(err)}`);
      }
    }
  }

  return {
    processed: unmapped.length,
    created,
    skipped:   whales.length - unmapped.length,
    errors:    errors.slice(0, 20),
  };
}

// ── seedKnownAddressesToEntityGraph ───────────────────────────

export interface SeedKnownAddressesResult {
  groups_processed:  number;
  entities_created:  number;
  addresses_created: number;
  errors:            string[];
}

function categoryToEntityType(cat: string): string {
  if (cat === 'exchange') return 'exchange';
  if (cat === 'bridge')   return 'bridge';
  return 'protocol'; // staking, defi, protocol → all 'protocol'
}

/**
 * Seed known_addresses into the entity graph.
 *
 * Groups known_addresses by (category::label) — one entity per group,
 * multiple entity_addresses per entity. Confidence=90, verified=true.
 *
 * Idempotent: SELECT-before-INSERT for entities; UPSERT for addresses.
 */
export async function seedKnownAddressesToEntityGraph(
  db: Db,
): Promise<SeedKnownAddressesResult> {
  const { data: knownRaw, error: loadErr } = await db
    .from('known_addresses')
    .select('id, address, label, category, sub_category, is_active, metadata')
    .order('category')
    .limit(1000);

  if (loadErr) {
    return { groups_processed: 0, entities_created: 0, addresses_created: 0, errors: [loadErr.message] };
  }

  const known = (knownRaw ?? []) as KnownAddressRow[];
  if (known.length === 0) {
    return { groups_processed: 0, entities_created: 0, addresses_created: 0, errors: [] };
  }

  // Group by (category::label) — one entity per exchange/protocol name
  const byLabel = new Map<string, KnownAddressRow[]>();
  for (const row of known) {
    const key = `${row.category}::${row.label}`;
    const arr = byLabel.get(key) ?? [];
    arr.push(row);
    byLabel.set(key, arr);
  }

  let entities_created  = 0;
  let addresses_created = 0;
  const errors: string[] = [];

  for (const [, rows] of byLabel) {
    const first      = rows[0];
    const entityType = categoryToEntityType(first.category);

    for (const row of rows) {
      try {
        const result = await upsertEntityWithAddress(db, {
          entity_type:    entityType,
          canonical_name: first.label,
          description:    first.sub_category ?? null,
          confidence:     90,
          verified:       true,
          source:         'known_addresses_seed',
          address:        row.address,
          chain:          'solana',
          label:          row.sub_category ?? row.label,
        });

        if (result.entity_created)  entities_created++;
        if (result.address_created) addresses_created++;
      } catch (err) {
        errors.push(`${row.address}: ${String(err)}`);
      }
    }
  }

  return {
    groups_processed:  byLabel.size,
    entities_created,
    addresses_created,
    errors: errors.slice(0, 20),
  };
}

// ── Unmapped count helpers ────────────────────────────────────

/**
 * Count of active whale addresses not yet in entity_addresses.
 * Used by getEntityCoverage for coverage gap reporting.
 */
export async function getUnmappedWhaleCount(db: Db): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [{ data: whaleAddrs }, { data: mappedAddrs }] = await Promise.all([
    db.from('whales').select('address').eq('is_active', true).limit(2000),
    dba.from('entity_addresses').select('address').eq('chain', 'solana').limit(5000),
  ]);

  const mappedSet = new Set(
    ((mappedAddrs ?? []) as Array<{ address: string }>).map(r => r.address),
  );

  return ((whaleAddrs ?? []) as Array<{ address: string }>)
    .filter(r => !mappedSet.has(r.address)).length;
}

/**
 * Count of known_address rows not yet in entity_addresses.
 * Used by getEntityCoverage for coverage gap reporting.
 */
export async function getUnmappedKnownAddressCount(db: Db): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dba = db as any;

  const [{ data: knownAddrs }, { data: mappedAddrs }] = await Promise.all([
    db.from('known_addresses').select('address').eq('is_active', true).limit(1000),
    dba.from('entity_addresses').select('address').eq('chain', 'solana').limit(5000),
  ]);

  const mappedSet = new Set(
    ((mappedAddrs ?? []) as Array<{ address: string }>).map(r => r.address),
  );

  return ((knownAddrs ?? []) as Array<{ address: string }>)
    .filter(r => !mappedSet.has(r.address)).length;
}
