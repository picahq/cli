// Guide content — concise overview that routes agents to skill docs for details.
import { generateFlowGuide } from './flow-schema.js';

export const GUIDE_OVERVIEW = `# One CLI — Agent Guide

## Setup

1. Run \`one init\` for full interactive setup (authentication, skill installation, and platform connections)
2. Run \`one add <platform>\` to connect platforms via OAuth
3. Run \`one --agent connection list\` to verify connections

You can also use \`one login\` / \`one logout\` to manage authentication separately (global or per-directory).

## The --agent Flag

Always use \`--agent\` for machine-readable JSON output. It disables colors, spinners, and interactive prompts.

\`\`\`bash
one --agent <command>
\`\`\`

All commands return JSON. If an \`error\` key is present, the command failed.

## IMPORTANT: Read the guide before you act

Before using any feature, read its guide section first: \`one guide actions\`, \`one guide flows\`, or \`one guide relay\`. The guide teaches you the correct workflow, required fields, and common mistakes. Never guess — read the guide, then act.

## Features

### 1. Actions — Execute API calls on 250+ platforms
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

### 3. Relay — Webhook event forwarding between platforms
Receive webhooks from platforms (Stripe, GitHub, Airtable, Attio, Google Calendar) and forward event data to any connected platform using passthrough actions with Handlebars templates. No middleware, no code.

**Quick start:**
\`\`\`bash
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

### 4. Sync — Local data sync for instant offline queries
Sync platform data into local SQLite for instant queries, full-text search, and change-driven automation. Requires a one-time \`one sync install\`. Run \`one guide sync\` for the full reference.

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
- Platform names are always **kebab-case** (e.g., \`hub-spot\`, \`google-calendar\`)
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

**Do NOT** pass path or query parameters in \`-d\`. Use the correct flags.

### 4b. Parallel Execute

Execute multiple actions concurrently in a single command:

\`\`\`bash
one --agent actions execute --parallel \\
  gmail send-email conn123 -d '{"to":"a@b.com"}' \\
  -- slack post-message conn456 -d '{"text":"done"}' \\
  -- google-sheets append-row conn789 -d '{"values":["x"]}'
\`\`\`

Each segment separated by \`--\` follows the same format: \`<platform> <actionId> <connectionKey> [-d ...] [--path-vars ...] [--query-params ...]\`. Global flags (\`--dry-run\`, \`--mock\`, \`--skip-validation\`) apply to all segments.

All segments are validated upfront before any execution starts — if one segment has bad params, nothing runs. Execution uses \`Promise.allSettled\` so if one action fails the rest still complete. Use \`--max-concurrency <n>\` (default 5) to control batch size.

Agent-mode output:
\`\`\`json
{"parallel":true,"totalDurationMs":1234,"succeeded":2,"failed":0,"results":[{"segment":1,"platform":"gmail","actionId":"send-email","status":"success","durationMs":800,"response":{...}},{"segment":2,"platform":"slack","actionId":"post-message","status":"success","durationMs":600,"response":{...}}]}
\`\`\`

## Input Validation

The CLI validates required parameters before executing. Missing params return a structured error:
\`\`\`json
{"error": "Validation failed: missing required parameters", "validation": {"missing": [{"flag": "--path-vars", "param": "userId", "description": "..."}]}, "hint": "...pass --skip-validation to bypass..."}
\`\`\`

## Error Handling

All errors return JSON: \`{"error": "message"}\`. Check the \`error\` key.

## Notes

- Platform names are **kebab-case** (e.g., \`hub-spot\`)
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

1. **Discover connections** — identify source and destination platforms
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

The One CLI caches \`actions knowledge\` and \`actions search\` responses locally so repeated calls serve instantly from disk instead of hitting the API. This is the single biggest latency win for agents who call knowledge for the same actions repeatedly.

Cache location: \`~/.one/cache/knowledge/\` and \`~/.one/cache/search/\`

## How It Works

- **First call**: fetches from the API, writes to cache, serves the response
- **Subsequent calls (within TTL)**: serves from cache instantly, no API call
- **After TTL expires**: makes a conditional request (ETag). If content unchanged, refreshes the cache timestamp. If changed, writes fresh data.
- **Network failure with stale cache**: serves the stale cache with a warning — never fails hard when a cache exists

Default TTL: 3600 seconds (1 hour). Configure via \`ONE_CACHE_TTL\` env var or \`cacheTtl\` in \`~/.one/config.json\`.

## What Gets Cached

| Cached | Not Cached |
|--------|-----------|
| \`actions knowledge\` (API docs, change infrequently) | \`actions execute\` (live data, always fresh) |
| \`actions search\` results | \`connection list\` (changes with add/remove) |

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
\`\`\`

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

export const GUIDE_SYNC = `# One Sync — Reference

Sync platform data into local SQLite for instant queries, full-text search, scheduled refresh, and change-driven automation.

## Getting Started

\`\`\`bash
one sync install                    # One-time: install the SQLite engine
one sync doctor                     # Verify it's working
\`\`\`

## Built-in Profiles

Pre-validated sync configs ship with the CLI for common platforms. Discover them:

\`\`\`bash
one --agent sync profiles              # list all built-in profiles
one --agent sync profiles stripe       # filter by platform
\`\`\`

When a built-in exists, \`sync init\` uses it automatically — no inference needed, no manual config. The agent just needs to match the user's intent to a profile description.

## Action Resolution

Sync profiles MUST prefer passthrough actions over custom actions.
Custom actions add server-side fan-out and transformation that causes timeouts
and payload size failures at scale. The sync engine handles pagination, retries,
rate limiting, and enrichment locally — a server-side middleware layer on top
of that creates problems, not value.

When resolving actions for sync profiles:
1. Search with knowledge mode (not execute mode) to include passthrough actions
2. Prefer GET passthrough endpoints (e.g. /gmail/v1/users/{userId}/threads)
   over POST custom endpoints (e.g. /gmail/get-threads)
3. Use enrich config for per-record detail fetching instead of relying on
   custom actions that fan out server-side
4. Only fall back to custom actions when no passthrough equivalent exists

This applies to sync models discovery, sync init, and enrich action selection.

## Workflow: init → run → query

\`\`\`bash
# 1. Discover models
one --agent sync models stripe

# 2. Init — one command does everything:
#    - resolves action ID
#    - infers pagination, resultsPath, idField, pathVars from knowledge
#    - auto-resolves connectionKey (when only one connection exists)
#    - auto-runs sync test if profile is complete
one --agent sync init stripe balanceTransactions
# Response includes _complete:true and _test results when fully resolved.
# If connectionKey wasn't auto-resolved (multiple connections), patch it:
one --agent sync init stripe balanceTransactions --config '{"connectionKey":"<from one list>"}'

# 3. Sync
one --agent sync run stripe

# 4. Query
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync search "refund" --platform stripe
one --agent sync sql stripe "SELECT count(*) FROM balanceTransactions"
\`\`\`

## Auto-Inference

\`sync init\` without \`--config\` does all of this automatically:
- **connectionKey** — auto-resolved when there's exactly one connection for the platform
- **Pagination** — Stripe id-pagination, Notion body-cursor, HubSpot/Google token, offset, link. Inapplicable fields stripped (no nextPath for offset, no passAs for none)
- **resultsPath** — generic keys (data, results, items) + platform-specific (model name stripped of platform prefix: attioCompanies → companies)
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

The value is lowercased and trimmed. Query across platforms:
\`\`\`bash
one --agent sync sql hubspot "SELECT * FROM contacts WHERE _identity = 'jane@acme.com'"
one --agent sync sql stripe "SELECT * FROM customers WHERE _identity = 'jane@acme.com'"
\`\`\`

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

| Command | What it does |
|---------|-------------|
| \`sync profiles [platform]\` | List built-in pre-validated profiles |
| \`sync install\` | Install SQLite engine (first time) |
| \`sync doctor\` | Verify engine health |
| \`sync models <platform>\` | Discover available models |
| \`sync init <plat> <model>\` | Create profile (auto-infers from knowledge) |
| \`sync test <plat>/<model>\` | Validate profile + auto-fix fields |
| \`sync run <platform>\` | Sync data (\`--full-refresh\`, \`--since\`, \`--dry-run\`) |
| \`sync query <plat>/<model>\` | Query with \`--where\`, \`--after/before\`, \`--refresh\` |
| \`sync search "<query>"\` | FTS5 across all synced data |
| \`sync sql <plat> "<sql>"\` | Raw SELECT queries |
| \`sync list [platform]\` | Show profiles, record counts, freshness |
| \`sync schedule add/list/status/remove/repair\` | Manage cron schedules |
| \`sync remove <platform>\` | Delete local data (\`--dry-run\` to preview) |

## Sync Profile Fields

| Field | Required | Description |
|-------|----------|-------------|
| connectionKey | yes | From \`one list\` |
| actionId | yes | Auto-resolved by \`sync init\` |
| resultsPath | yes | Auto-inferred or auto-discovered by \`sync test\` |
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
  profiles/{platform}_{model}.json    # sync profiles
  data/{platform}.db                  # SQLite databases (WAL mode)
  state/{platform}/{model}.json       # per-model checkpoint tracking
  events/{platform}_{model}.jsonl     # change event logs (if onChange: "log")
  logs/{platform}.log                 # cron run logs
  locks/{platform}_{model}/           # cross-process sync locks
~/.one/sync/
  schedules.json                      # global schedule registry
\`\`\`
`;

type GuideTopic = 'overview' | 'actions' | 'flows' | 'relay' | 'cache' | 'sync' | 'all';

const TOPICS: { topic: GuideTopic; description: string }[] = [
  { topic: 'overview', description: 'Setup, features, and quick start for each' },
  { topic: 'actions', description: 'Search, read docs, and execute platform actions' },
  { topic: 'flows', description: 'Build and execute multi-step workflows' },
  { topic: 'relay', description: 'Receive webhooks and forward to other platforms' },
  { topic: 'cache', description: 'Local caching for knowledge and search responses' },
  { topic: 'sync', description: 'Sync platform data locally for instant offline queries' },
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
    case 'sync':
      return { title: 'One CLI — Agent Guide: Sync', content: GUIDE_SYNC };
    case 'all':
      return {
        title: 'One CLI — Agent Guide: Complete',
        content: [GUIDE_OVERVIEW, GUIDE_ACTIONS, GUIDE_FLOWS, GUIDE_RELAY, GUIDE_CACHE, GUIDE_SYNC].join('\n---\n\n'),
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
  'hub-spot': { description: 'List contacts', query: 'list contacts' },
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
  if (has('hub-spot') && has('gmail')) examples.push('HubSpot → Gmail: Auto-email new leads');
  if (has('github') && has('slack')) examples.push('GitHub → Slack: Notify on new issues/PRs');

  if (examples.length === 0) {
    examples.push('Connect 2+ platforms to unlock cross-platform workflows');
    examples.push('Example: Stripe + Slack → Notify on new payments');
    examples.push('Example: Gmail + HubSpot → Auto-create contacts from emails');
  }

  return examples;
}
