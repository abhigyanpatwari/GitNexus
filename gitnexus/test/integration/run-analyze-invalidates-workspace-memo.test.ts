/**
 * `runFullAnalysis` must invalidate the per-process workspace-package memo
 * BEFORE it takes the index lock, so a long-lived watch/server process never
 * resolves the second analyze's imports against the first analyze's package
 * map (a changed `package.json`, a new workspace member, or a moved entry point
 * would otherwise bind to the old file — a confident wrong edge).
 *
 * Delegating mocks: the real implementations run; the spies only record order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

type Workspace =
  typeof import('../../src/core/ingestion/import-resolvers/node-workspace-packages.js');
type Lock = typeof import('../../src/storage/index-lock.js');
const ctx = vi.hoisted(() => ({
  invalidate: vi.fn(),
  acquire: vi.fn(),
}));
vi.mock(
  '../../src/core/ingestion/import-resolvers/node-workspace-packages.js',
  async (importOriginal) => {
    const actual = await importOriginal<Workspace>();
    ctx.invalidate.mockImplementation(actual.invalidateNodeWorkspacePackages);
    return { ...actual, invalidateNodeWorkspacePackages: ctx.invalidate };
  },
);
vi.mock('../../src/storage/index-lock.js', async (importOriginal) => {
  const actual = await importOriginal<Lock>();
  ctx.acquire.mockImplementation(actual.acquireIndexLock);
  return { ...actual, acquireIndexLock: ctx.acquire };
});

import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createTempDir } from '../helpers/test-db.js';

describe('runFullAnalysis invalidates the workspace-package memo before the lock', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gn-ws-memo-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    ctx.invalidate.mockClear();
    ctx.acquire.mockClear();
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('calls invalidateNodeWorkspacePackages(repoPath) and does so before acquireIndexLock', async () => {
    const tmp = await createTempDir('gn-ws-memo-repo-');
    const repo = tmp.dbPath;
    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      await fs.writeFile(
        path.join(repo, 'a.ts'),
        'export function greet(n: string) { return `hi ${n}`; }\nexport function caller() { return greet("x"); }\n',
      );
      execSync('git add -A && git -c user.name=t -c user.email=t@t commit -m init', {
        cwd: repo,
        stdio: 'pipe',
      });

      await runFullAnalysis(repo, {}, { onProgress: () => {} });

      expect(ctx.invalidate).toHaveBeenCalled();
      const invalidateArgs = ctx.invalidate.mock.calls[0]!;
      expect(invalidateArgs[0]).toBe(repo);
      expect(ctx.acquire).toHaveBeenCalled();
      const firstInvalidate = ctx.invalidate.mock.invocationCallOrder[0]!;
      const firstAcquire = ctx.acquire.mock.invocationCallOrder[0]!;
      expect(firstInvalidate).toBeLessThan(firstAcquire);
    } finally {
      await tmp.cleanup();
    }
  }, 120_000);
});
