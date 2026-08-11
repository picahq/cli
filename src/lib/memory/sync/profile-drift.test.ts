import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findMissingBuiltinCapabilities, loadBuiltinProfile } from './builtin-profiles.js';
import { collectIdentityKeys } from './mem-writer.js';
import type { SyncProfile } from './types.js';

// Cover for the #129/#130 upgrade-path gap: `sync run` resolves profiles with
// readProfile() alone and never merges or diffs against the shipped built-in.
// So identity keys shipped in #167 reached nobody who had already run
// `sync init` — silently, with no warning and no change in record counts.

describe('findMissingBuiltinCapabilities', () => {
  it('reports a capability the built-in declares and the installed copy lacks', () => {
    // The real gmail built-in declares identityKeys; a pre-#167 installed
    // profile would not have the key at all.
    const installed = { platform: 'gmail', model: 'gmailThreads', enrich: {}, dateFilter: {} };
    const missing = findMissingBuiltinCapabilities('gmail', 'gmailThreads', installed);
    assert.ok(missing.includes('identityKeys'), `expected identityKeys in ${JSON.stringify(missing)}`);
  });

  it('reports nothing when the installed profile already has the field', () => {
    const installed = {
      platform: 'gmail',
      model: 'gmailThreads',
      identityKeys: [{ prefix: 'email', path: 'x' }],
      enrich: {},
      dateFilter: {},
      memory: {},
    };
    assert.deepEqual(findMissingBuiltinCapabilities('gmail', 'gmailThreads', installed), []);
  });

  it('does not nag about fields a user may have deliberately removed', () => {
    // `transform` / `exclude` / `onChange` are user-editable and must never
    // be reported, even when the built-in sets them.
    const installed = { platform: 'gmail', model: 'gmailThreads', identityKeys: [], enrich: {}, dateFilter: {}, memory: {} };
    const missing = findMissingBuiltinCapabilities('gmail', 'gmailThreads', installed);
    for (const noisy of ['transform', 'exclude', 'onChange', 'queryParams', 'pathVars']) {
      assert.equal(missing.includes(noisy), false, `${noisy} must not be reported as drift`);
    }
  });

  it('returns nothing when there is no built-in for the platform/model', () => {
    assert.deepEqual(findMissingBuiltinCapabilities('nosuch', 'nomodel', { a: 1 }), []);
  });

  it('returns nothing when no profile is installed', () => {
    assert.deepEqual(findMissingBuiltinCapabilities('gmail', 'gmailThreads', null), []);
    assert.deepEqual(findMissingBuiltinCapabilities('gmail', 'gmailThreads', undefined), []);
  });

  it('treats an explicitly-empty value as present, not missing', () => {
    // Someone who set `identityKeys: []` has made a choice; do not nag.
    const installed = { identityKeys: [], enrich: {}, dateFilter: {}, memory: {} };
    assert.equal(findMissingBuiltinCapabilities('gmail', 'gmailThreads', installed).includes('identityKeys'), false);
  });
});

describe('gmail/gmailThreads collects Bcc participants (#129)', () => {
  it('resolves Bcc alongside From/To/Cc', () => {
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    const thread = {
      messages: [
        {
          payload: {
            headers: [
              { name: 'From', value: 'Moe <moe@withone.ai>' },
              { name: 'To', value: 'jane@acme.com' },
              { name: 'Cc', value: 'boss@acme.com' },
              { name: 'Bcc', value: 'Silent <silent@acme.com>' },
            ],
          },
        },
      ],
    };
    const keys = collectIdentityKeys(thread, profile);
    assert.ok(
      keys.includes('email:silent@acme.com'),
      `Bcc participant missing from ${JSON.stringify(keys)}`,
    );
  });

  it('still resolves nothing extra when a thread has no Bcc header', () => {
    // Gmail only returns Bcc on messages the authenticated user sent, so the
    // common case must be unaffected.
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    const thread = { messages: [{ payload: { headers: [{ name: 'From', value: 'a@b.com' }] } }] };
    assert.deepEqual(collectIdentityKeys(thread, profile), ['email:a@b.com']);
  });
});
