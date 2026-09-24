import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import {
  resolveSharedStore,
  sharedStoreLayout,
  type SharedStoreLayout,
} from '../../src/storage/shared-store.js';
import {
  reclaimAfterSlotRemoval,
  reclaimSharedStore,
} from '../../src/storage/shared-store-lifecycle.js';
import { createTempDir } from '../helpers/test-db.js';

// These suites exercise sharing; an inherited opt-out would silently disable it.
const savedSharedStoreSwitch = process.env.GITNEXUS_SHARED_STORE;
beforeAll(() => {
  delete process.env.GITNEXUS_SHARED_STORE;
});
afterAll(() => {
  if (savedSharedStoreSwitch === undefined) delete process.env.GITNEXUS_SHARED_STORE;
  else process.env.GITNEXUS_SHARED_STORE = savedSharedStoreSwitch;
});

/**
 * #3352 U6 — clean removes only what no remaining member references.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const commitAll = (cwd: string, message: string): void => {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
};

const layoutOf = (checkout: string): SharedStoreLayout => {
  const layout = resolveSharedStore(checkout);
  expect(layout).not.toBeNull();
  return layout as SharedStoreLayout;
};

const commitDirs = async (layout: SharedStoreLayout): Promise<string[]> =>
  (await fs.readdir(layout.commitsDir).catch(() => [] as string[])).filter(
    (n) => !n.startsWith('.'),
  );

describe('shared store clean (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let savedCwd: string;
  let main: string;
  let wtA: string;
  let wtB: string;

  const analyze = async (checkout: string) => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    return runFullAnalysis(checkout, {}, { onProgress: () => {} });
  };

  const cleanIn = async (checkout: string, options: Record<string, unknown>) => {
    const { cleanCommand } = await import('../../src/cli/clean.js');
    process.chdir(checkout);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cleanCommand(options);
      return log.mock.calls.map((c) => String(c[0]));
    } finally {
      log.mockRestore();
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

  it('Covers AE5: cleaning one of two worktrees at X keeps X for the other', async () => {
    await analyze(wtA);
    await analyze(wtB);
    const graph = getStoragePaths(wtB, undefined, layoutOf(wtB).checkoutSlot).lbugPath;

    await cleanIn(wtA, { force: true });

    expect(existsSync(layoutOf(wtA).checkoutSlot)).toBe(false);
    expect(existsSync(graph)).toBe(true);
    expect((await loadMeta(layoutOf(wtB).checkoutSlot))?.graphPath).toBe(graph);
  }, 240_000);

  it('deletes the commit graph and the store when the last member is cleaned', async () => {
    await analyze(wtA);
    await analyze(wtB);
    const layout = layoutOf(wtA);

    await cleanIn(wtA, { force: true });
    const logs = await cleanIn(wtB, { force: true });

    expect(await commitDirs(layout)).toEqual([]);
    expect(existsSync(layout.root)).toBe(false);
    expect(logs.join('\n')).toMatch(/removed 1 commit graph/);
  }, 240_000);

  it('clean --all --force removes each shared checkout pointer with its slot', async () => {
    await analyze(wtA);
    await analyze(wtB);
    expect(existsSync(path.join(wtA, '.gitnexus', 'store.json'))).toBe(true);
    await cleanIn(wtA, { all: true, force: true });
    for (const wt of [wtA, wtB]) {
      expect(existsSync(path.join(wt, '.gitnexus', 'store.json'))).toBe(false);
    }
    expect(existsSync(layoutOf(wtA).root)).toBe(false);
  }, 240_000);

  it('previews without --force and deletes nothing', async () => {
    await analyze(wtA);
    const layout = layoutOf(wtA);
    await cleanIn(wtA, {});
    expect(existsSync(layout.checkoutSlot)).toBe(true);
    expect(await commitDirs(layout)).toHaveLength(1);
  }, 240_000);

  it('clean --gc without --force previews and deletes nothing', async () => {
    await analyze(wtA);
    await fs.writeFile(path.join(wtB, 'b.ts'), 'export function beta() { return 2; }\n');
    commitAll(wtB, 'b');
    await analyze(wtB);
    const slotB = layoutOf(wtB).checkoutSlot;
    git(main, 'worktree', 'remove', '--force', wtB);

    const logs = await cleanIn(main, { gc: true });

    expect(existsSync(slotB)).toBe(true);
    expect(await commitDirs(layoutOf(wtA))).toHaveLength(2);
    expect(logs.join('\n')).toMatch(/would drop 1 checkout\(s\) and remove 1 commit graph/);
  }, 240_000);

  it('clean --gc drops a deleted worktree and the graph only it referenced', async () => {
    await analyze(wtA);
    await fs.writeFile(path.join(wtB, 'b.ts'), 'export function beta() { return 2; }\n');
    commitAll(wtB, 'b');
    await analyze(wtB);
    const layout = layoutOf(wtB);
    const slotB = layout.checkoutSlot;
    expect(await commitDirs(layout)).toHaveLength(2);

    git(main, 'worktree', 'remove', '--force', wtB);
    const logs = await cleanIn(main, { gc: true, force: true });

    expect(existsSync(slotB)).toBe(false);
    expect(await commitDirs(layout)).toHaveLength(1);
    expect(existsSync(layoutOf(wtA).checkoutSlot)).toBe(true);
    expect(logs.join('\n')).toMatch(/dropped 1 checkout\(s\), removed 1 commit graph/);
  }, 240_000);
});

describe('reclaimSharedStore', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-reclaim-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  const layout = (): SharedStoreLayout => sharedStoreLayout('repo-0123456789ab', '/tmp/wt');

  const commitGraph = async (name: string): Promise<string> => {
    const dir = path.join(layout().commitsDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'lbug'), 'graph');
    return dir;
  };

  const member = async (slotName: string, meta: Record<string, unknown>): Promise<string> => {
    const slot = path.join(layout().checkoutsDir, slotName);
    await fs.mkdir(slot, { recursive: true });
    await saveMeta(slot, { lastCommit: '', indexedAt: '', repoPath: '/tmp/wt', ...meta });
    return slot;
  };

  it('keeps referenced graphs and removes unreferenced graphs and stale staging', async () => {
    const kept = await commitGraph('aaaaaaa-1111111111111111');
    const orphan = await commitGraph('bbbbbbb-2222222222222222');
    const staging = await commitGraph('.publish-dead');
    await member('wt-000000000000', { graphPath: path.join(kept, 'lbug') });

    const result = await reclaimSharedStore(layout().root);

    expect(existsSync(kept)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(staging)).toBe(false);
    expect(result.removed).toEqual([orphan]);
    expect(result.storeRemoved).toBe(false);
  });

  it('never collects a slot whose metadata it cannot attribute', async () => {
    const slot = path.join(layout().checkoutsDir, 'unknown-000000000000');
    await fs.mkdir(slot, { recursive: true });
    const result = await reclaimSharedStore(layout().root, { gc: true });
    expect(existsSync(slot)).toBe(true);
    expect(result.droppedMembers).toEqual([]);
  });

  it('is a no-op for storage outside the stores directory', async () => {
    const outside = path.join(tmpHome.dbPath, 'elsewhere', '.gitnexus');
    await fs.mkdir(outside, { recursive: true });
    expect(await reclaimAfterSlotRemoval(outside)).toBeNull();
    expect(existsSync(outside)).toBe(true);
  });

  it('reports a graph it cannot delete instead of failing', async () => {
    const orphan = await commitGraph('ccccccc-3333333333333333');
    await member('wt-000000000000', {});
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target) => {
      if (String(target) === orphan) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    try {
      const result = await reclaimSharedStore(layout().root);
      expect(result.kept).toEqual([orphan]);
      expect(result.removed).toEqual([]);
    } finally {
      rm.mockRestore();
    }
  });
});
