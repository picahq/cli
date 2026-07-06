// The `one listen` WebSocket contract. The CLI and the server both speak these
// messages; keep them in sync with the server-side definition.
//
// Modeled on the Stripe CLI's websocket protocol: the server pushes `event`
// messages, the CLI forwards each to the local endpoint and replies with a
// `response` (the local endpoint's answer) plus an `event_ack`.

/** Which One stream an event came from. */
export type ListenSource = 'relay' | 'subscription';

/** A single event pushed to the CLI to forward locally. */
export interface ListenEvent {
  /** Whether this is an inbound relay (platform) event or a One subscription event. */
  source: ListenSource;
  /** Stable event id — used for the ack and for local deduplication. */
  id: string;
  /** Dotted event type (e.g. `customer.created`, `connection.created`); null when unknown. */
  eventType: string | null;
  /** Source platform for relay events (e.g. `stripe`); absent for subscription events. */
  platform?: string;
  /** RFC 3339 timestamp of when One received/emitted the event. */
  timestamp: string;
  /**
   * The exact raw request body One received/signed, as a string. Replayed to
   * the local endpoint byte-for-byte — never re-serialized — so a signature
   * over the raw body (Stripe et al.) still verifies locally.
   */
  body: string;
  /** Headers to replay to the local endpoint, including any signature header. */
  headers: Record<string, string>;
}

/** Messages the server pushes to the CLI. */
export type ServerMessage =
  | { type: 'ready'; sessionId: string; scope: string }
  | { type: 'event'; conversationId: string; event: ListenEvent };

/** Messages the CLI sends back to the server. */
export type ClientMessage =
  | { type: 'event_ack'; conversationId: string; eventId: string }
  | {
      type: 'response';
      conversationId: string;
      status: number;
      body: string;
      headers: Record<string, string>;
    };
