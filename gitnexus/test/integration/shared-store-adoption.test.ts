import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import {
  readSharedStorePointer,
  resolveSharedStore,
  SHARED_STORE_ENV,
  type SharedStoreLayout,
} from '../../src/storage/shared-store.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * #3352 U8 — existing worktree indexes are adopted into the store without
 * being deleted, and status/doctor/clean make the leftover visible and
 * removable.
 */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();

const layoutOf = (checkout: string): SharedStoreLayout => {
  const layout = resolveSharedStore(checkout);
  expect(layout).not.toBeNull();
  return layout as SharedStoreLayout;
};

describe('shared store adoption and reporting (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let savedSwitch: string | undefined;
  let savedCwd: string;
  let main: string;
  let wt: string;

  const analyze = async (checkout: string) => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    return runFullAnalysis(checkout, {}, { onProgress: () => {} });
  };

  const runIn = async (checkout: string, fn: () => Promise<void>): Promise<string[]> => {
    process.chdir(checkout);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await fn();
      return log.mock.calls.map((c) => String(c[0]));
    } finally {
      log.mockRestore();
      process.chdir(savedCwd);
    }
  };

  const statusJson = async (checkout: string) => {
    const { statusCommand } = await import('../../src/cli/status.js');
    const lines = await runIn(checkout, () => statusCommand({ json: true }));
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  };

  /** Index `wt` the pre-store way, into its own `.gitnexus`. */
  const legacyIndex = async (checkout: string): Promise<void> => {
    process.env[SHARED_STORE_ENV] = 'off';
    try {
      await analyze(checkout);
    } finally {
      delete process.env[SHARED_STORE_ENV];
    }
    expect(existsSync(path.join(checkout, '.gitnexus', 'lbug'))).toBe(true);
  };

  beforeEach(async () => {
    savedCwd = process.cwd();
    tmpHome = await createTempDir('gitnexus-test-adopt-home-');
    tmpRepo = await createTempDir('gitnexus-test-adopt-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    savedSwitch = process.env[SHARED_STORE_ENV];
    delete process.env[SHARED_STORE_ENV];
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
    const root = await fs.realpath(tmpRepo.dbPath);
    main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(main, 'a.ts'), 'export function alpha() { return 1; }\n');
    git(main, 'add', '-A');
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
    wt = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
  });

  afterEach(async () => {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    if (savedSwitch === undefined) delete process.env[SHARED_STORE_ENV];
    else process.env[SHARED_STORE_ENV] = savedSwitch;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('Covers F4: adopts a worktree index into the store and leaves the old files', async () => {
    await legacyIndex(wt);
    const legacyGraph = await fs.readFile(path.join(wt, '.gitnexus', 'lbug'));

    const result = await analyze(wt);

    // Seeded from its own index, then verified by a file-hash diff rather than
    // trusted: a local index may hold edits that were later reverted.
    expect(result.alreadyUpToDate).not.toBe(true);
    const layout = layoutOf(wt);
    expect((await fs.readdir(layout.commitsDir)).filter((n) => !n.startsWith('.'))).toHaveLength(1);
    expect(await fs.readFile(path.join(wt, '.gitnexus', 'lbug'))).toEqual(legacyGraph);
    expect(readSharedStorePointer(wt)).toBe(layout.checkoutSlot);
    expect((await listRegisteredRepos()).find((e) => e.path === wt)?.storagePath).toBe(
      layout.checkoutSlot,
    );
  }, 240_000);

  it('status reports the shared graph and the leftover index with its removal command', async () => {
    await legacyIndex(wt);
    await analyze(wt);

    const json = await statusJson(wt);
    expect(json.sharedStore).toEqual({
      key: layoutOf(wt).key,
      graph: 'shared',
      commit: git(wt, 'rev-parse', 'HEAD'),
      privateClone: null,
    });
    expect(json.legacyLocalIndex).toMatchObject({ path: path.join(wt, '.gitnexus') });

    const { statusCommand } = await import('../../src/cli/status.js');
    const text = (await runIn(wt, () => statusCommand({}))).join('\n');
    expect(text).toMatch(/shared graph for commit/);
    expect(text).toMatch(/gitnexus clean --local-index --force/);
  }, 240_000);

  it('clean --local-index deletes only the leftover files and keeps the pointer', async () => {
    await legacyIndex(wt);
    await analyze(wt);
    const { cleanCommand } = await import('../../src/cli/clean.js');

    await runIn(wt, () => cleanCommand({ localIndex: true }));
    expect(existsSync(path.join(wt, '.gitnexus', 'lbug'))).toBe(true); // preview only

    await runIn(wt, () => cleanCommand({ localIndex: true, force: true }));
    expect((await fs.readdir(path.join(wt, '.gitnexus'))).sort()).toEqual([
      '.gitignore',
      'run.cjs',
      'store.json',
    ]);
    expect((await statusJson(wt)).legacyLocalIndex).toBeNull();
    expect((await statusJson(wt)).status).toBe('up-to-date');
  }, 240_000);

  it('status reports a pinned branch index as private even when the flat slot is shared', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await analyze(wt);
    // The flat slot now holds `wt` and points at a shared commit graph. A
    // different checked-out branch pinned with --branch gets its own index.
    git(wt, 'checkout', '-q', '-b', 'pinned');
    await runFullAnalysis(wt, { branch: 'pinned' }, { onProgress: () => {} });
    const json = await statusJson(wt);
    expect(json.sharedStore).toMatchObject({ graph: 'private' });
  }, 240_000);

  it('status reports a private graph for an edited worktree', async () => {
    await analyze(wt);
    await fs.writeFile(path.join(wt, 'a.ts'), 'export function alphaEdited() { return 1; }\n');
    await analyze(wt);
    expect((await statusJson(wt)).sharedStore).toMatchObject({ graph: 'private' });
  }, 240_000);

  it('indexes into .gitnexus with sharing turned off and never writes the commit graph', async () => {
    await analyze(wt);
    const layout = layoutOf(wt);
    const commitDir = (await fs.readdir(layout.commitsDir)).find((n) => !n.startsWith('.'));
    const commitGraph = path.join(layout.commitsDir, commitDir as string, 'lbug');
    const before = await fs.readFile(commitGraph);

    await fs.writeFile(path.join(wt, 'b.ts'), 'export function beta() { return 2; }\n');
    process.env[SHARED_STORE_ENV] = 'off';
    try {
      await analyze(wt);
    } finally {
      delete process.env[SHARED_STORE_ENV];
    }

    expect(existsSync(path.join(wt, '.gitnexus', 'lbug'))).toBe(true);
    expect((await listRegisteredRepos()).find((e) => e.path === wt)?.storagePath).toBe(
      path.join(wt, '.gitnexus'),
    );
    expect(await fs.readFile(commitGraph)).toEqual(before);
  }, 240_000);

  it('keeps committed agent docs pointing at a runner inside the checkout', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wt, { registryName: 'wt' }, { onProgress: () => {} });
    expect(existsSync(path.join(wt, '.gitnexus', 'run.cjs'))).toBe(true);
    const agents = await fs.readFile(path.join(wt, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('.gitnexus/run.cjs');
    expect(agents).not.toContain('stores/');
  }, 240_000);

  it('drops pinned branch summaries when a checkout moves into the store', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    process.env[SHARED_STORE_ENV] = 'off';
    try {
      await runFullAnalysis(wt, { branch: 'wt' }, { onProgress: () => {} });
      await analyze(wt);
    } finally {
      delete process.env[SHARED_STORE_ENV];
    }
    await analyze(wt);
    const entry = (await listRegisteredRepos()).find((e) => e.path === wt);
    expect(entry?.storagePath).toBe(layoutOf(wt).checkoutSlot);
    expect(entry?.branches).toBeUndefined();
  }, 240_000);

  it('re-registers at .gitnexus when sharing is turned off on an up-to-date index', async () => {
    await legacyIndex(wt);
    await analyze(wt);
    process.env[SHARED_STORE_ENV] = 'off';
    try {
      const result = await analyze(wt);
      expect(result.alreadyUpToDate).toBe(true);
    } finally {
      delete process.env[SHARED_STORE_ENV];
    }
    expect((await listRegisteredRepos()).find((e) => e.path === wt)?.storagePath).toBe(
      path.join(wt, '.gitnexus'),
    );
    expect(readSharedStorePointer(wt)).toBeNull();
  }, 240_000);

  it('rejects a pointer that names another checkout slot', async () => {
    await analyze(wt);
    const pointer = path.join(wt, '.gitnexus', 'store.json');
    const other = layoutOf(main).checkoutSlot;
    await fs.writeFile(pointer, JSON.stringify({ version: 1, checkoutSlot: other }));
    expect(readSharedStorePointer(wt)).toBeNull();
    const ownSlot = layoutOf(wt).checkoutSlot;
    const otherStoreSlot = path.join(
      path.dirname(path.dirname(path.dirname(ownSlot))),
      'other-000000000000',
      'checkouts',
      path.basename(ownSlot),
    );
    await fs.writeFile(
      pointer,
      JSON.stringify({ version: 1, storeKey: 'other-000000000000', checkoutSlot: otherStoreSlot }),
    );
    expect(readSharedStorePointer(wt)).toBeNull();
    await fs.writeFile(
      pointer,
      JSON.stringify({ version: 1, storeKey: layoutOf(wt).key, checkoutSlot: otherStoreSlot }),
    );
    expect(readSharedStorePointer(wt)).toBeNull();
    await fs.writeFile(pointer, JSON.stringify({ version: 1, checkoutSlot: '/etc' }));
    expect(readSharedStorePointer(wt)).toBeNull();
    await fs.writeFile(pointer, 'not json');
    expect(readSharedStorePointer(wt)).toBeNull();
  }, 240_000);
});
