import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectIdentityKeys,
  collectEntityKeys,
  collectAssociationKeys,
  resolveEntityIdentity,
} from './mem-writer.js';
import { loadBuiltinProfile } from './builtin-profiles.js';
import { buildIdentityKeysPreview } from './test.js';
import type { SyncProfile } from './types.js';

// #128: identityKeys (plural) — multiple cross-platform identity keys per
// record, with [] wildcard fan-out, normalization, and dedupe. The singular
// identityKey must keep its original scalar behavior (backwards compatible).

type IdProfile = Pick<SyncProfile, 'identityKey' | 'identityKeys'>;

describe('collectIdentityKeys — singular identityKey (backwards compatible) (#128)', () => {
  it('extracts a scalar identity key, lowercased + trimmed, with derived prefix', () => {
    const keys = collectIdentityKeys({ email: '  Jane@Acme.COM ' }, { identityKey: 'email' } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com']);
  });

  it('derives prefix from the path (email/phone/domain/id)', () => {
    assert.deepEqual(collectIdentityKeys({ work_phone: '+1-555' }, { identityKey: 'work_phone' } as IdProfile), ['phone:+1-555']);
    assert.deepEqual(collectIdentityKeys({ company_domain: 'Acme.com' }, { identityKey: 'company_domain' } as IdProfile), ['domain:acme.com']);
    assert.deepEqual(collectIdentityKeys({ ref: 'ABC' }, { identityKey: 'ref' } as IdProfile), ['id:abc']);
  });

  it('resolves dotted + numeric-index paths', () => {
    const rec = { email_addresses: [{ email_address: 'a@b.com' }] };
    assert.deepEqual(collectIdentityKeys(rec, { identityKey: 'email_addresses[0].email_address' } as IdProfile), ['email:a@b.com']);
  });

  it('produces no key when the value is missing/empty/object', () => {
    assert.deepEqual(collectIdentityKeys({}, { identityKey: 'email' } as IdProfile), []);
    assert.deepEqual(collectIdentityKeys({ email: '' }, { identityKey: 'email' } as IdProfile), []);
    assert.deepEqual(collectIdentityKeys({ email: { nested: 1 } }, { identityKey: 'email' } as IdProfile), []);
  });

  it('returns [] when no identity config is set', () => {
    assert.deepEqual(collectIdentityKeys({ email: 'a@b.com' }, {} as IdProfile), []);
  });
});

describe('collectIdentityKeys — plural identityKeys with [] wildcard (#128)', () => {
  it('fans out a [] wildcard path to one key per element', () => {
    const rec = { attendees: [{ email: 'A@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@x.com', 'email:c@x.com']);
  });

  it('handles nested [] wildcards (messages[].headers[].value)', () => {
    const rec = {
      messages: [
        { headers: [{ value: 'one@x.com' }, { value: 'two@x.com' }] },
        { headers: [{ value: 'three@x.com' }] },
      ],
    };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'messages[].headers[].value' }] } as IdProfile);
    assert.deepEqual(keys, ['email:one@x.com', 'email:two@x.com', 'email:three@x.com']);
  });

  it('dedupes repeats within and across entries (order-preserving)', () => {
    const rec = {
      organizer: { email: 'host@x.com' },
      attendees: [{ email: 'host@x.com' }, { email: 'guest@x.com' }, { email: 'GUEST@x.com' }],
    };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: 'email', path: 'organizer.email' },
        { prefix: 'email', path: 'attendees[].email' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:host@x.com', 'email:guest@x.com']);
  });

  it('respects each entry\'s prefix', () => {
    const rec = { primary: 'a@x.com', site: 'acme.com' };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: 'email', path: 'primary' },
        { prefix: 'domain', path: 'site' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'domain:acme.com']);
  });

  it('skips null/empty elements in a wildcard array', () => {
    const rec = { attendees: [{ email: 'a@x.com' }, { email: '' }, { email: null }, { other: 1 }, { email: 'b@x.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@x.com']);
  });

  it('ignores malformed entries (missing prefix or path)', () => {
    const rec = { email: 'a@x.com' };
    const keys = collectIdentityKeys(rec, {
      identityKeys: [
        { prefix: '', path: 'email' } as any,
        { prefix: 'email', path: '' } as any,
        { prefix: 'email', path: 'email' },
      ],
    } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com']);
  });
});

describe('collectIdentityKeys — email extraction from header values (#129)', () => {
  it('strips display names and lowercases', () => {
    const rec = { from: 'Jane Smith <Jane@Acme.com>' };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'from' }] } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com']);
  });

  it('extracts every address from a comma-list (To/Cc)', () => {
    const rec = { to: 'a@x.com, Bob <b@y.com>, c@z.com' };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'to' }] } as IdProfile);
    assert.deepEqual(keys, ['email:a@x.com', 'email:b@y.com', 'email:c@z.com']);
  });

  it('passes already-clean emails through unchanged (gcal attendees — #130)', () => {
    const rec = { attendees: [{ email: 'jane@acme.com' }, { email: 'BOB@acme.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'attendees[].email' }] } as IdProfile);
    assert.deepEqual(keys, ['email:jane@acme.com', 'email:bob@acme.com']);
  });

  it('yields nothing for an email-prefixed value with no address', () => {
    const rec = { from: 'mailer-daemon (no address)' };
    assert.deepEqual(collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'from' }] } as IdProfile), []);
  });
});

describe('collectIdentityKeys — [name=From] header filter (#129 Gmail shape)', () => {
  const thread = {
    messages: [
      { payload: { headers: [
        { name: 'From', value: 'Moe <moe@withone.ai>' },
        { name: 'To', value: 'anish@intently.ai, jane@acme.com' },
        { name: 'Subject', value: 'pricing for vip@whale.com' }, // must NOT leak
        { name: 'Received', value: 'by mail-server@google.com' }, // must NOT leak
      ] } },
      { payload: { headers: [
        { name: 'From', value: 'anish@intently.ai' },
        { name: 'Cc', value: 'Boss <boss@acme.com>' },
      ] } },
    ],
  };

  it('extracts From/To/Cc participants across all messages, ignoring other headers', () => {
    const keys = collectIdentityKeys(thread, {
      identityKeys: [
        { prefix: 'email', path: "messages[].payload.headers[name=From].value" },
        { prefix: 'email', path: "messages[].payload.headers[name=To].value" },
        { prefix: 'email', path: "messages[].payload.headers[name=Cc].value" },
      ],
    } as IdProfile);
    assert.deepEqual(keys, [
      'email:moe@withone.ai',
      'email:anish@intently.ai',
      'email:jane@acme.com',
      'email:boss@acme.com',
    ]);
    // Subject/Received emails must be absent
    assert.ok(!keys.includes('email:vip@whale.com'));
    assert.ok(!keys.includes('email:mail-server@google.com'));
  });

  it('filter is case-insensitive on the field value', () => {
    const rec = { headers: [{ name: 'from', value: 'x@y.com' }] };
    const keys = collectIdentityKeys(rec, { identityKeys: [{ prefix: 'email', path: 'headers[name=From].value' }] } as IdProfile);
    assert.deepEqual(keys, ['email:x@y.com']);
  });
});

describe('built-in profiles declare working identity keys (#129/#130)', () => {
  it('gmail/gmailThreads resolves From/To/Cc participants across the thread', () => {
    const profile = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'gmail profile declares identityKeys');
    const thread = {
      messages: [
        { payload: { headers: [
          { name: 'From', value: 'Moe <moe@withone.ai>' },
          { name: 'To', value: 'anish@intently.ai, jane@acme.com' },
          { name: 'Subject', value: 'note to self@nope.com' },
        ] } },
        { payload: { headers: [{ name: 'Cc', value: 'Boss <boss@acme.com>' }] } },
      ],
    };
    const keys = collectIdentityKeys(thread, profile);
    assert.deepEqual(keys.sort(), ['email:anish@intently.ai', 'email:boss@acme.com', 'email:jane@acme.com', 'email:moe@withone.ai'].sort());
    assert.ok(!keys.includes('email:self@nope.com'), 'Subject email must not leak');
  });

  it('google-calendar/events resolves organizer + attendees', () => {
    const profile = loadBuiltinProfile('google-calendar', 'events') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'gcal profile declares identityKeys');
    const event = { organizer: { email: 'Host@acme.com' }, attendees: [{ email: 'a@x.com' }, { email: 'b@y.com' }] };
    assert.deepEqual(collectIdentityKeys(event, profile).sort(), ['email:a@x.com', 'email:b@y.com', 'email:host@acme.com'].sort());
  });

  it('fathom/meetings resolves host + calendar invitees', () => {
    const profile = loadBuiltinProfile('fathom', 'meetings') as unknown as SyncProfile;
    assert.ok(profile?.identityKeys?.length, 'fathom profile declares identityKeys');
    const meeting = { recorded_by: { email: 'rec@acme.com' }, calendar_invitees: [{ email: 'x@y.com' }] };
    assert.deepEqual(collectIdentityKeys(meeting, profile).sort(), ['email:rec@acme.com', 'email:x@y.com'].sort());
  });
});

describe('collectIdentityKeys — singular + plural combined (#128)', () => {
  it('merges both sources and dedupes the overlap (prefix from singular path name)', () => {
    // Singular `from_email` derives the `email` prefix (path name contains
    // "email"), so it dedupes against the plural `email:` keys.
    const rec = { from_email: 'me@x.com', to: [{ email: 'me@x.com' }, { email: 'you@x.com' }] };
    const keys = collectIdentityKeys(rec, {
      identityKey: 'from_email',
      identityKeys: [{ prefix: 'email', path: 'to[].email' }],
    } as IdProfile);
    assert.deepEqual(keys, ['email:me@x.com', 'email:you@x.com']);
  });
});

/**
 * `collectIdentityKeys` above is the UNION helper — it exists for `sync test`
 * previews, and nothing in the write path calls it. The writer uses
 * `collectEntityKeys` (→ `keys[]`) and `collectAssociationKeys` (→
 * `identity_keys[]`) and the SPLIT between them is the #128 fix. Test them
 * directly, or a writer that shoves everything back into `keys[]` still looks
 * green here.
 */
describe('collectEntityKeys / collectAssociationKeys — the two columns are separate (#128)', () => {
  const rec = {
    id: 'T1',
    email: 'owner@acme.com',
    participants: [{ email: 'a@x.com' }, { email: 'b@x.com' }],
  };
  const both = {
    identityKey: 'email',
    identityKeys: [{ prefix: 'email', path: 'participants[].email' }],
  } as IdProfile;

  it('the singular key is an ENTITY key and never appears in the association set', () => {
    assert.deepEqual(collectEntityKeys(rec, both), ['email:owner@acme.com']);
    assert.deepEqual(collectAssociationKeys(rec, both), ['email:a@x.com', 'email:b@x.com']);
  });

  it('the plural keys are ASSOCIATIONS and never leak into the entity set', () => {
    // A thread-shaped profile: participants only, no entity identity of its own.
    const threadish = { identityKeys: both.identityKeys } as IdProfile;
    assert.deepEqual(collectEntityKeys(rec, threadish), [], 'no singular key → no entity key');
    assert.equal(collectAssociationKeys(rec, threadish).length, 2);
  });

  it('an association prefix is normalized, and an unusable one is dropped entirely', () => {
    // A namespace is compared as literal text by find-by-key and the uniqueness
    // trigger, so `"Email"` must land on `email:`…
    assert.deepEqual(
      collectAssociationKeys({ e: 'A@x.com' }, { identityKeys: [{ prefix: ' Email ', path: 'e' }] } as IdProfile),
      ['email:a@x.com'],
    );
    // …and a prefix containing the `:` separator (or a space) would make the
    // key unparseable, so the entry is dropped rather than written as garbage.
    assert.deepEqual(
      collectAssociationKeys({ e: 'a@x.com' }, { identityKeys: [{ prefix: 'we:ird', path: 'e' }] } as IdProfile),
      [],
    );
  });
});

/**
 * `keys[]` is the MERGE + uniqueness column, so the singular `identityKey` may
 * contribute AT MOST ONE key. A path that fans out would hand one record
 * several entity identities; combined with sync's `replace: true` that either
 * overwrites an unrelated entity's row wholesale or trips 23505. Ambiguous
 * must therefore resolve to nothing at all — not to a first-match guess.
 */
describe('singular identityKey fan-out guard — at most one merge key (#128)', () => {
  it('a comma-list value produces NO entity key (ambiguous, not first-match)', () => {
    const rec = { email: 'a@x.com, Bob <b@y.com>' };
    assert.deepEqual(collectEntityKeys(rec, { identityKey: 'email' } as IdProfile), []);
    // The candidates are still exposed so `sync test` can tell the profile
    // author exactly why their key vanished.
    const identity = resolveEntityIdentity(rec, 'email');
    assert.deepEqual(identity!.values, ['a@x.com', 'b@y.com']);
    assert.equal(identity!.value, null);
    assert.equal(identity!.key, null);
  });

  it('a [] wildcard path produces NO entity key even though it resolves', () => {
    const rec = { emails: [{ address: 'a@x.com' }, { address: 'b@x.com' }] };
    assert.deepEqual(collectEntityKeys(rec, { identityKey: 'emails[].address' } as IdProfile), []);
    // Pinning the index makes it unambiguous again — the documented fix.
    assert.deepEqual(collectEntityKeys(rec, { identityKey: 'emails[0].address' } as IdProfile), ['email:a@x.com']);
  });

  it('a fan-out that collapses to ONE distinct value is still fine', () => {
    // Duplicates are deduped before the ambiguity check, so a repeated address
    // is not punished.
    const rec = { emails: [{ address: 'Same@x.com' }, { address: 'same@X.com' }] };
    assert.deepEqual(collectEntityKeys(rec, { identityKey: 'emails[].address' } as IdProfile), ['email:same@x.com']);
  });

  it('non-email prefixes fan out too, and are guarded the same way', () => {
    const rec = { domains: ['acme.com', 'acme.io'] };
    assert.deepEqual(collectEntityKeys(rec, { identityKey: 'domains[]' } as IdProfile), []);
    assert.deepEqual(collectEntityKeys({ domains: ['acme.com'] }, { identityKey: 'domains[]' } as IdProfile), ['domain:acme.com']);
  });

  it('the shipped entity profiles each produce exactly ONE merge key', () => {
    // These three are the profiles whose records ARE entities (a person, a
    // company, a customer). Their `keys[]` contribution must stay singular no
    // matter what the payload looks like, or a sync merges two real people.
    const cases: Array<{ platform: string; model: string; record: Record<string, unknown>; expected: string }> = [
      {
        platform: 'attio', model: 'attioPeople',
        record: {
          values: {
            email_addresses: [
              { email_address: 'Jane@Acme.com' },
              // A second address must NOT create a second merge key — the
              // profile pins [0] precisely to avoid the fan-out above.
              { email_address: 'jane.smith@acme.com' },
            ],
          },
        },
        expected: 'email:jane@acme.com',
      },
      {
        platform: 'attio', model: 'attioCompanies',
        record: { values: { domains: [{ domain: 'Acme.com' }, { domain: 'acme.io' }] } },
        expected: 'domain:acme.com',
      },
      {
        platform: 'stripe', model: 'customers',
        record: { email: 'Cust@Acme.com' },
        expected: 'email:cust@acme.com',
      },
    ];

    for (const c of cases) {
      const profile = loadBuiltinProfile(c.platform, c.model) as unknown as SyncProfile;
      assert.ok(profile, `${c.platform}/${c.model} profile loads`);
      assert.ok(profile.identityKey, `${c.platform}/${c.model} declares a singular identityKey`);
      const keys = collectEntityKeys(c.record, profile);
      assert.deepEqual(keys, [c.expected], `${c.platform}/${c.model} must yield exactly one merge key`);
      // And none of them declares plural identityKeys — an entity profile has
      // no participants, so nothing should land in identity_keys[].
      assert.deepEqual(collectAssociationKeys(c.record, profile), [], `${c.platform}/${c.model} has no associations`);
    }
  });

  it('the shipped PARTICIPANT profiles contribute nothing to keys[]', () => {
    // The mirror image: gmail threads / calendar events / fathom meetings are
    // not entities, so they must add zero merge keys and leave `keys[]` as just
    // the source key. If one of these ever grew a singular identityKey, every
    // record sharing that value would collapse — the #128 bug all over again.
    for (const [platform, model] of [['gmail', 'gmailThreads'], ['google-calendar', 'events'], ['fathom', 'meetings']]) {
      const profile = loadBuiltinProfile(platform, model) as unknown as SyncProfile;
      assert.ok(profile, `${platform}/${model} profile loads`);
      assert.equal(profile.identityKey, undefined, `${platform}/${model} must NOT declare a singular identityKey`);
      assert.ok(profile.identityKeys?.length, `${platform}/${model} declares plural identityKeys`);
    }
  });
});

describe('sync test preview surfaces the two silent-looking cases (#128)', () => {
  it('flags a singular identityKey that fans out, with the values it saw', () => {
    const preview = buildIdentityKeysPreview(
      [
        { email: 'jane@acme.com' },
        { email: 'a@x.com, b@y.com' },
        { email: 'Solo@Acme.com' },
      ],
      { identityKey: 'email' } as SyncProfile,
    );
    assert.ok(preview);
    // Only the comma-list record fans out; the other two resolve cleanly.
    assert.equal(preview!.entityFanOut?.count, 1);
    assert.deepEqual(preview!.entityFanOut?.sampleValues, ['email:a@x.com', 'email:b@y.com']);
    // And that record contributed no key at all — the guard, seen from outside.
    assert.deepEqual(preview!.perRecord, [1, 0, 1]);
  });

  it('does not flag a fan-out that collapses to one distinct value', () => {
    const preview = buildIdentityKeysPreview(
      [{ email: 'jane@acme.com, Jane@ACME.com' }],
      { identityKey: 'email' } as SyncProfile,
    );
    assert.equal(preview!.entityFanOut, undefined);
    assert.deepEqual(preview!.perRecord, [1]);
  });

  it('marks an enriching profile so zero keys is not reported as a broken path', () => {
    const gmail = loadBuiltinProfile('gmail', 'gmailThreads') as unknown as SyncProfile;
    // The list shape: what threads.list actually returns, before enrichment.
    const preview = buildIdentityKeysPreview(
      [{ id: 'T1', snippet: 'hello', historyId: '99' }],
      gmail,
    );
    assert.deepEqual(preview!.perRecord, [0]);
    assert.equal(preview!.resolvesAfterEnrich, true);
  });

  it('leaves resolvesAfterEnrich unset for a non-enriching participant profile', () => {
    const gcal = loadBuiltinProfile('google-calendar', 'events') as unknown as SyncProfile;
    assert.equal(gcal.enrich, undefined);
    const preview = buildIdentityKeysPreview([{ organizer: { email: 'me@acme.com' } }], gcal);
    assert.equal(preview!.resolvesAfterEnrich, undefined);
    assert.deepEqual(preview!.perRecord, [1]);
  });

  it('returns undefined when the profile declares no identity config', () => {
    assert.equal(buildIdentityKeysPreview([{ email: 'a@b.com' }], {} as SyncProfile), undefined);
  });
});
