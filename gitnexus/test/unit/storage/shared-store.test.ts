import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitGraphDir,
  isSharedStoreDisabled,
  resolveSharedStore,
  resolveSharedStoreKey,
  SHARED_STORE_ENV,
  sharedStoreLayout,
  type SharedStoreLayout,
} from '../../../src/storage/shared-store.js';
import {
  STORAGE_PATH_ENV,
  STORAGE_ROOT_ENV,
  storageSlotName,
} from '../../../src/storage/storage-resolver.js';

const temporaryPaths: string[] = [];
const savedHome = process.env.GITNEXUS_HOME;
let home: string;

const makeTempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  temporaryPaths.push(dir);
  return dir;
};

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

/** A committed repo; `worktrees` names linked worktrees created beside it. */
const makeRepo = async (worktrees: string[] = []): Promise<{ main: string; wts: string[] }> => {
  const parent = await makeTempDir('gn-shared-store-');
  const main = path.join(parent, 'main');
  await fs.mkdir(main);
  git(main, 'init', '-q', '-b', 'main');
  git(
    main,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  const wts = worktrees.map((name) => {
    const wt = path.join(parent, name);
    git(main, 'worktree', 'add', '-q', '-b', name, wt);
    return wt;
  });
  return { main, wts };
};

// Only these keys are read by isSharedStoreDisabled/resolveSharedStoreKey.
const cleanEnv = (): NodeJS.ProcessEnv => ({});

const layoutOf = (checkoutPath: string): SharedStoreLayout => {
  const layout = resolveSharedStore(checkoutPath, cleanEnv());
  expect(layout).not.toBeNull();
  return layout as SharedStoreLayout;
};

beforeEach(async () => {
  home = await makeTempDir('gn-shared-home-');
  process.env.GITNEXUS_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
  else process.env.GITNEXUS_HOME = savedHome;
  await Promise.all(
    temporaryPaths.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })),
  );
});

describe('resolveSharedStoreKey', () => {
  it('gives the main checkout and every linked worktree the same key', async () => {
    const { main, wts } = await makeRepo(['wt-a', 'wt-b']);
    const keys = [main, ...wts].map((p) => resolveSharedStoreKey(p, cleanEnv()));
    expect(keys[0]).toMatch(/^main-[0-9a-f]{12}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps a repository without linked worktrees on local storage', async () => {
    const { main } = await makeRepo();
    expect(resolveSharedStoreKey(main, cleanEnv())).toBeNull();
  });

  it('gives two unrelated repos with the same basename different keys', async () => {
    const a = await makeRepo(['wt']);
    const b = await makeRepo(['wt']);
    const keyA = resolveSharedStoreKey(a.main, cleanEnv());
    const keyB = resolveSharedStoreKey(b.main, cleanEnv());
    expect(keyA).not.toBeNull();
    expect(keyA).not.toBe(keyB);
  });

  it('does not share a subdirectory of a checkout', async () => {
    const { main } = await makeRepo(['wt']);
    const sub = path.join(main, 'pkg');
    await fs.mkdir(sub);
    expect(resolveSharedStoreKey(sub, cleanEnv())).toBeNull();
  });

  it('does not share a non-git folder', async () => {
    const dir = await makeTempDir('gn-shared-nogit-');
    expect(resolveSharedStoreKey(dir, cleanEnv())).toBeNull();
  });

  it('does not treat a gitdir file without commondir (submodule shape) as a worktree', async () => {
    const dir = await makeTempDir('gn-shared-submodule-');
    const modules = path.join(dir, 'modules', 'sub');
    await fs.mkdir(modules, { recursive: true });
    await fs.writeFile(path.join(dir, '.git'), `gitdir: ${modules}\n`);
    expect(resolveSharedStoreKey(dir, cleanEnv())).toBeNull();
  });

  it.each([
    [{ [SHARED_STORE_ENV]: 'off' }],
    [{ [SHARED_STORE_ENV]: 'FALSE' }],
    [{ [SHARED_STORE_ENV]: '0' }],
    [{ [STORAGE_PATH_ENV]: '/tmp/explicit-index' }],
    [{ [STORAGE_ROOT_ENV]: '/tmp/index-root' }],
  ])('returns null for every checkout when disabled by %o', async (env) => {
    const { main, wts } = await makeRepo(['wt']);
    expect(isSharedStoreDisabled(env)).toBe(true);
    expect(resolveSharedStoreKey(main, env)).toBeNull();
    expect(resolveSharedStoreKey(wts[0], env)).toBeNull();
  });

  it('treats an unrecognized switch value as enabled', () => {
    expect(isSharedStoreDisabled({ [SHARED_STORE_ENV]: 'on' })).toBe(false);
  });
});

describe('sharedStoreLayout', () => {
  it('places every area inside the store under GITNEXUS_HOME', async () => {
    const { main, wts } = await makeRepo(['wt']);
    const layout = layoutOf(wts[0]);
    const root = path.join(home, 'stores', layout.key);
    expect(layout).toEqual({
      key: resolveSharedStoreKey(main, cleanEnv()),
      root,
      cachesDir: path.join(root, 'caches'),
      commitsDir: path.join(root, 'commits'),
      checkoutsDir: path.join(root, 'checkouts'),
      checkoutSlot: path.join(root, 'checkouts', storageSlotName(wts[0])),
    });
  });

  it('gives each checkout its own slot', async () => {
    const { main, wts } = await makeRepo(['wt']);
    const a = layoutOf(main);
    const b = layoutOf(wts[0]);
    expect(a.root).toBe(b.root);
    expect(a.checkoutSlot).not.toBe(b.checkoutSlot);
  });

  it('maps a symlinked spelling of a worktree to the same slot', async () => {
    const { wts } = await makeRepo(['wt']);
    const link = path.join(await makeTempDir('gn-shared-link-'), 'alias');
    await fs.symlink(wts[0], link);
    expect(layoutOf(link).checkoutSlot).toBe(layoutOf(wts[0]).checkoutSlot);
  });

  it.each(['..', '../escape', 'a/../../b'])(
    'rejects a key that escapes the stores dir: %s',
    (key) => {
      expect(() => sharedStoreLayout(key, '/tmp/x')).toThrow(/escapes the stores directory/);
    },
  );
});

describe('commitGraphDir', () => {
  const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout');

  it('names one directory per commit and feature key', () => {
    expect(commitGraphDir(layout, 'abc1234', 'deadbeef')).toBe(
      path.join(layout.commitsDir, 'abc1234-deadbeef'),
    );
  });

  it.each([
    ['../../x', 'deadbeef'],
    ['ABC1234', 'deadbeef'],
    ['abc1234', '../etc'],
    ['abc1234', 'short'],
  ])('rejects commit %s / feature key %s', (commit, featureKey) => {
    expect(() => commitGraphDir(layout, commit, featureKey)).toThrow(/Invalid/);
  });
});
