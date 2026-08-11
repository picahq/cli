import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { getAllAgents, getAgentConfigPath } from './agents.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

// Regression cover for a module-load capture in agents.ts.
//
// The agent list used to be a module-scope `const AGENTS = [...]`. On POSIX the
// entries held lazy `~/...` strings, but on win32 the Windsurf / Cursor /
// Claude-Desktop helpers return ABSOLUTE paths built from the home directory —
// so importing the module bound the real home on Windows and nothing could
// redirect it afterwards. The platform asymmetry is what made it invisible:
// the same code was lazy on the maintainers' machines and eager on Windows.

describe('agent config paths resolve lazily', () => {
  let saved: HomeEnvSnapshot;
  beforeEach(() => { saved = snapshotHomeEnv(); });
  afterEach(() => { restoreHomeEnv(saved); });

  it('follows the home directory when it changes after import', () => {
    const a = path.join(os.tmpdir(), 'one-agents-home-a');
    const b = path.join(os.tmpdir(), 'one-agents-home-b');

    setHomeTo(a);
    const first = getAllAgents().map(ag => getAgentConfigPath(ag));
    setHomeTo(b);
    const second = getAllAgents().map(ag => getAgentConfigPath(ag));

    assert.equal(first.length, second.length);
    assert.ok(first.length > 0, 'expected at least one agent');

    // Every path that was under sandbox A must now be under sandbox B. A
    // module-load capture would leave the second run still pointing at A.
    for (let i = 0; i < first.length; i++) {
      if (!first[i].startsWith(a)) continue; // not home-rooted (e.g. %APPDATA%)
      assert.ok(
        second[i].startsWith(b),
        `agent path did not follow the home change: ${first[i]} -> ${second[i]}`,
      );
    }
  });

  it('never resolves an agent path inside the real home while sandboxed', () => {
    const realHome = os.homedir();
    const sandbox = path.join(os.tmpdir(), 'one-agents-sandbox');
    setHomeTo(sandbox);

    for (const agent of getAllAgents()) {
      const p = getAgentConfigPath(agent);
      assert.equal(
        p.startsWith(realHome + path.sep),
        false,
        `${agent.id} resolved into the real home while sandboxed: ${p}`,
      );
    }
  });

  it('leaves no unexpanded ~ prefix in a resolved path', () => {
    setHomeTo(path.join(os.tmpdir(), 'one-agents-tilde'));
    for (const agent of getAllAgents()) {
      const p = getAgentConfigPath(agent);
      // Only a LEADING ~ means expandPath didn't run. A bare `includes('~')`
      // false-positives on Windows 8.3 short names like `C:\Users\DEATHS~1`.
      assert.equal(p.startsWith('~'), false, `${agent.id} path was not expanded: ${p}`);
    }
  });
});
