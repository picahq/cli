import { getByDotPath } from '../dot-path.js';

/**
 * A profile's `resultsPath` value that targets the root of the response
 * (i.e. the response IS the records array). Any of these are treated as
 * equivalent to "no path — use the whole response".
 */
const ROOT_PATH_TOKENS = new Set(['', '$', '.']);

export function isRootPath(resultsPath: string | undefined | null): boolean {
  return resultsPath === undefined || resultsPath === null || ROOT_PATH_TOKENS.has(resultsPath);
}

/** A primitive response element that must be wrapped as `{ id: <stringified> }`. */
function isPrimitive(value: unknown): value is string | number | boolean {
  const t = typeof value;
  return t === 'string' || t === 'number' || t === 'boolean';
}

/**
 * Describe the top-level type of a response for error messages.
 * Used when the caller points resultsPath at something that doesn't exist.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export interface ExtractResult {
  records: Record<string, unknown>[];
  /** Whether primitive elements were auto-wrapped as { id: <value> }. */
  wrappedPrimitives: boolean;
}

/**
 * Extract the records array from an API response for a sync profile.
 *
 * Supports three shapes:
 *   1. Dotted path on an object response (existing behaviour, e.g. "items").
 *   2. Root array: `resultsPath` is empty / "$" / "." AND response is an array.
 *   3. Array of primitives (numbers/strings/bools) at the root or at a path.
 *      Each primitive is wrapped as `{ [idField]: String(value) }` so the
 *      downstream schema-inference and upsert code can treat it like any
 *      other object record.
 *
 * Throws a descriptive Error when the configured path doesn't resolve to
 * an array — the message names both the profile path and the actual
 * top-level type so the agent can diagnose without re-running with -v.
 */
export function extractRecords(
  responseData: unknown,
  resultsPath: string | undefined | null,
  idField: string,
  profileLabel: string,
): ExtractResult {
  let candidate: unknown;

  if (isRootPath(resultsPath)) {
    candidate = responseData;
  } else {
    candidate = getByDotPath(responseData, resultsPath as string);
  }

  if (!Array.isArray(candidate)) {
    const topKeys = typeof responseData === 'object' && responseData !== null && !Array.isArray(responseData)
      ? Object.keys(responseData).slice(0, 10)
      : [];
    const pathLabel = isRootPath(resultsPath) ? '<root>' : `'${resultsPath}'`;
    const typeLabel = describeType(responseData);
    const keyHint = topKeys.length > 0 ? ` Top-level keys: [${topKeys.join(', ')}].` : '';
    throw new Error(
      `Could not find results at path ${pathLabel} for profile ${profileLabel}. ` +
      `Response top-level type is ${typeLabel}.${keyHint} ` +
      `Set resultsPath to the array field, or use "" / "$" / "." for root arrays.`
    );
  }

  // Fast-path: empty array. Caller will handle "no records" signalling.
  if (candidate.length === 0) {
    return { records: [], wrappedPrimitives: false };
  }

  // If the first element is a primitive, assume the whole array is primitives.
  // Mixed arrays (some primitives, some objects) are not a real-world shape
  // we need to handle — wrapping the primitives and leaving the objects alone
  // would give the schema inference two conflicting row shapes for the same
  // model, which has no good answer.
  if (isPrimitive(candidate[0])) {
    const wrapped: Record<string, unknown>[] = [];
    for (const value of candidate) {
      if (!isPrimitive(value)) continue; // skip nulls / oddball entries
      wrapped.push({ [idField]: String(value) });
    }
    return { records: wrapped, wrappedPrimitives: true };
  }

  return { records: candidate as Record<string, unknown>[], wrappedPrimitives: false };
}
