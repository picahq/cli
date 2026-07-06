import WebSocket, { type RawData } from 'ws';
import type { Socket, SocketFactory } from './listen-client.js';

// Production socket factory: opens an authenticated `ws` connection — the One
// secret key rides in the `X-One-Secret` header, matching the rest of the API —
// and adapts it to the minimal `Socket` interface the client depends on. This
// is the only place the `ws` package is imported; the client and its tests stay
// dependency-free.
export function createOneSocketFactory(apiKey: string): SocketFactory {
  return (url: string): Socket => {
    const ws = new WebSocket(url, { headers: { 'X-One-Secret': apiKey } });
    return {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onOpen: (handler) => ws.on('open', handler),
      onMessage: (handler) => ws.on('message', (data: RawData) => handler(data.toString())),
      onClose: (handler) => ws.on('close', handler),
      onError: (handler) => ws.on('error', handler),
    };
  };
}
