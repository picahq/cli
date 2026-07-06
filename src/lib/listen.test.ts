import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildListenUrl, forwardEvent, handleServerMessage, resolveListenTarget } from './listen.js';
import type { ClientMessage, ListenEvent } from './listen-protocol.js';

const okFetch = (async () =>
  ({ status: 200, text: async () => 'ok', headers: new Headers() }) as unknown as Response) as typeof fetch;

const sampleEvent: ListenEvent = {
  source: 'relay',
  id: 'evt_1',
  eventType: 'customer.created',
  platform: 'stripe',
  timestamp: '2026-07-05T00:00:00Z',
  body: '{"hello":"world"}',
  headers: { 'stripe-signature': 't=1,v1=abc' },
};

describe('forwardEvent', () => {
  it('POSTs the payload + replayed headers and returns an ack and the local response', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch = async (url: string, init: any) => {
      calls.push({ url, init });
      return {
        status: 202,
        text: async () => 'accepted',
        headers: new Headers({ 'x-app': 'yes' }),
      } as unknown as Response;
    };

    const result = await forwardEvent(sampleEvent, 'conv_1', 'http://localhost:4242/hook', fakeFetch as typeof fetch);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://localhost:4242/hook');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, '{"hello":"world"}');
    assert.equal(calls[0].init.headers['stripe-signature'], 't=1,v1=abc');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');

    assert.deepEqual(result.ack, { type: 'event_ack', conversationId: 'conv_1', eventId: 'evt_1' });
    assert.equal(result.response.type, 'response');
    assert.equal(result.response.status, 202);
    assert.equal(result.response.body, 'accepted');
    assert.equal(result.response.conversationId, 'conv_1');
  });

  it('replays the original content-type without duplicating it (any casing)', async () => {
    const calls: Array<{ init: any }> = [];
    const fakeFetch = async (_url: string, init: any) => {
      calls.push({ init });
      return { status: 200, text: async () => '', headers: new Headers() } as unknown as Response;
    };
    const event = {
      ...sampleEvent,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'stripe-signature': 'x' },
    };
    await forwardEvent(event, 'c', 'http://localhost/x', fakeFetch as typeof fetch);
    const ctKeys = Object.keys(calls[0].init.headers).filter((k) => k.toLowerCase() === 'content-type');
    assert.equal(ctKeys.length, 1);
    assert.equal(calls[0].init.headers[ctKeys[0]], 'application/x-www-form-urlencoded');
  });

  it('defaults content-type to application/json only when the event has none', async () => {
    const calls: Array<{ init: any }> = [];
    const fakeFetch = async (_url: string, init: any) => {
      calls.push({ init });
      return { status: 200, text: async () => '', headers: new Headers() } as unknown as Response;
    };
    await forwardEvent(
      { ...sampleEvent, headers: { 'stripe-signature': 'x' } },
      'c',
      'http://localhost/x',
      fakeFetch as typeof fetch,
    );
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
  });

  it('strips hop-by-hop transport headers before replaying, keeping the signature', async () => {
    const calls: Array<{ init: any }> = [];
    const fakeFetch = async (_url: string, init: any) => {
      calls.push({ init });
      return { status: 200, text: async () => '', headers: new Headers() } as unknown as Response;
    };
    const event = {
      ...sampleEvent,
      headers: {
        Host: 'evil.internal',
        'Content-Length': '999',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'stripe-signature': 'sig',
      },
    };
    await forwardEvent(event, 'c', 'http://localhost/x', fakeFetch as typeof fetch);
    const keys = Object.keys(calls[0].init.headers as Record<string, string>).map((k) => k.toLowerCase());
    assert.ok(!keys.includes('host'), 'host must be stripped');
    assert.ok(!keys.includes('content-length'), 'content-length must be stripped');
    assert.ok(!keys.includes('connection'), 'connection must be stripped');
    assert.ok(!keys.includes('transfer-encoding'), 'transfer-encoding must be stripped');
    assert.equal((calls[0].init.headers as Record<string, string>)['stripe-signature'], 'sig');
  });

  it('replays the raw body byte-for-byte so a signature over it still verifies', async () => {
    const calls: Array<{ init: any }> = [];
    const fakeFetch = async (_url: string, init: any) => {
      calls.push({ init });
      return { status: 200, text: async () => '', headers: new Headers() } as unknown as Response;
    };
    const raw = '{ "b": 2, "a": 1 }';
    await forwardEvent({ ...sampleEvent, body: raw }, 'c', 'http://localhost/x', fakeFetch as typeof fetch);
    assert.equal(calls[0].init.body, raw);
  });

  it('still acks when the local endpoint is unreachable, reporting a 0 status', async () => {
    const failingFetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await forwardEvent(sampleEvent, 'conv_2', 'http://localhost:4242/hook', failingFetch as typeof fetch);
    assert.deepEqual(result.ack, { type: 'event_ack', conversationId: 'conv_2', eventId: 'evt_1' });
    assert.equal(result.response.status, 0);
  });
});

describe('handleServerMessage', () => {
  it('forwards an event message then sends response and ack', async () => {
    const sent: ClientMessage[] = [];
    let seen: ListenEvent | undefined;
    await handleServerMessage(
      { type: 'event', conversationId: 'c1', event: sampleEvent },
      {
        forwardTo: 'http://localhost/x',
        fetchImpl: okFetch,
        send: (m) => sent.push(m),
        onEvent: (e) => {
          seen = e;
        },
      },
    );
    assert.equal(sent.length, 2);
    assert.equal(sent[0].type, 'response');
    assert.equal(sent[1].type, 'event_ack');
    assert.equal(seen?.id, 'evt_1');
  });

  it('reports the session on a ready message without forwarding', async () => {
    const sent: ClientMessage[] = [];
    let ready: { sessionId: string; scope: string } | undefined;
    await handleServerMessage(
      { type: 'ready', sessionId: 's1', scope: 'org:123' },
      {
        forwardTo: 'http://localhost/x',
        send: (m) => sent.push(m),
        onReady: (sessionId, scope) => {
          ready = { sessionId, scope };
        },
      },
    );
    assert.equal(sent.length, 0);
    assert.deepEqual(ready, { sessionId: 's1', scope: 'org:123' });
  });
});

describe('buildListenUrl', () => {
  it('upgrades https to wss and appends the listen path to the versioned base', () => {
    assert.equal(
      buildListenUrl('https://api.withone.ai/v1', 'both'),
      'wss://api.withone.ai/v1/webhooks/listen?source=both',
    );
  });

  it('upgrades http to ws for local dev and includes an events filter', () => {
    assert.equal(
      buildListenUrl('http://localhost:3000/v1', 'relay', 'customer.created,invoice.paid'),
      'ws://localhost:3000/v1/webhooks/listen?source=relay&events=customer.created%2Cinvoice.paid',
    );
  });
});

describe('resolveListenTarget', () => {
  const config = { apiKey: 'sk_test', apiBase: 'https://api.withone.ai/v1' };

  it('errors when not configured', () => {
    const r = resolveListenTarget({ forwardTo: 'http://localhost/x' }, { apiKey: null, apiBase: config.apiBase });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Not configured/);
  });

  it('errors when --forward-to is missing', () => {
    const r = resolveListenTarget({}, config);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /--forward-to/);
  });

  it('errors on an invalid --source', () => {
    const r = resolveListenTarget({ forwardTo: 'http://localhost/x', source: 'bogus' }, config);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Invalid --source/);
  });

  it('resolves a valid target with the ws url and the default source', () => {
    const r = resolveListenTarget({ forwardTo: 'http://localhost:4242/hook' }, config);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.target.forwardTo, 'http://localhost:4242/hook');
      assert.equal(r.target.source, 'both');
      assert.equal(r.target.url, 'wss://api.withone.ai/v1/webhooks/listen?source=both');
    }
  });
});
