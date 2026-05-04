/**
 * Relevance scoring.
 *
 * Mirrors `mem_calculate_relevance` in schema.ts so callers can score records
 * they've already loaded in memory without a round-trip. Composition:
 *   - weight  (40%): explicit importance (1-10)
 *   - access  (30%): usage frequency (capped at maxAccessCount)
 *   - recency (30%): how recently last accessed (decays over 30 days)
 */

const DEFAULT_MAX_ACCESS_COUNT = 100;

export interface RelevanceInputs {
  weight: number;
  accessCount: number;
  lastAccessedAt?: string | null;
  createdAt: string;
  maxAccessCount?: number;
}

export function calculateRelevance(input: RelevanceInputs): number {
  const max = input.maxAccessCount ?? DEFAULT_MAX_ACCESS_COUNT;

  const weightScore = (input.weight - 1) / 9;
  const accessScore = Math.min(input.accessCount / max, 1);

  let recencyScore: number;
  if (input.lastAccessedAt) {
    const days = daysSince(input.lastAccessedAt);
    recencyScore = Math.max(1 - (days / 30) * 0.9, 0.1);
  } else {
    const days = daysSince(input.createdAt);
    recencyScore = Math.max(0.5 - (days / 60) * 0.4, 0.1);
  }

  return weightScore * 0.4 + accessScore * 0.3 + recencyScore * 0.3;
}

function daysSince(iso: string): number {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}
