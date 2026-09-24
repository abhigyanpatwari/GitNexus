import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withStoreLock } from '../../src/storage/shared-store-lifecycle.js';
import { loadMeta } from '../../src/storage/repo-manager.js';
import {
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
 * #3352 U5 — linked worktrees keep one parse cache and ParsedFile store per
 * shared store, and one member's prune never evicts chunks another member
 * still records.
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

const indexedCacheKeys = async (layout: SharedStoreLayout): Promise<string[]> => {
  const raw = await fs.readFile(path.join(layout.cachesDir, 'parse-cache', 'index.json'), 'utf-8');
  return (JSON.parse(raw) as { keys: string[] }).keys;
};

describe('shared store caches (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let wtA: string;
  let wtB: string;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-cache-home-');
    tmpRepo = await createTempDir('gitnexus-cache-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    const root = await fs.realpath(tmpRepo.dbPath);
    const main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(main, 'a.ts'), 'export function alpha() { return 1; }\n');
    await fs.writeFile(path.join(main, 'b.ts'), 'export function beta() { return 2; }\n');
    commitAll(main, 'init');
    wtA = path.join(root, 'wt-a');
    wtB = path.join(root, 'wt-b');
    git(main, 'worktree', 'add', '-q', '-b', 'wt-a', wtA);
    git(main, 'worktree', 'add', '-q', '-b', 'wt-b', wtB);
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('keeps one cache tree in the store and none in any checkout', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    await fs.writeFile(path.join(wtB, 'c.ts'), 'export function gamma() { return 3; }\n');
    await runFullAnalysis(wtB, {}, { onProgress: () => {} });

    const layout = layoutOf(wtA);
    expect(existsSync(path.join(layout.cachesDir, 'parse-cache'))).toBe(true);
    expect(existsSync(path.join(layout.cachesDir, 'parsedfile-cache'))).toBe(true);
    for (const checkout of [wtA, wtB]) {
      for (const dir of [layoutOf(checkout).checkoutSlot, path.join(checkout, '.gitnexus')]) {
        expect(existsSync(path.join(dir, 'parse-cache'))).toBe(false);
        expect(existsSync(path.join(dir, 'parsedfile-cache'))).toBe(false);
      }
    }
  }, 240_000);

  it("keeps chunks another member records when one member's file set changes", async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    const layout = layoutOf(wtA);
    const commitDir = (await fs.readdir(layout.commitsDir)).find((n) => !n.startsWith('.'));
    const keysA = (await loadMeta(path.join(layout.commitsDir, commitDir as string)))?.cacheKeys;
    expect(keysA?.length).toBeGreaterThan(0);

    await fs.rm(path.join(wtB, 'b.ts'));
    await runFullAnalysis(wtB, {}, { onProgress: () => {} });
    const keysB = (await loadMeta(layoutOf(wtB).checkoutSlot))?.cacheKeys;
    expect(keysB?.length).toBeGreaterThan(0);
    expect(keysB).not.toEqual(keysA);

    const indexed = await indexedCacheKeys(layout);
    for (const key of [...(keysA ?? []), ...(keysB ?? [])]) expect(indexed).toContain(key);
  }, 240_000);
});

describe('withStoreLock', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-store-lock-home-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpHome.cleanup();
  });

  it('runs same-named sections one at a time', async () => {
    const layout = sharedStoreLayout('repo-0123456789ab', '/tmp/checkout');
    const events: string[] = [];
    const section = (name: string) => async () => {
      events.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 50));
      events.push(`${name}:end`);
    };
    await Promise.all([
      withStoreLock(layout, 'cache', section('one')),
      withStoreLock(layout, 'cache', section('two')),
    ]);
    expect(events[1]).toBe(`${events[0].split(':')[0]}:end`);
    expect(events[3]).toBe(`${events[2].split(':')[0]}:end`);
  });
});
