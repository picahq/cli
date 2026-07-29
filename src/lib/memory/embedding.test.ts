import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSearchableText } from './embedding.js';

describe('defaultSearchableText', () => {
  it('leads with name/title/email fields and drops UUID + timestamp noise', () => {
    const text = defaultSearchableText({
      name: 'Ada Lovelace',
      email: 'ada@analytical.engine',
      company: 'Analytical Engine Co',
      job_title: 'Countess of Computing',
      description: 'first programmer',
      attio_record_id: '6b2f9658-542c-5e9e-b5f5-ffcb568776e4',
      first_seen: '2025-06-30',
      last_meeting: '2025-06-30T23:36:40.816000000Z',
    });
    // Priority fields come first.
    assert.ok(text.startsWith('Ada Lovelace ada@analytical.engine'), text);
    // No UUID, no timestamps.
    assert.ok(!/6b2f9658/.test(text), 'UUID must be dropped');
    assert.ok(!/2025-06-30/.test(text), 'timestamp/date must be dropped');
    // Human fields survive.
    assert.ok(text.includes('Countess of Computing'));
    assert.ok(text.includes('first programmer'));
  });

  it('handles Attio nested value shape and skips structural noise', () => {
    const text = defaultSearchableText({
      id: {
        workspace_id: '87d81246-d824-45f0-a205-047a0eaa67bc',
        object_id: '7be572b1-939b-4930-8426-578f2c6ab576',
        record_id: '6b2f9658-542c-5e9e-b5f5-ffcb568776e4',
      },
      created_at: '2025-06-30T23:36:40.816000000Z',
      web_url: 'https://app.attio.com/x/person/6b2f9658',
      values: {
        name: [{
          active_from: '2025-06-30T23:36:40.816000000Z',
          created_by_actor: { type: 'workspace-member', id: 'cdcd471a-0d5e-4070-8c25-e7e0fa79b85d' },
          full_name: 'Patrick O\'Keeffe',
          first_name: 'Patrick',
          last_name: 'O\'Keeffe',
          attribute_type: 'personal-name',
        }],
        email_addresses: [{
          email_address: 'patrick.okeeffe@circuit.ai',
          attribute_type: 'email-address',
        }],
        job_title: [{ value: 'Head of Engineering', attribute_type: 'text' }],
      },
    });
    // Name leads.
    assert.ok(text.startsWith('Patrick O\'Keeffe'), text);
    // Nested job_title[0].value is picked up (classified via parent key).
    assert.ok(text.includes('Head of Engineering'), text);
    // Email present.
    assert.ok(text.includes('patrick.okeeffe@circuit.ai'));
    // All the noise is gone.
    assert.ok(!/87d81246|7be572b1|6b2f9658|cdcd471a/.test(text), 'UUIDs must be dropped');
    assert.ok(!/workspace-member|personal-name|email-address/.test(text), 'enum noise must be dropped');
    assert.ok(!/2025-06-30/.test(text), 'timestamps must be dropped');
    assert.ok(!/app\.attio\.com/.test(text), 'url must be dropped');
  });

  it('de-duplicates repeated tokens', () => {
    const text = defaultSearchableText({
      name: 'Acme',
      values: { a: 'Acme', b: 'Acme', c: 'Acme' },
    });
    assert.equal(text, 'Acme');
  });

  it('returns empty string when nothing usable remains', () => {
    const text = defaultSearchableText({
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      created_at: '2025-01-01T00:00:00Z',
    });
    assert.equal(text, '');
  });

  it('truncates to maxLen', () => {
    const text = defaultSearchableText({ description: 'x'.repeat(5000) }, 100);
    assert.equal(text.length, 100);
  });
});
