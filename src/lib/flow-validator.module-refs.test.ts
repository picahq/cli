import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateFlow } from './flow-validator.js';
import type { Flow } from './flow-types.js';

// #75: forward/undefined $.steps and $.input references inside an external
// code.module .mjs file must be caught by `flow validate`, the same as inline
// code.source. Requires rootDir (the module file is read from disk).

describe('flow validate — references inside code.module files (#75)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-modref-'));
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function writeModule(name: string, body: string): void {
    fs.writeFileSync(path.join(dir, 'lib', name), body);
  }

  const baseFlow = (steps: Flow['steps']): Flow => ({
    key: 'modflow', name: 'Mod', inputs: {}, steps,
  } as Flow);

  it('flags a forward reference to a later step from inside a module', () => {
    writeModule('cache.mjs', 'const $ = {}; const r = $.steps.buildResult.output; void r;');
    const flow = baseFlow([
      { id: 'buildCacheEntry', name: 'cache', type: 'code', code: { module: 'lib/cache.mjs' } },
      { id: 'buildResult', name: 'result', type: 'code', code: { source: "return {data:'x'};" } },
    ] as Flow['steps']);
    const errors = validateFlow(flow, dir);
    assert.ok(
      errors.some(e => e.path === 'steps[0].code.module' && /declared after the current step/.test(e.message)),
      `expected a forward-ref error on the module; got ${JSON.stringify(errors)}`,
    );
  });

  it('flags an undefined step reference from inside a module', () => {
    writeModule('m.mjs', 'const $ = {}; void $.steps.ghost.output;');
    const flow = baseFlow([
      { id: 'a', name: 'a', type: 'code', code: { module: 'lib/m.mjs' } },
    ] as Flow['steps']);
    const errors = validateFlow(flow, dir);
    assert.ok(errors.some(e => /references undefined step "ghost"/.test(e.message)));
  });

  it('flags an undefined input reference from inside a module', () => {
    writeModule('m.mjs', 'const $ = {}; void $.input.missing;');
    const flow = baseFlow([
      { id: 'a', name: 'a', type: 'code', code: { module: 'lib/m.mjs' } },
    ] as Flow['steps']);
    const errors = validateFlow(flow, dir);
    assert.ok(errors.some(e => /references undefined input "missing"/.test(e.message)));
  });

  it('passes when the module only references earlier steps and declared inputs', () => {
    writeModule('ok.mjs', 'const $ = {}; void $.steps.first.output; void $.input.token;');
    const flow: Flow = {
      key: 'modflow', name: 'Mod',
      inputs: { token: { type: 'string', required: false } },
      steps: [
        { id: 'first', name: 'first', type: 'code', code: { source: 'return {};' } },
        { id: 'second', name: 'second', type: 'code', code: { module: 'lib/ok.mjs' } },
      ],
    } as Flow;
    const errors = validateFlow(flow, dir);
    assert.deepEqual(errors, [], `expected no errors; got ${JSON.stringify(errors)}`);
  });

  it('does not scan module refs when rootDir is absent (no file access)', () => {
    // Without rootDir the validator can't read the file — must not crash, and
    // simply skips the module scan (validateCodeModules also needs rootDir).
    const flow = baseFlow([
      { id: 'a', name: 'a', type: 'code', code: { module: 'lib/whatever.mjs' } },
    ] as Flow['steps']);
    const errors = validateFlow(flow);
    assert.equal(errors.some(e => e.path.endsWith('.code.module')), false);
  });
});
