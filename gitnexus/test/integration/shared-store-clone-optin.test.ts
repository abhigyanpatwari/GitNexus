import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getStoragePaths, listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { resolveSharedStore, type SharedStoreLayout } from '../../src/storage/shared-store.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * #3352 U7 — an independent clone joins a shared store only by explicit
 * opt-in, and only when its remote matches the member it names.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const REMOTE = 'https://example.com/acme/widgets';

describe('shared store clone opt-in (#3352)', () => {
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
    tmpHome = await createTempDir('gitnexus-optin-home-');
    tmpRepo = await createTempDir('gitnexus-optin-repo-');
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

  it('Covers AE7: a clone that has not opted in keeps its own .gitnexus', async () => {
    const clone = cloneWithRemote('clone', REMOTE);
    await analyze(clone);
    expect(await registeredStorage(clone)).toBe(path.join(clone, '.gitnexus'));
    expect(existsSync(path.join(clone, '.gitnexus', 'lbug'))).toBe(true);
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
    await analyze(plain);
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
  }, 240_000);

  it('rejects --no-share in a linked worktree', async () => {
    await expect(analyze(wt, { noShare: true })).rejects.toThrow(/GITNEXUS_SHARED_STORE=off/);
  }, 240_000);
});
