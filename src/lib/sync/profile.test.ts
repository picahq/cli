import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeProfile } from './profile.js';
import type { SyncProfile } from './types.js';

let tmpDir: string;
let cwd: string;

before(() => {
  cwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-sync-profile-test-'));
  process.chdir(tmpDir);
});

after(() => {
  process.chdir(cwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseProfile: SyncProfile = {
  platform: 'gmail',
  model: 'threads',
  actionId: 'conn_mod_def::abc',
  resultsPath: 'threads',
  idField: 'id',
  pagination: { type: 'none' },
};

describe('writeProfile connection validation', () => {
  it('accepts a profile with `connection` ref alone', () => {
    const profile: SyncProfile = {
      ...baseProfile,
      model: 'threads-conn',
      connection: { platform: 'gmail' },
    };
    assert.doesNotThrow(() => writeProfile(profile));
  });

  it('accepts a profile with legacy `connectionKey` alone', () => {
    const profile: SyncProfile = {
      ...baseProfile,
      model: 'threads-key',
      connectionKey: 'live::gmail::default::abc',
    };
    assert.doesNotThrow(() => writeProfile(profile));
  });

  it('rejects a profile with both `connectionKey` and `connection`', () => {
    const profile: SyncProfile = {
      ...baseProfile,
      model: 'threads-both',
      connectionKey: 'live::gmail::default::abc',
      connection: { platform: 'gmail' },
    };
    assert.throws(() => writeProfile(profile), /both `connectionKey` and `connection`/);
  });

  it('rejects a profile with neither `connectionKey` nor `connection`', () => {
    const profile: SyncProfile = {
      ...baseProfile,
      model: 'threads-neither',
    };
    assert.throws(() => writeProfile(profile), /Missing connection/);
  });

  it('accepts a `connection` ref with a tag', () => {
    const profile: SyncProfile = {
      ...baseProfile,
      model: 'threads-tag',
      connection: { platform: 'gmail', tag: 'work@example.com' },
    };
    assert.doesNotThrow(() => writeProfile(profile));
  });
});
