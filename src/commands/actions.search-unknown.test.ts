import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { actionsSearchCommand } from './actions.js';
import { searchCachePath } from '../lib/cache.js';
import { setHomeTo, snapshotHomeEnv, restoreHomeEnv, type HomeEnvSnapshot } from '../test-support/home.js';

interface Harness {
  server: http.Server;
  port: number;
  counts: { search: number; connectors: number };
}

function startServer(opts: { platforms: string[]; searchHits: boolean }): Promise<Harness> {
  const counts = { search: 0, connectors: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/v1/available-actions/search/')) {
      counts.search++;
      res.setHeader('content-type', 'application/json');
      if (opts.searchHits) {
        res.end(JSON.stringify([{
          systemId: 'gmail::send',
          title: 'Send email',
          method: 'POST',
          path: '/gmail/v1/users/{userId}/messages/send',
        }]));
      } else {
        res.end('[]');
      }
      return;
    }
    if (url.pathname === '/v1/available-connectors') {
      counts.connectors++;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        rows: opts.platforms.map((p, i) => ({
          id: i + 1,
          name: p === 'gmail' ? 'Gmail' : p,
          key: p,
          platform: p,
          category: 'Other',
        })),
        total: opts.platforms.length,
        pages: 1,
        page: 1,
      }));
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

describe('actions search unknown platform (agent mode)', () => {
  let tmpHome: string;
  let originalHome: HomeEnvSnapshot;
  let originalAgent: string | undefined;
  let originalWrite: typeof process.stdout.write;
  let originalExit: typeof process.exit;
  let lines: string[];
  let exitCode: number | undefined;
  let harness: Harness;

  beforeEach(() => {
    originalHome = snapshotHomeEnv();
    originalAgent = process.env.ONE_AGENT;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'one-cli-search-unknown-'));
    setHomeTo(tmpHome);
    process.env.ONE_AGENT = '1';

    lines = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: any, ...rest: any[]) => {
      const s = typeof chunk === 'string' ? chunk : String(chunk);
      if (s.trim().startsWith('{')) { lines.push(s); return true; }
      return (originalWrite as any)(chunk, ...rest);
    }) as typeof process.stdout.write;

    exitCode = undefined;
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error(`process.exit(${exitCode})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.exit = originalExit;
    restoreHomeEnv(originalHome);
    if (originalAgent === undefined) delete process.env.ONE_AGENT; else process.env.ONE_AGENT = originalAgent;
    harness?.server.close();
    fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function lastJson(): any {
    const jsonLines = lines.filter((l) => l.trim().startsWith('{'));
    return JSON.parse(jsonLines[jsonLines.length - 1]);
  }

  function writeConfig(port: number) {
    fs.mkdirSync(path.join(tmpHome, '.one'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpHome, '.one', 'config.json'),
      JSON.stringify({ apiKey: 'sk_test', apiBase: `http://localhost:${port}` })
    );
  }

  it('exits 1 with error+similar and does not cache a misspelled platform', async () => {
    harness = await startServer({ platforms: ['gmail'], searchHits: false });
    writeConfig(harness.port);

    await assert.rejects(
      () => actionsSearchCommand('bogus-platform-xyz', 'test', { type: 'execute' }),
      /process\.exit\(1\)/
    );

    const out = lastJson();
    assert.equal(out.error, 'Unknown platform "bogus-platform-xyz"');
    assert.ok(Array.isArray(out.similar));
    assert.equal(exitCode, 1);
    assert.equal(harness.counts.connectors, 1);

    const cachePath = searchCachePath('bogus-platform-xyz', 'test', 'execute');
    assert.equal(fs.existsSync(cachePath), false);
  });

  it('exit 0 with empty actions when the platform exists and the query matches nothing', async () => {
    harness = await startServer({ platforms: ['gmail'], searchHits: false });
    writeConfig(harness.port);

    await actionsSearchCommand('gmail', 'zzzz-no-such-action', { type: 'execute' });

    const out = lastJson();
    assert.equal(out.error, undefined);
    assert.deepEqual(out.actions, []);
    assert.equal(exitCode, undefined);
  });

  it('does not consult the catalog when search returns hits', async () => {
    harness = await startServer({ platforms: ['gmail'], searchHits: true });
    writeConfig(harness.port);

    await actionsSearchCommand('gmail', 'send email', { type: 'execute' });

    const out = lastJson();
    assert.equal(out.actions.length, 1);
    assert.equal(out.actions[0].actionId, 'gmail::send');
    assert.equal(harness.counts.connectors, 0);
    assert.equal(exitCode, undefined);
  });
});
