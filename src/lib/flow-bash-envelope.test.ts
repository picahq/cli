import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapClaudeEnvelope, executeFlow } from './flow-engine.js';
import type { OneApi } from './api.js';
import type { Flow, FlowContext, FlowEvent, FlowStep } from './flow-types.js';

// #90/#68: `parseEnvelope` on bash steps unwraps the `claude --print
// --output-format json` envelope — envelope detection + fence strip + preamble
// removal — so flows stop re-implementing it. Bad JSON fails the step.

const env = (result: string) => JSON.stringify({ type: 'result', result });

describe('unwrapClaudeEnvelope (#90)', () => {
  it('unwraps a fenced-JSON envelope', () => {
    assert.deepEqual(unwrapClaudeEnvelope(env('```json\n{"a":1,"b":2}\n```'), 's'), { a: 1, b: 2 });
  });

  it('unwraps an envelope whose result is bare JSON (no fences)', () => {
    assert.deepEqual(unwrapClaudeEnvelope(env('{"a":1}'), 's'), { a: 1 });
  });

  it('strips conversational preamble before the JSON', () => {
    assert.deepEqual(unwrapClaudeEnvelope(env('Here is the analysis:\n{"score":9}'), 's'), { score: 9 });
  });

  it('strips trailing text after the JSON', () => {
    assert.deepEqual(unwrapClaudeEnvelope(env('{"done":true}\n\nLet me know if you need more!'), 's'), { done: true });
  });

  it('handles an array payload', () => {
    assert.deepEqual(unwrapClaudeEnvelope(env('```json\n[1,2,3]\n```'), 's'), [1, 2, 3]);
  });

  it('accepts a bare result string as stdout (not wrapped in an envelope)', () => {
    assert.deepEqual(unwrapClaudeEnvelope('```json\n{"x":true}\n```', 's'), { x: true });
  });

  it('passes through top-level JSON that is already unwrapped (not the envelope)', () => {
    assert.deepEqual(unwrapClaudeEnvelope('{"already":"clean"}', 's'), { already: 'clean' });
  });

  it('throws (with a snippet) when the unwrapped payload is not valid JSON', () => {
    assert.throws(
      () => unwrapClaudeEnvelope(env('I could not complete that request.'), 'analyze'),
      /parseEnvelope: claude output was not valid JSON/,
    );
  });
});

// ── integration through executeFlow + a real bash step ──

const fakeApi = {} as unknown as OneApi;

async function runBash(command: string, parseEnvelope: boolean): Promise<FlowContext> {
  const flow = {
    key: 'k', name: 'n', version: '1', inputs: {},
    steps: [{ id: 'llm', name: 'LLM', type: 'bash', bash: { command, parseEnvelope } }] as unknown as FlowStep[],
  } as unknown as Flow;
  const events: FlowEvent[] = [];
  return executeFlow(flow, {}, fakeApi, 'write', [], { allowBash: true, onEvent: e => events.push(e) });
}

describe('bash step parseEnvelope — integration (#90)', () => {
  it('unwraps a real claude-style envelope from stdout into step output', async () => {
    // printf emits the raw envelope JSON; \n inside the result is JSON-escaped.
    const envelopeText = '{"type":"result","result":"```json\\n{\\"ok\\":true,\\"n\\":2}\\n```"}';
    const ctx = await runBash(`printf '%s' '${envelopeText}'`, true);
    assert.equal(ctx.steps.llm.status, 'success');
    assert.deepEqual(ctx.steps.llm.output, { ok: true, n: 2 });
    // raw stdout is still available on response
    assert.match(String((ctx.steps.llm.response as { stdout: string }).stdout), /"type":"result"/);
  });

  it('fails the step when parseEnvelope output is not valid JSON', async () => {
    const bad = '{"type":"result","result":"sorry, no JSON here"}';
    await assert.rejects(
      () => runBash(`printf '%s' '${bad}'`, true),
      /parseEnvelope: claude output was not valid JSON/,
    );
  });
});
