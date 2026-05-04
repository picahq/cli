/**
 * Deterministic JSON canonicalization + sha256, used for `content_hash`.
 *
 * Canonical form sorts object keys recursively so that structurally-equal
 * payloads hash identically regardless of upstream JSON key order. Arrays
 * preserve order (ordering is semantic in JSON arrays).
 */

import { createHash } from 'node:crypto';

export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalValue(obj[key]);
  }
  return sorted;
}

export function contentHash(data: unknown): string {
  return createHash('sha256').update(canonicalize(data)).digest('hex');
}
