import { spawn } from 'node:child_process';
import { isAgentMode } from '../../output.js';

const TRANSFORM_TIMEOUT_MS = 60_000;

/**
 * Pipe a page of records through a shell command (or flow) and return the
 * transformed records.
 *
 * Protocol:
 * - stdin:  JSON array of records
 * - stdout: JSON array of transformed records
 * - stderr: forwarded to process.stderr (visible in logs)
 *
 * On failure (bad exit code, invalid JSON, timeout) returns null — the
 * caller should fall back to the original records and log a warning.
 */
export async function transformRecords(
  command: string,
  records: Record<string, unknown>[],
): Promise<Record<string, unknown>[] | null> {
  const input = JSON.stringify(records);

  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      if (!isAgentMode()) {
        process.stderr.write(`  Transform timed out after ${TRANSFORM_TIMEOUT_MS / 1000}s — using original records\n`);
      }
      resolve(null);
    }, TRANSFORM_TIMEOUT_MS);

    child.on('exit', (code) => {
      clearTimeout(timer);

      // Forward stderr to the process so it shows in cron logs / human output
      if (stderr.trim() && !isAgentMode()) {
        process.stderr.write(`  Transform stderr: ${stderr.trim()}\n`);
      }

      if (code !== 0) {
        if (!isAgentMode()) {
          process.stderr.write(`  Transform exited with code ${code} — using original records\n`);
        }
        resolve(null);
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (!Array.isArray(parsed)) {
          if (!isAgentMode()) {
            process.stderr.write(`  Transform returned non-array JSON — using original records\n`);
          }
          resolve(null);
          return;
        }
        resolve(parsed as Record<string, unknown>[]);
      } catch {
        if (!isAgentMode()) {
          process.stderr.write(`  Transform returned invalid JSON — using original records\n`);
        }
        resolve(null);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!isAgentMode()) {
        process.stderr.write(`  Transform failed to start: ${err.message} — using original records\n`);
      }
      resolve(null);
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
