// Static metadata for platform capabilities, demo actions, and cross-platform workflow examples.

export const PLATFORM_DEMO_ACTIONS: Record<string, { query: string; description: string }> = {
  gmail: { query: 'list messages', description: 'Search for recent emails' },
  'google-calendar': { query: 'list events', description: "Check today's schedule" },
  slack: { query: 'list channels', description: 'List Slack channels' },
  shopify: { query: 'list orders', description: 'List recent orders' },
  'hub-spot': { query: 'list contacts', description: 'Search CRM contacts' },
  github: { query: 'list repositories', description: 'List repos' },
  notion: { query: 'list pages', description: 'List Notion pages' },
  stripe: { query: 'list payments', description: 'List recent payments' },
  salesforce: { query: 'list accounts', description: 'List Salesforce accounts' },
  jira: { query: 'list issues', description: 'List Jira issues' },
  linear: { query: 'list issues', description: 'List Linear issues' },
  asana: { query: 'list tasks', description: 'List Asana tasks' },
  intercom: { query: 'list conversations', description: 'List Intercom conversations' },
  zendesk: { query: 'list tickets', description: 'List Zendesk tickets' },
  quickbooks: { query: 'list invoices', description: 'List QuickBooks invoices' },
  twilio: { query: 'list messages', description: 'List Twilio messages' },
};

// Cross-platform workflow examples keyed by sorted platform pair (e.g. "gmail+google-calendar")
const WORKFLOW_EXAMPLES: Record<string, string> = {
  'gmail+google-calendar': 'Check my calendar for today and draft a summary email',
  'gmail+shopify': 'Find unfulfilled orders and email each customer an update',
  'hub-spot+slack': 'Find deals closing this week and post a summary to Slack',
  'github+slack': 'List open PRs and post a review reminder to #engineering',
  'gmail+stripe': 'Find failed payments this week and send retry reminder emails',
  'gmail+hub-spot': 'Find new CRM contacts and send them a welcome email',
  'notion+slack': 'Summarize recent Notion updates and post to a Slack channel',
  'github+jira': 'Link recent commits to Jira issues and update their status',
  'google-calendar+slack': "Post today's meeting schedule to a Slack channel",
  'asana+slack': 'Post overdue Asana tasks to Slack as reminders',
};

function pairKey(a: string, b: string): string {
  return [a, b].sort().join('+');
}

export function getWorkflowExamples(connectedPlatforms: string[]): string[] {
  const results: string[] = [];
  const platforms = connectedPlatforms.map(p => p.toLowerCase());

  for (let i = 0; i < platforms.length; i++) {
    for (let j = i + 1; j < platforms.length; j++) {
      const key = pairKey(platforms[i], platforms[j]);
      const example = WORKFLOW_EXAMPLES[key];
      if (example) {
        results.push(example);
      }
    }
  }

  // If no matches from connected platforms, return a few popular examples
  if (results.length === 0) {
    return [
      'Gmail + Calendar: "Check my calendar for today and draft a summary email"',
      'Shopify + Gmail: "Find unfulfilled orders and email each customer an update"',
      'HubSpot + Slack: "Find deals closing this week and post a summary to Slack"',
      'GitHub + Slack: "List open PRs and post a review reminder to #engineering"',
      'Stripe + Gmail: "Find failed payments this week and send retry reminder emails"',
    ];
  }

  return results;
}
