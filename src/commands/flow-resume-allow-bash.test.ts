import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'commander';

import { program } from '../cli.js';

// Regression cover for INT-4409: `flow resume` was registered with ZERO
// options, and flowResumeCommand never passed `allowBash` to runner.resume.
// FlowRunner.resume accepts it — it was simply never populated, and no flag
// existed to populate it from. So resuming any flow with a bash step threw
// "Bash steps require --allow-bash flag for security" with no way to satisfy
// it, making a paused or failed bash flow permanently unrecoverable.

function sub(parent: Command, name: string): Command {
  const found = parent.commands.find(c => c.name() === name);
  assert.ok(found, `expected a "${name}" command`);
  return found;
}

const flow = sub(program, 'flow');

describe('flow resume --allow-bash (INT-4409)', () => {
  it('registers the flag', () => {
    const resume = sub(flow, 'resume');
    const opt = resume.options.find(o => o.long === '--allow-bash');
    assert.ok(opt, 'flow resume must accept --allow-bash, or bash flows cannot be resumed at all');
  });

  it('maps the flag to the `allowBash` property the handler reads', () => {
    // The half-fix this guards against: registering the flag but reading a
    // differently-named property, which commander would leave undefined —
    // the gate would still reject and nothing would look wrong.
    const resume = sub(flow, 'resume');
    const opt = resume.options.find(o => o.long === '--allow-bash')!;
    assert.equal(opt.attributeName(), 'allowBash');
  });

  it('is a boolean flag, not one taking a value', () => {
    const resume = sub(flow, 'resume');
    const opt = resume.options.find(o => o.long === '--allow-bash')!;
    assert.equal(opt.required, false, '--allow-bash must not require an argument');
    assert.equal(opt.optional, false);
  });

  it('matches how `flow execute` declares the same flag', () => {
    // The two commands gate the same engine behaviour; a mismatch in shape is
    // how they drifted apart in the first place.
    const execOpt = sub(flow, 'execute').options.find(o => o.long === '--allow-bash');
    const resumeOpt = sub(flow, 'resume').options.find(o => o.long === '--allow-bash');
    assert.ok(execOpt && resumeOpt);
    assert.equal(resumeOpt!.attributeName(), execOpt!.attributeName());
    assert.equal(resumeOpt!.required, execOpt!.required);
  });
});
