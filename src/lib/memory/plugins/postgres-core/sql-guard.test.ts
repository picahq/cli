import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateReadOnlySql } from './sql-guard.js';

describe('validateReadOnlySql', () => {
  it('accepts plain SELECT', () => {
    assert.doesNotThrow(() => validateReadOnlySql('SELECT 1'));
    assert.doesNotThrow(() => validateReadOnlySql('  SELECT id FROM mem_records WHERE type = $1  '));
    assert.doesNotThrow(() => validateReadOnlySql('SELECT 1;'));
  });

  it('accepts CTEs via WITH', () => {
    assert.doesNotThrow(() =>
      validateReadOnlySql("WITH a AS (SELECT 1 AS x) SELECT * FROM a"),
    );
  });

  it('accepts EXPLAIN', () => {
    assert.doesNotThrow(() => validateReadOnlySql('EXPLAIN SELECT * FROM mem_records'));
  });

  it('accepts JSONB path operators and aggregates', () => {
    assert.doesNotThrow(() =>
      validateReadOnlySql(
        "SELECT type, COUNT(*) FROM mem_records WHERE data->>'field' = 'x' GROUP BY type",
      ),
    );
  });

  it('rejects empty / whitespace input', () => {
    assert.throws(() => validateReadOnlySql(''), /empty/i);
    assert.throws(() => validateReadOnlySql('   '), /empty/i);
  });

  it('rejects non-SELECT leading statements', () => {
    assert.throws(() => validateReadOnlySql('DELETE FROM mem_records'), /SELECT.*only/i);
    assert.throws(() => validateReadOnlySql('UPDATE mem_records SET x=1'), /SELECT.*only/i);
    assert.throws(() => validateReadOnlySql('DROP TABLE mem_records'), /SELECT.*only/i);
    assert.throws(() => validateReadOnlySql('CREATE TABLE t (x int)'), /SELECT.*only/i);
    assert.throws(() => validateReadOnlySql('TRUNCATE mem_records'), /SELECT.*only/i);
  });

  it('rejects DDL/DML smuggled inside a CTE', () => {
    assert.throws(() =>
      validateReadOnlySql(
        "WITH deleted AS (DELETE FROM mem_records WHERE id='x' RETURNING *) SELECT * FROM deleted",
      ),
    /DDL.*DML.*blocked/i,
    );
  });

  it('rejects multi-statement compound input', () => {
    assert.throws(() =>
      validateReadOnlySql("SELECT 1; SELECT 2"),
    /Multi-statement/i,
    );
  });

  it('rejects session-control + side-effect keywords', () => {
    for (const sql of [
      "COPY mem_records TO '/tmp/x'",
      "PRAGMA table_info('mem_records')",
      "VACUUM",
      "ATTACH DATABASE 'x' AS a",
      "SET SESSION work_mem = '100MB'",
      "GRANT SELECT ON mem_records TO public",
    ]) {
      // Some hit the leading-statement check ("SELECT/WITH/EXPLAIN only"),
      // others hit the forbidden-keyword check; either way it must throw.
      assert.throws(() => validateReadOnlySql(sql), `should reject: ${sql}`);
    }
  });

  it('accepts lowercase keywords', () => {
    assert.doesNotThrow(() => validateReadOnlySql('select * from mem_records'));
    assert.doesNotThrow(() => validateReadOnlySql('with a as (select 1) select * from a'));
  });
});
