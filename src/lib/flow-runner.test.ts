import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripStepsAlias } from './flow-runner.js';

// #152: persisted run-state must not embed the `_steps` alias (a full copy of
// each sub-flow's step map), which duplicated the sub-flow tree at every
// nesting level and produced 150MB state files. The replacer drops `_steps`
// everywhere while preserving the flattened fields and the by-step-id nested
// paths that resume relies on.

// Mirrors flow-engine's flattenedOutput shape for a 2-level nested sub-flow.
function nestedContext() {
  const constantsSteps = { load: { status: 'success', output: { CHART_URL: 'https://x', API_KEY: 'k' } } };
  const midOutput = {
    // by-step-id spread (legacy nested path)
    c1: { status: 'success', output: { ...constantsSteps, CHART_URL: 'https://x', _steps: constantsSteps } },
    agg: { status: 'success', output: { ok: true } },
    // flattened final field
    ok: true,
    _steps: { c1: { output: { _steps: constantsSteps } }, agg: { output: { ok: true } } },
  };
  return {
    input: {},
    env: {},
    loop: {},
    steps: {
      loadConfig: { status: 'success', output: midOutput, response: midOutput },
      done: { status: 'success', output: { finished: true } },
    },
  };
}

describe('stripStepsAlias — persisted state replacer (#152)', () => {
  it('removes every _steps key at all nesting depths', () => {
    const json = JSON.stringify(nestedContext(), stripStepsAlias);
    assert.equal(json.includes('"_steps"'), false, 'no _steps should survive in persisted state');
  });

  it('preserves flattened fields and by-step-id nested paths used on resume', () => {
    const round = JSON.parse(JSON.stringify(nestedContext(), stripStepsAlias));
    const lc = round.steps.loadConfig.output;
    // flattened final field
    assert.equal(lc.ok, true);
    // by-step-id nested path: loadConfig.output.c1.output.CHART_URL
    assert.equal(lc.c1.output.CHART_URL, 'https://x');
    // output/response identity preserved (both serialized, both stripped)
    assert.equal(round.steps.loadConfig.response.ok, true);
    // unrelated step output intact
    assert.equal(round.steps.done.output.finished, true);
  });

  it('is a plain passthrough for non-_steps keys', () => {
    assert.equal(stripStepsAlias('output', { a: 1 }) instanceof Object, true);
    assert.equal(stripStepsAlias('_steps', { huge: 'map' }), undefined);
    assert.equal(stripStepsAlias('foo', 'bar'), 'bar');
  });

  it('shrinks the serialized size versus an unstripped stringify', () => {
    const ctx = nestedContext();
    const withAlias = JSON.stringify(ctx).length;
    const stripped = JSON.stringify(ctx, stripStepsAlias).length;
    assert.ok(stripped < withAlias, 'stripped state must be smaller');
  });
});
