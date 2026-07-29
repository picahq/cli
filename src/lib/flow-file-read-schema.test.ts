import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertMatchesFileReadSchema, executeFlow } from './flow-engine.js';
import { validateFlow } from './flow-validator.js';
import type { FileReadSchema, Flow } from './flow-types.js';
import type { OneApi } from './api.js';

// #80: runtime + load-time validation for `fileRead.schema`.

function violations(value: unknown, schema: FileReadSchema): string[] {
  try { assertMatchesFileReadSchema(value, schema, 'readConfig'); return []; }
  catch (e) {
    assert.equal((e as { errorCode?: string }).errorCode, 'SCHEMA_VALIDATION');
    assert.match((e as Error).message, /^Step "readConfig" output failed schema validation: /);
    return (e as Error).message.replace(/^Step "readConfig" output failed schema validation: /, '').split('; ');
  }
}

describe('assertMatchesFileReadSchema — runtime (#80)', () => {
  const full: FileReadSchema = {
    name: { type: 'string', required: true },
    retries: { type: 'number', required: true },
    mode: { type: 'string', required: true, enum: ['dev', 'staging', 'prod'] },
    tags: { type: 'array', items: 'string', minItems: 1, maxItems: 3 },
    coords: { type: 'array', length: 2, items: 'number' },
    owner: { type: 'object', required: true, properties: { id: 'string', email: { type: 'string', required: true } } },
  };
  const ok = { name: 'x', retries: 3, mode: 'dev', tags: ['a'], coords: [1, 2], owner: { id: 'o1', email: 'a@b.com' } };

  it('passes a fully conforming object', () => {
    assert.deepEqual(violations(ok, full), []);
  });

  it('flags a missing required field', () => {
    const v = violations({ ...ok, name: undefined }, full);
    assert.ok(v.includes('field "name" is required but missing'));
  });

  it('flags a wrong type with actual vs expected', () => {
    const v = violations({ ...ok, retries: '3' }, full);
    assert.ok(v.some(m => /field "retries" expected number but got string/.test(m)));
  });

  it('flags an enum violation', () => {
    const v = violations({ ...ok, mode: 'qa' }, full);
    assert.ok(v.some(m => /field "mode" value "qa" is not one of/.test(m)));
  });

  it('flags array length: exact / min / max', () => {
    assert.ok(violations({ ...ok, coords: [1, 2, 3] }, full).some(m => /coords" expected array of length 2 but got length 3/.test(m)));
    assert.ok(violations({ ...ok, tags: [] }, full).some(m => /tags" expected at least 1 item but got 0/.test(m)));
    assert.ok(violations({ ...ok, tags: ['a', 'b', 'c', 'd'] }, full).some(m => /tags" expected at most 3 items but got 4/.test(m)));
  });

  it('flags a bad array element via indexed path', () => {
    const v = violations({ ...ok, tags: ['a', 5] }, full);
    assert.ok(v.some(m => /field "tags\[1\]" expected string but got number/.test(m)));
  });

  it('flags a nested required field via dotted path', () => {
    const v = violations({ ...ok, owner: { id: 'o1' } }, full);
    assert.ok(v.includes('field "owner.email" is required but missing'));
  });

  it('reports ALL violations in one throw (not fail-fast)', () => {
    const v = violations({ retries: '3', mode: 'qa' }, full); // name & owner missing, retries wrong, mode bad enum
    assert.ok(v.length >= 4, `expected multiple violations, got ${JSON.stringify(v)}`);
    assert.ok(v.includes('field "name" is required but missing'));
    assert.ok(v.includes('field "owner" is required but missing'));
  });

  it('shorthand "field":"string" is an OPTIONAL string', () => {
    assert.deepEqual(violations({}, { note: 'string' }), []);                 // absent optional ok
    assert.ok(violations({ note: 5 }, { note: 'string' }).some(m => /expected string but got number/.test(m)));
  });

  it('null handling: type:object rejects null, type:null accepts null', () => {
    assert.ok(violations({ x: null }, { x: { type: 'object' } }).some(m => /expected object but got null/.test(m)));
    assert.deepEqual(violations({ x: null }, { x: { type: 'null' } }), []);
  });

  it('type:unknown passes anything', () => {
    assert.deepEqual(violations({ a: 1, b: 'x', c: [1], d: null }, { a: 'unknown', b: 'unknown', c: 'unknown', d: 'unknown' }), []);
  });

  it('flags a non-object root (array/scalar/null) clearly, even with all-optional schema', () => {
    for (const root of [[1, 2], 'hello', 42, null] as unknown[]) {
      const v = violations(root, { name: 'string' });
      assert.ok(v.some(m => /^expected an object at the root but got /.test(m)), `root ${JSON.stringify(root)} → ${JSON.stringify(v)}`);
    }
  });

  it('type:object rejects an array value', () => {
    assert.ok(violations({ owner: [1] }, { owner: { type: 'object', properties: { id: { type: 'string', required: true } } } })
      .some(m => /field "owner" expected object but got array/.test(m)));
  });

  it('enum matches strictly and supports number/boolean/null entries', () => {
    assert.deepEqual(violations({ n: 2, b: true, z: null }, { n: { enum: [1, 2, 3] }, b: { enum: [true, false] }, z: { enum: [null] } }), []);
    // strict: string "2" is not number 2
    assert.ok(violations({ n: '2' }, { n: { enum: [1, 2] } }).some(m => /is not one of/.test(m)));
  });

  it('allows extra/unknown keys (open schema)', () => {
    assert.deepEqual(violations({ name: 'x', extra: 'ok', more: [1] }, { name: { type: 'string', required: true } }), []);
  });
});

describe('validateFileReadSchemas — load-time shape (#80)', () => {
  const flow = (fileRead: Record<string, unknown>): Flow => ({
    key: 'f', name: 'F', inputs: {},
    steps: [{ id: 'r', name: 'r', type: 'file-read', fileRead }],
  } as unknown as Flow);
  const paths = (f: Flow) => validateFlow(f).map(e => e.path);

  it('accepts a valid schema with parseJson:true', () => {
    assert.deepEqual(validateFlow(flow({ path: './c.json', parseJson: true, schema: {
      name: { type: 'string', required: true }, mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: 'string', minItems: 1, maxItems: 5 },
    } })), []);
  });

  it('errors when schema is set without parseJson:true', () => {
    const errs = validateFlow(flow({ path: './c.json', schema: { x: 'string' } }));
    assert.ok(errs.some(e => e.path === 'steps[0].fileRead.schema' && /only checked when parseJson:true/.test(e.message)));
  });

  it('flags an unknown leaf type', () => {
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: 'strngg' } })).includes('steps[0].fileRead.schema.x'));
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'blob' } } })).includes('steps[0].fileRead.schema.x.type'));
  });

  it('flags empty enum and bad enum entries', () => {
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { enum: [] } } })).includes('steps[0].fileRead.schema.x.enum'));
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { enum: [{ a: 1 }] } } })).includes('steps[0].fileRead.schema.x.enum'));
  });

  it('requires type:array for any array constraint (items/minItems/maxItems/length)', () => {
    for (const rule of [{ items: 'number' }, { minItems: 1 }, { maxItems: 2 }, { length: 2 }, { type: 'string', items: 'number' }]) {
      assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: rule } })).includes('steps[0].fileRead.schema.x.type'),
        `expected type-gate error for ${JSON.stringify(rule)}`);
    }
    // valid when type:array is declared
    assert.deepEqual(validateFlow(flow({ path: 'c', parseJson: true, schema: { x: { type: 'array', items: 'number', minItems: 1 } } })), []);
  });

  it('requires type:object for properties', () => {
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { properties: { y: 'string' } } } })).includes('steps[0].fileRead.schema.x.properties'));
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'string', properties: { y: 'string' } } } })).includes('steps[0].fileRead.schema.x.properties'));
    assert.deepEqual(validateFlow(flow({ path: 'c', parseJson: true, schema: { x: { type: 'object', properties: { y: 'string' } } } })), []);
  });

  it('reports an items-descriptor error under a clean .items path (no synthetic [])', () => {
    const p = paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'array', items: { type: 'bogus' } } } }));
    assert.ok(p.includes('steps[0].fileRead.schema.x.items.type'), `got ${JSON.stringify(p)}`);
    assert.ok(!p.some(s => s.includes('[]')), 'no synthetic [] segment should leak into paths');
  });

  it('flags bad array-length bounds', () => {
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'array', minItems: -1 } } })).includes('steps[0].fileRead.schema.x.minItems'));
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'array', minItems: 5, maxItems: 2 } } })).includes('steps[0].fileRead.schema.x.minItems'));
    assert.ok(paths(flow({ path: 'c', parseJson: true, schema: { x: { type: 'array', length: 2, minItems: 1 } } })).includes('steps[0].fileRead.schema.x.length'));
  });

  it('validates schemas inside nested blocks (parallel)', () => {
    const f = { key: 'f', name: 'F', inputs: {}, steps: [
      { id: 'p', name: 'p', type: 'parallel', parallel: { steps: [
        { id: 'r', name: 'r', type: 'file-read', fileRead: { path: 'c', parseJson: true, schema: { x: 'nope' } } },
      ] } },
    ] } as unknown as Flow;
    assert.ok(validateFlow(f).some(e => e.path === 'steps[0].parallel.steps[0].fileRead.schema.x'));
  });
});

describe('file-read schema — executor integration / onError (#80)', () => {
  let dir: string;
  let file: string;
  const api = {} as unknown as OneApi; // file-read needs no API

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-fr-schema-'));
    file = path.join(dir, 'config.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const schema = { name: { type: 'string', required: true }, mode: { type: 'string', required: true, enum: ['dev', 'prod'] } };
  const flow = (onError?: unknown): Flow => ({
    key: 'f', name: 'F', inputs: {},
    steps: [
      { id: 'read', name: 'read', type: 'file-read', ...(onError ? { onError } : {}), fileRead: { path: file, parseJson: true, schema } },
      { id: 'after', name: 'after', type: 'code', code: { source: 'return { ran: true };' } },
    ],
  } as unknown as Flow);

  it('onError:continue → step failed with errorCode SCHEMA_VALIDATION, downstream runs', async () => {
    fs.writeFileSync(file, JSON.stringify({ name: 'svc' }));   // missing required mode
    const ctx = await executeFlow(flow({ strategy: 'continue' }), {}, api, 'admin', ['*']);
    assert.equal(ctx.steps.read.status, 'failed');
    assert.equal(ctx.steps.read.errorCode, 'SCHEMA_VALIDATION');
    assert.match(String(ctx.steps.read.error), /field "mode" is required but missing/);
    assert.equal(ctx.steps.after.status, 'success');   // run continued
  });

  it('default fail → schema mismatch aborts the run', async () => {
    fs.writeFileSync(file, JSON.stringify({ name: 'svc', mode: 'qa' }));   // bad enum
    await assert.rejects(() => executeFlow(flow(), {}, api, 'admin', ['*']), /SCHEMA_VALIDATION|is not one of/);
  });

  it('conforming file → success', async () => {
    fs.writeFileSync(file, JSON.stringify({ name: 'svc', mode: 'dev' }));
    const ctx = await executeFlow(flow(), {}, api, 'admin', ['*']);
    assert.equal(ctx.steps.read.status, 'success');
    assert.deepEqual(ctx.steps.read.output, { name: 'svc', mode: 'dev' });
  });

  it('retryOn:[SCHEMA_VALIDATION] re-reads + re-validates (recovers when the file is fixed mid-retry)', async () => {
    fs.writeFileSync(file, JSON.stringify({ name: 'svc' }));   // initially invalid
    // Fix the file shortly after the run starts, before retries are exhausted.
    setTimeout(() => fs.writeFileSync(file, JSON.stringify({ name: 'svc', mode: 'dev' })), 40);
    const ctx = await executeFlow(
      flow({ strategy: 'retry', retries: 5, retryDelayMs: 30, retryOn: ['SCHEMA_VALIDATION'] }),
      {}, api, 'admin', ['*'],
    );
    assert.equal(ctx.steps.read.status, 'success');
  });
});
