---
name: one
description: |
  Use the One CLI (`one`) to interact with 250+ third-party platforms — Gmail, Slack, Shopify, HubSpot, Stripe, GitHub, Notion, Salesforce, and more — through their APIs. One handles authentication, request building, and execution through a single unified interface.

  TRIGGER when the user wants to:
  - Interact with ANY third-party platform or external service (e.g., "send an email", "create a Shopify order", "look up a HubSpot contact", "post to Slack")
  - List their connected platforms or check what integrations are available
  - Search for what they can do on a platform (e.g., "what can I do with Gmail")
  - Execute any API call against a connected platform
  - Set up webhook-driven automations between platforms (e.g., "when a Stripe payment comes in, notify Slack")
  - Build multi-step workflows that chain actions across platforms (e.g., "fetch Stripe customers and email each one")
  - Anything involving third-party APIs, integrations, or connected apps — even if they don't mention "One" by name

  DO NOT TRIGGER for:
  - Setting up One or installing MCP (that's `one init`)
  - Adding new connections (that's `one add <platform>`)
  - Configuring access control (that's `one config`)
---

# One CLI

You have access to the One CLI which lets you interact with 250+ third-party platforms through their APIs. Always include the `--agent` flag right after `one` for structured JSON output.

If the user wants a separate API key / connections for a specific project (vs. their default), walk them through running `one init` from that project folder and picking the "project" scope — see `references/scoping.md`.

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

- Platform names are always kebab-case: `gmail`, `hub-spot`, `ship-station`
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

The CLI validates required parameters before executing. Missing params return a structured error with the flag name, parameter name, and description. Pass `--skip-validation` to bypass.

Examples:
```bash
# Simple GET
one --agent actions execute shopify <actionId> <connectionKey>

# POST with body data
one --agent actions execute hub-spot <actionId> <connectionKey> \
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

All segments are validated before any execution. Failed actions don't block others. Use `--max-concurrency <n>` (default 5) to control batching. Agent-mode output: `{"parallel":true,"results":[...],"succeeded":N,"failed":N,"totalDurationMs":N}`.

## Error Handling

All errors return JSON: `{"error": "message"}`. Parse output as JSON and check for the `error` key.

## Important Rules

- Always use `--agent` flag for structured JSON output
- Platform names are always kebab-case (`hub-spot` not `HubSpot`)
- Always use the exact action ID from search results — never guess or construct them
- Always read knowledge before executing — it has required params, validation rules, and caveats
- JSON values passed to `-d`, `--path-vars`, `--query-params` must be valid JSON (use single quotes around JSON to avoid shell escaping)
- Do NOT pass path or query parameters inside the `-d` body flag

## Caching

Knowledge and search responses are cached locally (`~/.one/cache/`). Subsequent calls for the same action serve instantly from disk.

- Cache is automatic — no setup required
- Default TTL: 1 hour (configurable via `ONE_CACHE_TTL` env var)
- In `--agent` mode, responses include a `_cache` field: `{"hit": true, "age": 1423, "fresh": true}`
- Use `--no-cache` to force a fresh fetch: `one --agent actions knowledge <platform> <actionId> --no-cache`
- Use `--cache-status` to check cache state without fetching
- Manage cache: `one cache list`, `one cache clear`, `one cache update-all`
- `actions execute` is NEVER cached — always fresh

## Local Data Sync

Sync platform data into local SQLite for instant queries, full-text search, scheduled refresh, and change-driven automation.

```bash
# First time only
one sync install

# Check built-in profiles (pre-validated configs for common platforms)
one --agent sync profiles

# Setup (uses built-in if available, otherwise auto-infers + auto-tests)
one --agent sync init stripe balanceTransactions
# If _complete: true and _test.ok: true → go straight to sync run

# Sync + query
one --agent sync run stripe
one --agent sync query stripe/balanceTransactions --where "status=available" --limit 20
one --agent sync search "refund"                 # FTS across all synced platforms
one --agent sync list stripe                     # progress + freshness

# Schedule unattended syncs
one sync schedule add stripe --every 1h
```

**Advanced features** (enrich, transform, exclude, identityKey, hooks, --full-refresh, --where-sql delete, cursor resume): run `one guide sync` for the full reference.

## Beyond Single Actions

One also supports more advanced patterns. Read the relevant reference file before using these:

- **Webhook Relay** — Receive webhooks from a platform and forward to another (e.g., Stripe event -> Slack message). Read `references/relay.md` in this skill's directory for the full workflow.
- **Multi-step Workflows** — Chain actions across platforms as JSON workflow files (like n8n/Zapier but file-based). Read `references/flows.md` in this skill's directory for the schema and examples.

## Adding New Connections

If the user needs a platform that isn't connected yet, tell them to run:
```bash
one add <platform>
```
This is interactive and opens the browser for OAuth. After connecting, the platform will appear in `one --agent connection list`.

## Removing Connections

To delete a connection that is no longer needed:
```bash
one --agent connection delete <connection-key>
```
The connection key comes from `one --agent connection list`. Returns `{"deleted": true, "platform": "...", "key": "..."}` on success.
