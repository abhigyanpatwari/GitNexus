import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const { acquire, release, pipeline, resolvePlacement } = vi.hoisted(() => ({
  acquire: vi.fn(),
  release: vi.fn(),
  pipeline: vi.fn(),
  resolvePlacement: vi.fn(async (): Promise<{ branch?: string }> => ({})),
}));
vi.mock('../../src/storage/index-lock.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/index-lock.js')>()),
  acquireIndexLock: acquire,
}));
vi.mock('../../src/core/ingestion/pipeline.js', () => ({ runPipelineFromRepo: pipeline }));
vi.mock('../../src/storage/repo-manager.js', async (original) => ({
  ...(await original<typeof import('../../src/storage/repo-manager.js')>()),
  resolveBranchPlacement: (...args: unknown[]) => resolvePlacement(...args),
}));

import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { unregisterRepo } from '../../src/storage/repo-manager.js';

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-required-lock-'));
  vi.stubEnv('GITNEXUS_HOME', home);
  vi.stubEnv('GITNEXUS_FTS_STEMMER', 'porter');
  vi.clearAllMocks();
  acquire.mockResolvedValue({ lockFree: true, release });
  resolvePlacement.mockReset().mockResolvedValue({});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

it('refuses analysis without exclusive ownership before invoking the pipeline', async () => {
  await expect(runFullAnalysis(home, {}, { onProgress: () => {} })).rejects.toThrow(
    'refusing an unlocked analysis',
  );
  expect(acquire).toHaveBeenCalled();
  expect(pipeline).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  await expect(fs.stat(path.join(home, '.gitnexus', 'lbug'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses a registry transaction without exclusive ownership', async () => {
  const registry = path.join(home, 'registry.json');
  const original = JSON.stringify([
    {
      name: 'keep',
      path: home,
      storagePath: path.join(home, '.gitnexus'),
      indexedAt: '',
      lastCommit: '',
    },
  ]);
  await fs.writeFile(registry, original);
  await expect(unregisterRepo(home)).rejects.toThrow('refusing an unlocked registry transaction');
  expect(await fs.readFile(registry, 'utf8')).toBe(original);
  expect(release).toHaveBeenCalledOnce();
});

it('refuses analysis without exclusive ownership after the write slot moves', async () => {
  resolvePlacement.mockResolvedValueOnce({}).mockResolvedValueOnce({ branch: 'moved' });
  acquire.mockResolvedValueOnce({ release }).mockResolvedValueOnce({ lockFree: true, release });

  await expect(
    runFullAnalysis(home, { branch: 'moved' }, { onProgress: () => {} }),
  ).rejects.toThrow('refusing an unlocked analysis');
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(pipeline).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalled();
});
