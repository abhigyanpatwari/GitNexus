/**
 * Real cross-process test for the index write lock (#2658): a child process
 * holds the lock while this process tries to acquire the same directory.
 *
 *  - mutual exclusion: while the child holds it, our acquire blocks and times
 *    out (never steals a live holder).
 *  - kill recovery: after the child is SIGKILLed, our next acquire reclaims the
 *    now-dead holder's lock and succeeds.
 *
 * The child imports the BUILT module (dist/) and this process imports the
 * source — proving the on-disk record is interoperable, and that the guarantee
 * is a genuine cross-process one rather than same-process bookkeeping.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireIndexLock, IndexLockTimeoutError } from '../../src/storage/index-lock.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const lockModule = path.join(repoRoot, 'dist', 'storage', 'index-lock.js');
const childScript = path.resolve(testDir, '..', 'fixtures', 'index-lock-child.mjs');

let dir: string;
let marker: string;
let child: ChildProcess | undefined;

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met within timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

const waitForExit = (proc: ChildProcess, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-lock-xp-'));
  marker = path.join(dir, 'held.marker');
});
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('index lock across processes (#2658)', () => {
  it('excludes a second writer while held, then recovers after the holder is killed', async () => {
    if (!existsSync(lockModule)) {
      throw new Error(
        `dist/storage/index-lock.js missing — run \`npm run build\` first ` +
          `(or use \`npm run test:integration\`, which builds via pretest:integration).`,
      );
    }

    child = spawn(process.execPath, [childScript], {
      env: { ...process.env, LOCK_MODULE: lockModule, LOCK_DIR: dir, MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(() => existsSync(marker), 15_000);
    const holderPid = Number(readFileSync(marker, 'utf8'));
    expect(holderPid).toBeGreaterThan(0);

    // Mutual exclusion: the live holder is waited on, then we time out.
    await expect(acquireIndexLock(dir, { timeoutMs: 500, pollMs: 25 })).rejects.toBeInstanceOf(
      IndexLockTimeoutError,
    );

    // Kill recovery: with the holder gone, its lock becomes reclaimable.
    child.kill('SIGKILL');
    await waitForExit(child, 10_000);
    const lock = await acquireIndexLock(dir, { timeoutMs: 5_000, pollMs: 25 });
    expect(lock.record.pid).toBe(process.pid);
    lock.release();
  }, 30_000);

  it('lets multiple waiters reclaim one dead holder without ever admitting two writers', async () => {
    if (!existsSync(lockModule)) {
      throw new Error(
        `dist/storage/index-lock.js missing — run \`npm run build\` first ` +
          `(or use \`npm run test:integration\`, which builds via pretest:integration).`,
      );
    }
    // Seed a stale lock owned by a dead, same-host holder — every child must
    // reclaim it, and the atomic steal must let exactly one at a time win so
    // no two children are ever in their O_EXCL sentinel section together.
    const deadRecord = {
      v: 1,
      pid: 999_999_999,
      hostname: os.hostname(),
      startTime: null,
      token: 'dead-holder-token',
      invocationId: 'dead-holder',
      acquiredAt: new Date(0).toISOString(),
    };
    writeFileSync(path.join(dir, 'analyze.lock'), JSON.stringify(deadRecord));
    const sentinel = path.join(dir, 'critical.sentinel');

    const runChild = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [childScript], {
          env: {
            ...process.env,
            LOCK_MODULE: lockModule,
            LOCK_DIR: dir,
            SENTINEL: sentinel,
            MODE: 'EXCLUSIVE',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        c.once('exit', (code, signal) => resolve({ code, signal }));
      });

    const results = await Promise.all([runChild(), runChild(), runChild(), runChild()]);
    // Every child acquired, ran its exclusive section, and exited cleanly (0).
    // Exit 3 = it found the sentinel already present = two holders at once.
    for (const r of results) {
      expect(r.signal).toBeNull();
      expect(r.code).toBe(0);
    }
    // No leftover sentinel — the last holder cleaned up.
    expect(existsSync(sentinel)).toBe(false);
  }, 30_000);
});
