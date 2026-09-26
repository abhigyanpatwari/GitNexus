import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import { RebuildReasonCollector } from '../../src/core/rebuild-reasons.js';
import type { EmbeddingCheckpoint } from '../../src/core/embedding-checkpoint.js';
import { SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';
import {
  ensurePrivateSharedGraph,
  featureKeyOf,
  listStoreMetaRoots,
  publishSharedGraph,
  seedSharedSlot,
} from '../../src/core/shared-store-analyze.js';
import {
  getStoragePaths,
  listRegisteredRepos,
  loadMeta,
  saveMeta,
} from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import {
  commitGraphDir,
  resolveGraphPath,
  resolveSharedStore,
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
    tmpHome = await createTempDir('gitnexus-test-shared-home-');
    tmpRepo = await createTempDir('gitnexus-test-shared-repo-');
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
    let rows: { p: string }[];
    try {
      rows = (await (
        await conn.query('MATCH (f:File) RETURN f.filePath AS p ORDER BY p')
      ).getAll()) as { p: string }[];
    } finally {
      await conn.close();
      await db.close();
    }
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
    // The previous commit's graph is no longer referenced and is reclaimed at once.
    expect(await listCommitDirs(layout)).toEqual([
      path.basename(path.dirname(meta?.graphPath as string)),
    ]);
  }, 180_000);

  it('never publishes a graph that was built from uncommitted edits', async () => {
    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    await fs.writeFile(path.join(wtA, 'a.ts'), 'export function uncommitted() { return 9; }\n');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });
    git(wtA, 'checkout', '--', 'a.ts');
    await runFullAnalysis(wtA, {}, { onProgress: () => {} });

    const layout = layoutOf(wtA);
    expect(await listCommitDirs(layout)).toEqual([]);
    expect(existsSync(path.join(layout.checkoutSlot, 'lbug'))).toBe(true);
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
    tmpHome = await createTempDir('gitnexus-test-shared-race-home-');
    tmpRepo = await createTempDir('gitnexus-test-shared-race-repo-');
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

  // #3374: `git status` is clean in a sparse checkout, but the graph lacks the
  // files the checkout leaves out.
  it('keeps a checkout that hides committed files private', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    git(main, 'update-index', '--skip-worktree', '--', 'a.ts');
    await fs.rm(path.join(main, 'a.ts'));
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    expect(await listCommitDirs(layoutOf(main))).toEqual([]);
    expect(existsSync(path.join(layoutOf(main).checkoutSlot, 'lbug'))).toBe(true);
  });

  /** Fail every rename onto one of `blocked`; others run for real. */
  const blockRenamesOnto = (blocked: ReadonlySet<string>) => {
    const realRename = fs.rename.bind(fs);
    return vi
      .spyOn(fs, 'rename')
      .mockImplementation((from, to) =>
        blocked.has(String(to))
          ? Promise.reject(Object.assign(new Error('rename blocked'), { code: 'EIO' }))
          : realRename(from, to),
      );
  };

  // #3374: the staging dir holds the checkout's only graph once putting it
  // back fails; deleting it would leave metadata at HEAD with no graph.
  it('keeps the staged graph when putting it back fails', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    const layout = layoutOf(main);
    const slot = layout.checkoutSlot;
    const meta = (await loadMeta(slot)) as RepoMeta;
    const target = commitGraphDir(layout, head, featureKeyOf(meta));
    const spy = blockRenamesOnto(new Set([target, path.join(slot, 'lbug')]));
    try {
      await publishSharedGraph(layout, main, head, () => {});
    } finally {
      spy.mockRestore();
    }
    const staging = (await fs.readdir(layout.commitsDir)).filter((n) => n.startsWith('.publish-'));
    expect(staging).toHaveLength(1);
    expect(await fs.readFile(path.join(layout.commitsDir, staging[0], 'lbug'), 'utf-8')).toBe(
      `graph from ${main}`,
    );
    expect(await listCommitDirs(layout)).toEqual([]);
    expect((await loadMeta(slot))?.graphPath).toBeUndefined();
  });

  it('drops the staging dir when the graph never left the slot', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    const layout = layoutOf(main);
    const slot = layout.checkoutSlot;
    const meta = (await loadMeta(slot)) as RepoMeta;
    const target = commitGraphDir(layout, head, featureKeyOf(meta));
    const spy = blockRenamesOnto(new Set([target]));
    try {
      await publishSharedGraph(layout, main, head, () => {});
    } finally {
      spy.mockRestore();
    }
    expect(await fs.readdir(layout.commitsDir)).toEqual([]);
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe(`graph from ${main}`);
  });

  const seedFreshSlot = async (checkout: string): Promise<RepoMeta | null> => {
    const layout = layoutOf(checkout);
    await fs.rm(layout.checkoutSlot, { recursive: true, force: true });
    await seedSharedSlot(layout, checkout, () => {});
    return loadMeta(layout.checkoutSlot);
  };

  it('seeds a pristine checkout at the graph commit as up to date', async () => {
    const { checkouts, head } = await setup();
    const [main, wt] = checkouts;
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    const seeded = await seedFreshSlot(wt);
    expect(seeded?.graphPath).toBe((await loadMeta(layoutOf(main).checkoutSlot))?.graphPath);
    expect(seeded?.lastCommit).toBe(head);
  });

  it('seeds a checkout that hides committed files without a commit, then re-points', async () => {
    const { checkouts, head } = await setup();
    const [main, wt] = checkouts;
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    const shared = (await loadMeta(layoutOf(main).checkoutSlot))?.graphPath;
    git(wt, 'update-index', '--skip-worktree', '--', 'a.ts');
    const seeded = await seedFreshSlot(wt);
    expect(seeded?.graphPath).toBe(shared);
    // An empty lastCommit sends the next analyze through the file-hash diff.
    expect(seeded?.lastCommit).toBe('');

    // That analyze copies the graph, finds nothing to change, and stamps HEAD;
    // once the checkout shows every file again, publish drops the copy.
    const slot = layoutOf(wt).checkoutSlot;
    expect(await ensurePrivateSharedGraph(slot, () => {})).toBe(true);
    const copied = await loadMeta(slot);
    expect(copied).not.toBeNull();
    await saveMeta(slot, { ...(copied as RepoMeta), lastCommit: head });
    git(wt, 'update-index', '--no-skip-worktree', '--', 'a.ts');
    await publishSharedGraph(layoutOf(wt), wt, head, () => {});
    expect((await loadMeta(slot))?.graphPath).toBe(shared);
    expect(existsSync(path.join(slot, 'lbug'))).toBe(false);
  });

  const checkpoint: EmbeddingCheckpoint = {
    at: '2026-01-01T00:00:00.000Z',
    nodesProcessed: 1,
    totalNodes: 2,
    chunksProcessed: 1,
    model: 'm',
    dimensions: 4,
    provider: 'local',
    kind: 'partial',
    pendingNodeIds: ['n2'],
  };

  // #3374: a graph with embeddings still owed would become every checkout's
  // graph, and its checkpoint-free copy would look complete forever.
  it('keeps a graph with pending embeddings private', async () => {
    const { checkouts, head } = await setup();
    const [main] = checkouts;
    const slot = layoutOf(main).checkoutSlot;
    const meta = (await loadMeta(slot)) as RepoMeta;
    await saveMeta(slot, { ...meta, embeddingCheckpoint: checkpoint });
    await publishSharedGraph(layoutOf(main), main, head, () => {});
    expect(await listCommitDirs(layoutOf(main))).toEqual([]);
    expect(existsSync(path.join(slot, 'lbug'))).toBe(true);
    expect((await loadMeta(slot))?.embeddingCheckpoint).toEqual(checkpoint);
  });

  // A commit graph published before that rule may still be the weaker one;
  // the checkout keeps its own graph rather than trading down to it.
  it.each<[string, Partial<RepoMeta>]>([
    ['records pending embeddings', { embeddingCheckpoint: checkpoint, stats: { embeddings: 5 } }],
    ['has fewer embeddings', { stats: { embeddings: 2 } }],
  ])('keeps the private graph when the published one %s', async (_label, targetDelta) => {
    const { checkouts, head } = await setup();
    const [main, wt] = checkouts;
    const layout = layoutOf(main);
    const slot = layout.checkoutSlot;
    const own: RepoMeta = { ...((await loadMeta(slot)) as RepoMeta), stats: { embeddings: 5 } };
    await saveMeta(slot, own);
    const target = commitGraphDir(layout, head, featureKeyOf(own));
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'lbug'), 'older published graph');
    const targetMeta: Partial<RepoMeta> = {
      lastCommit: head,
      indexedAt: own.indexedAt,
      ...targetDelta,
    };
    await fs.writeFile(path.join(target, 'gitnexus.json'), JSON.stringify(targetMeta));
    // Another checkout reads the published graph.
    const wtSlot = layoutOf(wt).checkoutSlot;
    await fs.rm(path.join(wtSlot, 'lbug'));
    const wtMeta = (await loadMeta(wtSlot)) as RepoMeta;
    await saveMeta(wtSlot, { ...wtMeta, graphPath: path.join(target, 'lbug') });
    await publishSharedGraph(layout, main, head, () => {});
    expect(await fs.readFile(path.join(slot, 'lbug'), 'utf-8')).toBe(`graph from ${main}`);
    expect((await loadMeta(slot))?.graphPath).toBeUndefined();
    // The published graph is immutable: other checkouts may point at it.
    expect(await fs.readFile(path.join(target, 'lbug'), 'utf-8')).toBe('older published graph');
  });
});

// #3374: a publish interrupted between its renames (or a reclaimed commit
// graph) leaves slot metadata at HEAD with no graph behind it.
describe('up-to-date fast path over a missing shared graph (#3374)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let tmpRepo: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-test-shared-missing-home-');
    tmpRepo = await createTempDir('gitnexus-test-shared-missing-repo-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await tmpRepo.cleanup();
    await tmpHome.cleanup();
  });

  /** A linked-worktree checkout slot whose metadata is current in every stamp. */
  const currentCheckoutSlot = async (
    overrides: Partial<RepoMeta> = {},
  ): Promise<{ wt: string; slot: string }> => {
    const root = await fs.realpath(tmpRepo.dbPath);
    const main = path.join(root, 'main');
    await fs.mkdir(main);
    git(main, 'init', '-q', '-b', 'main');
    git(
      main,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init',
    );
    const wt = path.join(root, 'wt');
    git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const slot = layoutOf(wt).checkoutSlot;
    await fs.mkdir(slot, { recursive: true });
    await saveMeta(slot, {
      repoPath: wt,
      storagePath: slot,
      lastCommit: git(wt, 'rev-parse', 'HEAD'),
      indexedAt: new Date().toISOString(),
      schemaFingerprint: SCHEMA_FINGERPRINT,
      analysisFeatures: {
        [CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.id]: CLASS_FRAMEWORK_ANNOTATIONS_FEATURE.version,
      },
      runnerIdentity: resolveAnalyzerRunnerIdentity(
        pathToFileURL(path.resolve(__dirname, '../../src/core/run-analyze.ts')).href,
      ),
      // Same FTS mode as the runs below, so only the graph can decide
      // against the fast path.
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' },
        fts: { provider: 'ladybugdb-fts', status: 'unavailable', skipReason: 'disabled-by-flag' },
        vectorSearch: { provider: 'exact-scan', status: 'unavailable', exactScanLimit: 0 },
      },
      ...overrides,
    });
    return { wt, slot };
  };

  it('rebuilds a slot whose metadata is at HEAD but whose graph is gone', async () => {
    const { wt, slot } = await currentCheckoutSlot();

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const result = await runFullAnalysis(
      wt,
      { skipAgentsMd: true, skipSkills: true, skipFts: true },
      { onProgress: () => {} },
    );

    expect(result.alreadyUpToDate).not.toBe(true);
    expect(result.rebuildReasons).toEqual(['shared-store-missing-graph']);
    expect(existsSync(resolveGraphPath(slot))).toBe(true);
  }, 120_000);

  it('names a failed shared-graph copy in the summary, not in a follow-up (#3137)', async () => {
    // The slot records an older commit, so the run reaches the copy, and
    // points at a published commit graph that exists but cannot be copied (a
    // directory where the graph file belongs).
    const olderCommit = '0'.repeat(40);
    const { wt, slot } = await currentCheckoutSlot({ lastCommit: olderCommit });
    const unreadableGraph = path.join(
      commitGraphDir(layoutOf(wt), olderCommit, 'deadbeefdeadbeef'),
      'lbug',
    );
    await fs.mkdir(unreadableGraph, { recursive: true });
    const meta = await loadMeta(slot);
    if (meta === null) throw new Error('slot metadata missing');
    await saveMeta(slot, { ...meta, graphPath: unreadableGraph });
    expect(resolveGraphPath(slot)).toBe(unreadableGraph);

    const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
    const logs: string[] = [];
    const result = await runFullAnalysis(
      wt,
      { skipAgentsMd: true, skipSkills: true, skipFts: true },
      { onProgress: () => {}, onLog: (m) => logs.push(m) },
    );

    expect(result.rebuildReasons).toEqual(['private-graph-unavailable']);
    const single = new RebuildReasonCollector();
    single.add({ key: 'private-graph-unavailable', text: '' });
    const summaryPrefix = single.formatSummary() ?? '';
    const late = new RebuildReasonCollector();
    late.formatSummary();
    late.add({ key: 'private-graph-unavailable', text: '' });
    const followUpPrefix = late.formatFollowUp() ?? '';
    expect(logs.filter((m) => m.startsWith(summaryPrefix))).toHaveLength(1);
    expect(logs.filter((m) => m.startsWith(followUpPrefix))).toEqual([]);
  }, 120_000);
});

describe('listStoreMetaRoots', () => {
  let tmp: Awaited<ReturnType<typeof createTempDir>>;
  let layout: SharedStoreLayout;

  beforeEach(async () => {
    tmp = await createTempDir('gitnexus-test-store-roots-');
    const root = path.join(tmp.dbPath, 'store');
    layout = {
      key: 'repo-0000',
      root,
      cachesDir: path.join(root, 'caches'),
      commitsDir: path.join(root, 'commits'),
      checkoutsDir: path.join(root, 'checkouts'),
      checkoutSlot: path.join(root, 'checkouts', 'slot-a'),
      canonicalCheckout: null,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tmp.cleanup();
  });

  it('stays complete when the store directories do not exist yet', async () => {
    expect(await listStoreMetaRoots(layout)).toEqual({ roots: [], complete: true });
  });

  it('lists checkout slots and commit graphs, skipping dot entries', async () => {
    await fs.mkdir(path.join(layout.checkoutsDir, 'slot-a'), { recursive: true });
    await fs.mkdir(path.join(layout.checkoutsDir, '.lock'), { recursive: true });
    await fs.mkdir(path.join(layout.commitsDir, 'abc'), { recursive: true });
    expect(await listStoreMetaRoots(layout)).toEqual({
      roots: [path.join(layout.checkoutsDir, 'slot-a'), path.join(layout.commitsDir, 'abc')],
      complete: true,
    });
  });

  it('reports an incomplete listing when a store directory cannot be read', async () => {
    await fs.mkdir(path.join(layout.commitsDir, 'abc'), { recursive: true });
    await fs.mkdir(layout.checkoutsDir, { recursive: true });
    const realReaddir = fs.readdir;
    vi.spyOn(fs, 'readdir').mockImplementation((async (dir: string) => {
      if (dir === layout.checkoutsDir) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realReaddir(dir);
    }) as unknown as typeof fs.readdir);
    expect(await listStoreMetaRoots(layout)).toEqual({
      roots: [path.join(layout.commitsDir, 'abc')],
      complete: false,
    });
  });
});
