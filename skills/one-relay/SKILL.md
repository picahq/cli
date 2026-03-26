---
name: one-relay
description: |
  Set up webhook relay endpoints to receive events from third-party platforms and forward them to other platforms using passthrough actions with Handlebars templates — no middleware, no flows, no code.

  TRIGGER when the user wants to:
  - Receive webhooks from a platform and forward/relay them somewhere
  - Set up event-driven automation between platforms (e.g., "when a Stripe customer is created, send a Slack message")
  - Create webhook endpoints for a connected platform
  - Map webhook event data from one platform to another platform's API
  - List, manage, or debug webhook relay endpoints, events, or deliveries

  DO NOT TRIGGER for:
  - Single action execution without webhooks (use one-actions skill)
  - Multi-step workflows not triggered by webhooks (use one-flow skill)
  - Setting up One or installing MCP (that's `one init`)
  - Adding new connections (that's `one connection add`)
---

# One Webhook Relay

Webhook relay lets you receive webhooks from third-party platforms (Stripe, Shopify, GitHub, etc.) and forward the event data to other platforms using passthrough actions. The passthrough action type maps fields from the incoming webhook payload directly to another platform's API using Handlebars templates — no middleware, no flows, no code needed.

## Supported Platforms

Webhook relay is currently supported for these platforms:

- **Airtable**
- **Attio**
- **GitHub**
- **Google Calendar**
- **Stripe**

Only these platforms can be used as webhook sources. Any connected platform can be a destination via passthrough actions.

## The Workflow

**You MUST follow this process to build a correct relay:**

### Step 1: Discover connections

```bash
one --agent connection list
```

Identify the **source** platform (sends webhooks) and **destination** platform (receives forwarded data). Note both connection keys.

### Step 2: Get event types for the source platform

```bash
one --agent relay event-types <source-platform>
```

See what webhook events the source platform supports. Pick the relevant event type(s).

### Step 3: Get source knowledge — understand the incoming webhook payload

Search for the webhook event to understand what data the source platform sends:

```bash
one --agent actions search <source-platform> "<event description>" -t knowledge
one --agent actions knowledge <source-platform> <actionId>
```

Read the knowledge to understand the webhook payload structure. These fields become `{{payload.*}}` paths in your Handlebars templates.

### Step 4: Get destination knowledge — understand the outgoing API shape

Search for the destination action to understand what data it expects:

```bash
one --agent actions search <dest-platform> "<what you want to do>" -t execute
one --agent actions knowledge <dest-platform> <actionId>
```

Read the knowledge to understand required fields, data types, and request body structure. These become the keys in your passthrough action's `body`.

### Step 5: Create the relay endpoint

```bash
one --agent relay create \
  --connection-key <source-connection-key> \
  --description "Forward <event> from <source> to <dest>" \
  --event-filters '["event.type"]' \
  --create-webhook
```

The `--create-webhook` flag automatically registers the webhook URL with the source platform. The response includes the relay endpoint `id` you need for activation.

### Step 6: Activate with a passthrough action

```bash
one --agent relay activate <relay-id> --actions '[{
  "type": "passthrough",
  "actionId": "<destination-action-id>",
  "connectionKey": "<destination-connection-key>",
  "body": {
    "field": "{{payload.path.to.value}}"
  },
  "eventFilters": ["event.type"]
}]'
```

Map source fields to destination fields using Handlebars templates in the `body`. The template paths come from the source knowledge (Step 3), and the body keys come from the destination knowledge (Step 4).

## Template Context Reference

When a webhook event is received, the following variables are available in Handlebars templates:

| Variable | Type | Description |
|---|---|---|
| `{{relayEventId}}` | UUID | Unique relay event ID |
| `{{platform}}` | String | Source platform (e.g., `stripe`) |
| `{{eventType}}` | String | Webhook event type (e.g., `customer.created`) |
| `{{payload}}` | Object | The full incoming webhook body |
| `{{timestamp}}` | DateTime | When the event was received |
| `{{connectionId}}` | UUID | Source connection UUID |

Access nested fields with dot notation: `{{payload.data.object.email}}`

Use the `{{json payload}}` helper to embed a full object as a JSON string.

## Action Types

Each relay endpoint can have multiple actions. Three types are supported:

### `passthrough` — Forward to another platform's API (primary)

Maps webhook data to another platform's API using Handlebars templates. This is the most powerful action type.

```json
{
  "type": "passthrough",
  "actionId": "<action-id-from-search>",
  "connectionKey": "<destination-connection-key>",
  "body": {
    "channel": "#alerts",
    "text": "New customer: {{payload.data.object.name}} ({{payload.data.object.email}})"
  },
  "eventFilters": ["customer.created"]
}
```

The `body`, `headers`, and `query` fields all support Handlebars templates.

### `url` — Forward raw event to a URL

```json
{
  "type": "url",
  "url": "https://your-app.com/webhooks/handler",
  "secret": "optional-signing-secret",
  "eventFilters": ["customer.created"]
}
```

### `agent` — Send to an agent

```json
{
  "type": "agent",
  "agentId": "<agent-uuid>",
  "eventFilters": ["customer.created"]
}
```

## Complete Example — Stripe customer.created → Slack message

### 1. Get connections

```bash
one --agent connection list
# stripe: live::stripe::default::abc123
# slack:  live::slack::default::xyz789
```

### 2. Get Stripe event types

```bash
one --agent relay event-types stripe
# Returns: ["customer.created", "customer.updated", "payment_intent.succeeded", ...]
```

### 3. Get Slack send message action

```bash
one --agent actions search slack "send message" -t execute
# Returns: actionId "conn_mod_def::GJ7H84zBlaI::BCfuA16aTaGVIax5magsLA"

one --agent actions knowledge slack conn_mod_def::GJ7H84zBlaI::BCfuA16aTaGVIax5magsLA
# Required body: { "channel": "string", "text": "string" }
# Optional: "blocks" for rich formatting
```

### 4. Create the relay

```bash
one --agent relay create \
  --connection-key "live::stripe::default::abc123" \
  --description "Notify Slack on new Stripe customers" \
  --event-filters '["customer.created"]' \
  --create-webhook
# Returns: { "id": "c531d7b8-...", "url": "https://api.withone.ai/v1/webhooks/relay/incoming/stripe/..." }
```

### 5. Activate with Slack passthrough action

```bash
one --agent relay activate c531d7b8-... --actions '[{
  "type": "passthrough",
  "actionId": "conn_mod_def::GJ7H84zBlaI::BCfuA16aTaGVIax5magsLA",
  "connectionKey": "live::slack::default::xyz789",
  "body": {
    "channel": "#alerts",
    "text": "New Stripe customer: {{payload.data.object.name}} ({{payload.data.object.email}})",
    "blocks": [
      {
        "type": "header",
        "text": { "type": "plain_text", "text": ":tada: New Stripe Customer", "emoji": true }
      },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": "*Name:*\n{{payload.data.object.name}}" },
          { "type": "mrkdwn", "text": "*Email:*\n{{payload.data.object.email}}" }
        ]
      },
      {
        "type": "section",
        "fields": [
          { "type": "mrkdwn", "text": "*Customer ID:*\n`{{payload.data.object.id}}`" },
          { "type": "mrkdwn", "text": "*Created:*\n<!date^{{payload.data.object.created}}^{date_short} at {time}|{{payload.data.object.created}}>" }
        ]
      },
      {
        "type": "divider"
      },
      {
        "type": "context",
        "elements": [
          { "type": "mrkdwn", "text": "Via One Webhook Relay · {{platform}}" }
        ]
      }
    ]
  },
  "eventFilters": ["customer.created"]
}]'
```

## Commands Reference

```bash
# Create a relay endpoint
one --agent relay create --connection-key <key> [--description <desc>] [--event-filters <json>] [--create-webhook]

# List all relay endpoints
one --agent relay list [--limit <n>] [--page <n>]

# Get relay endpoint details
one --agent relay get <id>

# Update a relay endpoint (including actions)
one --agent relay update <id> [--actions <json>] [--description <desc>] [--event-filters <json>] [--active] [--no-active]

# Delete a relay endpoint
one --agent relay delete <id>

# Activate a relay endpoint with actions
one --agent relay activate <id> --actions <json> [--webhook-secret <secret>]

# List supported event types for a platform
one --agent relay event-types <platform>

# List received webhook events
one --agent relay events [--platform <p>] [--event-type <t>] [--limit <n>] [--after <iso>] [--before <iso>]

# Get a specific event (includes full payload)
one --agent relay event <id>

# List delivery attempts
one --agent relay deliveries --endpoint-id <id>
one --agent relay deliveries --event-id <id>
```

## Debugging

If a relay isn't working:

1. **Check the endpoint is active:** `one --agent relay get <id>` — verify `active: true` and actions are configured
2. **Check events are arriving:** `one --agent relay events --platform <p> --limit 5` — if no events, the webhook isn't registered with the source platform (use `--create-webhook` on create)
3. **Check delivery status:** `one --agent relay deliveries --event-id <id>` — shows status, status code, and error for each delivery attempt
4. **Inspect the event payload:** `one --agent relay event <id>` — see the full payload to verify your template paths are correct

## Important Notes

- **Always use `--agent` flag** for structured JSON output
- **Always use `--create-webhook`** when creating relay endpoints — it automatically registers the webhook URL with the source platform
- **Always check `actions knowledge`** for both source and destination platforms before building templates — the source knowledge tells you the `{{payload.*}}` paths, the destination knowledge tells you the required body fields
- Platform names are **kebab-case** (e.g., `hub-spot`, not `HubSpot`)
- Connection keys are passed as values, not hardcoded — use the exact keys from `one connection list`
- Event filters on both the endpoint and individual actions must match — if the endpoint filters to `["customer.created"]`, the action's eventFilters should include `"customer.created"`
- Multiple actions can be attached to a single relay endpoint — each can forward to a different platform
- Missing template variables resolve to empty strings — verify your `{{payload.*}}` paths against the actual webhook payload structure
