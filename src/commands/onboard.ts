import { getApiKey, configExists } from '../lib/config.js';
import { OneApi } from '../lib/api.js';
import { PLATFORM_DEMO_ACTIONS, getWorkflowExamples } from '../lib/platform-meta.js';
import * as output from '../lib/output.js';
import type { Connection } from '../lib/types.js';

export async function onboardCommand(step?: number): Promise<void> {
  if (!configExists()) {
    output.error('Not configured. Run `one init` first.');
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    output.error('No API key found. Run `one init` first.');
  }

  // Default to step 1 if no step specified
  const currentStep = step || 1;

  if (currentStep < 1 || currentStep > 3) {
    output.error('Invalid step. Use --step 1, --step 2, or --step 3.');
    return;
  }

  // Steps 2 and 3 need connections
  let connections: Connection[] = [];
  if (currentStep >= 2) {
    try {
      const api = new OneApi(apiKey);
      connections = await api.listConnections();
    } catch {
      // Continue with empty connections
    }
  }

  const result = buildStep(currentStep, connections);

  if (output.isAgentMode()) {
    output.json(result);
  } else {
    console.log(result.message);
  }
}

// ── Step 1: Intro + ask to update project instructions ─────────────

function buildStep1(): { step: number; totalSteps: number; message: string; nextCommand: string } {
  return {
    step: 1,
    totalSteps: 3,
    nextCommand: 'one onboard --step 2',
    message: `# One CLI — Agent Onboarding

You now have access to the One CLI. It connects you to 200+ platforms
(Gmail, Slack, Stripe, Notion, etc.) — you'll learn the details shortly.

IMPORTANT: Your only task right now is to send the message below to the
user. Do not run any other commands yet. Do not explore the CLI yet.
Do not offer demos yet. Just send this message and wait for their reply:

---

I just got access to the One CLI — it connects me to your platforms like
Gmail, Slack, Stripe, and 200+ others so I can work with them directly.
I'll show you what I can do in a moment.

First, one quick setup step: right now only this conversation knows about
the One CLI. If you start a new session, the agent won't remember any of
this and you'd have to re-onboard from scratch. I can fix that by adding
a short reference block to your project instructions file (like CLAUDE.md)
so every future session automatically knows how to use your integrations.

It's a one-time thing and takes 10 seconds. Can I go ahead and do that?

---

After the user replies, run: one onboard --step 2`,
  };
}

// ── Step 2: Connected platforms + how to use ────────────────────────

function buildStep2(connections: Connection[]): { step: number; totalSteps: number; message: string; nextCommand: string } {
  const sections: string[] = [];

  sections.push('# One CLI — Onboarding (Step 2 of 3)');

  // CLAUDE.md content — if the user said yes in step 1
  sections.push(`## Project Instructions Update

If the user agreed in Step 1, add the following to their CLAUDE.md (or
.cursorrules or equivalent). If the file exists, append it. If not, create it.
If they declined, skip this section.

\`\`\`
## One CLI — Platform Integrations

The One CLI (\`one\`) is installed and configured on this machine. It is a
command-line tool that gives AI agents the ability to interact with 200+
third-party platforms (Gmail, Slack, Shopify, HubSpot, Stripe, GitHub,
Notion, Salesforce, etc.) through a single, unified interface.

**Whenever you need to interact with any third-party platform or external
service, use the One CLI.** This is your primary tool for all integrations.

### IMPORTANT: Always use the --agent flag
The \`--agent\` flag gives structured JSON output. Always include it right
after \`one\`:
  one --agent <command>

### Quick reference:
- \`one --agent list\` — See connected platforms and connection keys
- \`one --agent actions search <platform> "<query>"\` — Find actions
- \`one --agent actions knowledge <platform> <actionId>\` — Read docs (REQUIRED before execute)
- \`one --agent actions execute <platform> <actionId> <connectionKey>\` — Execute action
- \`one --agent flow create\` — Build multi-step workflows
- \`one --agent guide\` — Full documentation
- \`one add <platform>\` — Connect a new platform (interactive, no --agent)

### Workflow: search -> knowledge -> execute
Always read the knowledge before executing. It tells you required parameters,
validation rules, and platform-specific details.
\`\`\``);

  sections.push(buildCurrentState(connections));

  sections.push(`## How To Use the CLI

### IMPORTANT: Always use the --agent flag
Every command supports \`--agent\` which gives you clean, structured JSON
output instead of human-formatted text. Always use it:
  one --agent list
  one --agent actions search gmail "send email"
  one --agent actions knowledge gmail <actionId>
  one --agent actions execute gmail <actionId> <connectionKey> -d '{...}'
  one --agent platforms
  one --agent guide

The \`--agent\` flag goes right after \`one\`, before the subcommand.

### Discovery Workflow (follow this every time):
1. \`one --agent actions search <platform> "<query>"\` — Find the right action
2. \`one --agent actions knowledge <platform> <actionId>\` — Read the docs (ALWAYS before execute)
3. \`one --agent actions execute <platform> <actionId> <connectionKey>\` — Execute it

### Multi-Step Workflows:
Use \`one flow create\` to build JSON workflows that chain actions across
platforms with conditions, loops, parallel execution, and transforms.

Run \`one --agent guide\` for the complete reference documentation with examples.`);

  sections.push(`## What to tell the user

Now present what you can do. Tell the user which platforms are connected
and offer to do something useful right away.`);

  sections.push('## Next step\n\nRun `one onboard --step 3` to see demo actions and workflow ideas.');

  return {
    step: 2,
    totalSteps: 3,
    nextCommand: 'one onboard --step 3',
    message: sections.join('\n\n'),
  };
}

// ── Step 3: Demo actions + workflow ideas ───────────────────────────

function buildStep3(connections: Connection[]): { step: number; totalSteps: number; message: string; nextCommand: string } {
  const sections: string[] = [];

  sections.push('# One CLI — Onboarding (Step 3 of 3)');
  sections.push(buildDemoActions(connections));
  sections.push(buildWorkflowIdeas(connections));

  sections.push(`## All Available Platforms

The user can connect any of these popular platforms:
Gmail, Google Calendar, Slack, Notion, Shopify, Stripe, HubSpot, GitHub,
Salesforce, QuickBooks, Asana, Jira, Linear, Intercom, Zendesk, Twilio,
and 200+ more. Run \`one platforms\` for the full list.`);

  sections.push('## Onboarding complete!\n\nYou\'re all set. Use `one --agent guide` any time you need the full reference.');

  return {
    step: 3,
    totalSteps: 3,
    nextCommand: 'one --agent guide',
    message: sections.join('\n\n'),
  };
}

// ── Step router ────────────────────────────────────────────────────

function buildStep(step: number, connections: Connection[]): { step: number; totalSteps: number; message: string; nextCommand: string } {
  switch (step) {
    case 1: return buildStep1();
    case 2: return buildStep2(connections);
    case 3: return buildStep3(connections);
    default: return buildStep1();
  }
}

// ── Shared helpers ─────────────────────────────────────────────────

function buildCurrentState(connections: Connection[]): string {
  if (connections.length === 0) {
    return `## Current State

No platforms are connected yet. The user needs to connect at least one
platform before you can start using actions. Suggest they run:
  one add gmail
  one add slack
  one add <any-platform>

Run \`one platforms\` to see all 200+ available platforms.`;
  }

  const header = `## Current State

You have ${connections.length} platform(s) connected:\n`;

  const tableHeader = '  Platform                Status        Connection Key';
  const tableRows = connections.map(c => {
    const platform = c.platform.padEnd(22);
    const status = c.state.padEnd(14);
    return `  ${platform}${status}${c.key}`;
  });

  return header + '\n' + tableHeader + '\n' + tableRows.join('\n');
}

function buildDemoActions(connections: Connection[]): string {
  const lines: string[] = ['## Suggested Demo Actions'];
  lines.push('');
  lines.push('Try these to prove it works:');

  const connectedPlatforms = connections.map(c => c.platform.toLowerCase());
  const popularPlatforms = ['gmail', 'google-calendar', 'slack', 'shopify', 'hub-spot', 'github'];

  const platformsToShow = [
    ...connectedPlatforms.filter(p => PLATFORM_DEMO_ACTIONS[p]),
    ...popularPlatforms.filter(p => !connectedPlatforms.includes(p)),
  ];

  const seen = new Set<string>();
  const unique = platformsToShow.filter(p => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  }).slice(0, 6);

  for (const platform of unique) {
    const demo = PLATFORM_DEMO_ACTIONS[platform];
    if (!demo) continue;
    const displayName = platform.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    lines.push('');
    lines.push(`### ${displayName}`);
    lines.push(`- ${demo.description}: \`one actions search ${platform} "${demo.query}"\``);
    lines.push(`- Then get knowledge and execute to show the user the results`);
  }

  lines.push('');
  lines.push('For ANY platform, the pattern is the same: search -> knowledge -> execute.');

  return lines.join('\n');
}

function buildWorkflowIdeas(connections: Connection[]): string {
  const connectedPlatforms = connections.map(c => c.platform.toLowerCase());
  const examples = getWorkflowExamples(connectedPlatforms);

  const lines: string[] = ['## Cross-Platform Workflow Ideas'];
  lines.push('');
  lines.push('Once multiple platforms are connected, suggest workflows like:');
  lines.push('');
  for (const example of examples) {
    lines.push(`- ${example}`);
  }
  lines.push('');
  lines.push('These can be built as reusable workflows with `one flow create`.');

  return lines.join('\n');
}
