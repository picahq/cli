import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliVersion } from './version.js';

// The old code did `require('../package.json')` from two levels down, which
// only resolves in the bundled dist/ layout. From source it threw
// MODULE_NOT_FOUND in update.ts (so importing the command tree died outright)
// and was silently swallowed in analytics.ts (so every dev telemetry event
// reported version "unknown").

describe('cliVersion', () => {
  it('resolves the real version from a source checkout', () => {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json',
    );
    const expected = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string }).version;

    assert.equal(cliVersion(), expected);
  });

  it('never returns the "unknown" fallback here', () => {
    // The fallback exists for exotic layouts. Hitting it in this repo means
    // the walk broke, which is exactly the silent failure analytics had.
    assert.notEqual(cliVersion(), 'unknown');
  });

  it('looks like a semver', () => {
    assert.match(cliVersion(), /^\d+\.\d+\.\d+/);
  });

  it('is stable across calls', () => {
    assert.equal(cliVersion(), cliVersion());
  });
});
