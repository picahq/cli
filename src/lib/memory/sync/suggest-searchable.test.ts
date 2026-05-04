import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suggestSearchablePaths } from './suggest-searchable.js';

describe('suggestSearchablePaths', () => {
  it('ranks long prose fields above short enum-y fields', () => {
    const records = [
      { name: 'Acme', description: 'Software company that makes widgets for fintech.', status: 'active' },
      { name: 'Globex', description: 'B2B SaaS platform for workflow automation.', status: 'active' },
      { name: 'Initech', description: 'Enterprise consulting for manufacturing.', status: 'active' },
    ];
    const out = suggestSearchablePaths(records);
    assert.equal(out[0]?.path, 'description', `top path: ${out[0]?.path}`);
    // name / description both 100% hit, but description has more signal.
    const names = out.map(s => s.path);
    assert.ok(names.indexOf('description') < names.indexOf('name'));
  });

  it('excludes UUIDs + ISO timestamps via noise filter', () => {
    const records = [
      { id: '01bf654f-f5fb-42db-b0e7-a046b7571cc4', created_at: '2025-04-02T17:24:00.748000000Z', bio: 'Engineer from NYC.' },
      { id: '000050c1-5ccd-435e-8460-215d06b6493e', created_at: '2025-06-13T10:02:40.876000000Z', bio: 'Product designer from SF.' },
    ];
    const out = suggestSearchablePaths(records);
    const paths = out.map(s => s.path);
    assert.ok(!paths.includes('id'), 'id should be filtered — UUID-only');
    assert.ok(!paths.includes('created_at'), 'created_at should be filtered — ISO timestamps');
    assert.ok(paths.includes('bio'), 'bio should survive');
  });

  it('penalizes booleans and numeric leaves', () => {
    const records = [
      { title: 'CEO', is_archived: false, follower_count: 1200 },
      { title: 'Founder', is_archived: false, follower_count: 340 },
    ];
    const out = suggestSearchablePaths(records);
    const titleScore = out.find(s => s.path === 'title')?.score ?? 0;
    const boolScore = out.find(s => s.path === 'is_archived')?.score ?? 0;
    const numScore = out.find(s => s.path === 'follower_count')?.score ?? 0;
    assert.ok(titleScore > boolScore * 5, `title ${titleScore} should dominate boolean ${boolScore}`);
    assert.ok(titleScore > numScore * 5, `title ${titleScore} should dominate number ${numScore}`);
  });

  it('caps hit rate at 1.0 when arrays have multiple elements per record', () => {
    const records = [
      { tags: [{ name: 'urgent' }, { name: 'customer' }, { name: 'billing' }, { name: 'retention' }] },
      { tags: [{ name: 'product' }, { name: 'onboarding' }] },
    ];
    const out = suggestSearchablePaths(records);
    const s = out.find(p => p.path === 'tags[].name');
    assert.ok(s, 'tags[].name should be suggested');
    assert.equal(s!.hitRate, 1.0, `hitRate must cap at 1.0, got ${s!.hitRate}`);
  });

  it('emits paste-ready dot-paths with [] wildcards for array fan-out', () => {
    const records = [
      { messages: [{ snippet: 'Hello there' }, { snippet: 'Follow-up please' }] },
      { messages: [{ snippet: 'Re: proposal' }] },
    ];
    const out = suggestSearchablePaths(records);
    assert.ok(out.some(s => s.path === 'messages[].snippet'), `paths: ${out.map(s => s.path).join(', ')}`);
  });

  it('returns empty list for empty samples', () => {
    assert.deepEqual(suggestSearchablePaths([]), []);
  });

  it('excludes stringified numbers (lat/long style)', () => {
    const records = [
      { lat: '37.7749', lng: '-122.4194', city: 'San Francisco' },
      { lat: '40.7128', lng: '-74.0060', city: 'New York' },
    ];
    const out = suggestSearchablePaths(records);
    const paths = out.map(s => s.path);
    assert.ok(!paths.includes('lat'), 'numeric-string lat should be filtered');
    assert.ok(!paths.includes('lng'), 'numeric-string lng should be filtered');
    assert.ok(paths.includes('city'), 'city should survive');
  });
});
