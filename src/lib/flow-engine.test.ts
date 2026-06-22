import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, evaluateExpression } from './flow-engine.js';
import type { FlowContext, StepResult } from './flow-types.js';

// Regression coverage for #89: step-level `if`/`unless` (and `while` /
// `condition` steps) must not crash when a condition references a skipped or
// not-yet-produced step output. A missing upstream value makes the condition
// false instead of throwing "Cannot read properties of undefined".

function ctx(steps: Record<string, StepResult> = {}): FlowContext {
  return { input: {}, env: {}, steps, loop: {} };
}

describe('evaluateCondition — null-safe condition evaluation (#89)', () => {
  it('returns false when referencing the output of a skipped step (no output key)', () => {
    // Exactly the #89 repro: stepA was skipped, so it has { status: 'skipped' }
    // with no `output`. stepB's `if` reads $.steps.stepA.output.result.
    const context = ctx({ stepA: { status: 'skipped' } });
    assert.equal(evaluateCondition('$.steps.stepA.output.result', context), false);
  });

  it('returns false when referencing a step that never ran at all', () => {
    assert.equal(evaluateCondition('$.steps.neverRan.output.value === true', ctx()), false);
  });

  it('returns false for deep access through several missing segments', () => {
    assert.equal(evaluateCondition('$.steps.a.output.b.c.d', ctx()), false);
  });

  it('still evaluates truthy/falsy correctly when the value is present', () => {
    const context = ctx({ stepA: { status: 'success', output: { result: 'hello' } } });
    assert.equal(evaluateCondition('$.steps.stepA.output.result', context), true);
    assert.equal(evaluateCondition("$.steps.stepA.output.result === 'hello'", context), true);
    assert.equal(evaluateCondition("$.steps.stepA.output.result === 'nope'", context), false);
  });

  it('coerces non-boolean truthy results to a real boolean', () => {
    const context = ctx({ s: { status: 'success', output: { n: 0, str: 'x' } } });
    assert.strictEqual(evaluateCondition('$.steps.s.output.n', context), false);
    assert.strictEqual(evaluateCondition('$.steps.s.output.str', context), true);
  });

  it('reads input/env without crashing', () => {
    const context: FlowContext = { input: { flag: true }, env: { X: '1' }, steps: {}, loop: {} };
    assert.equal(evaluateCondition('$.input.flag', context), true);
    assert.equal(evaluateCondition('$.input.missing', context), false);
  });

  it('rethrows genuine syntax errors (does not swallow malformed expressions)', () => {
    assert.throws(() => evaluateCondition('$.steps.a.output.(', ctx()), SyntaxError);
  });

  it('rethrows reference errors for unknown bare identifiers', () => {
    assert.throws(() => evaluateCondition('someUndefinedGlobal === 1', ctx()), ReferenceError);
  });

  it('leaves evaluateExpression (transforms) throwing on undefined access', () => {
    // Transforms must still fail loudly — their output feeds downstream steps.
    assert.throws(() => evaluateExpression('$.steps.gone.output.x', ctx()), TypeError);
  });
});
