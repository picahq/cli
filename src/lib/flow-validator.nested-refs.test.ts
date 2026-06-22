import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow } from './flow-validator.js';
import type { Flow } from './flow-types.js';

// #58: a parallel/nested-block step stores its children directly in
// context.steps, so a step AFTER the block can reference them
// (`$.steps.parallelChild.status`). The validator must not flag those as
// forward references — while still catching genuine forward/intra-block ones.

const flow = (steps: unknown[]): Flow => ({ key: 'f', name: 'F', inputs: {}, steps } as Flow);

describe('flow validate — nested-block child references (#58)', () => {
  it('allows a later step to reference a parallel child', () => {
    const errors = validateFlow(flow([
      { id: 'block', name: 'block', type: 'parallel', parallel: { steps: [
        { id: 'fast', name: 'fast', type: 'code', code: { source: 'return {};' } },
        { id: 'slow', name: 'slow', type: 'code', code: { source: 'return {};' } },
      ] } },
      { id: 'gate', name: 'gate', type: 'code', code: { source: 'return { s: $.steps.slow.status };' } },
    ]));
    assert.deepEqual(errors, [], `expected no errors; got ${JSON.stringify(errors)}`);
  });

  it('allows a later step to reference a child of a condition branch', () => {
    const errors = validateFlow(flow([
      { id: 'cond', name: 'cond', type: 'condition', condition: {
        expression: 'true',
        then: [{ id: 'branchStep', name: 'b', type: 'code', code: { source: 'return {x:1};' } }],
      } },
      { id: 'after', name: 'after', type: 'code', code: { source: 'return { v: $.steps.branchStep.output };' } },
    ]));
    assert.deepEqual(errors, []);
  });

  it('still flags a genuine forward reference at the top level', () => {
    const errors = validateFlow(flow([
      { id: 'a', name: 'a', type: 'code', code: { source: 'return $.steps.b.output;' } },
      { id: 'b', name: 'b', type: 'code', code: { source: 'return {};' } },
    ]));
    assert.ok(errors.some(e => /references step "b" which is declared after/.test(e.message)));
  });

  it('still flags an intra-block forward reference (child reads a later sibling child)', () => {
    const errors = validateFlow(flow([
      { id: 'block', name: 'block', type: 'parallel', parallel: { steps: [
        { id: 'c1', name: 'c1', type: 'code', code: { source: 'return $.steps.c2.output;' } },
        { id: 'c2', name: 'c2', type: 'code', code: { source: 'return {};' } },
      ] } },
    ]));
    assert.ok(errors.some(e => /references step "c2" which is declared after/.test(e.message)));
  });

  it('still flags a reference to a nested child from BEFORE its containing block', () => {
    // `early` runs before `block`, so block's child `kid` is not yet available.
    const errors = validateFlow(flow([
      { id: 'early', name: 'early', type: 'code', code: { source: 'return $.steps.kid.output;' } },
      { id: 'block', name: 'block', type: 'parallel', parallel: { steps: [
        { id: 'kid', name: 'kid', type: 'code', code: { source: 'return {};' } },
      ] } },
    ]));
    assert.ok(errors.some(e => /references step "kid" which is declared after/.test(e.message)));
  });

  it('exposes deeply nested (grandchild) ids to later siblings', () => {
    const errors = validateFlow(flow([
      { id: 'outer', name: 'outer', type: 'parallel', parallel: { steps: [
        { id: 'inner', name: 'inner', type: 'parallel', parallel: { steps: [
          { id: 'grand', name: 'grand', type: 'code', code: { source: 'return {g:1};' } },
        ] } },
      ] } },
      { id: 'use', name: 'use', type: 'code', code: { source: 'return { g: $.steps.grand.output };' } },
    ]));
    assert.deepEqual(errors, []);
  });
});
