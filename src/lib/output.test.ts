import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { silenceWarningsInAgentMode } from './output.js';

// #88: in --agent mode, process warnings (e.g. Node's experimental-feature
// warnings) must not be emitted, so they can't interleave with the JSON a
// machine consumer parses off stdout/stderr.

describe('silenceWarningsInAgentMode (#88)', () => {
  let origArgv: string[];
  let origAgentEnv: string | undefined;
  let origNoWarn: string | undefined;
  let origEmit: typeof process.emitWarning;

  beforeEach(() => {
    origArgv = process.argv;
    origAgentEnv = process.env.ONE_AGENT;
    origNoWarn = process.env.NODE_NO_WARNINGS;
    origEmit = process.emitWarning;
    delete process.env.ONE_AGENT;
    delete process.env.NODE_NO_WARNINGS;
  });

  afterEach(() => {
    process.argv = origArgv;
    if (origAgentEnv === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = origAgentEnv;
    if (origNoWarn === undefined) delete process.env.NODE_NO_WARNINGS; else process.env.NODE_NO_WARNINGS = origNoWarn;
    process.emitWarning = origEmit;
  });

  it('is a no-op in human mode — warnings still fire', () => {
    process.argv = ['node', 'one', 'actions', 'search', 'gmail', 'x'];
    silenceWarningsInAgentMode();
    assert.equal(process.emitWarning, origEmit, 'emitWarning must be untouched in human mode');
    assert.equal(process.env.NODE_NO_WARNINGS, undefined);
  });

  it('suppresses emitWarning when --agent is in argv', () => {
    process.argv = ['node', 'one', '--agent', 'actions', 'execute', 'x', 'y', 'z'];
    let fired = false;
    process.on('warning', () => { fired = true; });
    silenceWarningsInAgentMode();
    process.emitWarning('Fetch API is an experimental feature');
    process.removeAllListeners('warning');
    assert.equal(fired, false, 'no warning should propagate after suppression');
    assert.equal(process.env.NODE_NO_WARNINGS, '1');
  });

  it('suppresses when ONE_AGENT=1 even without the flag', () => {
    process.argv = ['node', 'one', 'actions', 'execute', 'x', 'y', 'z'];
    process.env.ONE_AGENT = '1';
    silenceWarningsInAgentMode();
    assert.notEqual(process.emitWarning, origEmit, 'emitWarning must be replaced under ONE_AGENT=1');
    assert.equal(process.env.NODE_NO_WARNINGS, '1');
  });
});
