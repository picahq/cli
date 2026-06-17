import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  readConfig,
  getApiKey,
  getWhoAmI,
  getDeviceId,
  getEnvFromApiKey,
  telemetryNoticeShown,
  markTelemetryNoticeShown,
  appendAnalyticsQueue,
  readAnalyticsQueue,
  writeAnalyticsQueue,
} from './config.js';
import { isAgentMode } from './output.js';

/**
 * CLI usage analytics for the One CLI (identified — keyed to the One user).
 *
 * SCOPE — deliberately narrow. Emits ONLY CLI-specific signals the backend
 * can't see: which commands run, agent vs human, on which CLI version/OS. It
 * does NOT re-emit domain events — when the CLI calls pica-v2 (connect a
 * platform, execute an action, etc.) pica-v2 already emits those server-side,
 * so emitting them here too would double-count.
 *
 * TRANSPORT — PostHog's public HTTP capture API with the project's PUBLIC
 * ingest key (write-only; safe to embed, like the dashboard's
 * NEXT_PUBLIC_POSTHOG_KEY). Events are keyed on the One user id, so CLI
 * activity unifies onto the same PostHog person as the dashboard.
 *
 * DELIVERY — a CLI process is short-lived and a network round-trip is ~1s, so
 * we never make the user wait: each event is written to a tiny on-disk queue
 * instantly (sync), the queue is sent in the background overlapping the
 * command, in-flight requests are aborted at exit (so they can't hold the
 * process open), and anything not confirmed delivered is retried on the next
 * run. A stable `$insert_id` lets PostHog dedupe the occasional re-send. Net:
 * zero added latency, no lost events. (This is the standard CLI-telemetry
 * pattern used by tools like Next.js.)
 *
 * PRIVACY — on by default (opt-out), per CLI norms. We never send positional
 * args or flag values (they can contain emails, queries, payloads, secrets) —
 * only the command path. Disabled by ONE_NO_TELEMETRY / DO_NOT_TRACK / CI /
 * `telemetry: 'off'` in config (opting out also drops any queued events).
 */

const require = createRequire(import.meta.url);

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * PUBLIC PostHog project (ingest) key for the "Pica Prod" project. Write-only:
 * it can send events but never read data or settings — which is why it's safe
 * to ship in a client, exactly as the dashboard ships its public
 * `NEXT_PUBLIC_POSTHOG_KEY`. (The secret read/write key is the `phx_…`
 * personal key, which is NOT in this codebase.) Both sandbox (test keys) and
 * production (live keys) report here, mirroring the dashboard; the environment
 * is recorded as the `env` property, not a separate destination. Overridable
 * via env for internal testing.
 */
const DEFAULT_POSTHOG_KEY = 'phc_a9ok4w0uxiZcVoSWOISIlin85lHMXQD3vWPaYnuRlRV';

interface QueuedEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

/** Abort controllers for in-flight sends, so flush() can cancel them at exit. */
const inFlight = new Set<AbortController>();
/** `$insert_id`s confirmed delivered this run (so flush() drops them from the queue). */
const delivered = new Set<string>();

function posthogHost(): string {
  return process.env.ONE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
}
function posthogKey(): string {
  return process.env.ONE_POSTHOG_KEY || DEFAULT_POSTHOG_KEY;
}

function cliVersion(): string {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function envName(): 'live' | 'test' {
  const key = getApiKey();
  return key ? getEnvFromApiKey(key) : 'live';
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Opt-in stderr tracing for troubleshooting telemetry delivery. */
function debugLog(message: string): void {
  if (isOn(process.env.ONE_ANALYTICS_DEBUG)) {
    process.stderr.write(`[analytics] ${message}\n`);
  }
}

/**
 * Telemetry is on by default; disabled when any opt-out signal is present.
 * Mirrors the house `ONE_NO_AUTO_UPDATE` pattern, honors the cross-tool
 * `DO_NOT_TRACK` standard, and auto-disables under CI (no human to consent).
 */
export function isTelemetryDisabled(): boolean {
  if (isOn(process.env.ONE_NO_TELEMETRY) || isOn(process.env.ONE_DISABLE_TELEMETRY)) return true;
  if (isOn(process.env.DO_NOT_TRACK)) return true;
  if (isOn(process.env.CI)) return true;
  if (readConfig()?.telemetry === 'off') return true;
  return false;
}

function distinctId(): string {
  return getWhoAmI()?.user?.id ?? getDeviceId();
}

function baseProperties(): Record<string, unknown> {
  return {
    $lib: 'one-cli',
    cli_version: cliVersion(),
    agent_mode: isAgentMode(),
    env: envName(),
    os: process.platform,
    arch: process.arch,
    node_version: process.versions.node,
  };
}

/**
 * Person properties that unify the CLI user with their dashboard profile.
 * Only attached when we have an authenticated identity.
 */
function personSet(): Record<string, unknown> | undefined {
  const whoami = getWhoAmI();
  if (!whoami?.user) return undefined;
  const set: Record<string, unknown> = {};
  if (whoami.user.email) set.email = whoami.user.email;
  if (whoami.user.name) set.name = whoami.user.name;
  if (whoami.organization?.id) set.organization_id = whoami.organization.id;
  return Object.keys(set).length ? set : undefined;
}

/** Fire one queued event to PostHog (best-effort); mark it delivered on success. */
function send(item: QueuedEvent): void {
  const insertId = item.properties.$insert_id as string | undefined;
  const controller = new AbortController();
  inFlight.add(controller);
  void (async () => {
    try {
      const res = await fetch(`${posthogHost()}/i/v0/e/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: posthogKey(),
          event: item.event,
          distinct_id: item.distinct_id,
          properties: item.properties,
          timestamp: item.timestamp,
        }),
        signal: controller.signal,
      });
      if (res.ok && insertId) delivered.add(insertId);
      debugLog(`"${item.event}" -> HTTP ${res.status}${res.ok ? '' : ' (retry next run)'}`);
    } catch (err) {
      // Best-effort: a tracking failure must never affect the command; the
      // event stays queued and is retried on the next run.
      debugLog(`"${item.event}" not sent: ${err instanceof Error ? err.message : String(err)} (retry next run)`);
    } finally {
      inFlight.delete(controller);
    }
  })();
}

/**
 * Record a CLI usage event: write it to the on-disk queue instantly (sync, so
 * it survives an immediate process exit). Sending is done by drainQueue().
 * Never throws, never blocks. No-op when telemetry is disabled.
 */
export function capture(event: string, properties: Record<string, unknown> = {}): void {
  if (isTelemetryDisabled()) {
    debugLog(`disabled — skipping "${event}"`);
    return;
  }
  const props: Record<string, unknown> = { ...baseProperties(), ...properties, $insert_id: randomUUID() };
  const set = personSet();
  if (set) props.$set = set;
  const item: QueuedEvent = {
    event,
    distinct_id: distinctId(),
    properties: props,
    timestamp: new Date().toISOString(),
  };
  appendAnalyticsQueue(JSON.stringify(item));
}

/**
 * Emit the "CLI Command Run" usage event for the command about to execute.
 * Records only the command PATH (e.g. "actions execute") — never positional
 * args or flag values, which can contain PII or secrets.
 */
export function captureCommand(command: Command): void {
  capture('CLI Command Run', { command: commandPath(command) });
}

function commandPath(command: Command): string {
  const parts: string[] = [];
  let current: Command | null | undefined = command;
  while (current && current.name() && current.name() !== 'one') {
    parts.unshift(current.name());
    current = current.parent;
  }
  return parts.join(' ') || command.name();
}

/**
 * Start sending every queued event (this run's + any left over from prior
 * runs) in the background. Called once in preAction so the requests overlap
 * the command's own work. Opting out drops the backlog instead of sending it.
 */
export function drainQueue(): void {
  if (isTelemetryDisabled()) {
    writeAnalyticsQueue([]);
    return;
  }
  for (const line of readAnalyticsQueue()) {
    try {
      const item = JSON.parse(line) as QueuedEvent;
      if (item?.properties?.$insert_id) send(item);
    } catch {
      // Skip malformed lines; flush() prunes them from the queue.
    }
  }
}

/**
 * Called from postAction. Abort any still-in-flight sends so a pending request
 * can't hold the process open (and the user waiting) on the network, then
 * rewrite the queue to keep only events NOT yet confirmed delivered — those
 * are retried on the next run.
 */
export function flush(): void {
  for (const controller of inFlight) controller.abort();

  const remaining = readAnalyticsQueue().filter((line) => {
    try {
      const id = (JSON.parse(line) as QueuedEvent).properties?.$insert_id as string | undefined;
      return id ? !delivered.has(id) : false;
    } catch {
      return false; // drop malformed lines
    }
  });
  writeAnalyticsQueue(remaining);
}

/**
 * One-time, opt-out disclosure printed to stderr (never stdout, so it can't
 * corrupt `--agent` JSON or piped output). Shown once per machine, and never
 * in agent mode or when telemetry is disabled.
 */
export function maybeShowTelemetryNotice(): void {
  if (isTelemetryDisabled() || isAgentMode()) return;
  if (telemetryNoticeShown()) return;
  markTelemetryNoticeShown();
  process.stderr.write(
    pc.dim(
      'One CLI collects usage analytics (which commands run, linked to your One account) to improve the product.\n' +
        'No arguments, inputs, or secrets are ever collected. Opt out anytime with ONE_NO_TELEMETRY=1.\n',
    ),
  );
}
