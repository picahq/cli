---
name: pica
description: Interact with third-party platforms (Gmail, Slack, HubSpot, Stripe, etc.) via Pica. Use when the user wants to search for available API actions, read API documentation, execute API calls, manage connections, or do anything involving third-party integrations.
triggers:
  - "search actions"
  - "find actions"
  - "execute action"
  - "run action"
  - "list connections"
  - "add connection"
  - "list platforms"
  - "pica"
  - "integration"
  - "send email"
  - "check calendar"
  - "post to slack"
---

# Pica

Pica gives you access to 200+ third-party platforms (Gmail, Slack, HubSpot, Stripe, Shopify, etc.) through a single interface. It handles auth, rate limiting, and retries so you just call the action you need.

## Two interfaces: MCP and CLI

| Interface | Best for |
|-----------|----------|
| **MCP tools** | AI agents doing work (search, inspect, execute actions) |
| **CLI** (`pica`) | Humans doing setup, OAuth, browsing |

**Rule of thumb:** If you're doing the work, use MCP. If a human needs to interact (OAuth, setup), use CLI.

## MCP tools

The Pica MCP is your primary interface. It gives you structured JSON in/out with no parsing overhead.

| Tool | What it does |
|------|-------------|
| `mcp__pica__list_pica_integrations` | List all platforms and active connections |
| `mcp__pica__search_pica_platform_actions` | Search for actions on a platform |
| `mcp__pica__get_pica_action_knowledge` | Get full API docs for an action (call before execute) |
| `mcp__pica__execute_pica_action` | Execute an action on a connected platform |

### Standard workflow

```
1. list_pica_integrations          -> get connection keys and platform names
2. search_pica_platform_actions    -> find the right action
3. get_pica_action_knowledge       -> read the docs (REQUIRED before execute)
4. execute_pica_action             -> do the thing
```

### Step 1: List connections and platforms

```
mcp__pica__list_pica_integrations()
```

Returns all active connections (with connection keys) and available platforms. Always check this first.

### Step 2: Search for the right action

```
mcp__pica__search_pica_platform_actions({
  platform: "gmail",
  query: "send email",
  agentType: "execute"
})
```

- `agentType: "execute"` when you intend to run the action
- `agentType: "knowledge"` when you want to understand the API or write code
- Platform names are kebab-case: `gmail`, `hubspot`, `google-calendar`, `ship-station`
- Get the exact platform name from `list_pica_integrations`

### Step 3: Get action knowledge (required before execute)

```
mcp__pica__get_pica_action_knowledge({
  actionId: "conn_mod_def::ABC123::XYZ789",
  platform: "gmail"
})
```

Returns parameters, request/response schemas, caveats, and examples. You MUST call this before executing.

### Step 4: Execute

```
mcp__pica__execute_pica_action({
  actionId: "conn_mod_def::ABC123::XYZ789",
  connectionKey: "live::gmail::default::abc123",
  platform: "gmail",
  data: { to: "someone@example.com", subject: "Hello", body: "Hi there" },
  pathVariables: { userId: "me" }
})
```

Pass: `connectionKey` from step 1, `actionId` from step 2, parameters from step 3.

## CLI reference

For setup, OAuth, and human-facing tasks.

### Setup: `pica init`

First run prompts for API key, validates it, and installs the MCP into your AI agents.

Re-running `pica init` after setup shows a status dashboard:

```
  Current Setup
  ──────────────────────────────────────────
  API Key:  sk_test_...9j-Y
  Config:   ~/.pica/config.json

  Agent           Global  Project
  ──────────────  ──────  ───────
  Claude Code     ● yes   ● yes
  Claude Desktop  ● yes   -
  Cursor          ○ no    ○ no
  Windsurf        -       -

  - = not detected on this machine
```

Then offers targeted actions (only relevant options shown):

| Action | What it does |
|--------|-------------|
| Update API key | Validates new key, re-installs MCP to all agents that have it |
| Install MCP to more agents | Shows only detected agents missing the MCP |
| Install MCP for this project | Creates project-level configs in cwd |
| Start fresh | Full setup from scratch |

Flags: `-y` (skip confirmations), `-g` (global install), `-p` (project install).

### Other commands

| Command | Description |
|---------|-------------|
| `pica add <platform>` | Connect a platform via OAuth (opens browser) |
| `pica list` | List connections with keys |
| `pica platforms` | Browse all 200+ platforms |
| `pica search <platform> [query]` | Search for actions |
| `pica actions knowledge <id>` | Get API docs for an action |
| `pica exec <id>` | Execute an action |

All commands support `--json` for machine-readable output.

### Aliases

`pica ls` = list, `pica p` = platforms, `pica a search` = actions search, `pica a k` = actions knowledge, `pica a x` = actions execute.

### Exec flags

```bash
pica exec <actionId> \
  -c <connectionKey> \
  -d '{"key": "value"}' \
  -p pathVar=value \
  -q queryParam=value \
  --json
```

## Key concepts

- **Connection key**: Identifies which authenticated connection to use. Format: `live::gmail::default::abc123`. Get from `list_pica_integrations` or `pica list`.
- **Action ID**: Identifies a specific API action. Starts with `conn_mod_def::`. Get from search results.
- **Platform name**: Kebab-case identifier (`gmail`, `hubspot`, `google-calendar`, `ship-station`). Get from `list_pica_integrations`.
- **Passthrough proxy**: All actions route through Pica's proxy which injects auth, handles rate limits, and normalizes responses. You never touch raw OAuth tokens.
- **Pagination**: Some actions return `nextPageToken` or similar. Pass it back in subsequent requests to page through results.

## MCP installation details

`pica init` writes MCP configs here:

| Agent | Global | Project |
|-------|--------|---------|
| Claude Code | `~/.claude.json` | `.mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | n/a |
| Cursor | `~/.cursor/mcp.json` | `.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | n/a |

Global = available everywhere. Project = committed to repo, shared with team (each person needs their own API key).

If MCP tools are not available, install and init:

```bash
cd /Users/moe/projects/one/connection-cli
npm install && npm run build && npm link
pica init
```

## Common patterns

### Send an email
1. Search: `platform: "gmail", query: "send email"`
2. Knowledge: get the action docs
3. Execute with `data: { to, subject, body, connectionKey }`

### Read emails
1. Search: `platform: "gmail", query: "get emails"`
2. Knowledge: understand pagination (numberOfEmails, pageToken)
3. Execute with `data: { connectionKey, numberOfEmails, label, query }`

### Post to Slack
1. Search: `platform: "slack", query: "post message"`
2. Knowledge: get channel ID format
3. Execute with `data: { channel, text }`

### CRM operations
1. Search: `platform: "hubspot"` or `"attio"`, query: `"create contact"` / `"list contacts"`
2. Knowledge: understand required fields
3. Execute with the right data shape

### Calendar
1. Search: `platform: "google-calendar", query: "list events"`
2. Knowledge: understand time format, calendar ID
3. Execute with date range parameters
