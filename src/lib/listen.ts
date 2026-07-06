import type { ClientMessage, ListenEvent, ServerMessage } from './listen-protocol.js';

export interface ForwardResult {
  ack: Extract<ClientMessage, { type: 'event_ack' }>;
  response: Extract<ClientMessage, { type: 'response' }>;
}

export const LISTEN_SOURCES = ['relay', 'subscriptions', 'both'] as const;
export type ListenSourceOption = (typeof LISTEN_SOURCES)[number];

export interface ListenTarget {
  url: string;
  forwardTo: string;
  source: ListenSourceOption;
}

export type ResolveListenResult = { ok: true; target: ListenTarget } | { ok: false; error: string };

// Validates options + config into a listen target or a user-facing error. Pure.
export function resolveListenTarget(
  options: { forwardTo?: string; source?: string; events?: string },
  config: { apiKey: string | null; apiBase: string },
): ResolveListenResult {
  if (!config.apiKey) {
    return { ok: false, error: 'Not configured. Run `one init` first.' };
  }
  if (!options.forwardTo) {
    return { ok: false, error: '--forward-to <url> is required (e.g. --forward-to http://localhost:4242/webhook).' };
  }
  const source = (options.source ?? 'both').toLowerCase();
  if (!LISTEN_SOURCES.includes(source as ListenSourceOption)) {
    return { ok: false, error: `Invalid --source "${source}". Use one of: ${LISTEN_SOURCES.join(', ')}.` };
  }
  return {
    ok: true,
    target: {
      url: buildListenUrl(config.apiBase, source, options.events),
      forwardTo: options.forwardTo,
      source: source as ListenSourceOption,
    },
  };
}

// API base → listen WebSocket URL (https→wss) with source + optional filter.
export function buildListenUrl(apiBase: string, source: string, events?: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/webhooks/listen`;
  url.search = '';
  url.searchParams.set('source', source);
  if (events) url.searchParams.set('events', events);
  return url.toString();
}

// Transport headers describing the original connection — replaying a stale
// `content-length`/`host` corrupts the local request; `fetch` sets its own.
const STRIPPED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
  'proxy-authorization',
]);

// Replays the event's headers minus transport ones, defaulting content-type
// only when absent (case-insensitive) so signatures + non-JSON bodies survive.
function buildForwardHeaders(eventHeaders: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  let hasContentType = false;
  for (const [name, value] of Object.entries(eventHeaders)) {
    const lower = name.toLowerCase();
    if (STRIPPED_HEADERS.has(lower)) continue;
    if (lower === 'content-type') hasContentType = true;
    headers[name] = value;
  }
  if (!hasContentType) headers['content-type'] = 'application/json';
  return headers;
}

export interface HandlerContext {
  forwardTo: string;
  send: (message: ClientMessage) => void;
  fetchImpl?: typeof fetch;
  onReady?: (sessionId: string, scope: string) => void;
  onEvent?: (event: ListenEvent, response: ForwardResult['response']) => void;
}

// `ready` announces the session; `event` is forwarded, then its response + ack
// are sent back. Only calls `send`, so it's testable without a live socket.
export async function handleServerMessage(message: ServerMessage, ctx: HandlerContext): Promise<void> {
  if (message.type === 'ready') {
    ctx.onReady?.(message.sessionId, message.scope);
    return;
  }

  const { ack, response } = await forwardEvent(message.event, message.conversationId, ctx.forwardTo, ctx.fetchImpl);
  ctx.send(response);
  ctx.send(ack);
  ctx.onEvent?.(message.event, response);
}

// POSTs the event locally and returns the response + ack to send back. A dead
// endpoint still acks (status 0) so the stream keeps flowing.
export async function forwardEvent(
  event: ListenEvent,
  conversationId: string,
  forwardTo: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ForwardResult> {
  const ack = { type: 'event_ack' as const, conversationId, eventId: event.id };

  try {
    const res = await fetchImpl(forwardTo, {
      method: 'POST',
      headers: buildForwardHeaders(event.headers),
      body: event.body,
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      ack,
      response: { type: 'response', conversationId, status: res.status, body: text, headers },
    };
  } catch (error) {
    return {
      ack,
      response: {
        type: 'response',
        conversationId,
        status: 0,
        body: error instanceof Error ? error.message : String(error),
        headers: {},
      },
    };
  }
}
