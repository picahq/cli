import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFlowResultFile } from './flow.js';
import type { StepResult } from '../lib/flow-types.js';

// #87: large flow results must be writable to a file as valid JSON without
// building one giant string for stdout. writeFlowResultFile streams the
// envelope, serializing each step separately.

describe('writeFlowResultFile (#87)', () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-flow-out-'));
    out = path.join(dir, 'result.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const meta = { runId: 'run_1', logFile: '/tmp/x.log', status: 'success' };

  it('writes a valid, well-formed envelope for multiple steps', async () => {
    const steps: Record<string, StepResult> = {
      a: { status: 'success', output: { n: 1 } },
      b: { status: 'skipped' },
      c: { status: 'success', output: { list: [1, 2, 3] } },
    };
    const abs = await writeFlowResultFile(out, meta, steps);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    assert.equal(parsed.event, 'workflow:result');
    assert.equal(parsed.runId, 'run_1');
    assert.equal(parsed.status, 'success');
    assert.deepEqual(Object.keys(parsed.steps), ['a', 'b', 'c']);
    assert.deepEqual(parsed.steps.a.output, { n: 1 });
    assert.equal(parsed.steps.b.status, 'skipped');
    assert.deepEqual(parsed.steps.c.output.list, [1, 2, 3]);
  });

  it('produces valid JSON with zero steps', async () => {
    const abs = await writeFlowResultFile(out, meta, {});
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    assert.deepEqual(parsed.steps, {});
  });

  it('escapes special characters in step ids and values', async () => {
    const steps: Record<string, StepResult> = {
      'weird"id\nwith\tchars': { status: 'success', output: { s: 'quote " and \\ backslash' } },
    };
    const abs = await writeFlowResultFile(out, meta, steps);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    assert.equal(parsed.steps['weird"id\nwith\tchars'].output.s, 'quote " and \\ backslash');
  });

  it('round-trips a large aggregate result', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: 'x'.repeat(40) }));
    const steps: Record<string, StepResult> = { big: { status: 'success', output: { rows } } };
    const abs = await writeFlowResultFile(out, meta, steps);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    assert.equal(parsed.steps.big.output.rows.length, 5000);
    assert.equal(parsed.steps.big.output.rows[4999].id, 4999);
  });
});
