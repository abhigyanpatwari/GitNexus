/**
 * `runFullAnalysis` must invalidate the per-process workspace-package memo
 * BEFORE it takes the index lock, so a long-lived watch/server process never
 * resolves the second analyze's imports against the first analyze's package
 * map (a changed `package.json`, a new workspace member, or a moved entry point
 * would otherwise bind to the old file — a confident wrong edge).
 *
 * Delegating mocks: the real implementations run; the spies only record order.
 */
import { after, describe, it, mock, beforeEach, afterEach } from 'node:test';
import { expect } from 'expect';
import { execSync } from 'child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import * as workspace from '../../../../dist/core/ingestion/languages/typescript/workspace-packages.js';
import * as lock from '../../../../dist/storage/index-lock.js';
const calls: Array<{ operation: 'invalidate' | 'acquire'; path: string }> = [];
const workspaceMock = mock.module(
  new URL(
    '../../../../dist/core/ingestion/languages/typescript/workspace-packages.js',
    import.meta.url,
  ).href,
  {
    namedExports: {
      ...workspace,
      invalidateNodeWorkspacePackages(
        ...args: Parameters<typeof workspace.invalidateNodeWorkspacePackages>
      ) {
        calls.push({ operation: 'invalidate', path: args[0] });
        return workspace.invalidateNodeWorkspacePackages(...args);
      },
    },
  },
);
const lockMock = mock.module(
  new URL('../../../../dist/storage/index-lock.js', import.meta.url).href,
  {
    namedExports: {
      ...lock,
      acquireIndexLock(...args: Parameters<typeof lock.acquireIndexLock>) {
        calls.push({ operation: 'acquire', path: args[0] });
        return lock.acquireIndexLock(...args);
      },
    },
  },
);
after(() => {
  workspaceMock.restore();
  lockMock.restore();
});
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
import { createTempDir } from '../../../../test/helpers/test-db.js';

describe('runFullAnalysis invalidates the workspace-package memo before the lock', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gn-ws-memo-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    calls.length = 0;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it(
    'calls invalidateNodeWorkspacePackages(repoPath) and does so before acquireIndexLock',
    { timeout: 120_000 },
    async () => {
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

        expect(calls[0]).toEqual({ operation: 'invalidate', path: repo });
        expect(calls.some(({ operation }) => operation === 'acquire')).toBe(true);
      } finally {
        await tmp.cleanup();
      }
    },
  );
});
