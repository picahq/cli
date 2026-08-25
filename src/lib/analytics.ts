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
import { cliVersion } from './version.js';

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
 * command, and anything not confirmed delivered is retried on the next run.
 * At exit we give in-flight requests a short grace period (EXIT_GRACE_MS),
 * then abort whatever is left so telemetry can never hold the process open.
 *
 * Retries are idempotent and bounded. An aborted request has usually already
 * left the machine, so PostHog ingests it while the CLI still thinks it is
 * undelivered; PostHog dedupes on the event `uuid` (NOT on `$insert_id`), so
 * every event carries a `uuid` derived from its `$insert_id` and a re-sent copy
 * collapses on ingest. Each event also counts its dispatches and is dropped
 * after SEND_MAX_ATTEMPTS or QUEUE_MAX_AGE_MS, so a stuck backlog can never
 * replay forever (one user's queue once re-sent every rollup ~230 times).
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
  /** PostHog's dedupe key; derived from `$insert_id` (see uuidFromInsertId). */
  uuid?: string;
  /** How many runs have dispatched this event; dropped at SEND_MAX_ATTEMPTS. */
  attempts?: number;
}

/** An event is dropped once it has been dispatched this many times. */
export const SEND_MAX_ATTEMPTS = 3;
/** ...or once it is older than this (a stale backlog is not worth replaying). */
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How long flush() lets in-flight sends finish before aborting them at exit. */
export const EXIT_GRACE_MS = 300;

/** Abort controllers for in-flight sends, so flush() can cancel them at exit. */
const inFlight = new Set<AbortController>();
/** The in-flight send promises, so flush() can wait (briefly) for them. */
const pending = new Set<Promise<void>>();
/** `$insert_id`s dispatched this run (never send the same event twice per run). */
const dispatched = new Set<string>();
/** `$insert_id`s confirmed delivered this run (so flush() drops them from the queue). */
const delivered = new Set<string>();

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event `uuid` PostHog dedupes on, derived deterministically from the
 * `$insert_id` so a re-sent copy of an event carries the same uuid and
 * collapses on ingest. A v5-shaped UUID built from a SHA-1 of the id; an id
 * that already is a UUID is used as is.
 */
export function uuidFromInsertId(insertId: string): string {
  if (UUID_SHAPE.test(insertId)) return insertId.toLowerCase();
  const h = createHash('sha1').update(`one-cli-event:${insertId}`).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function posthogHost(): string {
  return process.env.ONE_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
}
function posthogKey(): string {
  return process.env.ONE_POSTHOG_KEY || DEFAULT_POSTHOG_KEY;
}

// cliVersion() now lives in lib/version.ts — the old `require('../package.json')`
// here resolved to `src/package.json`, which does not exist, so every telemetry
// event in a source checkout reported version "unknown". Correct only in the
// bundled dist/ layout.

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
  if (insertId) dispatched.add(insertId);
  const controller = new AbortController();
  inFlight.add(controller);
  const run = (async () => {
    try {
      const res = await fetch(`${posthogHost()}/i/v0/e/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: posthogKey(),
          event: item.event,
          distinct_id: item.distinct_id,
          // PostHog's dedupe key — a re-sent copy is dropped on ingest.
          uuid: item.uuid ?? (insertId ? uuidFromInsertId(insertId) : undefined),
          properties: item.properties,
          timestamp: item.timestamp,
        }),
        signal: controller.signal,
      });
      if (res.ok && insertId) delivered.add(insertId);
      debugLog(`"${item.event}" -> HTTP ${res.status}${res.ok ? '' : ' (retry next run)'}`);
    } catch (err) {
      // Best-effort: a tracking failure must never affect the command; the
      // event stays queued and is retried on the next run (bounded, see drainQueue).
      debugLog(`"${item.event}" not sent: ${err instanceof Error ? err.message : String(err)} (retry next run)`);
    } finally {
      inFlight.delete(controller);
    }
  })();
  pending.add(run);
  void run.finally(() => pending.delete(run));
}

/**
 * Record a CLI usage event: write it to the on-disk queue instantly (sync, so
 * it survives an immediate process exit). Sending is done by drainQueue().
 * Never throws, never blocks. No-op when telemetry is disabled.
 */
export function capture(
  event: string,
  properties: Record<string, unknown> = {},
  opts: { distinctId?: string; timestamp?: string; personProfile?: boolean } = {},
): void {
  if (isTelemetryDisabled()) {
    debugLog(`disabled — skipping "${event}"`);
    return;
  }
  const did = opts.distinctId ?? distinctId();
  const props: Record<string, unknown> = { ...baseProperties(), ...properties };
  // One-off events get a random id; rollups pass a content-derived id (see
  // emitRollup). The id is mirrored into the event `uuid`, which is what
  // PostHog actually dedupes on, so a re-sent copy collapses to one event.
  if (props.$insert_id === undefined) props.$insert_id = randomUUID();
  const insertId = props.$insert_id as string;
  if (opts.personProfile === false) {
    // Anonymous-rate event: no person profile is created or updated for it
    // (rollups don't need one — the signup events already made the person),
    // and person properties would be ignored, so none are attached.
    props.$process_person_profile = false;
  } else if (did === distinctId()) {
    // Person props belong only to the *current* user; never tag a rollup for a
    // previous login (distinct_id ≠ current) with the new user's email/name.
    const set = personSet();
    if (set) props.$set = set;
  }
  const item: QueuedEvent = {
    event,
    distinct_id: did,
    properties: props,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    uuid: uuidFromInsertId(insertId),
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
  // path + agent flag). A re-emitted copy of the same batch hashes identically
  // (and so gets the same event uuid, which PostHog dedupes on); genuinely
  // different batches hash differently (distinct per-command timestamps), so
  // this never collapses real activity.
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
    {
      distinctId: did,
      timestamp: new Date(group[group.length - 1].ts).toISOString(),
      // Rollups bill at the anonymous rate; the person already exists.
      personProfile: false,
    },
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
 * runs) in the background, so the requests overlap the command's own work.
 * Called in preAction and again in postAction (for a rollup that came due
 * during the command). Opting out drops the backlog instead of sending it.
 *
 * Bounded: an event is dispatched at most SEND_MAX_ATTEMPTS times in total
 * (the count is persisted before the send so a crash can't reset it) and is
 * dropped unsent once older than QUEUE_MAX_AGE_MS. A line an older CLI wrote
 * without a `uuid` gets one here, so an inherited backlog dedupes too.
 */
export function drainQueue(): void {
  if (isTelemetryDisabled()) {
    writeAnalyticsQueue([]);
    return;
  }
  const now = Date.now();
  const kept: string[] = [];
  let changed = false;
  for (const line of readAnalyticsQueue()) {
    let item: QueuedEvent;
    try {
      item = JSON.parse(line) as QueuedEvent;
    } catch {
      changed = true; // drop a malformed line
      continue;
    }
    const insertId = item?.properties?.$insert_id as string | undefined;
    if (!insertId) {
      changed = true;
      continue;
    }
    const age = now - Date.parse(item.timestamp);
    const attempts = item.attempts ?? 0;
    if (!(age < QUEUE_MAX_AGE_MS) || attempts >= SEND_MAX_ATTEMPTS) {
      debugLog(`"${item.event}" dropped (${attempts} attempts, ${Math.round(age / 60_000)} min old)`);
      changed = true;
      continue;
    }
    if (dispatched.has(insertId)) {
      kept.push(line); // already in flight (or delivered) this run; flush() settles it
      continue;
    }
    item.attempts = attempts + 1;
    if (!item.uuid) item.uuid = uuidFromInsertId(insertId);
    kept.push(JSON.stringify(item));
    changed = true;
    send(item);
  }
  if (changed) writeAnalyticsQueue(kept);
}

/**
 * Called from postAction. Give in-flight sends a short grace period to land,
 * abort whatever is still pending so it can't hold the process open (and the
 * user waiting), then rewrite the queue to keep only events NOT yet confirmed
 * delivered and still under the attempt cap — those are retried next run.
 */
export async function flush(): Promise<void> {
  if (pending.size > 0) {
    // The timer is deliberately NOT unref'd: it is the only thing guaranteed
    // to keep the process alive until the queue below is pruned, and it is
    // bounded to EXIT_GRACE_MS.
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => setTimeout(resolve, EXIT_GRACE_MS)),
    ]);
  }
  for (const controller of inFlight) controller.abort();

  const remaining = readAnalyticsQueue().filter((line) => {
    try {
      const item = JSON.parse(line) as QueuedEvent;
      const id = item.properties?.$insert_id as string | undefined;
      if (!id || delivered.has(id)) return false;
      return (item.attempts ?? 0) < SEND_MAX_ATTEMPTS;
    } catch {
      return false; // drop malformed lines
    }
  });
  writeAnalyticsQueue(remaining);
  // The run is over: the next drain (in this process, e.g. tests) starts clean.
  dispatched.clear();
  delivered.clear();
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
