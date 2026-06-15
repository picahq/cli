import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { actionsExecuteCommand, actionsExecuteParallelCommand } from './actions.js';

// Contract lock for the execute "_preflight" field: agent-mode execute and
// execute --parallel must report whether the action-details preflight was
// served from cache. These run the real command functions in-process against
// a throwaway HTTP server, with $HOME sandboxed so the cache lives in a temp dir.

const ACTION_ID = 'conn_mod_def::TEST::send';

const ACTION = {
  _id: ACTION_ID,
  title: 'Send',
  tags: [] as string[],
  knowledge: '# Send',
  path: '/v1/things/send',
  method: 'POST',
  ioSchema: { inputSchema: { properties: {} }, ioExample: { output: { ok: true } } },
};

interface Harness {
  server: http.Server;
  port: number;
  counts: { knowledge: number; passthrough: number };
}

function startServer(): Promise<Harness> {
  const counts = { knowledge: 0, passthrough: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/v1/knowledge') {
      counts.knowledge++;
      res.setHeader('content-type', 'application/json');
      res.setHeader('etag', '"send-v1"');
      res.end(JSON.stringify({ rows: [ACTION] }));
      return;
    }
    if (url.pathname.startsWith('/v1/passthrough/')) {
      counts.passthrough++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port, counts });
    });
  });
}

describe('execute _preflight contract (agent mode)', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalAgent: string | undefined;
  let originalArgv: string[];
  let originalWrite: typeof process.stdout.write;
  let originalExit: typeof process.exit;
  let lines: string[];
  let harness: Harness;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    originalAgent = process.env.ONE_AGENT;
    originalArgv = process.argv;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-preflight-test-'));
    process.env.HOME = tmpHome;
    process.env.ONE_AGENT = '1';

    harness = await startServer();
    fs.mkdirSync(path.join(tmpHome, '.one'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.one', 'config.json'),
      JSON.stringify({ apiKey: 'sk_test', apiBase: `http://localhost:${harness.port}` })
    );

    // Capture agent-mode JSON (output.json writes one line to stdout). Forward
    // everything through so the test reporter — which shares this stdout — still
    // prints; only stash JSON-object lines for assertions.
    lines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      const s = typeof chunk === 'string' ? chunk : String(chunk);
      // Capture (and swallow) agent-mode JSON; forward everything else so the
      // test reporter, which shares this stdout, still prints normally.
      if (s.trim().startsWith('{')) { lines.push(s); return true; }
      return (originalWrite as any)(chunk, ...rest);
    }) as typeof process.stdout.write;

    // Any process.exit during a success path is a bug — surface it as a throw.
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`unexpected process.exit(${code})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
    process.argv = originalArgv;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalAgent === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = originalAgent;
    harness.server.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function lastJson(): any {
    const jsonLines = lines.filter((l) => l.trim().startsWith('{'));
    return JSON.parse(jsonLines[jsonLines.length - 1]);
  }

  it('reports cache:miss on the first execute and cache:hit on the second', async () => {
    await actionsExecuteCommand('plat', ACTION_ID, 'plat::key', { skipValidation: true });
    const first = lastJson();
    assert.deepEqual(first._preflight, { cache: 'miss' });
    assert.equal(harness.counts.knowledge, 1);

    lines = [];
    await actionsExecuteCommand('plat', ACTION_ID, 'plat::key', { skipValidation: true });
    const second = lastJson();
    assert.deepEqual(second._preflight, { cache: 'hit' });
    // No extra /knowledge round trip on the warm execute.
    assert.equal(harness.counts.knowledge, 1);
  });

  it('reports cache:miss in --mock execute output too', async () => {
    await actionsExecuteCommand('plat', ACTION_ID, 'plat::key', { skipValidation: true, mock: true });
    const out = lastJson();
    assert.equal(out.mock, true);
    assert.deepEqual(out._preflight, { cache: 'miss' });
  });

  it('--parallel reports _preflight per segment: same action twice → [miss, hit]', async () => {
    // The preflight loop runs segments sequentially, so segment 1 warms the
    // cache and segment 2 hits it — one call exercises both states.
    process.argv = [
      'node', 'one', 'actions', 'execute', '--parallel', '--skip-validation',
      'plat', ACTION_ID, 'plat::key1', '-d', '{}',
      '--', 'plat', ACTION_ID, 'plat::key2', '-d', '{}',
    ];

    await actionsExecuteParallelCommand();

    const out = lastJson();
    assert.equal(out.parallel, true);
    assert.equal(out.results.length, 2);
    assert.deepEqual(out.results[0]._preflight, { cache: 'miss' });
    assert.deepEqual(out.results[1]._preflight, { cache: 'hit' });
    assert.equal(harness.counts.knowledge, 1);
  });
});
