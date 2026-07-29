import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dryResolveStep,
  dryResolveAllSteps,
  executeFlow,
  FlowStopSignal,
} from './flow-engine.js';
import type { OneApi } from './api.js';
import type { Flow, FlowContext, FlowEvent, FlowStep } from './flow-types.js';

// Coverage for #97 — flow debug/inspect mode:
//   1. `--dry-run` resolves each step's interpolations (dryResolveStep / dryResolveAllSteps)
//   2. `--stop-after` halts execution after a target step (FlowStopSignal via executeFlow)
//   3. `--dry-run --stop-after` runs earlier steps for real, then dry-resolves the target

// executeFlow never touches the API for transform/file steps; a bare stub is enough.
const fakeApi = {} as unknown as OneApi;

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { input: {}, env: {}, steps: {}, loop: {}, ...over };
}

function flowOf(steps: FlowStep[], inputs: Flow['inputs'] = {}): Flow {
  return { key: 'test', name: 'Test', version: '1', inputs, steps } as unknown as Flow;
}

async function run(
  flow: Flow,
  inputs: Record<string, unknown>,
  options: Parameters<typeof executeFlow>[5] = {},
): Promise<{ context: FlowContext; events: FlowEvent[] }> {
  const events: FlowEvent[] = [];
  const context = await executeFlow(flow, inputs, fakeApi, 'write', [], {
    ...options,
    onEvent: e => events.push(e),
  });
  return { context, events };
}

// ── dryResolveStep ──────────────────────────────────────────────────────────

describe('dryResolveStep — expression steps (#97)', () => {
  it('evaluates a transform against the context', () => {
    const step = { id: 's', name: 'S', type: 'transform', transform: { expression: "$.input.name + '!'" } } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx({ input: { name: 'hi' } }));
    assert.equal(r.resolved, 'hi!');
    assert.equal(r.error, undefined);
    assert.deepEqual(r.references, []);
  });

  it('marks the step deferred (not errored) when it reads a step that has not run yet', () => {
    const step = { id: 's', name: 'S', type: 'transform', transform: { expression: '$.steps.gone.output.x' } } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx());
    assert.equal(r.deferred, true);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.references.map(x => x.selector), ['$.steps.gone']);
    assert.equal(r.references[0].status, 'deferred');
  });

  it('marks deferred when reading a loop var that is not in scope yet', () => {
    const step = { id: 's', type: 'transform', transform: { expression: '$.loop.item.id.toString()' } } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx());
    assert.equal(r.deferred, true);
    assert.equal(r.error, undefined);
  });

  it('still ERRORS on a missing field of a step that DID run (genuine wiring bug)', () => {
    // `ran` ran and produced {}, so $.steps.ran resolves — the throw is a real
    // missing-field bug, not "runs later". Must surface as an error.
    const step = { id: 's', type: 'transform', transform: { expression: '$.steps.ran.output.foo.bar' } } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx({ steps: { ran: { status: 'success', output: {} } } }));
    assert.equal(r.deferred, undefined);
    assert.match(r.error ?? '', /Cannot read properties of undefined/);
  });

  it('still ERRORS on a syntax error (never downgraded to deferred)', () => {
    const step = { id: 's', type: 'transform', transform: { expression: '$.steps.gone.output.(' } } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx());
    assert.equal(r.deferred, undefined);
    assert.ok(r.error, 'a syntax error is reported, not deferred');
  });

  it('evaluates a condition expression to a boolean-ish value', () => {
    const step = { id: 'c', type: 'condition', condition: { expression: '$.input.n > 3', then: [] } } as unknown as FlowStep;
    assert.equal(dryResolveStep(step, ctx({ input: { n: 5 } })).resolved, true);
  });

  it('handles a while condition expression', () => {
    const step = { id: 'w', type: 'while', while: { condition: '$.input.go', steps: [] } } as unknown as FlowStep;
    assert.equal(dryResolveStep(step, ctx({ input: { go: false } })).resolved, false);
  });
});

describe('dryResolveStep — declarative steps + reference classification (#97)', () => {
  it('classifies $.input refs that resolve as "resolved"', () => {
    const step = {
      id: 'a', type: 'action',
      action: { platform: 'x', actionId: 'y', connection: { platform: 'x' }, data: { to: '$.input.email' } },
    } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx({ input: { email: 'a@b.com' } }));
    const ref = r.references.find(x => x.selector === '$.input.email');
    assert.ok(ref);
    assert.equal(ref.status, 'resolved');
    assert.equal(ref.value, 'a@b.com');
  });

  it('classifies $.steps refs as "deferred" pre-execution (not a bug — runs later)', () => {
    const step = {
      id: 'a', type: 'action',
      action: { platform: 'x', actionId: 'y', connection: { platform: 'x' }, data: { id: '$.steps.fetch.output.id' } },
    } as unknown as FlowStep;
    const ref = dryResolveStep(step, ctx()).references.find(x => x.selector.startsWith('$.steps.'));
    assert.ok(ref);
    assert.equal(ref.status, 'deferred');
  });

  it('classifies an unknown $.input ref as "missing" (the actionable wiring signal)', () => {
    const step = {
      id: 'a', type: 'action',
      action: { platform: 'x', actionId: 'y', connection: { platform: 'x' }, data: { to: '$.input.typo' } },
    } as unknown as FlowStep;
    const ref = dryResolveStep(step, ctx({ input: { email: 'a@b.com' } })).references.find(x => x.selector === '$.input.typo');
    assert.ok(ref);
    assert.equal(ref.status, 'missing');
  });

  it('extracts selectors embedded inside {{ }} templates', () => {
    const step = {
      id: 'w', type: 'file-write',
      fileWrite: { path: 'out.txt', content: 'Hi {{$.input.name}} / {{$.steps.greet.output}}' },
    } as unknown as FlowStep;
    const r = dryResolveStep(step, ctx({ input: { name: 'world' } }));
    const sels = r.references.map(x => x.selector).sort();
    assert.deepEqual(sels, ['$.input.name', '$.steps.greet.output']);
    assert.equal(r.references.find(x => x.selector === '$.input.name')!.status, 'resolved');
    assert.equal(r.references.find(x => x.selector === '$.steps.greet.output')!.status, 'deferred');
  });

  it('resolves loop.over selectors', () => {
    const step = { id: 'l', type: 'loop', loop: { over: '$.steps.list.output.items', as: 'item', steps: [] } } as unknown as FlowStep;
    const ref = dryResolveStep(step, ctx()).references.find(x => x.selector === '$.steps.list.output.items');
    assert.equal(ref!.status, 'deferred');
  });

  it('does not descend into nested step arrays when collecting references', () => {
    const step = {
      id: 'l', type: 'loop',
      loop: { over: '$.input.items', as: 'item', steps: [
        { id: 'inner', type: 'transform', transform: { expression: '$.input.deep' } },
      ] },
    } as unknown as FlowStep;
    const sels = dryResolveStep(step, ctx({ input: { items: [1] } })).references.map(x => x.selector);
    assert.deepEqual(sels, ['$.input.items']);
  });

  it('reports "(no references)" cleanly for a config with no interpolations', () => {
    const step = { id: 'a', type: 'action', action: { platform: 'x', actionId: 'y', connection: { platform: 'x' }, data: { fixed: 'literal' } } } as unknown as FlowStep;
    assert.deepEqual(dryResolveStep(step, ctx()).references, []);
  });

  it('de-duplicates a selector used more than once', () => {
    const step = {
      id: 'a', type: 'action',
      action: { platform: 'x', actionId: 'y', connection: { platform: 'x' }, data: { a: '$.input.x', b: '$.input.x' } },
    } as unknown as FlowStep;
    const matches = dryResolveStep(step, ctx({ input: { x: 1 } })).references.filter(r => r.selector === '$.input.x');
    assert.equal(matches.length, 1);
  });
});

describe('dryResolveAllSteps — recurses into nested blocks (#97)', () => {
  it('flattens top-level and nested steps', () => {
    const steps = [
      { id: 'top', type: 'transform', transform: { expression: '1' } },
      { id: 'cond', type: 'condition', condition: { expression: 'true', then: [
        { id: 'inThen', type: 'transform', transform: { expression: '2' } },
      ], else: [
        { id: 'inElse', type: 'transform', transform: { expression: '3' } },
      ] } },
    ] as unknown as FlowStep[];
    const ids = dryResolveAllSteps(steps, ctx()).map(s => s.stepId);
    assert.deepEqual(ids, ['top', 'cond', 'inThen', 'inElse']);
  });
});

// ── --stop-after (FlowStopSignal via executeFlow) ────────────────────────────

describe('executeFlow — --stop-after (#97)', () => {
  const threeSteps = () => flowOf([
    { id: 's1', name: 'S1', type: 'transform', transform: { expression: "'a'" } },
    { id: 's2', name: 'S2', type: 'transform', transform: { expression: "'b'" } },
    { id: 's3', name: 'S3', type: 'transform', transform: { expression: "'c'" } },
  ] as unknown as FlowStep[]);

  it('executes up to and including the target, then stops', async () => {
    const { context, events } = await run(threeSteps(), {}, { stopAfter: 's2' });
    assert.ok(context.steps.s1, 's1 ran');
    assert.ok(context.steps.s2, 's2 ran');
    assert.equal(context.steps.s3, undefined, 's3 did NOT run');
    const stopped = events.find(e => e.event === 'flow:stopped');
    assert.ok(stopped, 'a flow:stopped event fired');
    assert.equal(stopped!.stoppedAfter, 's2');
    assert.equal(stopped!.dryRun, false);
  });

  it('does not throw — a stop is a clean return, not a failure', async () => {
    const { events } = await run(threeSteps(), {}, { stopAfter: 's1' });
    assert.equal(events.some(e => e.event === 'flow:error'), false);
    assert.equal(events.some(e => e.event === 'flow:complete'), false);
  });

  it('stop-after the last step behaves like a normal full run', async () => {
    const { context } = await run(threeSteps(), {}, { stopAfter: 's3' });
    assert.ok(context.steps.s1 && context.steps.s2 && context.steps.s3);
  });

  it('a FlowStopSignal carries the target step id', () => {
    const sig = new FlowStopSignal('abc');
    assert.equal(sig.stepId, 'abc');
    assert.ok(sig instanceof Error);
  });
});

describe('executeFlow — --stop-after into a nested block survives onError (#97)', () => {
  it('a stop signal from inside a loop is not swallowed by the loop\'s onError', async () => {
    const flow = flowOf([
      { id: 'before', type: 'transform', transform: { expression: "'x'" } },
      {
        id: 'theLoop', type: 'loop',
        onError: { strategy: 'continue' },
        loop: { over: '$.input.items', as: 'item', steps: [
          { id: 'inner', type: 'transform', transform: { expression: '$.loop.item' } },
        ] },
      },
      { id: 'after', type: 'transform', transform: { expression: "'y'" } },
    ] as unknown as FlowStep[], { items: { type: 'array', required: false, default: [1] } } as unknown as Flow['inputs']);

    const { context, events } = await run(flow, { items: [1] }, { stopAfter: 'inner' });
    assert.ok(context.steps.before, 'before ran');
    assert.equal(context.steps.after, undefined, 'after did NOT run — stop propagated past the loop');
    assert.equal(events.some(e => e.event === 'flow:error'), false);
    assert.equal(events.find(e => e.event === 'flow:stopped')!.stoppedAfter, 'inner');
  });
});

// ── --dry-run (no execution) ─────────────────────────────────────────────────

describe('executeFlow — plain --dry-run resolves without executing (#97)', () => {
  it('emits flow:dry-run with per-step resolution and runs nothing', async () => {
    const flow = flowOf([
      { id: 'greet', name: 'Greet', type: 'transform', transform: { expression: "$.input.name + ' the great'" } },
      { id: 'use', name: 'Use', type: 'file-write', fileWrite: { path: 'out.txt', content: 'X {{$.steps.greet.output}}' } },
    ] as unknown as FlowStep[], { name: { type: 'string', required: true } } as unknown as Flow['inputs']);

    const { context, events } = await run(flow, { name: 'world' }, { dryRun: true });
    assert.deepEqual(context.steps, {}, 'no steps executed');

    const dry = events.find(e => e.event === 'flow:dry-run');
    assert.ok(dry);
    const steps = dry!.steps as Array<{ stepId: string; resolved?: unknown; references: Array<{ selector: string; status: string }> }>;
    assert.equal(steps[0].resolved, 'world the great', 'transform evaluated against input');
    const deferred = steps[1].references.find(r => r.selector === '$.steps.greet.output');
    assert.equal(deferred!.status, 'deferred', '$.steps ref is deferred pre-run');
  });
});

// ── --dry-run --stop-after combo ─────────────────────────────────────────────

describe('executeFlow — --dry-run --stop-after resolves the target against REAL context (#97)', () => {
  it('runs earlier steps for real, then dry-resolves (does not execute) the target', async () => {
    const flow = flowOf([
      { id: 'greet', name: 'Greet', type: 'transform', transform: { expression: "$.input.name + ' the great'" } },
      { id: 'shout', name: 'Shout', type: 'transform', transform: { expression: '$.steps.greet.output.toUpperCase()' } },
    ] as unknown as FlowStep[], { name: { type: 'string', required: true } } as unknown as Flow['inputs']);

    const { context, events } = await run(flow, { name: 'world' }, { dryRun: true, stopAfter: 'shout' });

    assert.equal(context.steps.greet?.output, 'world the great', 'greet ran for real');
    assert.equal(context.steps.shout, undefined, 'shout was NOT executed');

    const resolveEvt = events.find(e => e.event === 'step:dry-resolve');
    assert.ok(resolveEvt, 'a step:dry-resolve event fired for the target');
    assert.equal(resolveEvt!.stepId, 'shout');
    // resolved against the REAL greet output — proves $.steps.* resolves in the combo
    assert.equal(resolveEvt!.resolved, 'WORLD THE GREAT');

    const stopped = events.find(e => e.event === 'flow:stopped');
    assert.equal(stopped!.dryRun, true);
  });
});
