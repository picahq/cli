import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { reviveStringifiedJson, dotPathToJsonbExpr, buildIdentityMap } from './migrate.js';
import { getByDotPath } from '../../lib/dot-path.js';
import { pglitePlugin } from '../../lib/memory/plugins/pglite/index.js';
import type { MemBackend } from '../../lib/memory/backend.js';

describe('reviveStringifiedJson', () => {
  it('parses top-level JSON-stringified objects', () => {
    // Mirrors the exact legacy shape that bit Moe: Attio companies'
    // nested `id: {workspace_id, object_id, record_id}` gets
    // JSON.stringify'd on INSERT, stored as text in the `id` column,
    // and dot-path `id.record_id` needs to resolve after rehydration.
    const row = {
      id: '{"workspace_id":"ws_1","object_id":"obj_1","record_id":"rec_abc"}',
      name: 'Acme',
    };
    const out = reviveStringifiedJson(row);
    assert.deepEqual(out.id, { workspace_id: 'ws_1', object_id: 'obj_1', record_id: 'rec_abc' });
    assert.equal(getByDotPath(out, 'id.record_id'), 'rec_abc', 'dotted idField must resolve after rehydration');
  });

  it('parses top-level JSON-stringified arrays', () => {
    const row = { tags: '["urgent","billing"]', name: 'x' };
    const out = reviveStringifiedJson(row);
    assert.deepEqual(out.tags, ['urgent', 'billing']);
  });

  it('leaves plain strings alone', () => {
    const row = { name: 'Acme', description: 'Just a company' };
    const out = reviveStringifiedJson(row);
    assert.equal(out.name, 'Acme');
    assert.equal(out.description, 'Just a company');
  });

  it('leaves non-JSON strings alone even if they start with curly/bracket', () => {
    // Markdown content, log lines, etc. Don't corrupt user data.
    const row = { note: '{ this is not json' };
    const out = reviveStringifiedJson(row);
    assert.equal(out.note, '{ this is not json');
  });

  it('leaves non-string values untouched', () => {
    const row = { id: 42, active: true, tags: null };
    const out = reviveStringifiedJson(row);
    assert.equal(out.id, 42);
    assert.equal(out.active, true);
    assert.equal(out.tags, null);
  });

  it('does not mutate the input', () => {
    const row = { id: '{"x":1}' };
    const original = row.id;
    reviveStringifiedJson(row);
    assert.equal(row.id, original, 'input must not be mutated');
  });
});

describe('dotPathToJsonbExpr', () => {
  it('compiles the Attio people identity path correctly', () => {
    // The exact path that bit Moe's re-migrate — nested array index +
    // property. Must produce a PG jsonb expression with `->>` on the
    // final text segment.
    const expr = dotPathToJsonbExpr('values.email_addresses[0].email_address');
    assert.equal(expr, "data->'values'->'email_addresses'->0->>'email_address'");
  });

  it('compiles a top-level scalar path', () => {
    assert.equal(dotPathToJsonbExpr('email'), "data->>'email'");
  });

  it('uses ->> only on the final segment for array indices', () => {
    // numeric-terminal path: last ->> is a text cast, but integer
    // indices still parse via ->>. Consumers compare as string.
    assert.equal(dotPathToJsonbExpr('tags[0]'), "data->'tags'->>0");
  });

  it('rejects segments with characters outside [a-zA-Z0-9_]', () => {
    // SQL injection defense — segments are inlined into the query
    // (unparameterizable as column refs). Anything exotic aborts
    // the pre-pass, migrate falls back to plain key-overlap.
    assert.equal(dotPathToJsonbExpr("id'); DROP TABLE mem_records--"), null);
    assert.equal(dotPathToJsonbExpr('values."email"'), null);
    assert.equal(dotPathToJsonbExpr('weird field'), null);
  });

  it('returns null for empty input', () => {
    assert.equal(dotPathToJsonbExpr(''), null);
  });
});

describe('buildIdentityMap — migrate identity-merge pre-pass', () => {
  let backend: MemBackend;

  before(async () => {
    const parsed = pglitePlugin.parseConfig({ dbPath: ':memory:' });
    backend = pglitePlugin.create(parsed);
    await backend.init();
    await backend.ensureSchema();
  });

  after(async () => {
    await backend.close();
  });

  it('maps identity values from data JSONB back to existing row id+keys', async () => {
    // Simulates the exact shape the re-migrate bug creates: a pre-fix
    // row with a garbage sourceKey (stringified object) and NO identity
    // key in keys[]. The identity value is only reachable via data.
    const rec = await backend.insert({
      type: 'attio/attioPeople',
      data: {
        id: { workspace_id: 'ws_1', record_id: 'rec_abc' },
        values: { email_addresses: [{ email_address: 'Jane@Example.com' }] },
      },
      keys: ['attio/attioPeople:garbage-legacy-key'],
    });

    const map = await buildIdentityMap(
      backend,
      'attio/attioPeople',
      'values.email_addresses[0].email_address',
    );

    const hit = map.get('jane@example.com');
    assert.ok(hit, 'identity value must be resolved from data and normalized (lowercase + trim)');
    assert.equal(hit!.id, rec.id);
    assert.deepEqual(hit!.keys, ['attio/attioPeople:garbage-legacy-key']);
  });

  it('returns an empty map when identityKey is undefined', async () => {
    const map = await buildIdentityMap(backend, 'attio/attioPeople', undefined);
    assert.equal(map.size, 0);
  });

  it('returns an empty map when identityKey uses unsafe characters', async () => {
    // SQL-injection path: the helper must refuse to build the jsonb
    // expression, and the map stays empty.
    const map = await buildIdentityMap(
      backend,
      'attio/attioPeople',
      "id'); DROP TABLE mem_records--",
    );
    assert.equal(map.size, 0);
  });

  it('skips archived rows', async () => {
    const rec = await backend.insert({
      type: 'gmail/messages',
      data: { from: 'archived@example.com' },
      keys: ['gmail/messages:archived-msg'],
    });
    await backend.archive(rec.id, 'test');

    const map = await buildIdentityMap(backend, 'gmail/messages', 'from');
    assert.ok(!map.has('archived@example.com'), 'archived rows must not populate the identity map');
  });
});
