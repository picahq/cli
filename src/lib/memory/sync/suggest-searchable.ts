/**
 * Auto-rank string-leaf dot-paths on a sample of records to propose a
 * sensible `memory.searchable` starter block.
 *
 * Called by `one sync suggest-searchable <platform>/<model>`. The agent
 * reads the knowledge for the list action, picks signal fields with the
 * suggestion, pastes them into `memory.searchable`, and then iterates
 * against `sync test --show-searchable`.
 *
 * Heuristic: score each leaf path by the amount of real human-readable
 * signal it carries, minus penalties for machine-shaped noise.
 *
 *   score = hit_rate × log1p(avg_length) × signal_penalty
 *
 * where:
 *   hit_rate      = non-empty samples / total samples
 *   avg_length    = mean length of non-empty sample strings (capped)
 *   signal_penalty = 1 for clean text
 *                  = 0 when every non-empty sample is a UUID / ISO
 *                    timestamp / URL / a known enum marker ("system",
 *                    "text", "personal-name", actor types)
 *                  = partial penalty when most are noise
 *
 * The output is a ranked list; agents paste the top N they want and
 * drop the rest. Intentionally conservative on boolean / numeric leaves
 * — they're usually flags / counts rather than searchable text.
 */

// ── Shape detection ────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const URL_RE = /^https?:\/\//i;

/**
 * Noise-y string markers common in normalized API responses. Attio uses
 * these as `attribute_type` values on every wrapped value; embedding
 * them adds nothing to semantic search.
 */
const ENUM_MARKERS = new Set([
  'system', 'app', 'text', 'number', 'checkbox', 'select',
  'personal-name', 'email-address', 'phone-number', 'location',
  'timestamp', 'date', 'actor-reference', 'record-reference',
  'workspace-member', 'interaction', 'currency', 'status',
]);

function isNoise(s: string): boolean {
  if (UUID_RE.test(s)) return true;
  if (ISO_TS_RE.test(s)) return true;
  if (URL_RE.test(s) && s.length < 120) return true; // URLs as identifiers — long text URLs (links in content) keep their signal
  if (ENUM_MARKERS.has(s.toLowerCase())) return true;
  // Numeric-string (stringified float / int). APIs like Attio wrap
  // latitude / longitude / counts as strings; they have no semantic
  // signal for embedding even though they pass the typeof === 'string'
  // test. Matches "123", "-12.34", "1.5e-10". Requires at least one
  // digit to avoid matching "-" alone.
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return true;
  return false;
}

// ── Leaf-path walk ─────────────────────────────────────────────────────────

interface LeafStats {
  path: string;
  total: number;                  // total samples seen (for hit-rate denominator)
  /**
   * Records where this path produced at least one non-empty value.
   * Tracking per-record (not per-leaf-occurrence) means array wildcards
   * can't inflate hitRate above 1.0 — a single record with 25 category
   * entries counts once, not 25 times.
   */
  recordIndices: Set<number>;
  /**
   * Total character length summed across every non-empty string seen,
   * and the count of string observations — used for avgLength.
   */
  lenSum: number;
  strCount: number;
  noiseHits: number;              // string values matching isNoise
  /** JS typeof primarily seen at this leaf. */
  primaryType: 'string' | 'number' | 'boolean' | 'mixed';
  examples: string[];             // up to 3 short-ish samples for display
}

function recordSample(
  stats: Map<string, LeafStats>,
  path: string,
  value: string,
  jsType: 'string' | 'number' | 'boolean',
  recordIndex: number,
  totalSamples: number,
): void {
  let s = stats.get(path);
  if (!s) {
    s = {
      path,
      total: totalSamples,
      recordIndices: new Set(),
      lenSum: 0,
      strCount: 0,
      noiseHits: 0,
      primaryType: jsType,
      examples: [],
    };
    stats.set(path, s);
  }
  s.recordIndices.add(recordIndex);
  s.lenSum += value.length;
  s.strCount++;
  if (isNoise(value)) s.noiseHits++;
  if (s.primaryType !== jsType) s.primaryType = 'mixed';
  if (s.examples.length < 3 && value.length < 200) s.examples.push(value);
}

/**
 * Walk a record's shape, emitting one observation per leaf string per
 * sample. Records use `.` for object descent and `[]` for array
 * wildcards (matching the `memory.searchable` path syntax so the
 * suggestions paste directly).
 */
function walkRecord(
  record: unknown,
  path: string,
  stats: Map<string, LeafStats>,
  recordIndex: number,
  totalSamples: number,
): void {
  if (record === null || record === undefined) return;

  if (typeof record === 'string') {
    const trimmed = record.trim();
    if (trimmed) recordSample(stats, path, trimmed, 'string', recordIndex, totalSamples);
    return;
  }

  // Numbers/booleans sometimes carry signal (country codes, job titles
  // as categorical ids) but are usually flags / counts / ids. Emit them
  // so the agent CAN pick them, but penalize their score later.
  if (typeof record === 'number' || typeof record === 'boolean') {
    const str = String(record);
    const kind: 'number' | 'boolean' = typeof record === 'number' ? 'number' : 'boolean';
    if (str) recordSample(stats, path, str, kind, recordIndex, totalSamples);
    return;
  }

  if (Array.isArray(record)) {
    const childPath = path ? `${path}[]` : '[]';
    for (const item of record) walkRecord(item, childPath, stats, recordIndex, totalSamples);
    return;
  }

  if (typeof record === 'object') {
    for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
      if (key.startsWith('_')) continue; // sync-internal fields (_identity, _synced_at)
      const childPath = path ? `${path}.${key}` : key;
      walkRecord(value, childPath, stats, recordIndex, totalSamples);
    }
  }
}

// ── Scoring + ranking ──────────────────────────────────────────────────────

export interface SearchableSuggestion {
  path: string;
  hitRate: number;
  avgLength: number;
  noiseFraction: number;
  score: number;
  sampleValue: string;
}

export function suggestSearchablePaths(
  records: Array<Record<string, unknown>>,
  limit = 15,
): SearchableSuggestion[] {
  const total = records.length;
  if (total === 0) return [];

  const stats = new Map<string, LeafStats>();
  records.forEach((record, i) => walkRecord(record, '', stats, i, total));

  const ranked: SearchableSuggestion[] = [];
  for (const s of stats.values()) {
    if (s.strCount === 0) continue;
    // Per-record hit rate, capped at 1.0. Array wildcards can't
    // inflate this past 100% anymore.
    const hitRate = s.recordIndices.size / s.total;
    const avgLength = s.lenSum / s.strCount;
    const noiseFraction = s.noiseHits / s.strCount;

    // Penalty: 0 when all samples are noise, 1 when none are, linear
    // in between. Squared so "mostly noise" gets beaten harder.
    const signalPenalty = (1 - noiseFraction) ** 2;

    // log1p keeps the ranking from being dominated by a single
    // multi-paragraph description; caps long prose contribution.
    const lengthFactor = Math.log1p(Math.min(avgLength, 500));

    // Very short leaves (<=2 chars) are almost always flags or codes
    // — zero them out so they can't sneak into the top.
    const shortPenalty = avgLength <= 2 ? 0 : 1;

    // Booleans are flags, not text. Numbers are usually ids / counts /
    // coordinates / measurements — not useful semantic signal. Strong
    // type penalty pushes them below any real string leaf; agents can
    // still manually add them if they're meaningful for a given schema.
    const typePenalty =
      s.primaryType === 'boolean' ? 0.05 :
      s.primaryType === 'number' ? 0.1 :
      s.primaryType === 'mixed' ? 0.5 :
      1;

    const score = hitRate * lengthFactor * signalPenalty * shortPenalty * typePenalty;
    if (score <= 0) continue;

    ranked.push({
      path: s.path,
      hitRate,
      avgLength: Math.round(avgLength),
      noiseFraction,
      score: Number(score.toFixed(3)),
      sampleValue: s.examples[0] ?? '',
    });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}
