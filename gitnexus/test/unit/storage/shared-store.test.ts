import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitGraphDir,
  isSharedStoreDisabled,
  resolveGraphPath,
  resolveSharedStore,
  resolveSharedStoreKey,
  SHARED_STORE_ENV,
  sharedStoreLayout,
  type SharedStoreLayout,
} from '../../../src/storage/shared-store.js';
import {
  STORAGE_PATH_ENV,
  STORAGE_ROOT_ENV,
  resolveStoragePath,
  storageSlotName,
} from '../../../src/storage/storage-resolver.js';
import { getStoragePaths } from '../../../src/storage/repo-manager.js';

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
      canonicalCheckout: main,
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

describe('resolveGraphPath', () => {
  const writeSlotMeta = async (slot: string, meta: Record<string, unknown>): Promise<void> => {
    await fs.mkdir(slot, { recursive: true });
    await fs.writeFile(path.join(slot, 'gitnexus.json'), JSON.stringify(meta));
  };

  it('returns <storagePath>/lbug for non-shared storage without reading metadata', async () => {
    const dir = await makeTempDir('gn-shared-local-');
    const storagePath = path.join(dir, '.gitnexus');
    await writeSlotMeta(storagePath, { graphPath: path.join(dir, 'elsewhere', 'lbug') });
    expect(resolveGraphPath(storagePath)).toBe(path.join(storagePath, 'lbug'));
  });

  it('returns the recorded commit graph for a shared checkout slot', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout-a');
    const graph = path.join(commitGraphDir(layout, 'abc1234', 'deadbeef'), 'lbug');
    await writeSlotMeta(layout.checkoutSlot, { graphPath: graph });
    expect(resolveGraphPath(layout.checkoutSlot)).toBe(graph);
  });

  it('returns the slot graph when no graphPath is recorded', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout-a');
    await writeSlotMeta(layout.checkoutSlot, { repoPath: '/tmp/checkout-a' });
    expect(resolveGraphPath(layout.checkoutSlot)).toBe(path.join(layout.checkoutSlot, 'lbug'));
  });

  it('returns the slot graph when metadata is missing or unparseable', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout-a');
    const own = path.join(layout.checkoutSlot, 'lbug');
    expect(resolveGraphPath(layout.checkoutSlot)).toBe(own);
    await fs.mkdir(layout.checkoutSlot, { recursive: true });
    await fs.writeFile(path.join(layout.checkoutSlot, 'gitnexus.json'), '{not json');
    expect(resolveGraphPath(layout.checkoutSlot)).toBe(own);
  });

  it.each([
    [
      'another store',
      () => path.join(home, 'stores', 'other-000000000000', 'commits', 'abc1234-deadbeef', 'lbug'),
    ],
    [
      'a sibling private slot',
      (l: SharedStoreLayout) => path.join(l.checkoutsDir, 'sibling-000000000000', 'lbug'),
    ],
    ['outside GITNEXUS_HOME', () => '/etc/lbug'],
    ['a relative path', () => 'commits/abc1234-deadbeef/lbug'],
    ['a traversal', (l: SharedStoreLayout) => path.join(l.commitsDir, '..', '..', 'x', 'lbug')],
    [
      'a non-lbug file',
      (l: SharedStoreLayout) => path.join(l.commitsDir, 'abc1234-deadbeef', 'gitnexus.json'),
    ],
  ])('ignores a recorded graphPath in %s', async (_label, graphPathFor) => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout-a');
    await writeSlotMeta(layout.checkoutSlot, { graphPath: graphPathFor(layout) });
    expect(resolveGraphPath(layout.checkoutSlot)).toBe(path.join(layout.checkoutSlot, 'lbug'));
  });

  it('flows through getStoragePaths for the flat slot but not branch slots', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout-a');
    const graph = path.join(commitGraphDir(layout, 'abc1234', 'deadbeef'), 'lbug');
    await writeSlotMeta(layout.checkoutSlot, { graphPath: graph });
    expect(getStoragePaths('/tmp/checkout-a', undefined, layout.checkoutSlot).lbugPath).toBe(graph);
    expect(
      path.dirname(getStoragePaths('/tmp/checkout-a', 'feature', layout.checkoutSlot).lbugPath),
    ).toMatch(/branches/);
  });
});

describe('resolveStoragePath store tier', () => {
  const savedPath = process.env[STORAGE_PATH_ENV];
  const savedRoot = process.env[STORAGE_ROOT_ENV];
  const savedSwitch = process.env[SHARED_STORE_ENV];

  beforeEach(() => {
    delete process.env[STORAGE_PATH_ENV];
    delete process.env[STORAGE_ROOT_ENV];
    delete process.env[SHARED_STORE_ENV];
  });

  afterEach(() => {
    for (const [key, value] of [
      [STORAGE_PATH_ENV, savedPath],
      [STORAGE_ROOT_ENV, savedRoot],
      [SHARED_STORE_ENV, savedSwitch],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('keeps an unregistered worktree on local storage while its slot does not exist', async () => {
    const { wts } = await makeRepo(['wt']);
    expect(resolveStoragePath(wts[0])).toBe(path.join(wts[0], '.gitnexus'));
  });

  it('resolves an unregistered worktree to its existing store slot', async () => {
    const { wts } = await makeRepo(['wt']);
    const slot = layoutOf(wts[0]).checkoutSlot;
    await fs.mkdir(slot, { recursive: true });
    expect(resolveStoragePath(wts[0])).toBe(slot);
  });

  it('prefers a registered storage path over an existing store slot', async () => {
    const { wts } = await makeRepo(['wt']);
    await fs.mkdir(layoutOf(wts[0]).checkoutSlot, { recursive: true });
    const registered = path.join(await makeTempDir('gn-shared-registered-'), 'index');
    await fs.writeFile(
      path.join(home, 'registry.json'),
      JSON.stringify([{ name: 'wt', path: wts[0], storagePath: registered }]),
    );
    expect(resolveStoragePath(wts[0])).toBe(registered);
  });
});
