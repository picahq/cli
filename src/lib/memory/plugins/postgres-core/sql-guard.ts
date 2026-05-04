/**
 * Read-only SQL guard for `backend.raw()`.
 *
 * The memory store runs user-supplied SQL through `one mem sql` and
 * `one sync sql`. These surfaces should support joins / aggregates /
 * JSONB path queries — things `mem search` + `mem list` can't express —
 * but must not let a caller mutate the store or exfiltrate via
 * side-effects (PRAGMA, COPY, file reads, etc.).
 *
 * Strategy: keep it simple. Reject any statement that doesn't start with
 * SELECT / WITH / EXPLAIN. Additionally blocklist keywords that can
 * sneak in via CTEs or compound statements (INSERT / UPDATE / DELETE /
 * DROP / ALTER / CREATE / TRUNCATE / COPY / GRANT / REVOKE / VACUUM /
 * ATTACH / DETACH / PRAGMA / CALL). Multi-statement input (semicolons
 * past the end-of-query) is rejected too.
 *
 * Throws a descriptive Error when the query is not safe to execute.
 */

const ALLOWED_LEADING = /^\s*(SELECT|WITH|EXPLAIN)\b/i;
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|COPY|GRANT|REVOKE|VACUUM|ATTACH|DETACH|PRAGMA|CALL|LOAD|RESET|SET\s+SESSION|SET\s+LOCAL|DO|COMMIT|ROLLBACK|BEGIN|START)\b/i;

export function validateReadOnlySql(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error('SQL is empty.');
  }
  if (!ALLOWED_LEADING.test(trimmed)) {
    throw new Error(
      'Only SELECT / WITH / EXPLAIN statements are allowed. The unified memory store is read-only from this surface — use `one mem add` / `one sync run` for writes.',
    );
  }
  // Strip a single trailing semicolon (common in copy-paste) and check
  // that nothing else is past it. A second semicolon is a red flag for
  // compound statements.
  const stripped = trimmed.replace(/;\s*$/, '');
  if (stripped.includes(';')) {
    throw new Error('Multi-statement SQL is not allowed — submit a single SELECT / WITH / EXPLAIN.');
  }
  if (FORBIDDEN.test(stripped)) {
    throw new Error(
      'DDL / DML / session-control keywords are blocked. Allowed: SELECT, WITH, EXPLAIN, plus standard read-only operators (JOIN, WHERE, GROUP BY, aggregates, JSONB path operators).',
    );
  }
}
