import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFields } from './mem-writer.js';
import { loadBuiltinProfile } from './builtin-profiles.js';
import type { SyncProfile } from './types.js';

// #129 asked for the gmail `from_email` extraction to move out of a
// user-editable jq transform and into the built-in profile. It could not go in
// as a `transform`: that spawns `sh -c`, so it would need jq on PATH and would
// be a silent no-op on Windows. `derive` is the declarative replacement — same
// path resolver as identityKeys, no shell.

const gmailPath = 'messages[0].payload.headers[name=From].value';

describe('deriveFields', () => {
  it('returns nothing when the profile declares no derive block', () => {
    assert.deepEqual(deriveFields({ a: 1 }, undefined), {});
    assert.deepEqual(deriveFields({ a: 1 }, {}), {});
  });

  it('resolves a plain dot path', () => {
    assert.deepEqual(deriveFields({ user: { name: 'jane' } }, { who: 'user.name' }), { who: 'jane' });
  });

  it('extracts an address out of a display-name header', () => {
    const rec = { messages: [{ payload: { headers: [{ name: 'From', value: 'Jane Doe <Jane@Acme.com>' }] } }] };
    assert.deepEqual(
      deriveFields(rec, { from_email: { path: gmailPath, extract: 'email' } }),
      { from_email: 'jane@acme.com' },
    );
  });

  it('passes a bare address through unchanged', () => {
    const rec = { messages: [{ payload: { headers: [{ name: 'From', value: 'bob@acme.com' }] } }] };
    assert.deepEqual(deriveFields(rec, { from_email: { path: gmailPath, extract: 'email' } }), { from_email: 'bob@acme.com' });
  });

  it('omits the field entirely when the path resolves to nothing', () => {
    // Not null — a written null would break `--where` filters and leave every
    // record carrying dead keys.
    const out = deriveFields({ messages: [] }, { from_email: { path: gmailPath, extract: 'email' } });
    assert.deepEqual(out, {});
    assert.equal('from_email' in out, false);
  });

  it('omits the field when the value has no address to extract', () => {
    const rec = { messages: [{ payload: { headers: [{ name: 'From', value: 'Mailer Daemon' }] } }] };
    assert.deepEqual(deriveFields(rec, { from_email: { path: gmailPath, extract: 'email' } }), {});
  });

  it('takes the first value when a path fans out', () => {
    const rec = { items: [{ v: 'a' }, { v: 'b' }, { v: 'c' }] };
    assert.deepEqual(deriveFields(rec, { first: 'items[].v' }), { first: 'a' });
  });

  it('never emits an object or array as a derived value', () => {
    // A flat field is the whole point; a nested object would defeat --where.
    const rec = { nested: { deep: { a: 1 } }, list: [[1, 2]] };
    assert.deepEqual(deriveFields(rec, { x: 'nested.deep', y: 'list[]' }), {});
  });

  it('supports several fields at once and skips only the ones that miss', () => {
    const rec = { a: 'one', c: 'three' };
    assert.deepEqual(deriveFields(rec, { a: 'a', b: 'b', c: 'c' }), { a: 'one', c: 'three' });
  });

  it('ignores an empty path', () => {
    assert.deepEqual(deriveFields({ a: 1 }, { x: '' }), {});
  });
});

describe('built-in gmail profile derives from_email (#129)', () => {
  it('declares the derive block', () => {
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    assert.ok(profile.derive?.from_email, 'gmail profile should declare derive.from_email');
  });

  it('resolves the first sender of the first message, lowercased', () => {
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    const thread = {
      messages: [
        { payload: { headers: [
          { name: 'From', value: 'Moe Katib <Moe@WithOne.ai>' },
          { name: 'To', value: 'jane@acme.com' },
        ] } },
        { payload: { headers: [{ name: 'From', value: 'someone.else@acme.com' }] } },
      ],
    };
    assert.deepEqual(deriveFields(thread, profile.derive), { from_email: 'moe@withone.ai' });
  });

  it('does not use a shell transform', () => {
    // The reason derive exists: transform runs via `sh -c`, so a built-in
    // relying on it would need jq installed and would silently do nothing on
    // Windows.
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    assert.equal(profile.transform, undefined, 'built-in profiles must not require a shell');
  });
});
