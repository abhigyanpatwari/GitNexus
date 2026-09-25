import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveOptedInStore } from '../../src/core/shared-store-analyze.js';
import { getRemoteUrl } from '../../src/storage/git.js';
import {
  getStoragePaths,
  listRegisteredRepos,
  registerRepo,
} from '../../src/storage/repo-manager.js';
import {
  cloneStoreKey,
  resolveSharedStore,
  sharedStoreLayout,
  type SharedStoreLayout,
} from '../../src/storage/shared-store.js';
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
 * #3352 U7 — an independent clone joins the store of a registered sibling
 * clone (same normalized origin URL) automatically, or the member named by
 * `--share-with`; `--no-share` leaves and stays out.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const REMOTE = 'https://example.com/acme/widgets';

describe('shared store clone sharing (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let root: string;
  let main: string;
  let wt: string;
  let storeLayout: SharedStoreLayout;

  const analyze = async (checkout: string, options: Record<string, unknown> = {}) => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    return runFullAnalysis(checkout, options, { onProgress: () => {} });
  };

  const cloneWithRemote = (name: string, remote: string): string => {
    const clone = path.join(root, name);
    git(root, 'clone', '-q', main, clone);
    git(clone, 'remote', 'set-url', 'origin', remote);
    return clone;
  };

  const registeredStorage = async (checkout: string): Promise<string | undefined> =>
    (await listRegisteredRepos()).find((e) => e.path === checkout)?.storagePath;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-optin-home-');
    tmpRepo = await createTempDir('gitnexus-test-optin-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    root = await fs.realpath(tmpRepo.dbPath);
    main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'remote', 'add', 'origin', `${REMOTE}.git`);
    await fs.writeFile(path.join(main, 'a.ts'), 'export function alpha() { return 1; }\n');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    wt = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
    await analyze(wt);
    storeLayout = resolveSharedStore(wt) as SharedStoreLayout;
    expect(storeLayout).not.toBeNull();
  }, 240_000);

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('a clone joins the store of a registered sibling and reuses the commit graph', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    const result = await analyze(clone);

    const slot = await registeredStorage(clone);
    expect(path.dirname(slot as string)).toBe(storeLayout.checkoutsDir);
    expect(result.alreadyUpToDate).toBe(true);
    expect(getStoragePaths(clone, undefined, slot).lbugPath).toBe(
      getStoragePaths(wt, undefined, storeLayout.checkoutSlot).lbugPath,
    );
    expect(existsSync(path.join(clone, '.gitnexus', 'lbug'))).toBe(false);
  }, 240_000);

  it('Covers AE7: a clone with no registered sibling keeps its own .gitnexus', async () => {
    const clone = cloneWithRemote('clone', 'https://example.com/acme/gadgets');
    await analyze(clone);
    expect(await registeredStorage(clone)).toBe(path.join(clone, '.gitnexus'));
    expect(existsSync(path.join(clone, '.gitnexus', 'lbug'))).toBe(true);
  }, 240_000);

  it('two standalone clones of one repository found a store and share its graph', async () => {
    const solo = 'https://example.com/acme/solo';
    const first = cloneWithRemote('first', solo);
    await analyze(first);
    expect(await registeredStorage(first)).toBe(path.join(first, '.gitnexus'));

    const second = cloneWithRemote('second', solo);
    await analyze(second);
    const secondSlot = (await registeredStorage(second)) as string;
    const checkouts = path.dirname(secondSlot);
    expect(path.basename(checkouts)).toBe('checkouts');
    expect(checkouts).not.toBe(storeLayout.checkoutsDir);

    // The first clone joins on its next analyze and reads the same graph.
    await analyze(first);
    const firstSlot = (await registeredStorage(first)) as string;
    expect(path.dirname(firstSlot)).toBe(checkouts);
    expect(getStoragePaths(first, undefined, firstSlot).lbugPath).toBe(
      getStoragePaths(second, undefined, secondSlot).lbugPath,
    );
    // Adoption leaves the old repository-local index in place.
    expect(existsSync(path.join(first, '.gitnexus', 'lbug'))).toBe(true);
  }, 240_000);

  it('joins the store with --share-with and reuses the commit graph at its HEAD', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    const result = await analyze(clone, { shareWith: wt });

    const slot = await registeredStorage(clone);
    expect(path.dirname(slot as string)).toBe(storeLayout.checkoutsDir);
    expect(result.alreadyUpToDate).toBe(true);
    expect(getStoragePaths(clone, undefined, slot).lbugPath).toBe(
      getStoragePaths(wt, undefined, storeLayout.checkoutSlot).lbugPath,
    );
    expect(existsSync(path.join(clone, '.gitnexus', 'lbug'))).toBe(false);

    // Remembered: a later plain analyze stays in the store.
    await analyze(clone);
    expect(await registeredStorage(clone)).toBe(slot);
  }, 240_000);

  it('admits a clone whose remote differs only by embedded credentials', async () => {
    const clone = cloneWithRemote('clone', 'https://user:secret@example.com/acme/widgets.git');
    await analyze(clone, { shareWith: wt });
    expect(path.dirname((await registeredStorage(clone)) as string)).toBe(storeLayout.checkoutsDir);
  }, 240_000);

  it('Covers AE4: refuses a clone of a different repository and changes nothing', async () => {
    const clone = cloneWithRemote('other', 'https://example.com/acme/gadgets');
    await expect(analyze(clone, { shareWith: wt })).rejects.toThrow(
      /remote URL mismatch — this checkout is "https:\/\/example\.com\/acme\/gadgets"/,
    );
    expect(await registeredStorage(clone)).toBeUndefined();
    expect(existsSync(path.join(clone, '.gitnexus', 'lbug'))).toBe(false);
  }, 240_000);

  it('refuses a clone with no origin remote', async () => {
    const clone = cloneWithRemote('noremote', REMOTE);
    git(clone, 'remote', 'remove', 'origin');
    await expect(analyze(clone, { shareWith: wt })).rejects.toThrow(/\(no origin remote\)/);
  }, 240_000);

  it('refuses a --share-with target that is not in a shared store', async () => {
    const plain = cloneWithRemote('plain', REMOTE);
    await analyze(plain, { noShare: true });
    const clone = cloneWithRemote('clone', REMOTE);
    await expect(analyze(clone, { shareWith: plain })).rejects.toThrow(
      /does not use a shared index store/,
    );
  }, 240_000);

  it('--no-share moves a clone back to its own .gitnexus and keeps shared graphs', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    await analyze(clone, { shareWith: wt });
    const slot = (await registeredStorage(clone)) as string;

    await analyze(clone, { noShare: true });

    expect(await registeredStorage(clone)).toBe(path.join(clone, '.gitnexus'));
    expect(existsSync(slot)).toBe(false);
    expect(existsSync(getStoragePaths(wt, undefined, storeLayout.checkoutSlot).lbugPath)).toBe(
      true,
    );

    // The opt-out sticks: a plain analyze does not rejoin the sibling store.
    await analyze(clone);
    expect(await registeredStorage(clone)).toBe(path.join(clone, '.gitnexus'));

    // --share-with clears it: the clone is back in, and stays in.
    await analyze(clone, { shareWith: wt });
    await analyze(clone);
    expect(path.dirname((await registeredStorage(clone)) as string)).toBe(storeLayout.checkoutsDir);
  }, 240_000);

  it('--no-share on an up-to-date local index still re-registers there', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    await analyze(clone, { noShare: true });
    await analyze(clone, { shareWith: wt });
    const slot = (await registeredStorage(clone)) as string;

    const result = await analyze(clone, { noShare: true });

    expect(result.alreadyUpToDate).toBe(true);
    expect(await registeredStorage(clone)).toBe(path.join(clone, '.gitnexus'));
    expect(existsSync(slot)).toBe(false);
  }, 240_000);

  it('clean --gc keeps an opted-in clone that is still registered at its slot', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    await analyze(clone, { shareWith: wt });
    const slot = (await registeredStorage(clone)) as string;
    const { reclaimSharedStore } = await import('../../src/storage/shared-store-lifecycle.js');
    const result = await reclaimSharedStore(storeLayout.root, { gc: true });
    expect(result.droppedMembers).toEqual([]);
    expect(existsSync(slot)).toBe(true);
  }, 240_000);

  it('rejects --no-share in a linked worktree', async () => {
    const before = await fs.readFile(path.join(storeLayout.checkoutSlot, 'gitnexus.json'), 'utf-8');
    await expect(analyze(wt, { noShare: true })).rejects.toThrow(/GITNEXUS_SHARED_STORE=off/);
    // Rejected before any work: no local index, slot metadata untouched.
    expect(existsSync(path.join(wt, '.gitnexus', 'lbug'))).toBe(false);
    expect(await fs.readFile(path.join(storeLayout.checkoutSlot, 'gitnexus.json'), 'utf-8')).toBe(
      before,
    );
  }, 240_000);
});

/**
 * #3374 S7 — registered sibling clones that found a store at the same time
 * must pick the same key, or each keeps its own store forever. Resolves the
 * store directly (no analyze): only the registry and the clones' remotes matter.
 */
describe('shared store founder key for concurrent sibling clones (#3374)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let root: string;

  /** Clone `source` as `name` and register it at local storage, or at `storeKey`'s slot. */
  const cloneAndRegister = async (name: string, storeKey?: string): Promise<string> => {
    const clone = path.join(root, name);
    git(root, 'clone', '-q', path.join(root, 'source'), clone);
    git(clone, 'remote', 'set-url', 'origin', REMOTE);
    const storagePath = storeKey ? sharedStoreLayout(storeKey, clone).checkoutSlot : undefined;
    await registerRepo(
      clone,
      {
        repoPath: clone,
        storagePath,
        lastCommit: git(clone, 'rev-parse', 'HEAD'),
        indexedAt: new Date(0).toISOString(),
        remoteUrl: getRemoteUrl(clone),
      },
      storagePath ? { storagePath } : undefined,
    );
    return clone;
  };

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-founder-home-');
    tmpRepo = await createTempDir('gitnexus-test-founder-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    root = await fs.realpath(tmpRepo.dbPath);
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    git(source, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(source, 'a.ts'), 'export const a = 1;\n');
    git(source, 'add', '-A');
    git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('two registered local clones resolve the same new store, keyed on the first path', async () => {
    // Registered in reverse path order so registry order cannot pick the key.
    const second = await cloneAndRegister('zeta');
    const first = await cloneAndRegister('alpha');

    const fromFirst = await resolveOptedInStore(first, undefined);
    const fromSecond = await resolveOptedInStore(second, undefined);

    expect(fromFirst?.key).toBe(cloneStoreKey(first));
    expect(fromSecond?.key).toBe(cloneStoreKey(first));
  });

  it('a later clone joins the existing store rather than founding one', async () => {
    const existing = cloneStoreKey(path.join(root, 'zz-founder'));
    await cloneAndRegister('member', existing);
    await cloneAndRegister('other');

    const joiner = await cloneAndRegister('aaa-joiner');
    expect((await resolveOptedInStore(joiner, undefined))?.key).toBe(existing);
  });
});
