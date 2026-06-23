import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeFlow } from './flow-engine.js';
import { validateFlow } from './flow-validator.js';
import type { Flow } from './flow-types.js';
import type { OneApi } from './api.js';

// #93: a flow-level `defaultOnError` is inherited by every step without its own
// `onError`; a step opts out with its own `onError`. Scoped per-flow.

// executeFlow needs an api for action steps; these flows use only code steps,
// so a stub that's never called suffices.
const api = {} as unknown as OneApi;
const run = (flow: Flow) => executeFlow(flow, {}, api, 'admin', ['*']);

const boom = { id: 'boom', name: 'boom', type: 'code', code: { source: 'throw new Error("boom");' } };
const after = { id: 'after', name: 'after', type: 'code', code: { source: 'return { ran: true };' } };

describe('flow defaultOnError (#93)', () => {
  it('a failing step with no onError inherits the flow default (continue)', async () => {
    const ctx = await run({
      key: 'f', name: 'F', inputs: {},
      defaultOnError: { strategy: 'continue' },
      steps: [boom, after],
    } as Flow);
    assert.equal(ctx.steps.boom.status, 'failed');
    assert.equal(ctx.steps.after.status, 'success');   // downstream still ran
  });

  it('a step with its own onError overrides the flow default', async () => {
    await assert.rejects(() => run({
      key: 'f', name: 'F', inputs: {},
      defaultOnError: { strategy: 'continue' },
      steps: [{ ...boom, onError: { strategy: 'fail' } }, after],
    } as Flow), /boom/);
  });

  it('without a flow default, a failing step is still fatal (unchanged)', async () => {
    await assert.rejects(() => run({
      key: 'f', name: 'F', inputs: {}, steps: [boom, after],
    } as Flow), /boom/);
  });

  it('does not affect steps that succeed', async () => {
    const ctx = await run({
      key: 'f', name: 'F', inputs: {},
      defaultOnError: { strategy: 'continue' },
      steps: [after],
    } as Flow);
    assert.equal(ctx.steps.after.status, 'success');
    assert.deepEqual(ctx.steps.after.output, { ran: true });
  });

  it('validates defaultOnError.strategy', () => {
    const ok = validateFlow({ key: 'f', name: 'F', inputs: {}, defaultOnError: { strategy: 'continue' }, steps: [after] });
    assert.deepEqual(ok, []);
    const bad = validateFlow({ key: 'f', name: 'F', inputs: {}, defaultOnError: { strategy: 'bogus' }, steps: [after] });
    assert.ok(bad.some(e => e.path === 'defaultOnError.strategy'));
    const notObj = validateFlow({ key: 'f', name: 'F', inputs: {}, defaultOnError: 'continue', steps: [after] });
    assert.ok(notObj.some(e => e.path === 'defaultOnError'));
  });
});
