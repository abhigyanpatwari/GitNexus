import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { branchSlug } from '../../src/storage/branch-index.js';

const mocks = vi.hoisted(() => ({ repos: vi.fn(), branch: vi.fn(), init: vi.fn() }));
vi.mock('../../src/storage/repo-manager.js', () => ({ listRegisteredRepos: mocks.repos }));
vi.mock('../../src/storage/storage-resolver.js', () => ({
  STATUS_STORAGE_REQUIREMENTS: {},
  requireRegisteredStoragePath: async (entry: { storagePath: string }) => entry.storagePath,
}));
vi.mock('../../src/storage/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/git.js')>()),
  getCurrentBranch: mocks.branch,
}));
vi.mock('../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: mocks.init,
  isLbugReady: () => false,
  executeQuery: async () => [],
}));
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: async () => ({ results: [], ftsAvailable: true }),
}));
import { augment } from '../../src/core/augmentation/engine.js';

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-augment-generation-'));
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

it.each([undefined, 'feature/generation'])(
  'opens the published graph in slot %s',
  async (branch) => {
    const storagePath = path.join(root, '.gitnexus');
    const slot = branch ? path.join(storagePath, 'branches', branchSlug(branch)) : storagePath;
    const graphPath = `lbug.generation.${'a'.repeat(32)}`;
    await fs.mkdir(slot, { recursive: true });
    await fs.writeFile(path.join(slot, 'gitnexus.json'), JSON.stringify({ graphPath }));
    await fs.writeFile(path.join(slot, graphPath), 'owned graph fixture');
    mocks.branch.mockReturnValue(branch ?? 'main');
    mocks.repos.mockResolvedValue([
      { name: 'fixture', path: root, storagePath, branches: branch ? [{ branch }] : [] },
    ]);

    await augment('login', root);

    expect(mocks.init).toHaveBeenCalledWith('fixture', path.join(slot, graphPath));
  },
);
