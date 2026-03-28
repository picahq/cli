# One Webhook Relay

Webhook relay receives webhooks from a source platform and forwards the event data to a destination platform using passthrough actions with Handlebars templates — no middleware, no code needed.

## Supported Source Platforms

Only these platforms can send webhooks: **Airtable**, **Attio**, **GitHub**, **Google Calendar**, **Stripe**. Any connected platform can be a destination.

## Workflow

### Step 1: Discover connections

```bash
one --agent connection list
```

Identify source (sends webhooks) and destination (receives forwarded data). Note both connection keys.

### Step 2: Get event types

```bash
one --agent relay event-types <source-platform>
```

### Step 3: Get source knowledge (understand the incoming payload)

```bash
one --agent actions search <source-platform> "<event description>" -t knowledge
one --agent actions knowledge <source-platform> <actionId>
```

The knowledge tells you the webhook payload structure — these fields become `{{payload.*}}` in your templates.

### Step 4: Get destination knowledge (understand the outgoing API)

```bash
one --agent actions search <dest-platform> "<what you want to do>" -t execute
one --agent actions knowledge <dest-platform> <actionId>
```

The knowledge tells you required body fields — these become the keys in your passthrough action's `body`.

### Step 5: Create the relay endpoint

```bash
one --agent relay create \
  --connection-key <source-connection-key> \
  --description "Forward <event> from <source> to <dest>" \
  --event-filters '["event.type"]' \
  --create-webhook
```

Always use `--create-webhook` — it registers the webhook URL with the source platform automatically.

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

## Template Context

| Variable | Description |
|---|---|
| `{{relayEventId}}` | Unique relay event ID |
| `{{platform}}` | Source platform name |
| `{{eventType}}` | Webhook event type |
| `{{payload}}` | Full incoming webhook body |
| `{{timestamp}}` | When event was received |
| `{{connectionId}}` | Source connection UUID |

Access nested fields with dot notation: `{{payload.data.object.email}}`

Use `{{json payload}}` to embed a full object as a JSON string.

## Action Types

### `passthrough` — Forward to another platform's API (primary)

```json
{
  "type": "passthrough",
  "actionId": "<action-id>",
  "connectionKey": "<dest-connection-key>",
  "body": { "channel": "#alerts", "text": "New: {{payload.data.object.name}}" },
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

## Complete Example: Stripe customer.created -> Slack message

```bash
# 1. Get connections
one --agent connection list
# stripe: live::stripe::default::abc123, slack: live::slack::default::xyz789

# 2. Get event types
one --agent relay event-types stripe

# 3. Get Slack send message action
one --agent actions search slack "send message" -t execute
one --agent actions knowledge slack <actionId>

# 4. Create relay
one --agent relay create \
  --connection-key "live::stripe::default::abc123" \
  --description "Notify Slack on new Stripe customers" \
  --event-filters '["customer.created"]' \
  --create-webhook

# 5. Activate
one --agent relay activate <relay-id> --actions '[{
  "type": "passthrough",
  "actionId": "<slack-send-message-action-id>",
  "connectionKey": "live::slack::default::xyz789",
  "body": {
    "channel": "#alerts",
    "text": "New Stripe customer: {{payload.data.object.name}} ({{payload.data.object.email}})"
  },
  "eventFilters": ["customer.created"]
}]'
```

## Management Commands

```bash
one --agent relay list [--limit <n>] [--page <n>]
one --agent relay get <id>
one --agent relay update <id> [--actions <json>] [--description <desc>]
one --agent relay delete <id>
one --agent relay events [--platform <p>] [--event-type <t>] [--limit <n>]
one --agent relay event <id>
one --agent relay deliveries --endpoint-id <id>
one --agent relay deliveries --event-id <id>
```

## Debugging

1. Check endpoint is active: `one --agent relay get <id>` — verify `active: true`
2. Check events arriving: `one --agent relay events --platform <p> --limit 5`
3. Check delivery status: `one --agent relay deliveries --event-id <id>`
4. Inspect payload: `one --agent relay event <id>` — verify template paths

## Important Notes

- Event filters on both the endpoint and individual actions must match
- Multiple actions can be attached to a single relay endpoint
- Missing template variables resolve to empty strings — verify `{{payload.*}}` paths against the actual payload
