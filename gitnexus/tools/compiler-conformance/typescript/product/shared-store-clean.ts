import { mock } from 'node:test';

import { existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import {
  after as afterAll,
  afterEach,
  before as beforeAll,
  beforeEach,
  describe,
  it,
} from 'node:test';
import { expect } from 'expect';
import { getStoragePaths, loadMeta } from '../../../../src/storage/repo-manager.js';

import { createTempDir } from '../../../../test/helpers/test-db.js';

// These suites exercise sharing; an inherited opt-out would silently disable it.
const savedSharedStoreSwitch = process.env.GITNEXUS_SHARED_STORE;
beforeAll(() => {
  delete process.env.GITNEXUS_SHARED_STORE;
});
afterAll(() => {
  if (savedSharedStoreSwitch === undefined) delete process.env.GITNEXUS_SHARED_STORE;
  else process.env.GITNEXUS_SHARED_STORE = savedSharedStoreSwitch;
});

import {
  git,
  commitAll,
  layoutOf,
  listCommitDirs,
} from '../../../../test/helpers/shared-store-checkout.js';
describe('shared store clean (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let savedCwd: string;
  let main: string;
  let wtA: string;
  let wtB: string;

  const analyze = async (checkout: string) => {
    const { runFullAnalysis } = await import('../../../../src/core/run-analyze.js');
    return runFullAnalysis(checkout, {}, { onProgress: () => {} });
  };

  const cleanIn = async (checkout: string, options: Record<string, unknown>) => {
    const { cleanCommand } = await import('../../../../src/cli/clean.js');
    process.chdir(checkout);
    const log = mock.method(console, 'log', () => {});
    try {
      await cleanCommand(options);
      return log.mock.calls.map((call) => String(call.arguments[0]));
    } finally {
      log.mock.restore();
      process.chdir(savedCwd);
    }
  };

  beforeEach(async () => {
    savedCwd = process.cwd();
    tmpHome = await createTempDir('gitnexus-test-clean-home-');
    tmpRepo = await createTempDir('gitnexus-test-clean-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    const root = await fs.realpath(tmpRepo.dbPath);
    main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(main, 'a.ts'), 'export function alpha() { return 1; }\n');
    commitAll(main, 'init');
    wtA = path.join(root, 'wt-a');
    wtB = path.join(root, 'wt-b');
    git(main, 'worktree', 'add', '-q', '-b', 'wt-a', wtA);
    git(main, 'worktree', 'add', '-q', '-b', 'wt-b', wtB);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it(
    'Covers AE5: cleaning one of two worktrees at X keeps X for the other',
    { timeout: 240_000 },
    async () => {
      await analyze(wtA);
      await analyze(wtB);
      const graph = getStoragePaths(wtB, undefined, layoutOf(wtB).checkoutSlot).lbugPath;

      await cleanIn(wtA, { force: true });

      expect(existsSync(layoutOf(wtA).checkoutSlot)).toBe(false);
      expect(existsSync(graph)).toBe(true);
      expect((await loadMeta(layoutOf(wtB).checkoutSlot))?.graphPath).toBe(graph);
    },
  );

  it(
    'deletes the commit graph and the store when the last member is cleaned',
    { timeout: 240_000 },
    async () => {
      await analyze(wtA);
      await analyze(wtB);
      const layout = layoutOf(wtA);

      await cleanIn(wtA, { force: true });
      const logs = await cleanIn(wtB, { force: true });

      expect(await listCommitDirs(layout)).toEqual([]);
      expect(existsSync(layout.root)).toBe(false);
      expect(logs.join('\n')).toMatch(/removed 1 commit graph/);
    },
  );

  it(
    'clean --all --force removes each shared checkout pointer with its slot',
    { timeout: 240_000 },
    async () => {
      await analyze(wtA);
      await analyze(wtB);
      expect(existsSync(path.join(wtA, '.gitnexus', 'store.json'))).toBe(true);
      await cleanIn(wtA, { all: true, force: true });
      for (const wt of [wtA, wtB]) {
        expect(existsSync(path.join(wt, '.gitnexus', 'store.json'))).toBe(false);
      }
      expect(existsSync(layoutOf(wtA).root)).toBe(false);
    },
  );

  it(
    'deletes the slot directory last, after unregistering and removing the pointer',
    { timeout: 240_000 },
    async () => {
      await analyze(wtA);
      const slot = layoutOf(wtA).checkoutSlot;
      const pointer = path.join(wtA, '.gitnexus', 'store.json');
      const registry = path.join(tmpHome.dbPath, 'registry.json');
      expect(readFileSync(registry, 'utf-8')).toContain(JSON.stringify(wtA).slice(1, -1));
      const seen: { pointer: boolean; registered: boolean }[] = [];
      const realRm = fs.rm;
      const rm = mock.method(fs, 'rm', async (target, options) => {
        if (String(target) === slot) {
          seen.push({
            pointer: existsSync(pointer),
            registered: readFileSync(registry, 'utf-8').includes(JSON.stringify(wtA).slice(1, -1)),
          });
        }
        return realRm(target, options);
      });
      try {
        await cleanIn(wtA, { force: true });
      } finally {
        rm.mock.restore();
      }
      expect(seen).toEqual([{ pointer: false, registered: false }]);
      expect(existsSync(slot)).toBe(false);
    },
  );

  it('previews without --force and deletes nothing', { timeout: 240_000 }, async () => {
    await analyze(wtA);
    const layout = layoutOf(wtA);
    await cleanIn(wtA, {});
    expect(existsSync(layout.checkoutSlot)).toBe(true);
    expect(await listCommitDirs(layout)).toHaveLength(1);
  });

  it('clean --gc skips stray files in the stores directory', { timeout: 240_000 }, async () => {
    await analyze(wtA);
    await fs.writeFile(path.join(tmpHome.dbPath, 'stores', '.DS_Store'), 'x');
    const logs = await cleanIn(main, { gc: true, force: true });
    expect(logs.join('\n')).toMatch(/Shared store .*: dropped 0 checkout/);
  });

  it(
    'clean --gc does not follow a symlink in the stores directory',
    { timeout: 240_000 },
    async () => {
      const decoy = path.join(tmpRepo.dbPath, 'decoy');
      await fs.mkdir(path.join(decoy, 'checkouts'), { recursive: true });
      await fs.mkdir(path.join(decoy, 'commits', 'ddddddd-4444444444444444'), { recursive: true });
      const stores = path.join(tmpHome.dbPath, 'stores');
      await fs.mkdir(stores, { recursive: true });
      await fs.symlink(
        decoy,
        path.join(stores, 'repo-0123456789ab'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );

      await cleanIn(main, { gc: true, force: true });

      expect(existsSync(path.join(decoy, 'commits', 'ddddddd-4444444444444444'))).toBe(true);
    },
  );

  it('clean --gc reports no stores when stores/ holds only stray files', async () => {
    await fs.mkdir(path.join(tmpHome.dbPath, 'stores'), { recursive: true });
    await fs.writeFile(path.join(tmpHome.dbPath, 'stores', '.DS_Store'), 'x');
    const logs = await cleanIn(main, { gc: true });
    expect(logs).toContain('No shared stores to collect.');
  });

  it('clean --gc skips a store removed by a concurrent collector', async () => {
    const gone = path.join(tmpHome.dbPath, 'stores', 'repo-0123456789ab');
    await fs.mkdir(gone, { recursive: true });
    const realLstat = fs.lstat;
    const lstat = mock.method(fs, 'lstat', (async (target: string, ...rest: unknown[]) => {
      if (String(target) === gone) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return (realLstat as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.lstat);
    try {
      const logs = await cleanIn(main, { gc: true, force: true });
      expect(logs).toContain('No shared stores to collect.');
    } finally {
      lstat.mock.restore();
    }
  });

  it('clean --gc without --force previews and deletes nothing', { timeout: 240_000 }, async () => {
    await analyze(wtA);
    await fs.writeFile(path.join(wtB, 'b.ts'), 'export function beta() { return 2; }\n');
    commitAll(wtB, 'b');
    await analyze(wtB);
    const slotB = layoutOf(wtB).checkoutSlot;
    git(main, 'worktree', 'remove', '--force', wtB);

    const logs = await cleanIn(main, { gc: true });

    expect(existsSync(slotB)).toBe(true);
    expect(await listCommitDirs(layoutOf(wtA))).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/would drop 1 checkout\(s\) and remove 1 commit graph/);
  });

  it(
    'clean --gc drops a deleted worktree and the graph only it referenced',
    { timeout: 240_000 },
    async () => {
      await analyze(wtA);
      await fs.writeFile(path.join(wtB, 'b.ts'), 'export function beta() { return 2; }\n');
      commitAll(wtB, 'b');
      await analyze(wtB);
      const layout = layoutOf(wtB);
      const slotB = layout.checkoutSlot;
      expect(await listCommitDirs(layout)).toHaveLength(2);

      git(main, 'worktree', 'remove', '--force', wtB);
      const logs = await cleanIn(main, { gc: true, force: true });

      expect(existsSync(slotB)).toBe(false);
      expect(await listCommitDirs(layout)).toHaveLength(1);
      expect(existsSync(layoutOf(wtA).checkoutSlot)).toBe(true);
      expect(logs.join('\n')).toMatch(/dropped 1 checkout\(s\), removed 1 commit graph/);
    },
  );
});
