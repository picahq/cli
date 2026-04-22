<img src="https://assets.withone.ai/banners/cli.png" alt="One CLI - Connect your agents to every API on the internet." style="border-radius: 5px;">

<h3 align="center">One CLI</h3>

<p align="center">
  <a href="https://withone.ai"><strong>Website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://withone.ai/docs"><strong>Docs</strong></a>
  &nbsp;·&nbsp;
  <a href="https://app.withone.ai"><strong>Dashboard</strong></a>
  &nbsp;·&nbsp;
  <a href="https://withone.ai/changelog"><strong>Changelog</strong></a>
  &nbsp;·&nbsp;
  <a href="https://x.com/withoneai"><strong>X</strong></a>
  &nbsp;·&nbsp;
  <a href="https://linkedin.com/company/withoneai"><strong>LinkedIn</strong></a>
</p>

<p align="center">
  <a href="https://npmjs.com/package/@withone/cli"><img src="https://img.shields.io/npm/v/%40withone%2Fcli" alt="npm version"></a>
  &nbsp;
  <a href="https://withone.ai/knowledge"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fapi.withone.ai%2Fopen%2Fcount%2Fplatforms" alt="platforms"></a>
  &nbsp;
  <a href="https://withone.ai/knowledge"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fapi.withone.ai%2Fopen%2Fcount%2Ftools" alt="tools"></a>
</p>

One gives your AI agent authenticated access to 250+ platforms - Gmail, Slack, Shopify, HubSpot, Stripe, Notion, and everything else - through a single interface. No API keys to juggle, no OAuth flows to build, no request formats to memorize. Connect a platform once, and your agent can search for actions, read the docs, and execute API calls in seconds.

## Install

```bash
npx @withone/cli@latest init
```

Or install globally:

```bash
npm install -g @withone/cli
one init
```

`one init` walks you through setup: authenticate via browser or enter your [API key](https://app.withone.ai/settings/api-keys), pick your AI agents, and you're done. The MCP server gets installed automatically.

Or authenticate directly:

```bash
one login              # Opens browser for authentication (global or per-directory)
one logout             # Clear credentials (with scope picker and confirmation)
```

Requires Node.js 18+.

## Quick start

```bash
# Connect a platform
one add gmail

# See what you're connected to
one list

# Search for actions you can take
one actions search gmail "send email" -t execute

# Read the docs for an action
one actions knowledge gmail <actionId>

# Execute it
one actions execute gmail <actionId> <connectionKey> \
  -d '{"to": "jane@example.com", "subject": "Hello", "body": "Sent from my AI agent"}'
```

That's it. Five commands to go from zero to sending an email through Gmail's API - fully authenticated, correctly formatted, without touching a single OAuth token.

### Multi-step flows

Chain actions across platforms into reusable workflows:

```bash
# Create a flow that looks up a Stripe customer and sends a Gmail welcome email
one flow create welcome-customer --definition '{
  "key": "welcome-customer",
  "name": "Welcome New Customer",
  "version": "1",
  "inputs": {
    "stripeKey": { "type": "string", "required": true, "connection": { "platform": "stripe" } },
    "gmailKey": { "type": "string", "required": true, "connection": { "platform": "gmail" } },
    "email": { "type": "string", "required": true }
  },
  "steps": [
    { "id": "find", "name": "Find customer", "type": "action",
      "action": { "platform": "stripe", "actionId": "<actionId>", "connectionKey": "$.input.stripeKey",
        "data": { "query": "email:'\''{{$.input.email}}'\''" } } },
    { "id": "send", "name": "Send email", "type": "action",
      "if": "$.steps.find.response.data.length > 0",
      "action": { "platform": "gmail", "actionId": "<actionId>", "connectionKey": "$.input.gmailKey",
        "data": { "to": "{{$.input.email}}", "subject": "Welcome!", "body": "Thanks for joining." } } }
  ]
}'

# Validate it
one flow validate welcome-customer

# Run it - connection keys auto-resolve if you have one connection per platform
one flow execute welcome-customer -i email=jane@example.com
```

Workflows live under `.one/flows/<key>/flow.json` with an optional `lib/` subfolder for `.mjs` code modules — create new flows in this folder layout. Flows can be organized into subdirectory groups: `.one/flows/<group>/<key>/flow.json`. Reference them as `group/key` or just the bare key if unique. (The legacy single-file layout `.one/flows/<key>.flow.json` is deprecated but still loads for backward compatibility.) Flows support conditions, loops, while loops, parallel steps, transforms, sub-flows, pagination, bash steps, and external `.mjs` code modules. Run `one guide flows` for the full reference.

## How it works

```
Your AI Agent
    ↓
  One CLI
    ↓
  One API (api.withone.ai/v1/passthrough)
    ↓
  Gmail / Slack / Shopify / HubSpot / Stripe / ...
```

Every API call routes through One's passthrough proxy. One injects the right credentials, handles rate limiting, and normalizes responses. You never see or manage raw OAuth tokens - your connection key is all you need.

## Commands

### `one init`

Set up your API key and install the MCP server into your AI agents.

```bash
one init
```

Supports Claude Code, Claude Desktop, Cursor, Windsurf, Codex, and Kiro.

**Global vs. project scope.** `one init` is interactive and asks where the setup should live:

- **Global** (`~/.one/config.json`) — applies to every folder. Best when you only need one workspace / API key.
- **Project** (`~/.one/projects/<slug>/config.json`) — scoped to the current project, stored under your home directory so secrets never land in git. Use this when different projects need different API keys, connections, or access control.

When you run `one` in a project, it uses the project config if one exists and falls back to the global config otherwise. Use `one config path` to see which config is active and the full resolution order.

If you've already set up, `one init` shows your current status for the active scope and lets you update your key, install to more agents, or reconfigure.

| Flag | What it does |
|------|-------------|
| `-y` | Skip confirmations |
| `-g` | Non-interactive: write the One config globally (`~/.one/config.json`) |
| `-p` | Non-interactive: write the One config for this project (`~/.one/projects/<slug>/config.json`) |

### `one add <platform>`

Connect a new platform via OAuth.

```bash
one add shopify
one add hub-spot
one add gmail
```

Opens your browser, you authorize, done. The CLI polls until the connection is live. Platform names are kebab-case - run `one platforms` to see them all.

### `one list`

List your active connections with their status and connection keys.

```bash
one list
```

```
  ● gmail       operational   live::gmail::default::abc123
  ● slack       operational   live::slack::default::def456
  ● shopify     operational   live::shopify::default::ghi789
```

You need the connection key (rightmost column) when executing actions.

### `one connection delete <connection-key>`

Remove a connection by its key.

```bash
one connection delete live::gmail::default::abc123
one connection rm live::gmail::default::abc123      # alias
```

Shows the connection details and asks for confirmation before deleting. Use `--force` to skip the confirmation prompt.

| Option | What it does |
|--------|-------------|
| `-f, --force` | Skip confirmation prompt |

### `one platforms`

Browse all 200+ available platforms.

```bash
one platforms              # all platforms
one platforms -c "CRM"     # filter by category
one platforms --json       # machine-readable output
```

### `one actions search <platform> <query>`

Search for API actions on a connected platform using natural language.

```bash
one actions search shopify "list products"
one actions search hub-spot "create contact" -t execute
one actions search gmail "send email"
```

Returns the top 5 matching actions with their action IDs, HTTP methods, and paths. Use `-t execute` when you intend to run the action, or `-t knowledge` (default) when you want to learn about it or write code against it.

### `one actions knowledge <platform> <actionId>`

Get the full documentation for an action - parameters, validation rules, request/response structure, examples, and the exact API request format.

```bash
one actions knowledge shopify 67890abcdef
```

Always read the knowledge before executing. It tells you exactly what parameters are required, what format they need, and any platform-specific quirks.

### `one actions execute <platform> <actionId> <connectionKey>`

Execute an API action on a connected platform.

```bash
# Simple GET
one actions execute shopify <actionId> <connectionKey>

# POST with data
one actions execute hub-spot <actionId> <connectionKey> \
  -d '{"properties": {"email": "jane@example.com", "firstname": "Jane"}}'

# With path variables
one actions execute shopify <actionId> <connectionKey> \
  --path-vars '{"order_id": "12345"}'

# With query params
one actions execute stripe <actionId> <connectionKey> \
  --query-params '{"limit": "10"}'
```

| Option | What it does |
|--------|-------------|
| `-d, --data <json>` | Request body (POST, PUT, PATCH) |
| `--path-vars <json>` | Replace `{variables}` in the URL path |
| `--query-params <json>` | Query string parameters |
| `--headers <json>` | Additional request headers |
| `--form-data` | Send as multipart/form-data |
| `--form-url-encoded` | Send as application/x-www-form-urlencoded |
| `--dry-run` | Show the request without executing it |
| `--mock` | Return example response without making an API call |
| `--skip-validation` | Skip input validation against the action schema |
| `--output <path>` | Save response to a file (for binary downloads) |

The CLI validates required parameters (path variables, query params, body fields) against the action schema before executing. Missing params return a clear error with the flag name and description. Pass `--skip-validation` to bypass.

#### Parallel execution

Execute multiple actions concurrently with `--parallel`, separating each action with `--`:

```bash
one --agent actions execute --parallel \
  gmail send-email conn123 -d '{"to":"a@b.com","subject":"Hi","body":"Hello"}' \
  -- slack post-message conn456 -d '{"channel":"#general","text":"Done"}' \
  -- google-sheets append-row conn789 -d '{"values":["x","y"]}'
```

Each segment follows the same format: `<platform> <actionId> <connectionKey> [-d ...] [--path-vars ...] [--query-params ...]`. All segments are validated upfront before any execution starts. Results are collected via `Promise.allSettled` — if one fails, the rest still complete.

| Option | What it does |
|--------|-------------|
| `--parallel` | Enable parallel mode |
| `--max-concurrency <n>` | Max concurrent actions per batch (default: 5) |

Agent-mode output includes `parallel: true`, per-action `status`/`durationMs`/`response`, plus `totalDurationMs`, `succeeded`, and `failed` counts.

### `one cache`

Manage the local cache for knowledge and search responses. The CLI automatically caches `actions knowledge` and `actions search` results so repeated calls serve instantly from disk.

```bash
one cache list                    # List all cached entries with age and status
one cache list --expired          # Show only expired entries
one cache clear                   # Clear all cached data
one cache clear <actionId>        # Clear a specific entry
one cache update-all              # Re-fetch fresh data for all cached entries
```

Knowledge and search commands also support cache flags:

```bash
one actions knowledge gmail <actionId> --no-cache       # Skip cache, fetch fresh
one actions knowledge gmail <actionId> --cache-status   # Check cache status
one actions search gmail "send email" --no-cache        # Skip cache for search
```

Default TTL is 1 hour. Configure via `ONE_CACHE_TTL` environment variable or `cacheTtl` in `~/.one/config.json`.

Note: `actions execute` is never cached — it always hits the API fresh.

### `one sync`

Sync platform data into local SQLite for instant queries, full-text search, scheduled refresh, and change-driven automation. The sync engine (`better-sqlite3`) is an optional dependency — install it once per machine:

```bash
one sync install && one sync doctor
```

```bash
# Discover → init (one command: infer + late-bound connection + auto-test) → run
one sync models stripe
one sync init stripe balanceTransactions    # connection: { platform } baked in, test auto-run
one sync run stripe --since 90d

# Query, search, SQL
one sync query stripe/balanceTransactions --where "status=available" --limit 20
one sync search "refund"
one sync sql stripe "SELECT count(*) FROM balanceTransactions"

# Schedule unattended syncs + change hooks
one sync schedule add stripe --every 1h
one sync init stripe balanceTransactions --config '{"onInsert":"one flow execute handle-new-txn"}'

# Deletion detection
one sync run stripe --full-refresh
```

> **Sync uses passthrough actions only.** Profiles referencing a custom/composer action are rejected at runtime. `sync models` already filters to passthrough-only; if a model has no passthrough list endpoint, compose a flow instead of syncing.

> **Connections are late-bound.** Profiles use `"connection": { "platform": "<name>", "tag"?: "..." }` instead of literal `connectionKey` strings. The key is resolved at sync time, so `one add <platform>` (re-auth) doesn't break the profile. `tag` only needed for multi-account platforms (e.g. two Gmail accounts).

| Subcommand | What it does |
|------------|-------------|
| `install` / `doctor` | Install + verify the SQLite engine |
| `models <platform>` | Discover available data models |
| `init <platform> <model>` | Create profile (auto-infers all fields, auto-resolves key, auto-runs test) |
| `test <platform>/<model>` | Validate + auto-fix profile from real API response (also runs inside init) |
| `run <platform>` | Sync data (`--full-refresh`, `--since`, `--dry-run`) |
| `query <platform>/<model>` | Query with `--where`, `--after/before`, `--refresh` |
| `search <query>` | FTS5 across all synced data |
| `sql <platform> <sql>` | Raw SELECT queries |
| `schedule add/list/status/remove/repair` | Cron-backed scheduled syncs with drift detection |
| `remove <platform>` | Delete local data (`--dry-run` to preview) |

Change hooks (`onInsert`, `onUpdate`, `onChange`) fire per-page during sync — pipe to a shell command, a flow, or an event log. Root-array responses (e.g. Hacker News `/v0/topstories.json` → `[9129911, 9129199, ...]`) are supported by setting `resultsPath` to `""`, `"$"`, or `"."`; primitive elements are auto-wrapped as `{ [idField]: value }`. Run `one guide sync` for the full reference.

### `one relay`

Receive webhooks from platforms and forward them to any connected platform via passthrough actions.

```bash
one relay platforms                        # List relay-capable platforms + event type counts
one relay event-types <platform>           # List supported event types for a platform
one relay create --connection-key <key> --create-webhook --event-filters '["event.type"]'
one relay activate <id> --actions '<json>' # Attach passthrough forwarding actions
one relay list                             # List existing relay endpoints
one relay events --platform <p>            # Inspect received events
one relay deliveries --endpoint-id <id>    # Check delivery status
```

Start with `one relay platforms` to discover which platforms support relay at all, then drill into `event-types <platform>` for the specific events. Run `one guide relay` for the full reference including `--metadata` requirements per platform.

### `one guide [topic]`

Get the full CLI usage guide, designed for AI agents that only have the binary (no MCP, no IDE skills).

```bash
one guide                 # full guide (all topics)
one guide overview        # setup, --agent flag, discovery workflow
one guide actions         # search, knowledge, execute workflow
one guide flows           # multi-step API workflows

one --agent guide         # full guide as structured JSON
one --agent guide flows   # single topic as JSON
```

Topics: `overview`, `actions`, `flows`, `relay`, `cache`, `sync`, `all` (default).

In agent mode (`--agent`), the JSON response includes the guide content and an `availableTopics` array so agents can discover what sections exist.

### `one flow create [key]`

Create a workflow from a JSON definition. New workflows are always saved to the folder layout at `.one/flows/<key>/flow.json` (with a `lib/` subfolder scaffolded for code modules). Use `group/key` to place flows in a subdirectory group (e.g. `.one/flows/research/company-research/flow.json`). The legacy `.one/flows/<key>.flow.json` single-file layout is deprecated; existing legacy files continue to load and run unchanged for backward compatibility.

```bash
# From a --definition flag
one flow create welcome-customer --definition '{"key":"welcome-customer","name":"Welcome","version":"1","inputs":{},"steps":[]}'

# Create in a subdirectory group
one flow create research/company-research --definition @flow.json

# From stdin
cat flow.json | one flow create

# Custom output path
one flow create my-flow --definition '...' -o ./custom/path.json
```

| Option | What it does |
|--------|-------------|
| `--definition <json>` | Workflow definition as a JSON string |
| `-o, --output <path>` | Custom output path (default: `.one/flows/<key>/flow.json`) |

### `one flow execute <key>`

Execute a workflow by key or file path. Pass inputs with repeatable `-i` flags.

```bash
# Execute with inputs
one flow execute welcome-customer \
  -i customerEmail=jane@example.com

# Dry run - validate and show plan without executing
one flow execute welcome-customer --dry-run -i customerEmail=jane@example.com

# Verbose - show each step as it runs
one flow execute welcome-customer -v -i customerEmail=jane@example.com
```

Connection inputs with a `connection` field in the workflow definition are auto-resolved when the user has exactly one connection for that platform.

Press Ctrl+C during execution to pause - the run can be resumed later with `one flow resume <runId>`.

| Option | What it does |
|--------|-------------|
| `-i, --input <name=value>` | Input parameter (repeatable) |
| `--dry-run` | Validate and show execution plan without running |
| `--mock` | With `--dry-run`: execute transforms/code with realistic mock API responses |
| `--skip-validation` | Skip input validation against action schemas |
| `--allow-bash` | Allow bash step execution (disabled by default for security) |
| `-v, --verbose` | Show full request/response for each step |

### `one flow list`

List all workflows saved in `.one/flows/`.

```bash
one flow list
```

### `one flow validate <key>`

Validate a workflow JSON file against the schema.

```bash
one flow validate welcome-customer
```

### `one flow resume <runId>`

Resume a paused or failed workflow run from where it left off.

```bash
one flow resume abc123
```

### `one flow runs [flowKey]`

List workflow runs, optionally filtered by workflow key.

```bash
one flow runs                    # all runs
one flow runs welcome-customer   # runs for a specific workflow
```

### `one config`

Configure access control for the MCP server. Optional - full access is the default.

```bash
one config
```

| Setting | Options | Default |
|---------|---------|---------|
| Permission level | `admin` / `write` / `read` | `admin` |
| Connection scope | All or specific connections | All |
| Action scope | All or specific action IDs | All |
| Knowledge-only mode | Enable/disable execution | Off |

Settings propagate automatically to all installed agent configs.

#### `one config skills status` / `one config skills sync`

`one init` copies the packaged skill files (`SKILL.md`, `references/`) into `~/.agents/skills/one/` and symlinks per-agent paths to that canonical directory. When the CLI self-updates, the skill files in the canonical dir would normally stay frozen at the version that was installed. To prevent stale docs, every CLI command checks a `.one-cli-version` marker in the canonical dir and silently refreshes the skill files if they don't match the running CLI version. No user action required.

| Command | What it does |
|---------|--------------|
| `one config skills status` | Show installed skill version, current CLI version, and path |
| `one config skills sync` | Force a re-copy of packaged skill files (for troubleshooting) |

Auto-sync refuses to resurrect skills if you opted out of skill installation during `one init` — the canonical dir has to already exist.

### Project config (`.onerc`)

Drop a `.onerc` file in your project root to override global settings per-project. Simple `KEY=VALUE` format; `#` for comments. Read from the current working directory (no parent lookup).

| Key | Purpose |
|-----|---------|
| `ONE_SECRET` | API key (also honored as env var) |
| `ONE_API_BASE` | API base URL (also honored as env var) |
| `ONE_PERMISSIONS` | `admin` / `write` / `read` |
| `ONE_CONNECTION_KEYS` | Comma-separated connection-key allowlist |
| `ONE_ACTION_IDS` | Comma-separated action-ID allowlist |
| `ONE_KNOWLEDGE_AGENT` | `true` / `false` — knowledge-only mode |

Precedence: env var > `.onerc` > `~/.one/config.json`.

```bash
# .onerc
ONE_SECRET=sk_live_xxx
ONE_API_BASE=https://development-api.withone.ai
ONE_PERMISSIONS=read
```

> ⚠️ **Add `.onerc` to your `.gitignore`.** If you put `ONE_SECRET` in it, committing the file will leak your API key. Treat `.onerc` like `.env` — never check it in.

## The workflow

The power of One is in the workflow. Every interaction follows the same pattern:

```
one list                    → What am I connected to?
one actions search          → What can I do?
one actions knowledge       → How do I do it?
one actions execute         → Do it.
```

This is the same workflow whether you're sending emails, creating CRM contacts, processing payments, managing inventory, or posting to Slack. One pattern, any platform.

For multi-step workflows that chain actions across platforms:

```
one actions knowledge       → Learn each action's schema
one flow create             → Define the workflow as JSON
one flow validate           → Check it
one flow execute            → Run it
```

Workflows support conditions, loops, while loops, parallel execution, transforms, code steps, sub-flows, pagination, bash steps, and file I/O. Run `one guide flows` for the full schema reference and examples.

## For AI agents

If you're an AI agent with only the `one` binary (no MCP server or IDE skills), start with `one --agent guide` to get the full usage guide as structured JSON. This teaches you the complete workflow, JSON schemas, selector syntax, and more - everything you need to bootstrap yourself.

If you're an AI agent using the One MCP server, the tools map directly:

| MCP Tool | CLI Command |
|----------|------------|
| `list_one_integrations` | `one list` + `one platforms` |
| `search_one_platform_actions` | `one actions search` |
| `get_one_action_knowledge` | `one actions knowledge` |
| `execute_one_action` | `one actions execute` |

The workflow is the same: list → search → knowledge → execute. Never skip the knowledge step - it contains required parameter info and platform-specific details that are critical for building correct requests.

## MCP server installation

`one init` handles this automatically. Here's where configs go:

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | Platform-specific app support dir | - |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | - |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` |
| Kiro | `~/.kiro/settings/mcp.json` | `.kiro/settings/mcp.json` |

Project configs can be committed to your repo. Each team member runs `one init` with their own API key.

## Development

```bash
npm run dev        # watch mode
npm run build      # production build
npm run typecheck  # type check
```
