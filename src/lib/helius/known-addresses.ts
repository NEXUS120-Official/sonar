// ============================================================
// SONAR v2.0 — Known Address Lookup
// ============================================================
// In-memory lookup map built from constants.
// Used by classifier.ts on every movement — must be fast (O(1)).
// DB is source of truth; this is a warm cache for the hot path.

import {
  KNOWN_EXCHANGE_ADDRESSES,
  KNOWN_STAKING_ADDRESSES,
  KNOWN_DEFI_ADDRESSES,
} from '@/lib/utils/constants';
import type { KnownAddressCategory } from '@/lib/supabase/types';

export interface KnownAddressInfo {
  address:      string;
  label:        string;
  category:     KnownAddressCategory;
  sub_category: string;
}

// ── Build the lookup map ──────────────────────────────────────

function buildLookupMap(): Map<string, KnownAddressInfo> {
  const map = new Map<string, KnownAddressInfo>();

  for (const entry of KNOWN_EXCHANGE_ADDRESSES) {
    map.set(entry.address, { ...entry, category: 'exchange' });
  }
  for (const entry of KNOWN_STAKING_ADDRESSES) {
    map.set(entry.address, { ...entry, category: 'staking' });
  }
  for (const entry of KNOWN_DEFI_ADDRESSES) {
    map.set(entry.address, { ...entry, category: 'defi' });
  }

  return map;
}

// Singleton — built once per process lifetime
let _map: Map<string, KnownAddressInfo> | null = null;

export function getKnownAddressMap(): Map<string, KnownAddressInfo> {
  if (!_map) _map = buildLookupMap();
  return _map;
}

/**
 * Look up a single address. Returns null if unknown.
 */
export function lookupAddress(address: string): KnownAddressInfo | null {
  return getKnownAddressMap().get(address) ?? null;
}

/**
 * Returns all known addresses as an array — used by webhook setup.
 */
export function getAllKnownAddresses(): KnownAddressInfo[] {
  return Array.from(getKnownAddressMap().values());
}

/**
 * Returns all addresses for a specific category.
 */
export function getAddressesByCategory(category: KnownAddressCategory): KnownAddressInfo[] {
  return getAllKnownAddresses().filter((a) => a.category === category);
}

/**
 * Returns the Set of all known address strings — for fast `has()` checks.
 */
export function getKnownAddressSet(): Set<string> {
  return new Set(getKnownAddressMap().keys());
}
