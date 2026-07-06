import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { ListenClient } from './listen-client.js';
import { createOneSocketFactory } from './listen-socket.js';

describe('createOneSocketFactory (integration)', () => {
  it('connects with the secret header, forwards an event, and replies over the real socket', async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const { port } = wss.address() as AddressInfo;

    let authHeader: string | undefined;
    const serverReceived: Array<{ type: string }> = [];
    const gotReplies = new Promise<void>((resolve) => {
      wss.on('connection', (socket: WsSocket, req) => {
        authHeader = req.headers['x-one-secret'] as string | undefined;
        socket.on('message', (data) => {
          serverReceived.push(JSON.parse(data.toString()));
          if (serverReceived.length === 2) resolve();
        });
        socket.send(
          JSON.stringify({
            type: 'event',
            conversationId: 'c1',
            event: {
              source: 'relay',
              id: 'evt_1',
              eventType: 'customer.created',
              platform: 'stripe',
              timestamp: '2026-07-05T00:00:00Z',
              body: '{"a":1}',
              headers: {},
            },
          }),
        );
      });
    });

    const forwarded: Array<{ init: any }> = [];
    const fakeFetch = (async (_url: string, init: any) => {
      forwarded.push({ init });
      return { status: 200, text: async () => 'ok', headers: new Headers() } as unknown as Response;
    }) as typeof fetch;

    const client = new ListenClient({
      url: `ws://127.0.0.1:${port}`,
      forwardTo: 'http://localhost:9/hook',
      createSocket: createOneSocketFactory('sk_test_123'),
      fetchImpl: fakeFetch,
    });
    client.start();

    await gotReplies;
    client.stop();
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    assert.equal(authHeader, 'sk_test_123');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].init.body, '{"a":1}');
    assert.deepEqual(
      serverReceived.map((m) => m.type).sort(),
      ['event_ack', 'response'],
    );
  });
});
