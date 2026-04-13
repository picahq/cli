/**
 * Shared dot-path utilities for navigating nested objects.
 * Used by both flow-engine pagination and sync pagination.
 */

/**
 * Resolve a dot-notation path on an object.
 * Supports bracket indexing: "data[0].id" resolves to obj.data[0].id
 */
export function getByDotPath(obj: unknown, dotPath: string): unknown {
  // Split on dots, then handle bracket notation within each part
  const parts = dotPath.split('.').flatMap(part => {
    // "data[0]" → ["data", "0"]
    const bracketMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      return [bracketMatch[1], bracketMatch[2]];
    }
    return [part];
  });

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[parseInt(part, 10)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Set a value at a dot-notation path on an object.
 * Creates intermediate objects as needed.
 */
export function setByDotPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined || current[parts[i]] === null) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
