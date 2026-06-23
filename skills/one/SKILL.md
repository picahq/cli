---
name: one
description: |
  Use the One CLI (`one`) to interact with 3rd-party platforms — Gmail, Slack, Stripe, Notion, etc. through their APIs. One handles auth, request building, and execution.

  TRIGGER when:
  - Interact with ANY 3rd-party platform or external service (e.g., "send an email", "create a Shopify order", "find a HubSpot contact", "post to Slack")
  - List their connected platforms or check available ones
  - Search for available actions (e.g., "what can I do with Gmail")
  - Execute API calls with a connected platform
  - Set up webhook-driven automations between platforms (e.g., "when a Stripe payment comes in, notify Slack")
  - Build multi-step workflows that chain actions across platforms (e.g., "fetch Stripe customers and email each one")
  - Anything involving 3rd-party APIs, integrations, or connected apps — even if they don't mention "One" by name

  DO NOT TRIGGER for:
  - Setting up One or installing MCP (use `one init`)
  - Adding new connections (use `one add <platform>`)
  - Configuring access control (use `one config`)
---

# One CLI

You have access to the One CLI which lets you interact with 400+ third-party platforms through their APIs. Always include the `--agent` flag right after `one` for structured JSON output.

If the user wants a separate API key / connections for a specific project (vs. their default), walk them through running `one init` from that project folder and picking the "project" scope — see `references/scoping.md`. For monorepo subprojects (where a parent already has `.git`/`package.json`), have them `mkdir .one` in the subproject first so the config is keyed to that dir, not the monorepo root.

## Authentication

```bash
one login                    # Browser-based login (opens app.withone.ai)
one logout                   # Clear local credentials
```

`one login` opens the browser for OAuth authentication and automatically creates and stores an API key. If already logged in, the user can choose to log in globally or for the current directory. `one logout` shows current session info and confirms before clearing credentials.

**Onboarding a user with no prompts:** run `one init --auth browser` — it opens a login window (the user authenticates there), saves the key, and auto-installs this skill, all without blocking on stdin. Add `-g`/`-p` for scope (default global). For CI/CD or headless environments, use `one init --auth manual --api-key sk_live_...`.

## Core Workflow: search -> knowledge -> execute

Always follow this sequence when the user wants to do something on a connected platform:

### 1. List connections

```bash
one --agent connection list
```

Returns connected platforms with their connection keys (needed for execution) and platform names in kebab-case (needed for searching).

### 1b. Delete a connection

```bash
one --agent connection delete <connection-key>
```

Removes a connection. Returns `{"deleted": true, "platform": "...", "key": "..."}` on success. Use the connection key from `one --agent connection list`.

### 2. Search for the right action

```bash
one --agent actions search <platform> "<query>" -t execute
```

- Platform names are lowercase; multi-word names use dashes: `gmail`, `hubspot`, `ship-station`, `google-calendar`
- Use `-t execute` when performing actions, `-t knowledge` when researching or writing code
- If no results, broaden the query (e.g., `"list"` instead of `"list active premium customers"`)

### 3. Get the action's knowledge (REQUIRED before executing)

```bash
one --agent actions knowledge <platform> <actionId>
```

This tells you exactly what parameters are required, how to structure the request, and which flags to use. Never skip this step — without it you'll guess wrong on parameters.

### 4. Execute

```bash
one --agent actions execute <platform> <actionId> <connectionKey> [options]
```

Options:
- `-d, --data <json>` — Request body (POST, PUT, PATCH)
- `--path-vars <json>` — Path variables for URLs with `{id}` placeholders
- `--query-params <json>` — Query parameters
- `--headers <json>` — Additional headers
- `--form-data` — Send as multipart/form-data
- `--form-url-encoded` — Send as application/x-www-form-urlencoded
- `--dry-run` — Preview the request without executing
- `--mock` — Return example response without making an API call (useful for building UI)
- `--skip-validation` — Skip input validation against the action schema
- `--output <path>` — Save response to a file (for binary downloads like PDFs, images, documents)
- `--no-cache` — Bypass the cached action details and re-fetch them; the fresh details still refresh the cache (execution itself is never cached)

The CLI validates required parameters before executing. Missing params return a structured error with the flag name, parameter name, and description. Pass `--skip-validation` to bypass.

Examples:
```bash
# Simple GET
one --agent actions execute shopify <actionId> <connectionKey>

# POST with body data
one --agent actions execute hubspot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# Path variables + query params
one --agent actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}' \
  --query-params '{"limit": "10"}'

# Array query params (expand to repeated keys)
one --agent actions execute gmail <actionId> <connectionKey> \
  --path-vars '{"userId": "me", "id": "msg123"}' \
  --query-params '{"format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]}'
```

### Parallel execution

Execute multiple actions concurrently with `--parallel`, separating each action with `--`:

```bash
one --agent actions execute --parallel \
  gmail send-email conn123 -d '{"to":"a@b.com"}' \
  -- slack post-message conn456 -d '{"text":"done"}'
```

All segments are validated before any execution. Failed actions don't block others. Use `--max-concurrency <n>` (default 5) to control batching. Agent-mode output: `{"parallel":true,"results":[...],"succeeded":N,"failed":N,"totalDurationMs":N}`. Each result carries `"_preflight":{"cache":"hit"|"miss"}` showing whether that action's details were served from cache.

## Error Handling

All errors return JSON: `{"error": "message"}`. Parse output as JSON and check for the `error` key.

## Important Rules

- Always use `--agent` flag for structured JSON output
- Platform names are lowercase; multi-word names use dashes (`hubspot` not `HubSpot`, `google-calendar` not `googleCalendar`)
- Always use the exact action ID from search results — never guess or construct them
- Always read knowledge before executing — it has required params, validation rules, and caveats
- JSON values passed to `-d`, `--path-vars`, `--query-params` must be valid JSON (use single quotes around JSON to avoid shell escaping)
- Do NOT pass path or query parameters inside the `-d` body flag

## Caching

Knowledge and search responses are cached locally (`~/.one/cache/`). Subsequent calls for the same action serve instantly from disk. `actions execute` reuses the cached action details for its preflight lookup, so after a knowledge call (or a prior execute of the same action) it makes a single API call — the action itself.

- Cache is automatic — no setup required
- Default TTL: 1 hour (configurable via `ONE_CACHE_TTL` env var)
- In `--agent` mode, responses include a `_cache` field: `{"hit": true, "age": 1423, "fresh": true}`; execute responses include `"_preflight": {"cache": "hit"|"miss"}`
- Use `--no-cache` to force a fresh fetch: works on `knowledge`, `search`, and `execute` (refreshes execute's action-details lookup)
- Use `--cache-status` to check cache state without fetching
- Manage cache: `one cache list`, `one cache clear`, `one cache update-all`
- Execution responses are NEVER cached — the action always runs live; only action metadata (docs, method, path, schema) is cached

## Unified Memory

One ships a local memory store (a real Postgres process bootstrapped on demand via the bundled `embedded-postgres` plugin, with a `postgres` plugin available for remote/self-hosted Postgres) that backs both user-authored notes and synced platform data. `one mem <cmd>` is the primary surface; `one sync` is a namespaced alias (`one mem sync ...`) that writes synced rows into the same store.

**Zero-config.** The first `one mem` call on a new machine auto-initializes — no separate `mem init` step required. The `embedded-postgres` plugin downloads its Postgres binaries on first run (~52MB) and writes a daemon PID/port file at `~/.one/pg/.pgserve.json` so subsequent CLI invocations reuse the running cluster. If an OpenAI key is already resolvable (env, `.onerc`, or `config.openaiApiKey`), embeddings enable automatically and search becomes hybrid FTS + semantic. Otherwise you get FTS-only with a structured `_upgrade` hint on every response telling the user how to upgrade.

**Listing synced rows.** `mem list <type>` takes a positional namespaced type — there is no `--platform` flag. Synced rows live under `<platform>/<model>` types:

```bash
one --agent mem list "gmail/threads"
one --agent mem list "attio/attioPeople" --limit 5
one --agent mem list "google-calendar/events"
```

Underneath, the store has no `platform` column — `type` is the only platform-scoping mechanism. If you need raw SQL via `mem sql`, filter with `WHERE type LIKE 'platform/%'` (not `WHERE platform = ...`).

```bash
# User memories
one --agent mem add note '{"content":"..."}' --tags work --weight 7
one --agent mem search "deadline"                       # hybrid if key set, else FTS
one --agent mem list note --limit 20
one --agent mem link <from-id> <to-id> relates_to --bi

# Status + diagnostics
one --agent mem status                                  # backend, provider, _upgrade hint
one --agent mem doctor                                  # full health report
```

### Adding OpenAI for semantic search

Stored at the top level of `~/.one/config.json` as `openaiApiKey`, same precedence as `ONE_SECRET` (env > `.onerc OPENAI_API_KEY=...` > project > global). Three equivalent ways to set:

```bash
# Via re-run of one init (interactive prompt)
one init

# Via config set (writes to top-level, not the memory block)
one --agent mem config set embedding.apiKey sk-...

# Via env var (no persistence)
export OPENAI_API_KEY=sk-...
```

### Syncing platforms into memory

```bash
# Check built-in profiles (pre-validated configs for common platforms)
one --agent sync profiles

# Setup — seeds from the built-in, merges your --config overrides
one --agent sync init stripe balanceTransactions
# If _complete: true and _test.ok: true → ready to run

# Preview what gets embedded BEFORE paying embedding cost (agent declares paths)
one --agent sync init attio attioPeople --config '{
  "memory": {
    "embed": true,
    "searchable": [
      "values.name[0].full_name",
      "values.job_title[0].value",
      "values.description[0].value",
      "values.email_addresses[0].email_address"
    ]
  }
}'
# Skip the "pick paths by reading knowledge" step — let the CLI rank them from a live sample
one --agent sync suggest-searchable attio/attioPeople
# → { suggestions: [{path, score, hitRate, avgLength, noiseFraction, sampleValue}], configPatch: {...paste-ready...} }

one --agent sync test attio/attioPeople --show-searchable
# → Previews across 5 samples. Each path has { hits, total, sample }:
#     5/5 = path resolves on every record (clean)
#     1/5 = field is real but sparse on this page
#     0/5 = typo, or field never populated in sampled records
# Iterate until the numbers match intent.

# Run — memory is always written; pass --no-memory to skip (rare)
one --agent sync run stripe
one --agent sync schema stripe/customers         # inspect field paths/types before querying
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync search "refund"                 # hybrid across all synced platforms
one --agent sync list stripe                     # progress + freshness

# Schedule unattended syncs
one sync schedule add stripe --every 1h
```

### memory.searchable paths

Declared on the profile, drives what gets embedded + FTS-indexed. Supports numeric indexes AND `[]` wildcards for array fan-out:

```
values.name[0].full_name              # numeric index (first element)
messages[].snippet                    # wildcard — every element's .snippet
messages[].payload.parts[].body.data  # nested wildcards
```

Without declared paths, the default walker concatenates every string in the record — correct but often noisy for hierarchical APIs (Attio, HubSpot). **Always declare paths for any profile with `embed: true`.**

**Sync rejects custom actions** — profiles must use passthrough. `sync init` only surfaces passthrough models; `sync run` aborts if the list or enrich action is tagged `custom`. If no passthrough exists, compose a flow instead.

**Connections are late-bound** — profiles use `"connection": { "platform": "<name>" }`, not literal `connectionKey` strings. The key is resolved at sync time, so `one add <platform>` (re-auth) doesn't break the profile. For multi-account platforms, add `"tag": "<connection-tag>"` to disambiguate, and create the tagged connection with `one add <platform> --tag <name>`. Don't hardcode connection keys in profiles.

**Advanced features** (enrich, transform, exclude, identityKey, hooks, --full-refresh, alternative backends, embedding tuning): run `one guide memory` or `one guide sync` for the full reference.

## Beyond Single Actions

One also supports more advanced patterns. Read the relevant reference file before using these:

- **Webhook Relay** — Receive webhooks from a platform and forward to another (e.g., Stripe event -> Slack message). Read `references/relay.md` in this skill's directory for the full workflow.
- **Multi-step Workflows** — Chain actions across platforms as JSON workflow files (like n8n/Zapier but file-based). Read `references/flows.md` in this skill's directory for the schema and examples. To debug: `flow execute <key> --dry-run` (resolve interpolations without running), `--stop-after <stepId>` (run up to a step then stop), and `flow inspect <runId>` (a past run's per-step outputs).

## Adding New Connections

If the user needs a platform that isn't connected yet, tell them to run:
```bash
one add <platform>
one add <platform> --tag <name>   # tag it (for multiple connections per platform)
```
This is interactive and opens the browser for OAuth. After connecting, the platform will appear in `one --agent connection list`. Use `--tag` when the user has (or will have) more than one connection for the same platform so sync/flow profiles can target a specific one via `"connection": { "platform": "<name>", "tag": "<name>" }`.

## Removing Connections

To delete a connection that is no longer needed:
```bash
one --agent connection delete <connection-key>
```
The connection key comes from `one --agent connection list`. Returns `{"deleted": true, "platform": "...", "key": "..."}` on success.
