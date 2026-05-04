/**
 * `one mem sql "<SELECT ...>"` — raw read-only SQL against the memory
 * store. Only SELECT / WITH / EXPLAIN statements are accepted; DDL,
 * DML, and session-control keywords are blocked by the backend's
 * shared guard (see plugins/postgres-core/sql-guard.ts).
 *
 * `one sync sql <platform>/<model> "<SELECT ...>"` is the type-filtered
 * ergonomic helper: injects a WHERE type = '<platform>/<model>' clause
 * so agents don't have to repeat the filter in every query.
 *
 * Capability-gated. Third-party plugins that opt out via
 * `capabilities.rawSql = false` surface a clear error.
 */

import * as output from '../../lib/output.js';
import { getBackend } from '../../lib/memory/runtime.js';
import { requireMemoryInit } from './util.js';

export async function memSqlCommand(sql: string): Promise<void> {
  requireMemoryInit();
  const backend = await getBackend();

  if (!backend.capabilities().rawSql || !backend.raw) {
    output.error(
      'This memory backend does not support raw SQL (capabilities.rawSql = false). Use `mem list` / `mem search` / `mem find-by-source` for high-level queries.',
    );
  }

  try {
    const result = await backend.raw!(sql);
    if (output.isAgentMode()) {
      output.json({
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
      });
      return;
    }
    if (result.rows.length === 0) {
      console.log('(0 rows)');
      return;
    }
    console.log(JSON.stringify(result.rows, null, 2));
    console.log(`\n${result.rowCount} row(s)`);
  } catch (err) {
    output.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Type-filtered helper: `one sync sql <platform>/<model> "<sql>"`.
 *
 * Thin alias over `mem sql` with a hint: if the query doesn't mention
 * the expected type literal, surface a warning on stderr so the agent
 * knows it's reading across types. We don't inject a filter clause —
 * that would require a real SQL parser and the wrong guess leads to
 * silently wrong results. Document the pattern instead:
 *
 *   one sync sql attio/attioPeople "SELECT data->>'id' FROM mem_records WHERE type = 'attio/attioPeople'"
 *
 * For common shapes, agents should prefer `sync query` (handles the
 * type filter automatically) and fall back here only for joins /
 * aggregates / window functions.
 */
export async function syncSqlCommand(platformModel: string, sql: string): Promise<void> {
  const [platform, model] = platformModel.split('/');
  if (!platform || !model) {
    output.error(`Usage: one sync sql <platform>/<model> "<SELECT ...>". Example: one sync sql attio/attioPeople "SELECT data->>'id' FROM mem_records WHERE type = 'attio/attioPeople'"`);
  }
  const type = `${platform}/${model}`;

  // Best-effort hint if the agent forgot to mention the type. Not a
  // block — they might genuinely want a cross-type query.
  if (!output.isAgentMode() && !sql.includes(`'${type}'`) && !sql.includes(`"${type}"`)) {
    process.stderr.write(
      `  note: this query does not filter to type = '${type}'. Results span all types. Add \`WHERE type = '${type}'\` to scope.\n`,
    );
  }
  await memSqlCommand(sql);
}
