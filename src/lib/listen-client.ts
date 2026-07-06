import { handleServerMessage, type ForwardResult } from './listen.js';
import type { ListenEvent, ServerMessage } from './listen-protocol.js';

// The minimal socket the client depends on. The real implementation wraps the
// `ws` package (for header auth); tests inject a fake, so nothing here touches
// the network or requires `ws`.
export interface Socket {
  send(data: string): void;
  close(): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: unknown) => void): void;
}

export type SocketFactory = (url: string) => Socket;

export type ListenStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Exponential backoff in ms, capped. */
export function computeBackoff(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

export interface ListenClientConfig {
  url: string;
  forwardTo: string;
  createSocket: SocketFactory;
  fetchImpl?: typeof fetch;
  reconnectDelayMs?: number;
  reconnectCapMs?: number;
  onReady?: (sessionId: string, scope: string) => void;
  onEvent?: (event: ListenEvent, response: ForwardResult['response']) => void;
  onStatus?: (status: ListenStatus) => void;
  onError?: (error: unknown) => void;
}

export class ListenClient {
  private socket?: Socket;
  private stopped = false;
  private opened = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly config: ListenClientConfig) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.config.onStatus?.('closed');
  }

  private connect(): void {
    this.config.onStatus?.('connecting');
    const socket = this.config.createSocket(this.config.url);
    this.socket = socket;
    socket.onOpen(() => {
      this.opened = true;
      this.reconnectAttempts = 0;
      this.config.onStatus?.('open');
    });
    socket.onMessage((data) => this.onMessage(socket, data));
    socket.onError((error) => this.config.onError?.(error));
    socket.onClose(() => this.onClose());
  }

  // `socket` is bound to the connection the message arrived on, so a reply for
  // an event received before a reconnect isn't acked on the new session.
  private async onMessage(socket: Socket, data: string): Promise<void> {
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    await handleServerMessage(message, {
      forwardTo: this.config.forwardTo,
      fetchImpl: this.config.fetchImpl,
      send: (m) => {
        try {
          socket.send(JSON.stringify(m));
        } catch {
          // Socket closed mid-forward; best-effort, redelivers on reconnect.
        }
      },
      onReady: this.config.onReady,
      onEvent: this.config.onEvent,
    });
  }

  private onClose(): void {
    if (this.stopped) return;
    // A failure before we ever opened is almost always config/auth (bad key,
    // wrong base, 401) — already surfaced via `onError`; stop, don't loop.
    if (!this.opened) {
      this.stopped = true;
      this.config.onStatus?.('closed');
      return;
    }
    this.config.onStatus?.('reconnecting');
    const delay = computeBackoff(this.reconnectAttempts, this.config.reconnectDelayMs ?? 1000, this.config.reconnectCapMs ?? 30000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
