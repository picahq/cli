// Guide content — concise overview that routes agents to skill docs for details.
import { generateFlowGuide } from './flow-schema.js';

export const GUIDE_OVERVIEW = `# One CLI — Agent Guide

## Setup

1. Run \`one init\` for full interactive setup (authentication, skill installation, and platform connections)
2. Run \`one add <platform>\` to connect platforms via OAuth
3. Run \`one --agent connection list\` to verify connections

You can also use \`one login\` / \`one logout\` to manage authentication separately (global or per-directory).

### Agent-driven setup (no prompts)
To onboard a user without any terminal interaction, pass \`--auth\` to \`one init\`. This disables every prompt, auto-installs the One skill, and skips the connect-a-platform step (run \`one add <platform>\` afterwards).

\`\`\`bash
one init --auth browser              # opens a login window; the user authenticates, the CLI saves the key
one init --auth browser --project    # same, but scoped to this folder (default scope is global)
one init --auth manual --api-key sk_live_...   # headless / CI — no browser
\`\`\`

With \`--auth browser\` the user sees a browser window, picks how to authenticate, and the window closes when done — the agent never blocks on stdin. Add \`--openai-key sk-...\` to enable semantic search in \`one mem\` during setup.

## The --agent Flag

Always use \`--agent\` for machine-readable JSON output. It disables colors, spinners, and interactive prompts.

\`\`\`bash
one --agent <command>
\`\`\`

All commands return JSON. If an \`error\` key is present, the command failed.

## IMPORTANT: Read the guide before you act

Before using any feature, read its guide section first: \`one guide actions\`, \`one guide flows\`, or \`one guide relay\`. The guide teaches you the correct workflow, required fields, and common mistakes. Never guess — read the guide, then act.

## Features

### 1. Actions — Execute API calls on 400+ platforms
Search for actions, read their docs, and execute them. This is the core workflow.

**Quick start:**
\`\`\`bash
one --agent connection list                                    # See connected platforms
one --agent connection delete <connection-key>                 # Remove a connection
one --agent actions search <platform> "<query>" -t execute     # Find an action
one --agent actions knowledge <platform> <actionId>            # Read docs (REQUIRED)
one --agent actions execute <platform> <actionId> <key> -d '{}'  # Execute it
\`\`\`

**Parameter flags:**
- \`-d <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — URL path variables (e.g., \`{"userId": "me"}\`)
- \`--query-params <json>\` — Query parameters (arrays expand to repeated params)
- \`--form-url-encoded\` — Send as form data instead of JSON
- \`--dry-run\` — Preview request without executing
- \`--mock\` — Return example response without making an API call (useful for building UI against a response shape)
- \`--skip-validation\` — Skip input validation against the action schema
- \`--output <path>\` — Save response to a file (for binary downloads like PDFs, images, documents)
- \`--no-cache\` — Bypass the cached action details and re-fetch them; the fresh details still refresh the cache (execution itself is never cached)

The CLI validates required parameters against the action schema before executing. If you're missing a required path variable, query param, or body field, you'll get a clear error listing what's missing and which flag to use. Pass \`--skip-validation\` to bypass.

Do NOT pass path or query parameters in \`-d\` — use the correct flags.

### 2. Flows — Multi-step API workflows
Chain actions across platforms as JSON workflow files with conditions, loops, parallel execution, transforms, and AI analysis via bash steps.

**Quick start:**
\`\`\`bash
one --agent flow create <key> --definition '<json>'   # Create a workflow
one --agent flow validate <key>                       # Validate it
one --agent flow execute <key> -i param=value         # Execute it
one --agent flow list                                 # List all workflows
\`\`\`

**Key concepts:**
- Workflows live at \`.one/flows/<key>/flow.json\` (folder layout — REQUIRED for new flows). Flows can be organized into subdirectory groups: \`.one/flows/<group>/<key>/flow.json\`. Reference them as \`group/key\` or just the bare key. The legacy \`.one/flows/<key>.flow.json\` single-file layout is DEPRECATED but still loads for backward compatibility
- Code steps can reference an external \`.mjs\` module under the flow's \`lib/\` folder (stdin JSON in, stdout JSON out) — keeps JS out of JSON strings and makes flows shareable
- 12 step types: action, transform, code, condition, loop, parallel, file-read, file-write, while, flow, paginate, bash
- Data wiring via selectors: \`$.input.param\`, \`$.steps.stepId.response\`, \`$.loop.item\`
- AI analysis via bash steps: \`claude --print\` with \`parseJson: true\`
- Use \`--allow-bash\` to enable bash steps, \`--mock\` for dry-run with realistic mock responses (uses example data from action schemas)
- Use \`--skip-validation\` to bypass input validation on action steps
- Use \`--output-file <path>\` to stream the full result to a file instead of stdout — for large results that would otherwise be truncated or hit the JSON string-size limit; stdout (and \`--agent\` output) then carries an \`outputFile\` pointer instead of inline \`steps\`
- Step-level \`if\`/\`unless\` (and \`while\`/\`condition\` steps) are null-safe: a condition referencing a skipped or not-yet-run step's output (e.g. \`$.steps.maybeSkipped.output.x\`) evaluates to \`false\` instead of crashing the flow

### 3. Relay — Webhook event forwarding between platforms
Receive webhooks from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forward event data to any connected platform using passthrough actions with Handlebars templates. No middleware, no code.

**Quick start:**
\`\`\`bash
one --agent relay platforms                                     # See relay-capable platforms
one --agent relay event-types <platform>                        # See available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '[{"type":"passthrough","actionId":"...","connectionKey":"...","body":{...}}]'
one --agent relay list                                          # List endpoints
one --agent relay events --platform <p>                         # List received events
one --agent relay deliveries --endpoint-id <id>                 # Check delivery status
\`\`\`

**Key concepts:**
- \`passthrough\` actions map webhook fields to another platform's API using Handlebars: \`{{payload.data.object.email}}\`
- Template context: \`{{relayEventId}}\`, \`{{platform}}\`, \`{{eventType}}\`, \`{{payload}}\`, \`{{timestamp}}\`, \`{{connectionId}}\`
- \`--create-webhook\` auto-registers the webhook URL with the source platform
- Use \`actions knowledge\` to learn both the incoming payload shape AND the destination API shape before building templates

### 4. Memory + Sync — Unified store with hybrid FTS + semantic search
One ships a local memory store (a real Postgres process bootstrapped on demand via the bundled \`embedded-postgres\` plugin, with a \`postgres\` plugin for remote/self-hosted) that backs both user-authored notes (\`one mem add\`) and synced platform data (\`one sync run\`). Auto-initializes on first use — no separate install step. Run \`one guide memory\` and \`one guide sync\` for the full references.

## Topics

Request specific sections:
- \`one guide overview\` — This section
- \`one guide actions\` — Actions reference (search, knowledge, execute)
- \`one guide flows\` — Workflow engine reference (step types, selectors, examples)
- \`one guide relay\` — Webhook relay reference (templates, passthrough actions)
- \`one guide cache\` — Cache management (TTL, flags, commands)
- \`one guide sync\` — Data sync reference (profiles, pagination, queries)
- \`one guide all\` — Everything

## Important Notes

- **Always use \`--agent\` flag** for structured JSON output
- Platform names are **lowercase**; multi-word names use dashes (e.g., \`hubspot\`, \`google-calendar\`)
- Always use the **exact action ID** from search results — don't guess
- Always read **knowledge** before executing any action
- Connection keys come from \`one connection list\` — don't hardcode them
- Skills stay in lockstep with the CLI version automatically — every command checks a \`.one-cli-version\` marker in the canonical skill dir and refreshes the files if the CLI has been upgraded. Check manually with \`one config skills status\`; force a resync with \`one config skills sync\`
`;

export const GUIDE_ACTIONS = `# One Actions — Reference

## Workflow: search → knowledge → execute

Always follow this sequence. Never skip the knowledge step.

### 1. List Connections

\`\`\`bash
one --agent connection list
\`\`\`

Returns platforms, status, connection keys, and tags.

### 1b. Delete a Connection

\`\`\`bash
one --agent connection delete <connection-key>
\`\`\`

Removes a connection by its key. In agent mode, returns \`{"deleted": true, "platform": "...", "key": "..."}\`. The connection key comes from \`one connection list\`.

### 2. Search Actions

\`\`\`bash
one --agent actions search <platform> "<query>" -t execute
\`\`\`

- Use \`-t execute\` when the user wants to perform an action
- Use \`-t knowledge\` (default) for documentation/code generation
- Returns up to 5 matching actions with IDs, methods, and paths

### 3. Get Knowledge

\`\`\`bash
one --agent actions knowledge <platform> <actionId>
\`\`\`

Returns full API docs: required fields, validation rules, request structure. **REQUIRED before execute.** The output includes a CLI PARAMETER MAPPING section showing which flags to use.

### 4. Execute

\`\`\`bash
one --agent actions execute <platform> <actionId> <connectionKey> [options]
\`\`\`

**Flags:**
- \`-d, --data <json>\` — Request body (POST/PUT/PATCH)
- \`--path-vars <json>\` — Path variables: \`{"userId": "me"}\`
- \`--query-params <json>\` — Query params: \`{"limit": "10"}\`
  - Arrays expand to repeated params: \`{"metadataHeaders": ["From", "Subject"]}\`
- \`--headers <json>\` — Additional headers
- \`--form-data\` / \`--form-url-encoded\` — Alternative content types
- \`--dry-run\` — Preview without executing
- \`--mock\` — Return example response without making an API call
- \`--skip-validation\` — Skip input validation against the action schema
- \`--output <path>\` — Save response to a file (for binary downloads like PDFs, images, documents)
- \`--no-cache\` — Bypass the cached action details and re-fetch them; the fresh details still refresh the cache (execution itself is never cached)

Execute reuses the action details cached by \`actions knowledge\` (method, path, schema), so in the standard search → knowledge → execute flow it makes a single API call — the action being executed. The live response is never cached. In \`--agent\` mode the response includes \`"_preflight": {"cache": "hit"|"miss"}\` showing whether the lookup was served from disk.

**Do NOT** pass path or query parameters in \`-d\`. Use the correct flags.

### 4b. Parallel Execute

Execute multiple actions concurrently in a single command:

\`\`\`bash
one --agent actions execute --parallel \\
  gmail send-email conn123 -d '{"to":"a@b.com"}' \\
  -- slack post-message conn456 -d '{"text":"done"}' \\
  -- google-sheets append-row conn789 -d '{"values":["x"]}'
\`\`\`

Each segment separated by \`--\` follows the same format: \`<platform> <actionId> <connectionKey> [-d ...] [--path-vars ...] [--query-params ...]\`. Global flags (\`--dry-run\`, \`--mock\`, \`--skip-validation\`, \`--no-cache\`) apply to all segments.

All segments are validated upfront before any execution starts — if one segment has bad params, nothing runs. Execution uses \`Promise.allSettled\` so if one action fails the rest still complete. Use \`--max-concurrency <n>\` (default 5) to control batch size.

Agent-mode output (each result carries its own \`_preflight\` showing whether that action's details were served from cache):
\`\`\`json
{"parallel":true,"totalDurationMs":1234,"succeeded":2,"failed":0,"results":[{"segment":1,"platform":"gmail","actionId":"send-email","status":"success","durationMs":800,"response":{...},"_preflight":{"cache":"hit"}},{"segment":2,"platform":"slack","actionId":"post-message","status":"success","durationMs":600,"response":{...},"_preflight":{"cache":"miss"}}]}
\`\`\`

## Input Validation

The CLI validates required parameters before executing. Missing params return a structured error:
\`\`\`json
{"error": "Validation failed: missing required parameters", "validation": {"missing": [{"flag": "--path-vars", "param": "userId", "description": "..."}]}, "hint": "...pass --skip-validation to bypass..."}
\`\`\`

## Error Handling

All errors return JSON: \`{"error": "message"}\`. Check the \`error\` key.

## Notes

- Platform names are **lowercase**; multi-word names use dashes (e.g., \`hubspot\`, \`ship-station\`)
- JSON flags use single quotes around the JSON to avoid shell escaping
- If search returns no results, try broader queries
- Access control settings from \`one config\` may restrict execution
`;

// Flow guide is generated from the schema descriptor in flow-schema.ts.
// This ensures documentation always matches the actual type definitions.
export const GUIDE_FLOWS = generateFlowGuide();

export const GUIDE_RELAY = `# One Relay — Reference

## Overview

Webhook relay receives events from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forwards them to any connected platform using passthrough actions with Handlebars templates.

## Commands

\`\`\`bash
one --agent relay platforms                        # List relay-capable platforms + event type counts
one --agent relay event-types <platform>          # List available events
one --agent relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one --agent relay activate <id> --actions '<json>' # Add forwarding actions
one --agent relay list                             # List endpoints
one --agent relay get <id>                         # Get endpoint details
one --agent relay update <id> --actions '<json>'   # Update endpoint
one --agent relay delete <id>                      # Delete endpoint
one --agent relay events --platform <p>            # List received events
one --agent relay event <id>                       # Get event with payload
one --agent relay deliveries --endpoint-id <id>    # Check delivery status
\`\`\`

## Building a Relay

1. **Discover connections** — identify source and destination platforms. Use \`one --agent relay platforms\` to see which platforms support relay at all before digging into a specific one.
2. **Get event types** — \`one --agent relay event-types <platform>\`
3. **Get source knowledge** — understand the incoming webhook payload shape (\`{{payload.*}}\` paths)
4. **Get destination knowledge** — understand the outgoing API body shape
5. **Create endpoint** — with \`--create-webhook\`, \`--event-filters\`, and \`--metadata\` if the source platform requires it
6. **Activate** — with passthrough action mapping source fields to destination fields. **Do NOT pass \`--webhook-secret\`** when the endpoint was created with \`--create-webhook\` — the correct secret is auto-stored, and supplying a wrong one silently drops every delivery (events arrive, 0 deliveries).

## Platform-Specific Metadata (\`--metadata\`)

Some source platforms need extra identifiers to register a webhook. Pass these via \`--metadata '<json>'\` on \`relay create\`. Without them, \`--create-webhook\` silently fails:

| Platform | Required metadata keys |
|---|---|
| \`github\` | \`GITHUB_OWNER\`, \`GITHUB_REPOSITORY\` |
| \`typeform\` | \`TYPEFORM_FORM_ID\` |
| \`stripe\` | (none) |
| \`airtable\` | (none) |
| \`attio\` | (none) |
| \`google-calendar\` | (none) |

Example (GitHub):

\`\`\`bash
one --agent relay create \\
  --connection-key "live::github::default::<key>" \\
  --event-filters '["issues","pull_request"]' \\
  --metadata '{"GITHUB_OWNER":"my-org","GITHUB_REPOSITORY":"my-repo"}' \\
  --description "GitHub relay" \\
  --create-webhook
\`\`\`

## Template Context

| Variable | Description |
|----------|-------------|
| \`{{relayEventId}}\` | Unique event UUID |
| \`{{platform}}\` | Source platform (e.g., \`stripe\`) |
| \`{{eventType}}\` | Event type (e.g., \`customer.created\`) |
| \`{{payload}}\` | Full incoming webhook body |
| \`{{timestamp}}\` | When the event was received |
| \`{{connectionId}}\` | Source connection UUID |
| \`{{json payload}}\` | Embed full payload as JSON string |

Access nested fields: \`{{payload.data.object.email}}\`

## Action Types

**passthrough** (primary) — forward to another platform's API:
\`\`\`json
{
  "type": "passthrough",
  "actionId": "<action-id>",
  "connectionKey": "<dest-connection-key>",
  "body": { "channel": "#alerts", "text": "New customer: {{payload.data.object.name}}" },
  "eventFilters": ["customer.created"]
}
\`\`\`

**url** — forward raw event to a URL:
\`\`\`json
{"type": "url", "url": "https://your-app.com/webhook", "eventFilters": ["customer.created"]}
\`\`\`

**agent** — send to an agent:
\`\`\`json
{"type": "agent", "agentId": "<uuid>", "eventFilters": ["customer.created"]}
\`\`\`

## Supported Source Platforms

Airtable, Attio, GitHub, Google Calendar, Stripe

Any connected platform can be a destination via passthrough actions.

## Debugging

1. \`relay get <id>\` — verify endpoint is active with actions configured
2. \`relay events --platform <p>\` — check events are arriving
3. \`relay deliveries --event-id <id>\` — check delivery status and errors
4. \`relay event <id>\` — inspect full payload to verify template paths

**If events arrive but 0 deliveries succeed**: you likely passed a wrong \`--webhook-secret\` on \`relay activate\`. When you created the endpoint with \`--create-webhook\`, the secret was registered with the source platform and stored automatically — do not pass it again on activate. Signature verification will fail silently and every event will be dropped.
`;

export const GUIDE_CACHE = `# One Cache — Reference

## Overview

The One CLI caches \`actions knowledge\` and \`actions search\` responses locally so repeated calls serve instantly from disk instead of hitting the API. The knowledge cache stores the action's full details (docs, method, path, schema), so \`actions execute\` reuses it for its preflight lookup — in the standard search → knowledge → execute flow, execute makes exactly one API call: the action itself.

Cache location: \`~/.one/cache/knowledge/\` and \`~/.one/cache/search/\`

## How It Works

- **First call**: fetches from the API, writes to cache, serves the response
- **Subsequent calls (within TTL)**: serves from cache instantly, no API call
- **After TTL expires**: makes a conditional request (ETag). If content unchanged, refreshes the cache timestamp. If changed, writes fresh data.
- **Network failure with stale cache**: serves the stale cache with a warning — never fails hard when a cache exists
- **Shared preflight**: \`actions execute\`, flow action steps, and \`sync\` all read action details (method, path, validation schema) from the same cache and warm it on a miss — so a knowledge call, a flow run, and a later execute of the same action all reuse one cached lookup

Default TTL: 3600 seconds (1 hour). Configure via \`ONE_CACHE_TTL\` env var or \`cacheTtl\` in \`~/.one/config.json\`.

## What Gets Cached

| Cached | Not Cached |
|--------|-----------|
| \`actions knowledge\` (API docs, change infrequently) | \`actions execute\` responses (live data, always fresh) |
| \`actions search\` results | \`connection list\` (changes with add/remove) |
| Action details used by execute / flow / sync preflight (method, path, schema) | |

## Agent Mode \`_cache\` Metadata

In \`--agent\` mode, knowledge and search responses include a \`_cache\` field:

\`\`\`json
{
  "knowledge": "...",
  "method": "POST",
  "_cache": {
    "hit": true,
    "age": 1423,
    "fresh": true
  }
}
\`\`\`

Use this to programmatically decide whether to force-refresh.

## Cache Flags

\`\`\`bash
# Skip cache, fetch fresh (result still gets cached for next time)
one --agent actions knowledge <platform> <actionId> --no-cache

# Check cache status without fetching
one --agent actions knowledge <platform> <actionId> --cache-status

# Same for search
one --agent actions search <platform> "<query>" --no-cache

# Same for execute's action-details preflight (the action itself always runs live)
one --agent actions execute <platform> <actionId> <key> --no-cache
\`\`\`

In \`--agent\` mode, execute responses include \`"_preflight": {"cache": "hit"|"miss"}\` showing whether the action details came from disk.

## Cache Management Commands

\`\`\`bash
one cache list                    # List all cached entries with age and status
one cache list --expired          # List only expired entries
one cache clear                   # Delete all cached knowledge and search data
one cache clear <actionId>        # Delete one specific entry
one cache update-all              # Re-fetch fresh data for all cached entries
\`\`\`

All cache commands respect \`--agent\` for JSON output.

## When to Force-Refresh

- After a platform updates its API docs (rare)
- If you suspect stale data is causing issues
- Use \`one cache update-all\` to proactively warm the entire cache

## Configuration

| Setting | Source | Example |
|---------|--------|---------|
| TTL (seconds) | \`ONE_CACHE_TTL\` env var | \`ONE_CACHE_TTL=7200\` |
| TTL (seconds) | \`cacheTtl\` in \`~/.one/config.json\` | \`"cacheTtl": 7200\` |
| Default | — | 3600 (1 hour) |
`;

export const GUIDE_MEMORY = `# One Memory — Reference

The unified memory store is a local, pluggable database (\`embedded-postgres\` by default — a real Postgres process bootstrapped on demand) that backs both user-authored memories AND synced platform data. Every \`one mem\` and \`one sync\` call lands in the same store, keyed by a stable source id and searchable via FTS + optional semantic embedding.

## Zero-config

The first \`one mem\` call on a fresh install auto-initializes:
- Backend: \`embedded-postgres\` (Postgres 18 via pgserve; downloads ~52MB of binaries on first use, ~2s on later boots)
- Cluster path: \`~/.one/pg/cluster/\`, daemon PID/port at \`~/.one/pg/.pgserve.json\`
- Embedding provider: \`openai\` if a key is already resolvable AND pgvector is loadable; else \`none\`

If pgvector isn't installed in the bundled Postgres (the default binary distribution doesn't ship it yet), the schema applies cleanly without an \`embedding\` column, all FTS paths work, and \`mem doctor\` emits an \`_upgrade\` block pointing at \`brew install pgvector\` when an OpenAI key is present.

No \`mem init\` step needed. \`mem init\` still exists for power-user tuning (switch to Postgres, change paths, toggle defaults).

## OpenAI key (optional, enables semantic search)

Stored top-level in \`~/.one/config.json\` as \`openaiApiKey\`, same precedence chain as \`ONE_SECRET\`:

1. \`process.env.OPENAI_API_KEY\`
2. \`.onerc\` with \`OPENAI_API_KEY=sk-...\`
3. Project-scoped \`config.openaiApiKey\`
4. Global \`config.openaiApiKey\`

Three equivalent ways to set:
\`\`\`bash
one init                                       # interactive prompt (skip with Enter)
one --agent mem config set embedding.apiKey sk-...   # writes to top-level
export OPENAI_API_KEY=sk-...                   # no persistence
\`\`\`

When the key is present but provider is still \`none\`, \`mem config set embedding.apiKey\` auto-flips the provider to \`openai\` in the same write.

When no key is available, every response from \`mem status\`, \`mem search\`, and \`mem doctor\` includes a structured \`_upgrade\` block with \`how\` and \`benefit\` fields. Agents should surface that to the user verbatim — it tells them semantic search is available as an upgrade.

## Records

\`\`\`bash
# Add
one --agent mem add note '{"content":"..."}' --tags work,urgent --weight 8 --keys 'doc:design-v2'

# Get (optionally with links)
one --agent mem get <id> --links

# Update (shallow merge into data)
one --agent mem update <id> '{"status":"done"}'

# Archive / unarchive
one --agent mem archive <id> --reason superseded

# List by type — type is positional. Synced rows are namespaced as <platform>/<model>.
# There is NO --platform flag on \`mem list\`, and NO platform column in the schema.
one --agent mem list note --limit 20
one --agent mem list "gmail/threads" --limit 5
one --agent mem list "attio/attioPeople"
one --agent mem list "google-calendar/events"

# Search (hybrid FTS + semantic when embeddings enabled)
one --agent mem search "deadline next week"
one --agent mem search "..." --deep          # force embedding on query
one --agent mem search "..." --type note     # restrict to one type
\`\`\`

Every search response includes \`searchMode: "hybrid" | "fts_only"\`. Use it to detect when semantic ranking isn't actually running.

If you need raw SQL via \`mem sql\`, filter by \`type\` (not \`platform\` — there is no such column):

\`\`\`bash
one --agent mem sql "SELECT type, COUNT(*) FROM mem_records WHERE type LIKE 'gmail/%' GROUP BY type"
\`\`\`

## Graph

\`\`\`bash
one --agent mem link <a-id> <b-id> relates_to --bi
one --agent mem linked <id> --relation relates_to --direction both
one --agent mem unlink <a-id> <b-id> relates_to
\`\`\`

## Sources (who wrote this record)

Synced rows carry \`sources\` entries keyed by \`<platform>/<model>:<external_id>\`:

\`\`\`bash
one --agent mem sources <id>                          # list source entries
one --agent mem find-by-source attio/attioPeople:abc-123
\`\`\`

## Sync into memory

\`one mem sync\` is a full alias of \`one sync\` — same handlers, same options. Use either.

\`\`\`bash
# Memory is ALWAYS written on sync (default behaviour since v1.41).
# Pass --no-memory to skip (rare; breaks mem search / mem query over synced data).
one --agent sync run stripe
one --agent mem sync run stripe                       # identical

# Read synced data out of memory
one --agent sync query stripe/customers --where "plan=pro" --limit 20
one --agent sync query stripe/customers --where 'address.city=SF'   # dotted path
one --agent sync search "refund" --platform stripe                  # hybrid per-type
\`\`\`

See \`one guide sync\` for the profile-declaration workflow, \`memory.searchable\` paths, and \`--show-searchable\` preview.

## Diagnostics

\`\`\`bash
one --agent mem status          # backend, provider, _upgrade hint
one --agent mem doctor          # 7-check health report
one --agent mem vacuum          # backend maintenance (VACUUM ANALYZE)
one --agent mem reindex         # re-embed records under current model
\`\`\`

## Admin

\`\`\`bash
one --agent mem export records.jsonl                  # streamed JSONL — memory-safe on large stores
one --agent mem export -                              # stream to stdout
one --agent mem import records.jsonl                  # idempotent via keys[]
one --agent mem migrate --dry-run                     # preview legacy .db → memory
one --agent mem migrate --cleanup -y                  # migrate + delete .db files
\`\`\`

## Backends

First-party plugins: \`embedded-postgres\` (default — Postgres 18 via pgserve, daemon at \`~/.one/pg/\`), \`postgres\` (Supabase, Neon, self-hosted). Third-party plugins declared in \`memory.plugins\` as npm package specs.

\`\`\`bash
one --agent mem init --backend postgres --connection-string 'postgres://...'
# or: export MEM_DATABASE_URL and re-run mem init
\`\`\`

Switching backends does not migrate data. Run \`mem export | mem import\` to copy between stores.
`;

export const GUIDE_SYNC = `# One Sync — Reference

Sync platform data into the unified memory store for instant queries, hybrid FTS + semantic search, scheduled refresh, and change-driven automation. Sync is the write path; reads go through \`one mem\` or the \`sync query\` / \`sync search\` commands.

## Getting Started

The local SQLite fallback installed by the old \`sync install\` flow is still present for backwards compatibility, but memory auto-initializes on first use with the bundled \`embedded-postgres\` backend (Postgres 18 via pgserve) — no install step needed.

\`\`\`bash
one --agent mem status              # confirms the backend + provider
one --agent mem doctor              # 7-check health report
\`\`\`

## Built-in Profiles

Pre-validated sync configs ship with the CLI for common platforms. Discover them:

\`\`\`bash
one --agent sync profiles              # list all built-in profiles
one --agent sync profiles stripe       # filter by platform
\`\`\`

When a built-in exists, \`sync init\` uses it automatically — no inference needed, no manual config. The agent just needs to match the user's intent to a profile description.

## Action Resolution — custom actions are hard-blocked

Sync refuses to run against custom/composer actions (tag \`custom\`). Both
the list action and any enrich detail action in a profile MUST be passthrough.
\`sync run\` loads the action's knowledge, checks for the \`custom\` tag, and
aborts with a clear error pointing at the passthrough alternative.

Why the block:
- Custom actions run on a small shared fleet that collapses under sync-scale load
- Custom list endpoints often expect filters in the body and silently return
  unfiltered or empty results (sync sends params as query/path only by design)
- The sync engine already handles pagination, retry, rate limiting, and per-record
  enrichment locally — server-side fan-out on top of that creates 5xx, not value

How to build a profile:
1. \`one actions search <platform> "<model>"\` surfaces passthrough actions.
   \`sync init\`'s auto-infer also drops customs before offering choices.
2. Prefer GET passthrough endpoints (e.g. /gmail/v1/users/{userId}/threads)
   over POST custom endpoints (e.g. /gmail/get-threads).
3. If no passthrough list action exists for a model, that model can't be
   synced. Compose a flow that chains passthrough calls instead. Custom
   actions are for one-off agent use only — never sync, never flow.
4. The enrich \`actionId\` is held to the same rule: must be passthrough.

## Workflow: init → run → query

\`\`\`bash
# 1. Discover models
one --agent sync models stripe

# 2. Init — one command does everything:
#    - resolves action ID
#    - infers pagination, resultsPath, idField, pathVars from knowledge
#    - sets connection: { platform } so the profile survives re-auth
#    - auto-runs sync test if profile is complete
one --agent sync init stripe balanceTransactions
# Response includes _complete:true and _test results when fully resolved.
# Multi-account platforms (e.g. two Gmail connections) need a tag:
one --agent sync init gmail gmailThreads --config '{"connection":{"platform":"gmail","tag":"work@example.com"}}'

# 3. (Optional but recommended for profiles with embed:true) Declare the
#    fields that should be embedded + FTS-indexed, then preview the text.
one --agent sync init stripe balanceTransactions --config '{
  "memory": {
    "embed": true,
    "searchable": ["description", "type", "amount", "currency"]
  }
}'
one --agent sync test stripe/balanceTransactions --show-searchable
# → Returns searchable: { mode: "declared", length, text, paths: [{path, found, sample}] }
# Iterate on paths until the preview is clean signal (no UUIDs, timestamps, URLs).

# 4. Sync — memory is written automatically; pass --no-memory to skip
one --agent sync run stripe
one --agent mem sync run stripe                    # identical (alias)

# 5. Query + search (read from memory)
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync query stripe/customers --where 'address.city=SF'   # dotted --where paths
one --agent sync search "refund" --platform stripe                  # hybrid FTS + semantic
\`\`\`

## memory.searchable — agent-declared clean text

Profile field that drives what gets embedded + full-text-indexed. Without it, the default walker concatenates every string in the record — correct but often 90% noise (UUIDs, timestamps, URLs) for hierarchical APIs. Always declare paths when \`memory.embed: true\`.

\`\`\`jsonc
{
  "memory": {
    "embed": true,
    "searchable": [
      "values.name[0].full_name",              // numeric index
      "values.job_title[0].value",
      "messages[].snippet",                    // wildcard — every array element
      "messages[].payload.parts[].body.data"   // nested wildcards
    ]
  }
}
\`\`\`

Get a ranked starter list from a real sample:

\`\`\`bash
one --agent sync suggest-searchable <platform>/<model>
\`\`\`

Walks the first page of records, ranks every leaf path by signal density (non-empty rate × log-length × noise penalty). UUIDs / ISO timestamps / URLs / numeric strings / boolean and number leaves are penalized or filtered; prose and enum-title fields rank high. The response includes a paste-ready \`configPatch\` the agent can drop into \`sync init --config\`.

Preview what will actually be embedded across 5 sample records:

\`\`\`bash
one --agent sync test <platform>/<model> --show-searchable
\`\`\`

The response \`searchable.paths\` array carries \`{path, hits, total, sample}\` per declared path. \`5/5\` means the path resolves on every record; \`1/5\` means it's real but sparse; \`0/5\` is a typo or a field that never appears on this page. Iterate until the numbers and samples match your intent, then \`sync run\` to ship.

## sync run — memory-primary

\`\`\`
--force         Ignore existing state, start fresh
--max-pages <n> Cap page count (good for probing)
--since <dur>   Only fetch records since (e.g. 30d, 90d)
--dry-run       Fetch first page only, show results, no writes
--full-refresh  Fetch ALL and archive rows whose source didn't reappear
--no-memory     Skip the memory write (rare; breaks mem/sync queries over this data)
--to-memory     (deprecated — memory is now always written; kept for back-compat)
\`\`\`

**\`--full-refresh\` + \`--max-pages\` = reconcile is skipped.** Reconcile can only tell "not returned by the API" from "we didn't ask" if pagination actually exhausted. Truncated runs would mass-archive unseen rows as \`deleted_upstream\`, so the reconcile pass skips with \`reconcileSkipped: true\` and \`deletedStale: 0\`. Re-run without \`--max-pages\` to prune.

**Upsert-by-keys is self-healing.** If a previous buggy run archived a row, the next \`--full-refresh\` that re-pulls its source key flips it back to \`active\` and clears \`archived_reason\`. No manual un-archive required.

**Every sync output surfaces \`statusCounts: { active, archived }\`** — if archived is high after a run, the store needs a full \`--full-refresh\` (no \`--max-pages\`) to heal.

## Connection Resolution — late-bound by default

Sync profiles use a late-bound connection ref instead of a hardcoded key, so re-auth (which always mints a new key) doesn't break the profile:

\`\`\`json
// recommended — survives re-auth
"connection": { "platform": "gmail" }

// multi-account: disambiguate with the connection's tag
"connection": { "platform": "gmail", "tag": "work@example.com" }

// legacy — still works for backwards compat, but breaks on re-auth
"connectionKey": "live::gmail::default::abc123..."
\`\`\`

The resolver runs at \`sync test\` and \`sync run\` time. Resolution errors (no connection, ambiguous tag, missing tag with multiple connections) surface as the first check in the test report, before any HTTP call.

To migrate an existing profile: replace the \`connectionKey\` field with \`connection: { platform: "<platform>" }\`. Tags only needed when more than one connection exists for the platform.

## Auto-Inference

\`sync init\` without \`--config\` does all of this automatically:
- **connection** — defaults to \`{ platform: "<platform>" }\` (late-bound). When multiple connections exist, init surfaces the available tags so the agent can add one to the ref.
- **Pagination** — Stripe id-pagination, Notion body-cursor, HubSpot/Google token, offset, link. Inapplicable fields stripped (no nextPath for offset, no passAs for none)
- **resultsPath** — generic keys (data, results, items) + platform-specific (model name stripped of platform prefix: attioCompanies → companies). Use \`""\`, \`"$"\`, or \`"."\` for responses that return a bare array at the root (e.g. Hacker News \`/v0/topstories.json\`); primitive array elements are auto-wrapped as \`{ [idField]: value }\`.
- **idField** — id, _id, uuid
- **pathVars** — extracted from URL template with smart defaults (calendarId="primary", userId="me"). Internal keys (INTERNAL_SIGNING_KEY) and record-level IDs (record_id) are stripped automatically
- **dateFilter** — updated_since, created_after, etc.
- **limitLocation** — auto-detected as "body" for POST endpoints

When the profile is complete (no FILL_IN values remain), \`sync init\` automatically runs \`sync test\` and includes the results in the response (\`_test: {ok, checks, autoFixed}\`). If test auto-discovers fields the inference missed, it patches the profile on disk.

## Scheduled Syncs

\`\`\`bash
one sync schedule add stripe --every 1h
one sync schedule add notion --every 30m --models search
one --agent sync schedule list            # Works from any directory
one --agent sync schedule status          # Drift detection + log tails
one sync schedule remove <id|platform>    # By id (any dir) or platform
one sync schedule repair <id>             # Re-install broken cron line
\`\`\`
Backed by system cron (macOS/Linux). Schedules tracked in a global registry at \`~/.one/sync/schedules.json\`.

## Record Enrichment

When a list endpoint returns lightweight records (e.g. just IDs), add an \`enrich\` config to call a detail endpoint per record and merge the full data before storing:

\`\`\`json
{
  "enrich": {
    "actionId": "<get-message-action-id>",
    "pathVars": { "messageId": "{{id}}" },
    "concurrency": 3,
    "delayMs": 200
  }
}
\`\`\`

- \`pathVars\` / \`queryParams\` / \`body\` support \`{{field}}\` interpolation from the list record
- \`concurrency\` controls parallel detail requests per page (default: 3, lower = safer for rate limits)
- \`delayMs\` is the pause between batches (default: 200ms)
- \`resultsPath\` extracts a sub-object from the detail response before merging
- \`merge: false\` replaces the record entirely instead of deep-merging

**Rate limiting is first-class:**
- Honors \`Retry-After\` headers from 429 responses
- Exponential backoff (2s → 4s → 8s)
- Adaptive throttle: if any request in a batch hits 429, concurrency halves automatically
- Records that fail after 3 retries are skipped (sync continues, count reported in \`enrichSkipped\`)

**Important:** \`enrich.resultsPath\` operates on the raw API response, NOT the CLI's \`{dryRun, request, response}\` wrapper you see when testing with \`one --agent actions execute\`. If the CLI shows your data at \`response.thread\`, the enrich resultsPath is just \`"thread"\` (no \`response.\` prefix).

Enrichment runs after list sync completes (Phase 2), not inline. It's inherently resumable — records track an \`_enriched_at\` timestamp, and re-running skips already-enriched rows.

**Limitation:** Each profile supports one enrich action. If you need multiple enrichments (e.g. both summary and transcript from Fathom), create a second profile/model for the second enrichment.

## Record Transform

Pipe records through any shell command or flow between fetch and store. The command receives a JSON array on stdin and must return a JSON array on stdout.

\`\`\`json
{
  "transform": "jq '[.[] | . + {flat_title: (.properties.title.title[0].plain_text // null)}]'"
}
\`\`\`

Use cases:
- Flatten nested fields into queryable top-level columns
- Add computed fields (tags, categories, scores)
- Filter out records you don't want to store
- Reshape API responses into a cleaner schema

The transform can be any command: \`jq\`, \`python3\`, a bash script, or \`one flow execute <key>\`. If the command fails, times out (60s), or returns invalid JSON, the original records are used (warning printed, sync continues).

**Pipeline order:** fetch → enrich → transform → **exclude** → create table → schema evolution → upsert → hooks

Transform, exclude, identityKey, and hooks all fire in **both** phases. In Phase 1 they run on the raw list page; in Phase 2 they run again on the merged (list + enriched) record so that transforms can extract columns from fields that only appear after enrichment. Phase 2 fires \`onUpdate\`/\`onChange\` for every row it writes — \`onInsert\` is Phase-1-only because the row already exists in SQL by the time enrichment runs.

## Cross-Platform Identity

Add \`identityKey\` to a sync profile to extract a stable cross-platform identifier (e.g. email) into a normalized \`_identity\` column:

\`\`\`json
{"platform": "hubspot", "model": "contacts", "identityKey": "properties.email"}
{"platform": "stripe",  "model": "customers", "identityKey": "email"}
{"platform": "attio",   "model": "attioPeople", "identityKey": "email_addresses[0].email_address"}
\`\`\`

The value is lowercased and trimmed, stored as a prefixed key on the mem record (e.g. \`email:jane@acme.com\`). Look up across platforms:

\`\`\`bash
one --agent mem find-by-source hubspot/contacts:<id>
# Or via the dotted --where path on the identity key:
one --agent sync query hubspot/contacts --where 'email=jane@acme.com'
\`\`\`

\`sync sql\` was retired in the unified memory cutover — a raw-SQL surface can't safely span the embedded Postgres, remote Postgres, and third-party backends without leaking specifics. Use \`mem search\` / \`sync search\` / \`sync query\` with dotted \`--where\` paths instead.

## Exclude Fields

Strip large or unwanted fields from records before storing (e.g. base64 attachments, raw HTML bodies):

\`\`\`json
{ "exclude": ["messages[].body", "messages[].attachments[].data", "payload.parts"] }
\`\`\`

Supports dot-path notation and array iteration (\`messages[].body\` strips \`body\` from each element of the \`messages\` array). Runs before table creation so excluded columns never exist in the schema.

## Monitoring Progress

\`sync list\` doubles as a progress monitor. The state file is updated after every page, so while a sync is running you can check progress from another context:

\`\`\`bash
one --agent sync list gmail
# → {"syncs":[{"model":"gmailThreads","totalRecords":400,"pagesProcessed":8,"status":"syncing",...}]}
\`\`\`

When \`status\` is \`"syncing"\`, \`totalRecords\` and \`pagesProcessed\` reflect real-time progress. When it flips to \`"idle"\`, the sync is done. No need to babysit — especially when using \`sync schedule\` for unattended runs.

## Change Hooks (CDC)

Add \`onInsert\`, \`onUpdate\`, or \`onChange\` to a sync profile to fire hooks when records change:

\`\`\`json
{
  "onInsert": "one flow execute enrich-new-contact",
  "onUpdate": "log",
  "onChange": "node ./scripts/handle-change.js"
}
\`\`\`

**Hook modes:**
- **Shell command** — record events piped as NDJSON to stdin
- **\`"log"\`** — append to \`.one/sync/events/<platform>_<model>.jsonl\`
- **Flow execution** — \`one flow execute <key>\` with record as input

Hooks fire after each page (not end-of-sync) for real-time processing. Each event:
\`{"type":"insert|update","platform":"...","model":"...","record":{...},"timestamp":"..."}\`

Every record has a \`_synced_at\` timestamp so you can track when it was last pulled.

## Full Refresh (deletion detection)

\`\`\`bash
one --agent sync run stripe --full-refresh
\`\`\`
Fetches ALL records and deletes local rows whose IDs are no longer in the source. Cannot be combined with \`--since\`.

## Commands Reference

Every \`sync X\` command is also exposed as \`mem sync X\` — same handlers, same options. Pick whichever reads better in context.

| Command | What it does |
|---------|-------------|
| \`sync profiles [platform]\` | List built-in pre-validated profiles |
| \`sync doctor\` | Verify sync engine health |
| \`sync models <platform>\` | Discover available models |
| \`sync init <plat> <model>\` | Create/patch profile (seeds from built-in, auto-tests) |
| \`sync test <plat>/<model>\` | Validate profile. \`--show-searchable\` previews embedded text across 5 samples with per-path hit rates |
| \`sync suggest-searchable <plat>/<model>\` | Rank candidate \`memory.searchable\` paths by signal density; emits paste-ready config |
| \`sync run <platform>\` | Sync data (\`--full-refresh\`, \`--since\`, \`--dry-run\`, \`--no-memory\`) |
| \`sync query <plat>/<model>\` | Query memory with \`--where\` (dotted paths), \`--after/before\` |
| \`sync search "<query>"\` | Hybrid FTS + semantic across all synced data |
| \`sync list [platform]\` | Show profiles, record counts, freshness |
| \`sync schedule add/list/status/remove/repair\` | Manage cron schedules |
| \`sync remove <platform>\` | Delete synced data (\`--dry-run\` to preview) |

## Sync Profile Fields

| Field | Required | Description |
|-------|----------|-------------|
| connectionKey | yes | From \`one list\` |
| actionId | yes | Auto-resolved by \`sync init\` |
| resultsPath | yes | Auto-inferred or auto-discovered by \`sync test\`. Use \`""\` / \`"$"\` / \`"."\` for root-array responses |
| idField | yes | Auto-inferred or auto-discovered by \`sync test\` |
| pagination | yes | Auto-inferred (cursor/token/offset/id/link/none) |
| pathVars | no | Auto-extracted from URL template |
| dateFilter | no | For incremental sync (auto-detected when available) |
| limitParam | no | Page size param name (empty string = don't send) |
| limitLocation | no | "query" (default) or "body" for POST endpoints |
| enrich | no | Detail endpoint config for record enrichment (actionId, pathVars, concurrency) |
| transform | no | Shell command to transform records (stdin: JSON array, stdout: JSON array) |
| identityKey | no | Dot-path to cross-platform identifier (e.g. email) → stored as \`_identity\` column |
| exclude | no | Dot-path fields to strip before storing (e.g. \`["messages[].body"]\`) |
| onInsert/onUpdate/onChange | no | Change hooks (shell command, "log", or flow) |

## Pagination Types

- **cursor** — \`{"type":"cursor", "nextPath":"next_cursor", "passAs":"query:cursor"}\`
- **token** — \`{"type":"token", "nextPath":"paging.next.after", "passAs":"query:after"}\`
- **offset** — \`{"type":"offset", "passAs":"query:offset", "totalPath":"total"}\`
- **id** — \`{"type":"id", "passAs":"query:starting_after", "hasMorePath":"has_more"}\`
- **link** — \`{"type":"link", "nextPath":"link.next.page_info", "passAs":"query:page_info"}\`
- **none** — single request, no pagination (no limit param injected)

## File Layout

\`\`\`
.one/sync/
  profiles/{platform}_{model}.json    # sync profiles (source of truth for each run)
  data/{platform}.db                  # legacy SQLite DBs (kept for enrich-phase rollback)
  events/{platform}_{model}.jsonl     # change event logs (if onChange: "log")
  logs/{platform}.log                 # cron run logs
  locks/{platform}_{model}/           # cross-process sync locks
~/.one/pg/cluster/                    # unified memory store — embedded Postgres data dir
~/.one/pg/.pgserve.json               # daemon PID/port file (cleared on stop)
~/.one/pg/pgserve.log                 # daemon stdout/stderr
~/.one/config.json                    # apiKey + openaiApiKey + memory config block
~/.one/sync/
  schedules.json                      # global schedule registry
\`\`\`
`;

type GuideTopic = 'overview' | 'actions' | 'flows' | 'relay' | 'cache' | 'sync' | 'memory' | 'all';

const TOPICS: { topic: GuideTopic; description: string }[] = [
  { topic: 'overview', description: 'Setup, features, and quick start for each' },
  { topic: 'actions', description: 'Search, read docs, and execute platform actions' },
  { topic: 'flows', description: 'Build and execute multi-step workflows' },
  { topic: 'relay', description: 'Receive webhooks and forward to other platforms' },
  { topic: 'cache', description: 'Local caching for knowledge and search responses' },
  { topic: 'memory', description: 'Unified memory store: notes, decisions, synced rows, semantic search' },
  { topic: 'sync', description: 'Sync platform data into memory for instant offline queries' },
  { topic: 'all', description: 'Complete guide (all topics combined)' },
];

export function getGuideContent(topic: GuideTopic): { title: string; content: string } {
  switch (topic) {
    case 'overview':
      return { title: 'One CLI — Agent Guide: Overview', content: GUIDE_OVERVIEW };
    case 'actions':
      return { title: 'One CLI — Agent Guide: Actions', content: GUIDE_ACTIONS };
    case 'flows':
      return { title: 'One CLI — Agent Guide: Workflows', content: GUIDE_FLOWS };
    case 'relay':
      return { title: 'One CLI — Agent Guide: Relay', content: GUIDE_RELAY };
    case 'cache':
      return { title: 'One CLI — Agent Guide: Cache', content: GUIDE_CACHE };
    case 'memory':
      return { title: 'One CLI — Agent Guide: Memory', content: GUIDE_MEMORY };
    case 'sync':
      return { title: 'One CLI — Agent Guide: Sync', content: GUIDE_SYNC };
    case 'all':
      return {
        title: 'One CLI — Agent Guide: Complete',
        content: [GUIDE_OVERVIEW, GUIDE_ACTIONS, GUIDE_FLOWS, GUIDE_RELAY, GUIDE_CACHE, GUIDE_MEMORY, GUIDE_SYNC].join('\n---\n\n'),
      };
  }
}

export function getAvailableTopics(): { topic: string; description: string }[] {
  return TOPICS;
}

// Platform demo actions (used by onboard)
export const PLATFORM_DEMO_ACTIONS: Record<string, { description: string; query: string }> = {
  'gmail': { description: 'List recent emails', query: 'list messages' },
  'google-calendar': { description: 'List upcoming events', query: 'list events' },
  'slack': { description: 'List channels', query: 'list channels' },
  'shopify': { description: 'List products', query: 'list products' },
  'hubspot': { description: 'List contacts', query: 'list contacts' },
  'github': { description: 'List repositories', query: 'list repos' },
  'stripe': { description: 'List customers', query: 'list customers' },
  'notion': { description: 'Search pages', query: 'search' },
  'airtable': { description: 'List bases', query: 'list bases' },
  'linear': { description: 'List issues', query: 'list issues' },
};

export function getWorkflowExamples(connectedPlatforms: string[]): string[] {
  const examples: string[] = [];
  const has = (p: string) => connectedPlatforms.includes(p);

  if (has('gmail') && has('slack')) examples.push('Gmail → Slack: Forward important emails to a channel');
  if (has('stripe') && has('slack')) examples.push('Stripe → Slack: Notify on new payments');
  if (has('shopify') && has('gmail')) examples.push('Shopify → Gmail: Send order confirmation emails');
  if (has('hubspot') && has('gmail')) examples.push('HubSpot → Gmail: Auto-email new leads');
  if (has('github') && has('slack')) examples.push('GitHub → Slack: Notify on new issues/PRs');

  if (examples.length === 0) {
    examples.push('Connect 2+ platforms to unlock cross-platform workflows');
    examples.push('Example: Stripe + Slack → Notify on new payments');
    examples.push('Example: Gmail + HubSpot → Auto-create contacts from emails');
  }

  return examples;
}
