import fs from 'node:fs';
import path from 'node:path';

/**
 * Cross-process sync lock for a single platform/model.
 *
 * Uses fs.mkdirSync (atomic on POSIX and Windows — it throws EEXIST if the
 * directory already exists) so two processes can't both think they hold the
 * lock. This protects against a long-running cron tick overlapping with a
 * manual `sync run` invocation, or two cron ticks racing on a >1m sync.
 *
 * Stale-lock protection: if the lock is older than STALE_MS and its pid no
 * longer maps to a live process, we assume a crashed owner and take over.
 */

const LOCK_DIR_REL = path.join('.one', 'sync', 'locks');
const STALE_MS = 30 * 60 * 1000; // 30 minutes

export interface SyncLock {
  release(): void;
}

function lockPath(platform: string, model: string): string {
  return path.join(LOCK_DIR_REL, `${platform}_${model}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 probes without actually killing anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SyncLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncLockError';
  }
}

/**
 * Attempt to acquire a lock for (platform, model). Throws SyncLockError if
 * another process already holds it.
 */
export function acquireSyncLock(platform: string, model: string): SyncLock {
  fs.mkdirSync(LOCK_DIR_REL, { recursive: true });
  const dir = lockPath(platform, model);
  const pidFile = path.join(dir, 'pid');

  try {
    fs.mkdirSync(dir);
  } catch (err) {
    // EEXIST means someone else holds the lock — check whether it's stale
    const stat = (() => {
      try { return fs.statSync(dir); } catch { return null; }
    })();

    if (stat) {
      const age = Date.now() - stat.mtimeMs;
      let ownerPid: number | null = null;
      try {
        const raw = fs.readFileSync(pidFile, 'utf-8');
        const parsed = parseInt(raw.trim(), 10);
        if (!isNaN(parsed)) ownerPid = parsed;
      } catch {
        // no pid file — treat as unknown owner
      }

      const ownerDead = ownerPid !== null && !isProcessAlive(ownerPid);
      const veryOld = age > STALE_MS;

      if (ownerDead || veryOld) {
        // Take over the stale lock
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          fs.mkdirSync(dir);
        } catch {
          throw new SyncLockError(
            `Could not take over stale lock at ${dir}. Remove it manually if no sync is running.`
          );
        }
      } else {
        const ownerMsg = ownerPid !== null ? ` (held by pid ${ownerPid})` : '';
        throw new SyncLockError(
          `Another sync for ${platform}/${model} is already running${ownerMsg}. ` +
          `Wait for it to finish, or remove ${dir} manually if you're sure it's stale.`
        );
      }
    } else {
      throw new SyncLockError(`Failed to acquire sync lock: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    fs.writeFileSync(pidFile, String(process.pid));
  } catch {
    // Non-fatal — lock still held by the directory itself
  }

  return {
    release() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort; a stale directory will be cleaned up on the next run
      }
    },
  };
}
