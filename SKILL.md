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

## How to interact with Pica

Pica provides two interfaces: the **MCP tools** and the **CLI**. Use the right one for the job.

### MCP tools (primary, for AI agents)

The Pica MCP is your primary interface. It gives you structured JSON in/out with no parsing overhead. Always prefer MCP tools for discovering, inspecting, and executing actions.

The MCP exposes 5 tools:

| Tool | Purpose |
|------|---------|
| `mcp__pica__list_pica_integrations` | List all available platforms and active connections |
| `mcp__pica__search_pica_platform_actions` | Search for actions on a platform |
| `mcp__pica__get_pica_action_knowledge` | Get full API docs for an action (MUST call before execute) |
| `mcp__pica__execute_pica_action` | Execute an action on a connected platform |

### CLI (secondary, for setup and human-facing tasks)

The `pica` CLI is better for tasks that require a browser (OAuth), interactive prompts, or human-readable output. Use it for:

- **Setup**: `pica init` (configures API key and installs MCP)
- **Adding connections**: `pica add gmail` (opens browser for OAuth)
- **Browsing platforms**: `pica platforms` (visual, categorized list)
- **Quick lookups by a human**: `pica list`, `pica search gmail "send"`

## When to use which

| Task | Use |
|------|-----|
| Execute an API action | MCP |
| Search for actions | MCP |
| Read action docs | MCP |
| List connections/platforms | MCP |
| Add a new connection (OAuth) | CLI |
| Initial setup | CLI |
| Show a user what's available (visual output) | CLI |

**Rule of thumb:** If you're doing the work, use MCP. If a human needs to interact (OAuth, setup), use CLI.

## Setup and prerequisites

The MCP server is installed via `pica init`. If the MCP tools are not available, the CLI needs to be installed and init needs to run:

```bash
pica --version
```

If the command is not found, install it:

```bash
cd /Users/moe/projects/one/connection-cli
npm install
npm run build
npm link
```

Then run setup:

```bash
pica init
```

This stores the API key in `~/.pica/config.json` and installs the MCP server into Claude Code, Claude Desktop, Cursor, and Windsurf. After init, the MCP tools will be available.

## MCP workflow

This is the standard workflow for any integration task.

### Step 1: List connections and platforms

```
mcp__pica__list_pica_integrations()
```

Returns all active connections (with connection keys) and available platforms. Check this first to see what's connected.

### Step 2: Search for the right action

```
mcp__pica__search_pica_platform_actions({
  platform: "gmail",
  query: "send email",
  agentType: "execute"
})
```

Use `agentType: "execute"` when the intent is to run the action. Use `"knowledge"` when the user wants to understand the API or write code against it.

The platform name must be in kebab-case (e.g., `ship-station`, `hubspot`, `google-calendar`). Get the exact name from `list_pica_integrations`.

### Step 3: Get action knowledge (required before execute)

```
mcp__pica__get_pica_action_knowledge({
  actionId: "conn_mod_def::ABC123::XYZ789",
  platform: "gmail"
})
```

This returns full API documentation: parameters, request/response schemas, caveats, examples. You MUST call this before executing to understand what the action expects.

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

Pass the `connectionKey` from step 1, the `actionId` from step 2, and the parameters from step 3.

## CLI reference

For when you need the CLI (setup, OAuth, human-facing output):

| Command | Description |
|---------|-------------|
| `pica init` | Set up API key and install MCP |
| `pica list` | List connections with keys |
| `pica add <platform>` | Add a new connection via OAuth (opens browser) |
| `pica platforms` | Browse all available platforms |
| `pica search <platform> [query]` | Search for actions |
| `pica actions knowledge <id>` | Get API docs for an action |
| `pica exec <id>` | Execute an action |

### CLI options for exec

```bash
pica exec <actionId> \
  -c <connectionKey> \
  -d '{"key": "value"}' \
  -p pathVar=value \
  -q queryParam=value \
  --json
```

All commands support `--json` for machine-readable output.

## Key concepts

- **Connection key**: Identifies which authenticated connection to use. Format: `live::gmail::default::abc123` or `test::gmail::default::abc123`. Get these from `list_pica_integrations` or `pica list`.
- **Action ID**: Identifies a specific API action. Always starts with `conn_mod_def::`. Get these from search results.
- **Platform name**: Kebab-case identifier (e.g., `gmail`, `hubspot`, `google-calendar`, `ship-station`). Get the exact name from `list_pica_integrations`.
- **Passthrough proxy**: All actions route through Pica's proxy which injects auth, handles rate limits, and normalizes responses. You never touch raw OAuth tokens.
- **Pagination**: Some actions return `nextPageToken` or similar. Pass it back in subsequent requests to page through results.

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
1. Search: `platform: "hubspot"` or `"attio"`, query: `"create contact"` / `"list contacts"` / etc.
2. Knowledge: understand required fields
3. Execute with the right data shape

### Calendar
1. Search: `platform: "google-calendar", query: "list events"`
2. Knowledge: understand time format, calendar ID
3. Execute with date range parameters
