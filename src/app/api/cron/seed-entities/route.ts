// ============================================================
// SONAR — Seed Entity Graph from known_addresses
// POST /api/cron/seed-entities
// ============================================================
// One-time (idempotent) job that migrates known_addresses into
// the sovereign entity graph (entities + entity_addresses tables).
//
// Run once after migration 009 is applied. Safe to re-run.
// Protected by CRON_SECRET.
//
// Category mapping:
//   exchange → entity_type 'exchange'
//   staking  → entity_type 'protocol'
//   defi     → entity_type 'protocol'
//   bridge   → entity_type 'bridge'
//   protocol → entity_type 'protocol'
// ============================================================

import { type NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import type { KnownAddressRow } from '@/lib/supabase/types';

function verifyCronSecret(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get('x-cron-secret') ?? req.headers.get('authorization') ?? '';
  return header.replace(/^Bearer\s+/, '') === secret;
}

function categoryToEntityType(cat: string): string {
  if (cat === 'exchange') return 'exchange';
  if (cat === 'bridge')   return 'bridge';
  return 'protocol';   // staking, defi, protocol → all 'protocol'
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const db    = createAdminClient();
  const dbAny = db as any;

  // ── 1. Load all known_addresses ───────────────────────────────
  const { data: knownRaw, error: loadErr } = await db
    .from('known_addresses')
    .select('id, address, label, category, sub_category, is_active, metadata')
    .order('category')
    .limit(1000);

  if (loadErr) {
    return NextResponse.json({ ok: false, error: loadErr.message }, { status: 500 });
  }

  const known = (knownRaw ?? []) as KnownAddressRow[];
  if (known.length === 0) {
    return NextResponse.json({ ok: true, message: 'no known_addresses found', seeded: 0 });
  }

  // ── 2. Group by label (one entity per exchange/protocol name) ─
  // e.g. all "Binance" addresses → one entity + multiple entity_addresses
  const byLabel = new Map<string, KnownAddressRow[]>();
  for (const row of known) {
    const key = `${row.category}::${row.label}`;
    const arr = byLabel.get(key) ?? [];
    arr.push(row);
    byLabel.set(key, arr);
  }

  let entitiesCreated  = 0;
  let addressesCreated = 0;
  const errors: string[] = [];

  for (const [key, rows] of byLabel) {
    const first = rows[0];
    const entityType = categoryToEntityType(first.category);

    try {
      // ── 3. Upsert entity (by canonical_name + entity_type) ──
      // If already seeded, skip creation and just add missing addresses.
      let entityId: string | null = null;

      const { data: existing } = await dbAny
        .from('entities')
        .select('id')
        .eq('canonical_name', first.label)
        .eq('entity_type', entityType)
        .maybeSingle();

      if (existing?.id) {
        entityId = existing.id;
      } else {
        const { data: inserted, error: insertErr } = await dbAny
          .from('entities')
          .insert({
            entity_type:    entityType,
            canonical_name: first.label,
            description:    first.sub_category ?? null,
            confidence:     90,
            verified:       true,
            source:         'known_addresses_seed',
            metadata:       first.metadata ?? null,
          })
          .select('id')
          .single();

        if (insertErr) {
          errors.push(`Entity insert failed for ${key}: ${insertErr.message}`);
          continue;
        }

        entityId = inserted.id;
        entitiesCreated++;
      }

      // ── 4. Upsert entity_addresses for each address ──────────
      for (const row of rows) {
        const { error: addrErr } = await dbAny
          .from('entity_addresses')
          .upsert({
            entity_id:  entityId,
            address:    row.address,
            chain:      'solana',
            label:      row.sub_category ?? row.label,
            confidence: 90,
            is_active:  row.is_active,
            source:     'known_addresses_seed',
          }, { onConflict: 'address,chain', ignoreDuplicates: false });

        if (addrErr && !addrErr.message.includes('duplicate')) {
          errors.push(`Address insert failed ${row.address}: ${addrErr.message}`);
        } else {
          addressesCreated++;
        }
      }
    } catch (err) {
      errors.push(`Failed for ${key}: ${String(err)}`);
    }
  }

  // ── 5. Seed whale addresses as 'whale' entities ──────────────
  // Each active whale gets its own entity (or updates existing one).
  let whaleEntities = 0;
  try {
    const { data: whaleRows } = await db
      .from('whales')
      .select('id, address, label, is_active')
      .eq('is_active', true)
      .limit(500);

    for (const whale of (whaleRows ?? []) as { id: string; address: string; label: string | null; is_active: boolean }[]) {
      try {
        // Check if already in entity_addresses
        const { data: existingAddr } = await dbAny
          .from('entity_addresses')
          .select('id')
          .eq('address', whale.address)
          .eq('chain', 'solana')
          .maybeSingle();

        if (existingAddr?.id) continue; // already mapped

        // Create entity for this whale
        const { data: wEntity, error: wEntityErr } = await dbAny
          .from('entities')
          .insert({
            entity_type:    'whale',
            canonical_name: whale.label ?? whale.address.slice(0, 8),
            confidence:     70,
            verified:       false,
            source:         'whale_table_seed',
          })
          .select('id')
          .single();

        if (wEntityErr) continue;

        await dbAny.from('entity_addresses').insert({
          entity_id:  wEntity.id,
          address:    whale.address,
          chain:      'solana',
          label:      'whale_wallet',
          confidence: 70,
          is_active:  true,
          source:     'whale_table_seed',
        });

        whaleEntities++;
      } catch { /* skip individual whale errors */ }
    }
  } catch (err) {
    errors.push(`Whale seeding failed: ${String(err)}`);
  }

  return NextResponse.json({
    ok:                errors.length === 0,
    known_address_groups: byLabel.size,
    entities_created:  entitiesCreated,
    addresses_created: addressesCreated,
    whale_entities:    whaleEntities,
    errors:            errors.slice(0, 10),
  });
}

export const GET = POST;
