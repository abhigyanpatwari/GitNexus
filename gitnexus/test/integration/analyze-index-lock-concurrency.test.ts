/**
 * Real cross-process tests for the index write lock (#2658): child processes
 * contend for the lock on the same directory as this process.
 *
 *  - Test 1 exercises the DEFAULT backend (the OS socket/pipe lock on
 *    Linux/Windows): while the child holds it, our acquire blocks and times out;
 *    after the child is SIGKILLed the kernel drops the binding and our next
 *    acquire succeeds — the kernel-auto-release guarantee, no stale handling.
 *  - Test 2 pins the FILE backend and races several children reclaiming one dead
 *    holder, asserting the atomic rename-steal never lets two into the critical
 *    section at once.
 *
 * The child imports the BUILT module (dist/) and this process imports the
 * source, proving the guarantee is a genuine cross-process one (and, for the
 * socket backend, that both derive the same endpoint name for a given dir).
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
    // This case targets the FILE backend's reclaim path specifically (the socket
    // backend has no stale file to reclaim). Seed a stale lock owned by a dead,
    // same-host holder — every child must reclaim it, and the reclaim must let
    // exactly one at a time win so no two children are ever in their O_EXCL
    // sentinel section together.
    //
    // The reclaim's rename-steal must NOT act on a stale staleness judgment: a
    // waiter that judged the dead record must re-verify the file still holds it
    // before renaming, or it will rename a live winner's freshly-created lock
    // aside and admit a second writer (#2658 review — this reproduced at ~18% per
    // round of 4-way contention before the judgment-verified steal). One round
    // catches that regression only ~1-in-6 of the time, so loop several rounds to
    // make it a reliable guard; with the fix every round is clean.
    const sentinel = path.join(dir, 'critical.sentinel');
    const seedDeadHolder = (): void => {
      writeFileSync(
        path.join(dir, 'analyze.lock'),
        JSON.stringify({
          v: 1,
          pid: 999_999_999,
          hostname: os.hostname(),
          startTime: null,
          token: 'dead-holder-token',
          invocationId: 'dead-holder',
          acquiredAt: new Date(0).toISOString(),
        }),
      );
    };

    const runChild = (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [childScript], {
          env: {
            ...process.env,
            LOCK_MODULE: lockModule,
            LOCK_DIR: dir,
            SENTINEL: sentinel,
            MODE: 'EXCLUSIVE',
            GITNEXUS_INDEX_LOCK_BACKEND: 'file',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        c.once('exit', (code, signal) => resolve({ code, signal }));
      });

    const ROUNDS = 8;
    const KIDS = 5;
    for (let round = 0; round < ROUNDS; round++) {
      seedDeadHolder(); // the previous round's winner released (unlinked) the lock
      const results = await Promise.all(Array.from({ length: KIDS }, () => runChild()));
      // Every child acquired, ran its exclusive section, and exited cleanly (0).
      // Exit 3 = it found the sentinel already present = two holders at once.
      for (const r of results) {
        expect(r.signal).toBeNull();
        expect(r.code).toBe(0);
      }
      // No leftover sentinel — the last holder cleaned up.
      expect(existsSync(sentinel)).toBe(false);
    }
  }, 60_000);
});
