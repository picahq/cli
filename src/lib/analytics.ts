import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
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
  appendUsageLog,
  claimUsageLog,
  writeUsageLog,
  readUsageState,
  writeUsageState,
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
 * AGGREGATION — one event per command would let a single agent loop emit tens
 * of thousands of events a day and blow our PostHog bill. Instead the CLI
 * appends each command to a local log and rolls it up into ONE "CLI Usage
 * Rollup" event with EXACT counts, flushed at most ~once per 5 min of activity
 * per user (see recordCommand / flushUsageRollups). The first command of each
 * day flushes immediately, so no user is ever missed — even a one-and-done try.
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

/** True when the CLI has an identity — a logged-in user or a configured API key. */
function isAuthenticated(): boolean {
  return !!getWhoAmI()?.user || !!getApiKey();
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
    authenticated: isAuthenticated(),
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
export function capture(
  event: string,
  properties: Record<string, unknown> = {},
  opts: { distinctId?: string; timestamp?: string } = {},
): void {
  if (isTelemetryDisabled()) {
    debugLog(`disabled — skipping "${event}"`);
    return;
  }
  const did = opts.distinctId ?? distinctId();
  const props: Record<string, unknown> = { ...baseProperties(), ...properties };
  // One-off events get a random id; rollups pass a content-derived id (see
  // emitRollup) so duplicate batches collapse to a single event in PostHog.
  if (props.$insert_id === undefined) props.$insert_id = randomUUID();
  // Person props belong only to the *current* user; never tag a rollup for a
  // previous login (distinct_id ≠ current) with the new user's email/name.
  if (did === distinctId()) {
    const set = personSet();
    if (set) props.$set = set;
  }
  const item: QueuedEvent = {
    event,
    distinct_id: did,
    properties: props,
    timestamp: opts.timestamp ?? new Date().toISOString(),
  };
  appendAnalyticsQueue(JSON.stringify(item));
}

/** Flush a rollup at most ~once per this window of activity per user. */
const ROLLUP_WINDOW_MS = 5 * 60 * 1000;
/** ...or after this many commands accumulate (burst safety cap). */
const ROLLUP_MAX_BATCH = 500;

interface UsageEntry { ts: number; command: string; agent: boolean; did: string }

/** UTC calendar day (YYYY-MM-DD) of a timestamp — the first-touch boundary. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Top-level commands worth recording BEFORE authentication — the install / try /
 * activation funnel. Anything else run without an identity is dropped, so a
 * determined unauthenticated loop (e.g. `actions execute` failing on repeat)
 * can't pollute analytics. Fail-closed: unknown commands need auth to count.
 */
const PRE_AUTH_COMMANDS = new Set([
  'init', 'login', 'logout', 'guide', 'platforms', 'onboard', 'config', 'update', 'help',
]);

/** Authenticated → record everything; unauthenticated → only the pre-auth funnel. */
function shouldRecord(commandPath: string): boolean {
  if (isAuthenticated()) return true;
  return PRE_AUTH_COMMANDS.has(commandPath.split(' ')[0]);
}

/**
 * Record the command about to run for usage analytics. Appends the command
 * PATH (e.g. "actions execute") — never args/flags — to the local rollup log
 * (instant, sync), then flushes any due rollups. The first command of the day
 * flushes immediately so a user is captured even if they run the CLI once and
 * never again. Never throws, never blocks. No-op when telemetry is disabled, or
 * when an unauthenticated session runs an auth-required command (see shouldRecord).
 */
export function recordCommand(command: Command): void {
  if (isTelemetryDisabled()) {
    writeUsageLog([]);
    return;
  }
  const cmdPath = commandPath(command);
  if (!shouldRecord(cmdPath)) return;
  const did = distinctId();
  const entry: UsageEntry = { ts: Date.now(), command: cmdPath, agent: isAgentMode(), did };
  appendUsageLog(JSON.stringify(entry));

  const today = utcDay(entry.ts);
  const state = readUsageState();
  // First command today (or first ever, or right after a login) → flush now so
  // the user is captured immediately and can never be missed.
  const firstTouch = state.lastDay !== today || state.distinctId !== did;
  flushUsageRollups({ force: firstTouch });
  if (firstTouch) writeUsageState({ lastDay: today, distinctId: did });
}

/**
 * Aggregate the local usage log into "CLI Usage Rollup" events and enqueue the
 * ones that are due — a batch is due when forced (first-touch / exit drain),
 * the window elapsed, it hit the size cap, or a newer login superseded it.
 * Counts are EXACT (no sampling). Entries not yet due are kept for the next run.
 */
export function flushUsageRollups(opts: { force?: boolean } = {}): void {
  if (isTelemetryDisabled()) {
    writeUsageLog([]);
    return;
  }
  // Atomically claim the batch so concurrent CLI processes can't each emit it
  // (the cause of duplicate "CLI Usage Rollup" events). Only one flush wins.
  const lines = claimUsageLog();
  if (!lines || lines.length === 0) return;

  const entries: UsageEntry[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as UsageEntry;
      if (e && typeof e.ts === 'number' && typeof e.command === 'string' && typeof e.did === 'string') {
        entries.push(e);
      }
    } catch {
      // skip a malformed line
    }
  }
  if (entries.length === 0) return;

  const currentDid = entries[entries.length - 1].did;
  const now = Date.now();
  // Group by distinct_id (a login mid-log yields one rollup per identity).
  const groups = new Map<string, UsageEntry[]>();
  for (const e of entries) {
    const g = groups.get(e.did);
    if (g) g.push(e);
    else groups.set(e.did, [e]);
  }

  const kept: UsageEntry[] = [];
  for (const [did, group] of groups) {
    const due =
      opts.force === true ||
      did !== currentDid || // a superseded login's batch — flush it now
      group.length >= ROLLUP_MAX_BATCH ||
      now - group[0].ts >= ROLLUP_WINDOW_MS;
    if (due) emitRollup(did, group);
    else kept.push(...group);
  }
  // Re-append (never overwrite) the not-yet-due entries, so we can't clobber rows
  // another process appended to the fresh log while we held this batch.
  for (const e of kept) appendUsageLog(JSON.stringify(e));
}

/** Build + enqueue one "CLI Usage Rollup" event carrying exact counts for a batch. */
function emitRollup(did: string, group: UsageEntry[]): void {
  const byCommand: Record<string, number> = {};
  let agentCount = 0;
  for (const e of group) {
    byCommand[e.command] = (byCommand[e.command] ?? 0) + 1;
    if (e.agent) agentCount += 1;
  }
  // Content-derived id hashed over the EXACT entries (each command's timestamp +
  // path + agent flag). A re-emitted copy of the same batch hashes identically so
  // PostHog dedupes it on ingest; genuinely different batches hash differently
  // (distinct per-command timestamps), so this never collapses real activity.
  const insertId = createHash('sha1')
    .update(`${did}|${group.map((e) => `${e.ts}:${e.command}:${e.agent ? 1 : 0}`).join('|')}`)
    .digest('hex');
  capture(
    'CLI Usage Rollup',
    {
      command_count: group.length,
      by_command: byCommand,
      agent_count: agentCount,
      human_count: group.length - agentCount,
      window_start: new Date(group[0].ts).toISOString(),
      window_end: new Date(group[group.length - 1].ts).toISOString(),
      $insert_id: insertId,
    },
    { distinctId: did, timestamp: new Date(group[group.length - 1].ts).toISOString() },
  );
  debugLog(`rollup — ${group.length} command(s) for ${did}`);
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
