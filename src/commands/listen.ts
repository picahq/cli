import pc from 'picocolors';
import { getApiBase, getApiKey } from '../lib/config.js';
import { ListenClient, type ListenStatus } from '../lib/listen-client.js';
import { resolveListenTarget } from '../lib/listen.js';
import { createOneSocketFactory } from '../lib/listen-socket.js';
import * as output from '../lib/output.js';

export async function listenCommand(options: {
  forwardTo?: string;
  source?: string;
  events?: string;
}): Promise<void> {
  const apiKey = getApiKey();
  const resolved = resolveListenTarget(options, { apiKey, apiBase: getApiBase() });
  if (!resolved.ok) {
    output.error(resolved.error);
  }
  const { url, forwardTo, source } = resolved.target;

  const agent = output.isAgentMode();

  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const client = new ListenClient({
    url,
    forwardTo,
    createSocket: createOneSocketFactory(apiKey as string),
    onStatus: (status: ListenStatus) => {
      if (status === 'closed') resolveDone();
      if (agent) {
        output.json({ event: 'status', status });
        return;
      }
      if (status === 'open') {
        console.log(pc.green(`  Ready — forwarding ${source} events to ${forwardTo}\n`));
      } else if (status === 'reconnecting') {
        console.log(pc.yellow('  Connection lost — reconnecting…'));
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (agent) {
        output.json({ event: 'error', message });
      } else {
        console.log(pc.red(`  Connection error: ${message}`));
      }
    },
    onReady: (sessionId, scope) => {
      if (agent) {
        output.json({ event: 'ready', sessionId, scope });
      } else {
        console.log(pc.dim(`  Session ${sessionId}${scope ? ` · ${scope}` : ''}`));
      }
    },
    onEvent: (event, response) => {
      if (agent) {
        output.json({ event: 'forwarded', id: event.id, type: event.eventType, source: event.source, status: response.status });
        return;
      }
      const label = event.platform ? `${event.platform} ${event.eventType ?? ''}`.trim() : event.eventType ?? event.source;
      const code =
        response.status === 0
          ? pc.red('unreachable')
          : response.status < 400
            ? pc.green(String(response.status))
            : pc.red(String(response.status));
      console.log(`  ${pc.dim(new Date().toLocaleTimeString())}  ${pc.cyan(label)}  →  ${code}`);
    },
  });

  if (!agent) {
    output.intro('one listen');
    console.log(pc.dim(`  Streaming ${source} events → ${forwardTo}`));
    console.log(pc.dim('  Local delivery is best-effort (no retries); Press Ctrl-C to stop.\n'));
  }

  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.start();
  await done;
  output.error('Listen connection closed — check your API key and that the listen endpoint is reachable.');
}
