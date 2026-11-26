import { after, describe, it, mock, beforeEach, afterEach } from 'node:test';
import { expect } from 'expect';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

import * as manager from '../../../../dist/storage/repo-manager.js';
const adopt = mock.fn(manager.adoptFlatBranchLabel);
const managerMock = mock.module(
  new URL('../../../../dist/storage/repo-manager.js', import.meta.url).href,
  {
    namedExports: { ...manager, adoptFlatBranchLabel: adopt },
  },
);
after(() => managerMock.restore());
const { runFullAnalysis } = await import('../../../../dist/core/run-analyze.js');
import { createTempDir } from '../../../../test/helpers/test-db.js';

describe('end-of-run adopt is best-effort (#2364 F5)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedGitnexusHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-adopt-besteffort-home-');
    savedGitnexusHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedGitnexusHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedGitnexusHome;
    await tmpHome.cleanup();
  });

  it(
    'a failed label sync warns and the run still succeeds, already registered',
    { timeout: 180_000 },
    async () => {
      const tmp = await createTempDir('gitnexus-adopt-besteffort-');
      const repo = tmp.dbPath;
      try {
        execSync('git init', { cwd: repo, stdio: 'pipe' });
        await fs.writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
        execSync('git add -A', { cwd: repo, stdio: 'pipe' });
        execSync('git -c user.name=t -c user.email=t@t commit -m a', { cwd: repo, stdio: 'pipe' });
        execSync('git branch -M main', { cwd: repo, stdio: 'pipe' });

        const logs: string[] = [];
        adopt.mock.mockImplementationOnce(async () => {
          throw new Error('mock registry write failure');
        });
        const result = await runFullAnalysis(
          repo,
          {},
          { onProgress: () => {}, onLog: (m) => logs.push(m) },
        );

        // The run resolved (no throw), the adopt was attempted and its failure
        // surfaced as a warning…
        expect(result.alreadyUpToDate).toBeFalsy();
        expect(adopt.mock.calls.map((call) => call.arguments)).toContainEqual([
          repo,
          'main',
          path.join(repo, '.gitnexus'),
        ]);
        expect(logs.some((m) => m.includes('could not sync the workspace branch label'))).toBe(
          true,
        );
        // …and registration had already completed before the label sync.
        const entries = await manager.listRegisteredRepos();
        expect(entries.some((e) => path.resolve(e.path) === path.resolve(repo))).toBe(true);
      } finally {
        await tmp.cleanup();
      }
    },
  );
});
