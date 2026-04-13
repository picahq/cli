/**
 * Shared parser for `--where` CLI conditions used by `sync query` and
 * `sync delete`. Splits by commas *outside* quoted values and strips one
 * layer of surrounding quotes so values with hyphens/UUIDs/commas work.
 */

export interface ParsedCondition {
  field: string;
  operator: string;
  value: string;
}

/** Strip one layer of surrounding single or double quotes from a value. */
export function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** Split on commas that are NOT inside a single- or double-quoted section. */
export function splitConditions(input: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === ',' && !inSingle && !inDouble) {
      if (buf.trim().length > 0) parts.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.trim().length > 0) parts.push(buf.trim());
  return parts;
}

/** Parse a single where condition like "status=active" or "id='abc-123'" */
export function parseCondition(condition: string): ParsedCondition {
  const operators = ['>=', '<=', '!=', '>', '<', '=', ' like '];
  for (const op of operators) {
    const idx = condition.toLowerCase().indexOf(op.toLowerCase());
    if (idx > 0) {
      const field = condition.slice(0, idx).trim();
      const rawValue = condition.slice(idx + op.length).trim();
      const value = unquote(rawValue);
      const sqlOp = op.trim().toUpperCase() === 'LIKE' ? 'LIKE' : op.trim();
      return { field, operator: sqlOp, value };
    }
  }
  throw new Error(
    `Cannot parse where condition: "${condition}". Expected format: field=value, field>value, field like %pattern`
  );
}
