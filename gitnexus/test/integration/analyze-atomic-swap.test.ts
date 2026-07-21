/**
 * Integration test for the #2 atomic full-rebuild swap.
 *
 * A full rebuild builds the fresh index at `<lbugPath>.new` and swaps it over
 * the live index in one atomic rename (POSIX). Two invariants:
 *  - success publishes a single valid `lbug` with no `.new` temp left behind,
 *    and a repeat rebuild replaces the inode (proving the swap, not an in-place
 *    edit); and
 *  - a failure BEFORE the swap leaves the previous index byte-for-byte intact
 *    (the crash-safety win — the live index is never wiped mid-rebuild).
 *
 * POSIX only: on Windows the build stays in place (buildPath === lbugPath), so
 * these swap invariants do not apply — see run-analyze's platform guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type LbugAdapter = typeof import('../../src/core/lbug/lbug-adapter.js');
const ctx = vi.hoisted(() => ({
  loadMock: vi.fn(),
  realLoad: null as LbugAdapter['loadGraphToLbug'] | null,
}));
// Delegating mock: overrides only loadGraphToLbug so a rebuild can be made to
// fail on demand (mirrors run-analyze-adopt-failure.test.ts).
vi.mock('../../src/core/lbug/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<LbugAdapter>();
  ctx.realLoad = actual.loadGraphToLbug;
  ctx.loadMock.mockImplementation(actual.loadGraphToLbug);
  return { ...actual, loadGraphToLbug: ctx.loadMock };
});

import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import {
  initLbug as poolInit,
  executeQuery as poolQuery,
  closeLbug as poolClose,
} from '../../src/core/lbug/pool-adapter.js';
import { createTempDir } from '../helpers/test-db.js';

const isWin = process.platform === 'win32';

const identity = async (p: string): Promise<string> => {
  const s = await fs.stat(p);
  return `${s.ino}:${s.mtimeMs}:${s.size}`;
};
const lingeringTemp = async (lbugPath: string): Promise<string[]> => {
  const base = path.basename(lbugPath);
  const entries = await fs.readdir(path.dirname(lbugPath));
  return entries.filter((e) => e.startsWith(`${base}.new`));
};

describe.skipIf(isWin)('atomic full-rebuild swap (#2)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gn-atomic-swap-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    ctx.loadMock.mockReset();
    ctx.loadMock.mockImplementation((...a: Parameters<LbugAdapter['loadGraphToLbug']>) =>
      ctx.realLoad!(...a),
    );
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  const makeRepo = async () => {
    const tmp = await createTempDir('gn-atomic-swap-repo-');
    const repo = tmp.dbPath;
    execSync('git init', { cwd: repo, stdio: 'pipe' });
    await fs.writeFile(
      path.join(repo, 'a.ts'),
      'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\n',
    );
    execSync('git add -A && git -c user.name=t -c user.email=t@t commit -m init', {
      cwd: repo,
      stdio: 'pipe',
    });
    return { repo, cleanup: tmp.cleanup };
  };

  it('publishes one lbug with no temp leak; a repeat rebuild swaps the inode', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      await expect(fs.stat(lbugPath)).resolves.toBeTruthy();
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      const first = await identity(lbugPath);

      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} });
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      // The atomic rename replaced the file — a new inode, not an in-place edit.
      expect(await identity(lbugPath)).not.toBe(first);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('leaves the previous index intact when a rebuild fails before the swap', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1
      const { lbugPath } = getStoragePaths(repo);
      const before = await identity(lbugPath);

      ctx.loadMock.mockRejectedValueOnce(new Error('injected mid-rebuild failure'));
      await expect(
        runFullAnalysis(repo, { force: true }, { onProgress: () => {} }),
      ).rejects.toThrow('injected mid-rebuild failure');

      // The build failed in the temp; the swap (skipped on failure) never
      // published it, so the live index is byte-for-byte untouched.
      expect(await identity(lbugPath)).toBe(before);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('the read pool serves the freshly-swapped index after a rebuild (#1 + #2 end-to-end)', async () => {
    const { repo, cleanup } = await makeRepo();
    const repoId = 'atomic-swap-e2e';
    const names = async (): Promise<string[]> =>
      (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap((r) =>
        Object.values(r as Record<string, unknown>).map(String),
      );
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1: greet
      const { lbugPath } = getStoragePaths(repo);

      await poolInit(repoId, lbugPath);
      expect(await names()).toContain('greet');

      // Rebuild with a renamed function so v1 and v2 differ observably.
      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function renamedGreet(n: string) { return `hi ${n}`; }\nexport function caller() { return renamedGreet("x"); }\n',
      );
      execSync('git -c user.name=t -c user.email=t@t commit -am rename', {
        cwd: repo,
        stdio: 'pipe',
      });
      await runFullAnalysis(repo, { force: true }, { onProgress: () => {} }); // v2 → atomic swap

      // Same repoId: initLbug detects the swapped inode and re-opens the pool
      // onto the new index instead of serving the stale (unlinked) one.
      await poolInit(repoId, lbugPath);
      const v2 = await names();
      expect(v2).toContain('renamedGreet');
      // Proves the pool actually re-opened — a stale handle would still see v1.
      expect(v2).not.toContain('greet');
    } finally {
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  it('opt-in atomic incremental copies then swaps, no temp leak, change reflected', async () => {
    const { repo, cleanup } = await makeRepo();
    const prev = process.env.GITNEXUS_ATOMIC_INCREMENTAL;
    process.env.GITNEXUS_ATOMIC_INCREMENTAL = '1';
    const repoId = 'atomic-incr-e2e';
    try {
      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // v1
      const { lbugPath } = getStoragePaths(repo);

      // Change a single file so the next run is incremental, adding a function.
      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\nexport function addedFn() { return 1; }\n',
      );
      execSync('git -c user.name=t -c user.email=t@t commit -am change', {
        cwd: repo,
        stdio: 'pipe',
      });

      await runFullAnalysis(repo, {}, { onProgress: () => {} }); // incremental + atomic swap
      expect(await lingeringTemp(lbugPath)).toEqual([]);

      await poolInit(repoId, lbugPath);
      const names = (await poolQuery(repoId, 'MATCH (f:Function) RETURN f.name AS n')).flatMap(
        (r) => Object.values(r as Record<string, unknown>).map(String),
      );
      expect(names).toContain('addedFn'); // the incremental change landed via the swap
    } finally {
      if (prev === undefined) delete process.env.GITNEXUS_ATOMIC_INCREMENTAL;
      else process.env.GITNEXUS_ATOMIC_INCREMENTAL = prev;
      await poolClose(repoId);
      await cleanup();
    }
  }, 180_000);

  it('publishes cleanly on the production close path (skipNativeCloseOnExit) (#2614 F5)', async () => {
    const { repo, cleanup } = await makeRepo();
    try {
      // The CLI and serve-worker set skipNativeCloseOnExit (dodges #2264), so the
      // build handle is still open at swap time — the path production actually
      // ships, distinct from the default real-close the other tests exercise.
      // Prove the POSIX swap still publishes a single consolidated file with no
      // .new temp and no orphan sidecar.
      await runFullAnalysis(repo, { skipNativeCloseOnExit: true }, { onProgress: () => {} });
      const { lbugPath } = getStoragePaths(repo);
      await expect(fs.stat(lbugPath)).resolves.toBeTruthy();
      expect(await lingeringTemp(lbugPath)).toEqual([]);
      for (const s of ['.wal', '.shadow', '.wal.checkpoint'] as const) {
        await expect(fs.stat(`${lbugPath}${s}`)).rejects.toThrow(); // no orphan sidecar
      }
    } finally {
      await cleanup();
    }
  }, 180_000);
});
