/**
 * End-of-run adopt is best-effort (#2364 review F5): a completed, registered
 * analyze must not exit non-zero because the post-registration branch-label
 * sync failed (e.g. registry write ENOSPC). Integration-level because the
 * full pipeline opens a real LadybugDB (multi-branch-analyze.test.ts
 * precedent); the delegating vi.mock makes adoptFlatBranchLabel fail on
 * demand (vi.spyOn cannot intercept ESM namespace exports).
 *
 * Once-mock starvation hazard: the delegating mock intercepts every
 * repo-manager call in the process — arm mockRejectedValueOnce only
 * immediately before the call under test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

type RepoManagerModule = typeof import('../../src/storage/repo-manager.js');

const rmCtx = vi.hoisted(() => ({
  adoptMock: vi.fn(),
  realAdopt: null as RepoManagerModule['adoptFlatBranchLabel'] | null,
}));

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<RepoManagerModule>();
  rmCtx.realAdopt = actual.adoptFlatBranchLabel;
  rmCtx.adoptMock.mockImplementation(actual.adoptFlatBranchLabel);
  return {
    ...actual,
    adoptFlatBranchLabel: rmCtx.adoptMock,
  };
});

import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { createTempDir } from '../helpers/test-db.js';

describe('end-of-run adopt is best-effort (#2364 F5)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-adopt-besteffort-home-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    rmCtx.adoptMock.mockReset();
    rmCtx.adoptMock.mockImplementation(
      (...args: Parameters<RepoManagerModule['adoptFlatBranchLabel']>) => rmCtx.realAdopt!(...args),
    );
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it('a failed label sync warns and the run still succeeds, already registered', async () => {
    const tmp = await createTempDir('gitnexus-adopt-besteffort-');
    const repo = tmp.dbPath;
    try {
      execSync('git init', { cwd: repo, stdio: 'pipe' });
      await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      execSync('git add -A', { cwd: repo, stdio: 'pipe' });
      execSync('git -c user.name=t -c user.email=t@t commit -m a', { cwd: repo, stdio: 'pipe' });
      execSync('git branch -M main', { cwd: repo, stdio: 'pipe' });

      const logs: string[] = [];
      rmCtx.adoptMock.mockRejectedValueOnce(new Error('mock registry write failure'));
      const result = await runFullAnalysis(
        repo,
        {},
        { onProgress: () => {}, onLog: (m) => logs.push(m) },
      );

      // The run resolved (no throw), the adopt was attempted and its failure
      // surfaced as a warning…
      expect(result.alreadyUpToDate).toBeFalsy();
      expect(rmCtx.adoptMock).toHaveBeenCalledWith(repo, 'main');
      expect(logs.some((m) => m.includes('could not sync the workspace branch label'))).toBe(true);
      // …and registration had already completed before the label sync.
      const entries = await listRegisteredRepos();
      expect(entries.some((e) => path.resolve(e.path) === path.resolve(repo))).toBe(true);
    } finally {
      await tmp.cleanup();
    }
  }, 180_000);
});
