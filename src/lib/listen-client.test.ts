import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ListenClient, computeBackoff, type Socket } from './listen-client.js';

class FakeSocket implements Socket {
  sent: string[] = [];
  closed = false;
  failSend = false;
  private handlers: Record<string, ((arg?: any) => void) | undefined> = {};
  send(data: string) {
    if (this.failSend) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.handlers.close?.();
  }
  onOpen(h: () => void) {
    this.handlers.open = h;
  }
  onMessage(h: (d: string) => void) {
    this.handlers.message = h;
  }
  onClose(h: () => void) {
    this.handlers.close = h;
  }
  onError(h: (e: unknown) => void) {
    this.handlers.error = h;
  }
  emitOpen() {
    this.handlers.open?.();
  }
  async emitMessage(d: string) {
    await this.handlers.message?.(d);
  }
  emitClose() {
    this.handlers.close?.();
  }
  emitError(error: unknown) {
    this.handlers.error?.(error);
  }
}

const okFetch = (async () =>
  ({ status: 200, text: async () => 'ok', headers: new Headers() }) as unknown as Response) as typeof fetch;

const eventMessage = JSON.stringify({
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
});

describe('ListenClient', () => {
  it('reports status transitions from connecting to open', () => {
    const statuses: string[] = [];
    const socket = new FakeSocket();
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      createSocket: () => socket,
      onStatus: (s) => statuses.push(s),
    });
    client.start();
    assert.deepEqual(statuses, ['connecting']);
    socket.emitOpen();
    assert.deepEqual(statuses, ['connecting', 'open']);
  });

  it('forwards an event message and sends response then ack over the socket', async () => {
    const socket = new FakeSocket();
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      createSocket: () => socket,
      fetchImpl: okFetch,
    });
    client.start();
    socket.emitOpen();
    await socket.emitMessage(eventMessage);
    assert.equal(socket.sent.length, 2);
    assert.equal(JSON.parse(socket.sent[0]).type, 'response');
    assert.equal(JSON.parse(socket.sent[1]).type, 'event_ack');
  });

  it('reconnects after an unexpected close', async () => {
    let created = 0;
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      reconnectDelayMs: 0,
      createSocket: () => {
        created++;
        return new FakeSocket();
      },
    });
    client.start();
    assert.equal(created, 1);
    const socket = (client as unknown as { socket: FakeSocket }).socket;
    socket.emitOpen();
    socket.emitClose();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(created, 2);
  });

  it('surfaces the error and stops (no reconnect loop) when the handshake fails', async () => {
    let created = 0;
    const statuses: string[] = [];
    const errors: unknown[] = [];
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      reconnectDelayMs: 0,
      createSocket: () => {
        created++;
        return new FakeSocket();
      },
      onStatus: (s) => statuses.push(s),
      onError: (e) => errors.push(e),
    });
    client.start();
    const socket = (client as unknown as { socket: FakeSocket }).socket;
    socket.emitError(new Error('Unexpected server response: 401'));
    socket.emitClose();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(created, 1);
    assert.equal(errors.length, 1);
    assert.ok(statuses.includes('closed'));
  });

  it('sends the reply on the socket that received the event, even across a reconnect', async () => {
    const sockets: FakeSocket[] = [];
    let releaseFetch: () => void = () => {};
    const slowFetch = (async () => {
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return { status: 200, text: async () => 'ok', headers: new Headers() } as unknown as Response;
    }) as typeof fetch;

    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      reconnectDelayMs: 0,
      fetchImpl: slowFetch,
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    client.start();
    sockets[0].emitOpen();

    const forwarding = sockets[0].emitMessage(eventMessage);
    sockets[0].emitClose();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(sockets.length, 2);

    releaseFetch();
    await forwarding;

    assert.equal(sockets[0].sent.length, 2);
    assert.equal(sockets[1].sent.length, 0);
  });

  it('survives a send on a socket that closed mid-forward', async () => {
    const socket = new FakeSocket();
    socket.failSend = true;
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      createSocket: () => socket,
      fetchImpl: okFetch,
    });
    client.start();
    socket.emitOpen();
    await socket.emitMessage(eventMessage);
    assert.equal(socket.sent.length, 0);
  });

  it('does not reconnect after stop()', async () => {
    let created = 0;
    const statuses: string[] = [];
    const client = new ListenClient({
      url: 'wss://x',
      forwardTo: 'http://localhost/x',
      reconnectDelayMs: 0,
      createSocket: () => {
        created++;
        return new FakeSocket();
      },
      onStatus: (s) => statuses.push(s),
    });
    client.start();
    client.stop();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(created, 1);
    assert.ok(statuses.includes('closed'));
  });
});

describe('computeBackoff', () => {
  it('grows exponentially and caps', () => {
    assert.equal(computeBackoff(0, 1000, 30000), 1000);
    assert.equal(computeBackoff(1, 1000, 30000), 2000);
    assert.equal(computeBackoff(2, 1000, 30000), 4000);
    assert.equal(computeBackoff(5, 1000, 30000), 30000);
    assert.equal(computeBackoff(20, 1000, 30000), 30000);
  });
});
