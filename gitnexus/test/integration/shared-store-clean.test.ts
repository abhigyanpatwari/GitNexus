import { execFileSync } from 'child_process';
import { constants as fsConstants, existsSync, readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoragePaths,
  loadMeta,
  readRegistry,
  registerRepo,
  saveMeta,
  unregisterRepo,
} from '../../src/storage/repo-manager.js';
import {
  resolveSharedStore,
  sharedStoreLayout,
  type SharedStoreLayout,
} from '../../src/storage/shared-store.js';
import {
  findLegacyLocalIndex,
  reclaimAfterSlotRemoval,
  readGraphCloneKind,
  reclaimSharedStore,
  removeCheckoutStorage,
  removeLegacyLocalIndex,
  removeSharedStorePointer,
  writeSharedStorePointer,
} from '../../src/storage/shared-store-lifecycle.js';
import { getGlobalDir } from '../../src/storage/global-dir.js';
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

  it('deletes the slot directory last, after unregistering and removing the pointer', async () => {
    await analyze(wtA);
    const slot = layoutOf(wtA).checkoutSlot;
    const pointer = path.join(wtA, '.gitnexus', 'store.json');
    const registry = path.join(tmpHome.dbPath, 'registry.json');
    expect(readFileSync(registry, 'utf-8')).toContain(JSON.stringify(wtA).slice(1, -1));
    const seen: { pointer: boolean; registered: boolean }[] = [];
    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
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
      rm.mockRestore();
    }
    expect(seen).toEqual([{ pointer: false, registered: false }]);
    expect(existsSync(slot)).toBe(false);
  }, 240_000);

  it('previews without --force and deletes nothing', async () => {
    await analyze(wtA);
    const layout = layoutOf(wtA);
    await cleanIn(wtA, {});
    expect(existsSync(layout.checkoutSlot)).toBe(true);
    expect(await commitDirs(layout)).toHaveLength(1);
  }, 240_000);

  it('clean --gc skips stray files in the stores directory', async () => {
    await analyze(wtA);
    await fs.writeFile(path.join(tmpHome.dbPath, 'stores', '.DS_Store'), 'x');
    const logs = await cleanIn(main, { gc: true, force: true });
    expect(logs.join('\n')).toMatch(/Shared store .*: dropped 0 checkout/);
  }, 240_000);

  it('clean --gc does not follow a symlink in the stores directory', async () => {
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
  }, 240_000);

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
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      if (String(target) === gone) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return (realLstat as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.lstat);
    try {
      const logs = await cleanIn(main, { gc: true, force: true });
      expect(logs).toContain('No shared stores to collect.');
    } finally {
      lstat.mockRestore();
    }
  });

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

  it('clean --gc keeps a slot whose index lock is held (analyze in progress)', async () => {
    const slot = await member('busy-000000000000', { repoPath: '/nonexistent/checkout' });
    const { acquireIndexLock } = await import('../../src/storage/index-lock.js');
    const lock = await acquireIndexLock(slot);
    try {
      const result = await reclaimSharedStore(layout().root, { gc: true });
      expect(result.droppedMembers).toEqual([]);
      expect(existsSync(slot)).toBe(true);
    } finally {
      lock.release();
    }
    const after = await reclaimSharedStore(layout().root, { gc: true });
    expect(after.droppedMembers).toEqual([slot]);
  });

  it('clean --gc preview does not count a slot whose index lock is held', async () => {
    const slot = await member('busy-000000000000', { repoPath: '/nonexistent/checkout' });
    const { acquireIndexLock } = await import('../../src/storage/index-lock.js');
    const lock = await acquireIndexLock(slot);
    try {
      const preview = await reclaimSharedStore(layout().root, { gc: true, dryRun: true });
      expect(preview.droppedMembers).toEqual([]);
    } finally {
      lock.release();
    }
    const after = await reclaimSharedStore(layout().root, { gc: true, dryRun: true });
    expect(after.droppedMembers).toEqual([slot]);
    expect(existsSync(slot)).toBe(true);
  });

  it("clean --gc preview leaves an orphan slot's staging files in place", async () => {
    const slot = await member('gone-000000000000', { repoPath: '/nonexistent/checkout' });
    const staging = path.join(slot, 'lbug.staging.x');
    await fs.writeFile(staging, 'partial');
    const preview = await reclaimSharedStore(layout().root, { gc: true, dryRun: true });
    expect(preview.droppedMembers).toEqual([slot]);
    expect(existsSync(staging)).toBe(true);
  });

  it('names the leftover slot and clean --gc when the final slot deletion fails', async () => {
    const checkout = path.join(tmpHome.dbPath, 'checkout');
    await fs.mkdir(checkout);
    const slot = await member('wt-000000000000', { repoPath: checkout });
    await registerRepo(
      checkout,
      { repoPath: checkout, storagePath: slot, lastCommit: '', indexedAt: '' },
      { storagePath: slot },
    );
    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      if (String(target) === slot) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return (realRm as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.rm);
    try {
      await expect(
        removeCheckoutStorage(slot, () => unregisterRepo(checkout), checkout),
      ).rejects.toThrow(/was unregistered.*gitnexus clean --gc --force/s);
    } finally {
      rm.mockRestore();
    }
    expect(await readRegistry()).toEqual([]);
    expect(existsSync(slot)).toBe(true);

    // The leftover is now an orphan member, which `clean --gc` collects.
    const result = await reclaimSharedStore(layout().root, { gc: true });
    expect(result.droppedMembers).toEqual([slot]);
    expect(existsSync(slot)).toBe(false);
  });

  it('counts references correctly when GITNEXUS_HOME is relative', async () => {
    const absoluteHome = process.env.GITNEXUS_HOME as string;
    process.env.GITNEXUS_HOME = path.relative(process.cwd(), absoluteHome);
    try {
      const referenced = await commitGraph('ddddddd-4444444444444444');
      await member('wt-000000000000', { graphPath: path.resolve(referenced, 'lbug') });
      // The root exactly as `clean --gc` builds it: relative under this home.
      const gcRoot = path.join(getGlobalDir(), 'stores', layout().key);
      expect(path.isAbsolute(gcRoot)).toBe(false);
      const result = await reclaimSharedStore(gcRoot);
      expect(result.removed).toEqual([]);
      expect(existsSync(referenced)).toBe(true);
    } finally {
      process.env.GITNEXUS_HOME = absoluteHome;
    }
  });

  it('aborts instead of deleting graphs when the member list cannot be read', async () => {
    const graph = await commitGraph('eeeeeee-5555555555555555');
    await member('wt-000000000000', { graphPath: path.join(graph, 'lbug') });
    const realReaddir = fs.readdir;
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      if (String(target) === layout().checkoutsDir) {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      }
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.readdir);
    try {
      await expect(reclaimSharedStore(layout().root, { gc: true })).rejects.toThrow(/denied/);
    } finally {
      readdir.mockRestore();
    }
    expect(existsSync(graph)).toBe(true);
  });

  it('keeps a checkout .gitnexus directory it cannot list', async () => {
    const dir = path.join(tmpHome.dbPath, 'checkout', '.gitnexus');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'store.json'), '{}');
    const realReaddir = fs.readdir;
    const readdir = vi.spyOn(fs, 'readdir').mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      if (String(target) === dir) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (realReaddir as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.readdir);
    try {
      await removeSharedStorePointer(path.dirname(dir));
    } finally {
      readdir.mockRestore();
    }
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(path.join(dir, 'store.json'))).toBe(false);
  });

  /** `<parent>/repo/.gitnexus -> ..`, beside a file that lives outside the checkout. */
  const symlinkedPointerDir = async (): Promise<{ checkout: string; victim: string }> => {
    const parent = path.join(tmpHome.dbPath, 'parent');
    const checkout = path.join(parent, 'repo');
    await fs.mkdir(checkout, { recursive: true });
    const victim = path.join(parent, 'a-victim.txt');
    await fs.writeFile(victim, 'keep');
    await fs.symlink('..', path.join(checkout, '.gitnexus'), 'dir');
    return { checkout, victim };
  };

  it('writes the pointer into a real checkout .gitnexus and removes only the legacy index', async () => {
    const checkout = path.join(tmpHome.dbPath, 'checkout');
    await fs.mkdir(checkout);
    const slot = await member('wt-000000000000', { repoPath: checkout });
    await writeSharedStorePointer(checkout, layout());
    await fs.writeFile(path.join(checkout, '.gitnexus', 'lbug'), 'old graph');
    expect((await removeLegacyLocalIndex(checkout, slot))?.entries).toEqual(['lbug']);
    expect(await fs.readdir(path.join(checkout, '.gitnexus'))).toEqual(
      expect.arrayContaining(['store.json', '.gitignore']),
    );
    expect(existsSync(path.join(checkout, '.gitnexus', 'lbug'))).toBe(false);
  });

  it('ignores a symlinked checkout .gitnexus when finding or removing a legacy index', async () => {
    const { checkout, victim } = await symlinkedPointerDir();
    const slot = await member('wt-000000000000', { repoPath: checkout });
    expect(await findLegacyLocalIndex(checkout, slot)).toBeNull();
    expect(await removeLegacyLocalIndex(checkout, slot)).toBeNull();
    expect(readFileSync(victim, 'utf-8')).toBe('keep');
  });

  it('writes no pointer through a symlinked checkout .gitnexus', async () => {
    const { checkout } = await symlinkedPointerDir();
    await writeSharedStorePointer(checkout, layout());
    expect(existsSync(path.join(path.dirname(checkout), 'store.json'))).toBe(false);
    expect(existsSync(path.join(path.dirname(checkout), '.gitignore'))).toBe(false);
  });

  it('removes nothing through a symlinked checkout .gitnexus', async () => {
    const { checkout, victim } = await symlinkedPointerDir();
    const outsidePointer = path.join(path.dirname(checkout), 'store.json');
    await fs.writeFile(outsidePointer, '{}');
    await removeSharedStorePointer(checkout);
    expect(existsSync(outsidePointer)).toBe(true);
    expect(readFileSync(victim, 'utf-8')).toBe('keep');
  });

  it('aborts instead of collecting members when the registry cannot be read', async () => {
    const slot = await member('wt-000000000000', { repoPath: tmpHome.dbPath });
    await fs.writeFile(path.join(tmpHome.dbPath, 'registry.json'), '{not json');
    await expect(reclaimSharedStore(layout().root, { gc: true })).rejects.toThrow();
    expect(existsSync(slot)).toBe(true);
  });

  it('without a registry file collects only members whose checkout is gone', async () => {
    const live = await member('wt-000000000000', { repoPath: tmpHome.dbPath });
    const dead = await member('wt-111111111111', {
      repoPath: path.join(tmpHome.dbPath, 'deleted-worktree'),
    });
    await reclaimSharedStore(layout().root, { gc: true });
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
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

  // A torn or unreadable gitnexus.json must not read as "references nothing":
  // the graph it names would be deleted while the checkout still uses it.
  it.each([
    ['invalid JSON', (file: string) => fs.writeFile(file, '{"graphPath": "/trunc')],
    ['an unreadable file', (file: string) => fs.mkdir(file)],
  ])('aborts instead of deleting graphs when a member has %s as metadata', async (_, corrupt) => {
    const graph = await commitGraph('fffffff-6666666666666666');
    const slot = path.join(layout().checkoutsDir, 'wt-000000000000');
    await fs.mkdir(slot, { recursive: true });
    await corrupt(path.join(slot, 'gitnexus.json'));
    await member('wt-111111111111', {});

    await expect(reclaimSharedStore(layout().root)).rejects.toThrow(/wt-000000000000/);
    expect(existsSync(graph)).toBe(true);
  });

  it('counts a member with no metadata as referencing nothing', async () => {
    const graph = await commitGraph('fffffff-6666666666666666');
    const slot = path.join(layout().checkoutsDir, 'wt-000000000000');
    await fs.mkdir(slot, { recursive: true });

    const result = await reclaimSharedStore(layout().root);

    expect(result.removed).toEqual([graph]);
    expect(existsSync(graph)).toBe(false);
  });

  it('clean --gc keeps a member it cannot delete and still collects every store', async () => {
    const gone = '/nonexistent/checkout';
    const stuckGraph = await commitGraph('aaaaaaa-1111111111111111');
    const unreferenced = await commitGraph('bbbbbbb-2222222222222222');
    const stuck = await member('wt-000000000000', {
      repoPath: gone,
      graphPath: path.join(stuckGraph, 'lbug'),
    });
    const dropped = await member('wt-111111111111', { repoPath: gone });
    const other = sharedStoreLayout('repo-fedcba987654', '/tmp/wt');
    const otherGraph = path.join(other.commitsDir, 'ccccccc-3333333333333333');
    await fs.mkdir(otherGraph, { recursive: true });
    const otherSlot = path.join(other.checkoutsDir, 'wt-000000000000');
    await fs.mkdir(otherSlot, { recursive: true });
    await saveMeta(otherSlot, { lastCommit: '', indexedAt: '', repoPath: gone });

    const realRm = fs.rm;
    const rm = vi.spyOn(fs, 'rm').mockImplementation((async (
      target: string,
      ...rest: unknown[]
    ) => {
      if (String(target) === stuck) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return (realRm as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as typeof fs.rm);
    const { cleanCommand } = await import('../../src/cli/clean.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let lines: string[];
    try {
      await cleanCommand({ gc: true, force: true });
      lines = log.mock.calls.map((c) => String(c[0]));
    } finally {
      log.mockRestore();
      rm.mockRestore();
    }

    // The stuck member stays a member, so the graph it names stays live.
    expect(existsSync(stuck)).toBe(true);
    expect(existsSync(stuckGraph)).toBe(true);
    expect(existsSync(dropped)).toBe(false);
    expect(existsSync(unreferenced)).toBe(false);
    // The store after it was still collected, down to its root.
    expect(existsSync(other.root)).toBe(false);
    expect(lines).toEqual(
      expect.arrayContaining([expect.stringMatching(/kept 1 checkout\(s\) it could not delete/)]),
    );
  });
});

describe('private graph copies (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-clone-kind-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  const pointerSlot = async (): Promise<string> => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/wt');
    const graph = path.join(layout.commitsDir, 'aaaaaaa-1111111111111111');
    await fs.mkdir(graph, { recursive: true });
    await fs.writeFile(path.join(graph, 'lbug'), 'graph');
    await fs.mkdir(layout.checkoutSlot, { recursive: true });
    await saveMeta(layout.checkoutSlot, {
      lastCommit: 'aaaaaaa',
      indexedAt: '',
      repoPath: '/tmp/wt',
      graphPath: path.join(graph, 'lbug'),
    });
    return layout.checkoutSlot;
  };

  // Stand in for the filesystem: FICLONE_FORCE succeeds only when `cow` is set.
  const fakeCopyFile = (cow: boolean) => {
    const realCopyFile = fs.copyFile;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (src, dest, mode) => {
      if (mode === fsConstants.COPYFILE_FICLONE_FORCE && !cow) {
        throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' });
      }
      return realCopyFile(src, dest);
    });
  };

  it('records a copy-on-write clone', async () => {
    const slot = await pointerSlot();
    fakeCopyFile(true);
    const { ensurePrivateSharedGraph } = await import('../../src/core/shared-store-analyze.js');
    expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    expect(await readGraphCloneKind(slot)).toBe('copy-on-write');
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe('graph');
  });

  it('falls back to a full copy and records it', async () => {
    const slot = await pointerSlot();
    fakeCopyFile(false);
    const { ensurePrivateSharedGraph } = await import('../../src/core/shared-store-analyze.js');
    expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    expect(await readGraphCloneKind(slot)).toBe('copy');
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe('graph');
  });

  it('forgets the record when the private graph is rebuilt instead of copied', async () => {
    const slot = await pointerSlot();
    await fs.writeFile(path.join(slot, 'graph-clone'), 'copy');
    const { ensurePrivateSharedGraph } = await import('../../src/core/shared-store-analyze.js');
    await ensurePrivateSharedGraph(slot, () => {}, { copy: false });
    expect(await readGraphCloneKind(slot)).toBeNull();
  });
});
