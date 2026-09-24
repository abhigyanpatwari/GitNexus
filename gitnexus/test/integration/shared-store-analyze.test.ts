import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { featureKeyOf, publishSharedGraph } from '../../src/core/shared-store-analyze.js';
import {
  getStoragePaths,
  listRegisteredRepos,
  loadMeta,
  saveMeta,
} from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import {
  commitGraphDir,
  resolveSharedStore,
  type SharedStoreLayout,
} from '../../src/storage/shared-store.js';
import { createTempDir } from '../helpers/test-db.js';

/**
 * #3352 — linked worktrees at one commit share one immutable commit graph in
 * the store under GITNEXUS_HOME, and a second worktree's analyze reuses it
 * without writing a graph.
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

const listCommitDirs = async (layout: SharedStoreLayout): Promise<string[]> =>
  (await fs.readdir(layout.commitsDir).catch(() => [] as string[])).filter(
    (name) => !name.startsWith('.'),
  );

describe('shared sibling store analyze (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;
  let main: string;
  let wtA: string;
  let wtB: string;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-shared-home-');
    tmpRepo = await createTempDir('gitnexus-shared-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;

    const root = await fs.realpath(tmpRepo.dbPath);
    main = path.join(root, 'main');
    wtA = path.join(root, 'wt-a');
    wtB = path.join(root, 'wt-b');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(
      path.join(main, 'a.ts'),
      'export function a() { return b(); }\nexport function b() { return 1; }\n',
    );
    commitAll(main, 'init');
    git(main, 'worktree', 'add', '-q', '-b', 'wt-a', wtA);
    git(main, 'worktree', 'add', '-q', '-b', 'wt-b', wtB);
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  it('Covers AE1: three clean worktrees at one commit share one commit graph', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const results = [];
    for (const checkout of [main, wtA, wtB]) {
      results.push(await runFullAnalysis(checkout, {}, { onProgress: () => {} }));
    }

    const layout = layoutOf(main);
    const commitDirs = await listCommitDirs(layout);
    expect(commitDirs).toHaveLength(1);
    const graph = path.join(layout.commitsDir, commitDirs[0], 'lbug');

    for (const checkout of [main, wtA, wtB]) {
      const slot = layoutOf(checkout).checkoutSlot;
      expect(getStoragePaths(checkout, undefined, slot).lbugPath).toBe(graph);
      expect(existsSync(path.join(slot, 'lbug'))).toBe(false);
      // The pre-existing repository-local index location is never written.
      expect(existsSync(path.join(checkout, '.gitnexus', 'lbug'))).toBe(false);
    }
    // Siblings after the first reuse the published graph without a pipeline run.
    expect(results.map((r) => r.alreadyUpToDate === true)).toEqual([false, true, true]);

    const registered = await listRegisteredRepos();
    for (const checkout of [main, wtA, wtB]) {
      const entry = registered.find((e) => e.path === checkout);
      expect(entry?.storagePath).toBe(layoutOf(checkout).checkoutSlot);
    }
  }, 180_000);

  it('reports a checkout that reads a commit graph as indexed', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    await runFullAnalysis(wtB, {}, { onProgress: () => {} });
    const slot = layoutOf(wtB).checkoutSlot;
    expect(existsSync(path.join(slot, 'lbug'))).toBe(false);

    const { inspectRegisteredStorage } = await import('../../src/storage/storage-resolver.js');
    const inspection = await inspectRegisteredStorage({ path: wtB, storagePath: slot });
    expect(inspection).toMatchObject({ state: 'owned', hasCodeIndexDB: true });
    const validated = await listRegisteredRepos({ validate: true });
    expect(validated.map((e) => e.path)).toEqual(expect.arrayContaining([wtA, wtB]));
  }, 180_000);

  it('Covers AE1: MCP opens one database for three checkouts on one commit graph', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    for (const checkout of [main, wtA, wtB]) {
      await runFullAnalysis(checkout, {}, { onProgress: () => {} });
    }
    const graphs = [main, wtA, wtB].map(
      (c) => getStoragePaths(c, undefined, layoutOf(c).checkoutSlot).lbugPath,
    );
    expect(new Set(graphs).size).toBe(1);

    const { initLbug, closeLbug } = await import('../../src/core/lbug/pool-adapter.js');
    const savedTrace = process.env.GITNEXUS_POOL_RSS_TRACE;
    process.env.GITNEXUS_POOL_RSS_TRACE = '1';
    const traces: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      if (String(chunk).startsWith('[pool-rss]')) traces.push(String(chunk));
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      for (const [i, graph] of graphs.entries()) await initLbug(`shared-${i}`, graph);
    } finally {
      process.stderr.write = write;
      if (savedTrace === undefined) delete process.env.GITNEXUS_POOL_RSS_TRACE;
      else process.env.GITNEXUS_POOL_RSS_TRACE = savedTrace;
      await closeLbug();
    }
    const last = traces.filter((t) => t.includes(' init ')).pop();
    expect(last).toMatch(/pool=3 dbCache=1 /);
  }, 240_000);

  it('serves a sibling the same relative file paths from the shared graph', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    await runFullAnalysis(wtB, {}, { onProgress: () => {} });

    const lbug = (await import('@ladybugdb/core')).default;
    const graph = getStoragePaths(wtB, undefined, layoutOf(wtB).checkoutSlot).lbugPath;
    const db = new lbug.Database(graph, 0, true, true);
    const conn = new lbug.Connection(db);
    const rows = (await (
      await conn.query('MATCH (f:File) RETURN f.filePath AS p ORDER BY p')
    ).getAll()) as { p: string }[];
    await conn.close();
    await db.close();
    expect(rows.map((r) => r.p)).toEqual(['a.ts']);
  }, 180_000);

  it('publishes a new commit graph when a clean worktree moves to a new commit', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    await fs.writeFile(path.join(wtA, 'c.ts'), 'export const c = 3;\n');
    commitAll(wtA, 'c');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });

    const layout = layoutOf(wtA);
    const head = git(wtA, 'rev-parse', 'HEAD');
    const meta = await loadMeta(layout.checkoutSlot);
    expect(meta?.lastCommit).toBe(head);
    expect(meta?.graphPath).toBe(
      path.join(commitGraphDir(layout, head, featureKeyOf(meta as RepoMeta)), 'lbug'),
    );
    expect(await listCommitDirs(layout)).toHaveLength(2);
  }, 180_000);
});

describe('featureKeyOf', () => {
  const base: RepoMeta = {
    repoPath: '/a',
    storagePath: '/a/.gitnexus',
    lastCommit: 'abc1234',
    indexedAt: '2026-01-01T00:00:00.000Z',
    schemaFingerprint: 'fp1',
    analysisFeatures: { x: 1 },
  };

  it('ignores per-checkout and per-run fields', () => {
    expect(
      featureKeyOf({
        ...base,
        repoPath: '/b',
        storagePath: '/b/.gitnexus',
        indexedAt: '2027-01-01T00:00:00.000Z',
        lastCommit: 'def5678',
        branch: 'feature',
        fileHashes: { 'a.ts': 'h' },
        stats: { nodes: 9 },
      }),
    ).toBe(featureKeyOf(base));
  });

  it('is independent of key order', () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as RepoMeta;
    expect(featureKeyOf(reordered)).toBe(featureKeyOf(base));
  });

  it.each([
    ['schema fingerprint', { schemaFingerprint: 'fp2' }],
    ['analysis features', { analysisFeatures: { x: 2 } }],
    ['PDG layer', { pdg: {} as RepoMeta['pdg'] }],
    ['content retention', { contentRetention: 'none' as const }],
    ['embeddings present', { stats: { embeddings: 3 } }],
  ])('changes with %s', (_label, delta) => {
    expect(featureKeyOf({ ...base, ...delta })).not.toBe(featureKeyOf(base));
  });
});

describe('publishSharedGraph race (#3352)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-shared-race-home-');
    tmpRepo = await createTempDir('gitnexus-shared-race-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  const setup = async (): Promise<{ checkouts: string[]; head: string }> => {
    const root = await fs.realpath(tmpRepo.dbPath);
    const main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(main, 'a.ts'), 'export const a = 1;\n');
    commitAll(main, 'init');
    const wt = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const head = git(main, 'rev-parse', 'HEAD');
    for (const checkout of [main, wt]) {
      const slot = layoutOf(checkout).checkoutSlot;
      await fs.mkdir(slot, { recursive: true });
      await fs.writeFile(path.join(slot, 'lbug'), `graph from ${checkout}`);
      await saveMeta(slot, {
        repoPath: checkout,
        storagePath: slot,
        lastCommit: head,
        indexedAt: new Date().toISOString(),
      });
    }
    return { checkouts: [main, wt], head };
  };

  it('Covers AE6: two checkouts publishing one new commit produce exactly one graph', async () => {
    const { checkouts } = await setup();
    await Promise.all(
      checkouts.map((c) =>
        publishSharedGraph(layoutOf(c), c, git(c, 'rev-parse', 'HEAD'), () => {}),
      ),
    );
    const layout = layoutOf(checkouts[0]);
    expect(await listCommitDirs(layout)).toHaveLength(1);
    const pointers = await Promise.all(
      checkouts.map(async (c) => (await loadMeta(layoutOf(c).checkoutSlot))?.graphPath),
    );
    expect(new Set(pointers).size).toBe(1);
    for (const c of checkouts) {
      expect(existsSync(path.join(layoutOf(c).checkoutSlot, 'lbug'))).toBe(false);
    }
  });

  it('keeps a private graph whose sidecars are not consolidated', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    const slot = layoutOf(main).checkoutSlot;
    await fs.writeFile(path.join(slot, 'lbug.wal'), 'pending');
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    expect(await listCommitDirs(layoutOf(main))).toEqual([]);
    expect(existsSync(path.join(slot, 'lbug'))).toBe(true);
    expect((await loadMeta(slot))?.graphPath).toBeUndefined();
  });

  it('keeps a dirty checkout private', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    await fs.writeFile(path.join(main, 'a.ts'), 'export const a = 2;\n');
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    expect(await listCommitDirs(layoutOf(main))).toEqual([]);
    expect(existsSync(path.join(layoutOf(main).checkoutSlot, 'lbug'))).toBe(true);
  });
});
