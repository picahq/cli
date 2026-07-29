import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { OneApi, isTextualContentType, looksLikeText } from './api.js';
import type { ActionDetails, ExecuteActionArgs } from './types.js';

// #163: `actions execute` classified ANY non-JSON response as binary, hiding
// readable text/plain, text/html, CSV, etc. behind "Binary response received".
// The proxy also mislabels text endpoints as application/octet-stream, so the
// fix needs both a content-type check and a text-sniff fallback.

describe('isTextualContentType (#163)', () => {
  for (const ct of [
    'text/plain', 'text/html', 'text/csv', 'TEXT/PLAIN',
    'text/plain; charset=utf-8', 'application/json', 'application/json; charset=utf-8',
    'application/xml', 'application/javascript', 'application/x-www-form-urlencoded',
    'application/yaml', 'application/ld+json', 'image/svg+xml',
  ]) {
    it(`treats "${ct}" as textual`, () => assert.equal(isTextualContentType(ct), true));
  }
  for (const ct of [
    'application/octet-stream', 'image/png', 'image/jpeg', 'application/pdf',
    'application/zip', 'audio/mpeg', '',
  ]) {
    it(`treats "${ct || '<empty>'}" as NOT textual`, () => assert.equal(isTextualContentType(ct), false));
  }
});

describe('looksLikeText (#163)', () => {
  it('accepts plain ascii / whitespace / unicode', () => {
    assert.equal(looksLikeText('8.8.8.8\n'), true);
    assert.equal(looksLikeText('<!DOCTYPE html><title>Example</title>'), true);
    assert.equal(looksLikeText('a,b,c\n1,2,3\n'), true);
    assert.equal(looksLikeText('café — über'), true); // accented UTF-8 + em dash
    assert.equal(looksLikeText(''), true);
  });
  it('rejects a NUL byte or invalid-UTF8 replacement char', () => {
    assert.equal(looksLikeText('abc\u0000def'), false);
    assert.equal(looksLikeText('abc\uFFFDdef'), false);
  });
  it('rejects bodies dense with control characters (binary)', () => {
    // PNG magic + IHDR-ish control bytes (written as escapes — pure-ASCII source)
    assert.equal(looksLikeText('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x01\x02\x03\x04'), false);
    assert.equal(looksLikeText('\x01\x02\x03\x04\x05\x06\x07\x08'), false);
  });
});

describe('OneApi.executePassthroughRequest — text vs binary classification (#163)', () => {
  let originalFetch: typeof globalThis.fetch;
  const api = new OneApi('test-key', 'http://proxy/v1');

  const action = { _id: 'a1', method: 'GET', path: '/x', tags: [] } as unknown as ActionDetails;
  const args: ExecuteActionArgs = { platform: 'p', actionId: 'a1', connectionKey: 'k' };

  function mockResponse(body: string, contentType: string) {
    globalThis.fetch = (async () =>
      new Response(body, { status: 200, headers: contentType ? { 'content-type': contentType } : {} })
    ) as typeof globalThis.fetch;
  }

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns plain text as a string (text/plain, not JSON)', async () => {
    mockResponse('8.8.8.8\n', 'text/plain; charset=utf-8');
    const { responseData } = await api.executePassthroughRequest(args, action);
    assert.deepEqual(responseData, { text: '8.8.8.8\n', contentType: 'text/plain; charset=utf-8' });
  });

  it('returns HTML as text (text/html)', async () => {
    mockResponse('<!DOCTYPE html><title>Example Domain</title>', 'text/html');
    const { responseData } = await api.executePassthroughRequest(args, action) as { responseData: any };
    assert.equal(responseData.text, '<!DOCTYPE html><title>Example Domain</title>');
    assert.equal(responseData.contentType, 'text/html');
  });

  it('still parses JSON when the body is JSON (text/* or application/json)', async () => {
    mockResponse('{"token":"abc","n":2}', 'application/json');
    const { responseData } = await api.executePassthroughRequest(args, action);
    assert.deepEqual(responseData, { token: 'abc', n: 2 });
  });

  it('parses JSON that the proxy mislabeled as octet-stream', async () => {
    mockResponse('{"ok":true}', 'application/octet-stream');
    const { responseData } = await api.executePassthroughRequest(args, action);
    assert.deepEqual(responseData, { ok: true });
  });

  it('THE #163 REPRO: octet-stream text body is returned as text, not a binary stub', async () => {
    mockResponse('8.8.8.8\n', 'application/octet-stream');
    const { responseData } = await api.executePassthroughRequest(args, action) as { responseData: any };
    assert.equal(responseData.binary, undefined, 'must NOT be classified binary');
    assert.equal(responseData.text, '8.8.8.8\n');
    assert.equal(responseData.contentType, 'application/octet-stream');
  });

  it('still returns the binary stub for genuinely binary octet-stream bytes', async () => {
    mockResponse('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x01\x02\x03\x04', 'application/octet-stream');
    const { responseData } = await api.executePassthroughRequest(args, action) as { responseData: any };
    assert.equal(responseData.binary, true);
    assert.equal(responseData.contentType, 'application/octet-stream');
    assert.match(responseData.message, /Binary response received/);
  });

  it('a text/plain body that happens to be valid JSON is parsed (JSON wins)', async () => {
    mockResponse('[1,2,3]', 'text/plain');
    const { responseData } = await api.executePassthroughRequest(args, action);
    assert.deepEqual(responseData, [1, 2, 3]);
  });

  it('an empty body returns {}', async () => {
    mockResponse('', 'text/plain');
    const { responseData } = await api.executePassthroughRequest(args, action);
    assert.deepEqual(responseData, {});
  });
});
