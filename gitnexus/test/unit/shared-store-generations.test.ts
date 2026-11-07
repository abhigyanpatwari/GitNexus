import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensurePrivateSharedGraph,
  featureKeyOf,
  publishSharedGraph,
  seedSharedSlot,
} from '../../src/core/shared-store-analyze.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import {
  describeSharedGraph,
  reclaimSharedStore,
} from '../../src/storage/shared-store-lifecycle.js';
import {
  resolveGraphPath,
  resolveGraphWritePath,
  sharedStoreLayout,
} from '../../src/storage/shared-store.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import { acquireIndexLock } from '../../src/storage/index-lock.js';
import {
  acquireAnalysisSlotLock,
  sharedMemberGatePath,
} from '../../src/storage/analysis-slot-lock.js';

it('reports named slot-local generations as private and commit graphs as shared', () => {
  const slot = path.resolve('store/checkouts/owner');
  expect(describeSharedGraph(path.join(slot, 'lbug'), slot)).toBe('private');
  expect(describeSharedGraph(path.join(slot, `lbug.generation.${'a'.repeat(32)}`), slot)).toBe(
    'private',
  );
  expect(describeSharedGraph(path.resolve('store/commits/commit-feature/lbug'), slot)).toBe(
    'shared',
  );
  expect(describeSharedGraph(path.resolve('store/checkouts/owner-other/lbug'), slot)).toBe(
    'shared',
  );
});

describe('shared-store logical generations', () => {
  let root: string;
  let repo: string;
  let head: string;
  let slot: string;
  let layout: ReturnType<typeof sharedStoreLayout>;
  const generation = `lbug.generation.${'a'.repeat(32)}`;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  const metadata = (extra: Partial<RepoMeta> = {}): RepoMeta => ({
    repoPath: repo,
    storagePath: slot,
    lastCommit: head,
    indexedAt: '2026-11-04T00:00:00Z',
    parseCacheIdentity: { base: 'fixture-parser' },
    ...extra,
  });
  const modern = (extra: Partial<RepoMeta> = {}): RepoMeta =>
    metadata({
      graphGeneration: { version: 1, id: 'a'.repeat(32), coveredContent: 'c'.repeat(64) },
      ...extra,
    });
  const requireMeta = async (directory: string): Promise<RepoMeta> => {
    const meta = await loadMeta(directory);
    if (!meta) throw new Error(`Missing fixture metadata: ${directory}`);
    return meta;
  };
  const vector = (): NonNullable<RepoMeta['vectorGeneration']> => ({
    version: 1,
    identity: 'b'.repeat(64),
    graphGeneration: 'a'.repeat(32),
    vectorIdentity: 'd'.repeat(64),
    inputIdentity: 'e'.repeat(64),
    dimensions: 4,
    nodes: 1,
    chunks: 1,
    indexKind: 'exact',
  });
  const vectorFile = (directory: string) =>
    path.join(directory, 'embeddings', 'b'.repeat(64), 'vectors');
  const writeVector = async (directory: string) => {
    const file = vectorFile(directory);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // These fixtures test filesystem ownership; native seals are tested in
    // embedding-vector-store.test.ts and the published-job controller suite.
    await fs.writeFile(file, 'sealed vector filesystem fixture');
    return file;
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gn-shared-generations-')));
    vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
    repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-qm', 'fixture');
    head = git('rev-parse', 'HEAD');
    layout = sharedStoreLayout('fixture-0123456789ab', repo);
    slot = layout.checkoutSlot;
    await fs.mkdir(slot, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('shares modern graph facts independently of logical IDs and separate vector work', () => {
    const a = modern({ stats: { embeddings: 0 } });
    const b = modern({
      graphGeneration: { version: 1, coveredContent: 'c'.repeat(64), id: 'f'.repeat(32) },
      embeddingDims: 4,
      vectorGeneration: vector(),
      embeddingJob: { version: 1, identity: '1'.repeat(64), graphGeneration: 'f'.repeat(32) },
      legacyVectorSource: '2'.repeat(64),
      stats: { embeddings: 1 },
    });
    expect(featureKeyOf(a)).toBe(featureKeyOf(b));
    expect(
      featureKeyOf({
        ...b,
        graphGeneration: { version: 1, id: 'f'.repeat(32), coveredContent: '9'.repeat(64) },
      }),
    ).not.toBe(featureKeyOf(a));
    expect(featureKeyOf({ ...b, schemaFingerprint: 'different graph schema' })).not.toBe(
      featureKeyOf(a),
    );
    expect(featureKeyOf(metadata({ stats: { embeddings: 0 } }))).not.toBe(
      featureKeyOf(metadata({ stats: { embeddings: 1 } })),
    );
  });

  it('publishes a completed vector pin without copying its contents', async () => {
    await fs.writeFile(path.join(slot, generation), 'completed graph');
    const original = await writeVector(slot);
    await saveMeta(
      slot,
      modern({ graphPath: generation, vectorGeneration: vector(), stats: { embeddings: 1 } }),
    );
    const copy = vi.spyOn(fs, 'copyFile');
    await publishSharedGraph(layout, repo, head, () => {});
    const committed = path.dirname(resolveGraphPath(slot));
    expect((await loadMeta(committed))?.vectorGeneration).toEqual(vector());
    expect((await fs.stat(vectorFile(committed))).ino).toBe((await fs.stat(original)).ino);
    expect(copy).not.toHaveBeenCalled();
  });

  it('keeps the private graph while historical vectors still belong to its migration', async () => {
    const graph = path.join(slot, generation);
    await fs.writeFile(graph, 'graph with preserved legacy vectors');
    const meta = modern({
      graphPath: generation,
      legacyVectorSource: 'e'.repeat(64),
      embeddingDims: 4,
      stats: { embeddings: 3 },
    });
    await saveMeta(slot, meta);
    await publishSharedGraph(layout, repo, head, () => {});
    expect(resolveGraphPath(slot)).toBe(graph);
    expect(await loadMeta(slot)).toMatchObject(meta);
    expect(await fs.readFile(graph, 'utf8')).toBe('graph with preserved legacy vectors');
  });

  it('does not collect an orphan member while a branch writer owns its lock', async () => {
    await saveMeta(slot, metadata({ repoPath: path.join(root, 'removed-checkout') }));
    const branch = path.join(slot, 'branches', 'feature');
    await fs.mkdir(branch, { recursive: true });
    const lock = await acquireIndexLock(branch, { sweep: false });
    try {
      expect((await reclaimSharedStore(layout.root, { gc: true })).droppedMembers).toEqual([]);
      expect((await fs.stat(branch)).isDirectory()).toBe(true);
    } finally {
      lock.release();
    }
    expect((await reclaimSharedStore(layout.root, { gc: true })).droppedMembers).toEqual([slot]);
  });

  it('admits new branch writers under the member gate, then releases it for sibling work', async () => {
    const gate = await acquireIndexLock(slot, { sweep: false });
    const branch = path.join(slot, 'branches', 'new-branch');
    try {
      await expect(
        acquireAnalysisSlotLock(branch, { timeoutMs: 1, sweep: false }),
      ).rejects.toThrow();
    } finally {
      gate.release();
    }
    const writer = await acquireAnalysisSlotLock(branch, { timeoutMs: 1000, sweep: false });
    try {
      const rootWriter = await acquireIndexLock(slot, { timeoutMs: 1000, sweep: false });
      rootWriter.release();
      await expect(acquireIndexLock(branch, { timeoutMs: 1, sweep: false })).rejects.toThrow();
    } finally {
      writer.release();
    }
  });

  it('uses the same file-backed admission gate through a storage-home alias', async () => {
    vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
    const alias = path.join(root, 'home-alias');
    await fs.symlink(path.join(root, 'home'), alias, 'junction');
    const gate = await acquireIndexLock(sharedMemberGatePath(layout.root, slot), { sweep: false });
    try {
      vi.stubEnv('GITNEXUS_HOME', alias);
      const branch = path.join(
        alias,
        'stores',
        path.basename(layout.root),
        'checkouts',
        path.basename(slot),
        'branches',
        'aliased',
      );
      const writer = await acquireAnalysisSlotLock(branch, { timeoutMs: 1, sweep: false }).catch(
        () => null,
      );
      writer?.release();
      expect(writer).toBeNull();
    } finally {
      gate.release();
    }
  });

  it.each([
    { stage: 'member', kind: 'flat' },
    { stage: 'graph', kind: 'flat' },
    { stage: 'store', kind: 'flat' },
    { stage: 'member', kind: 'branch' },
    { stage: 'graph', kind: 'branch' },
    { stage: 'store', kind: 'branch' },
  ])('keeps $kind admission closed throughout orphan $stage deletion', async ({ stage, kind }) => {
    vi.stubEnv('GITNEXUS_INDEX_LOCK_BACKEND', 'file');
    await saveMeta(slot, metadata({ repoPath: path.join(root, 'removed-checkout') }));
    const commit = path.join(layout.commitsDir, 'unreferenced');
    await fs.mkdir(commit, { recursive: true });
    await fs.writeFile(path.join(commit, 'lbug'), 'old graph');
    const branch = kind === 'flat' ? slot : path.join(slot, 'branches', 'new-branch');
    const remove = fs.rm.bind(fs);
    let checked = false;
    let admission: string | undefined;
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      await remove(target, options);
      const deleting = stage === 'member' ? slot : stage === 'graph' ? commit : layout.root;
      if (String(target) !== deleting) return;
      checked = true;
      // A second process must consult the lock on disk, not this process's
      // in-memory lock queue, after GC has removed the old member directory.
      const moduleUrl = new URL('../../src/storage/analysis-slot-lock.ts', import.meta.url).href;
      const { stdout } = await promisify(execFile)(process.execPath, [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `import { acquireAnalysisSlotLock } from ${JSON.stringify(moduleUrl)};
         const lock = await acquireAnalysisSlotLock(${JSON.stringify(branch)}, { timeoutMs: 1, sweep: false }).catch(() => null);
         console.log(lock ? 'admitted' : 'blocked');
         lock?.release();`,
      ]);
      admission = stdout.trim();
    });
    const result = await reclaimSharedStore(layout.root, { gc: true });
    expect(checked).toBe(true);
    expect(admission).toBe('blocked');
    expect(result.droppedMembers).toEqual([slot]);
    expect(result.storeRemoved).toBe(true);
    const writer = await acquireAnalysisSlotLock(branch, { timeoutMs: 1000, sweep: false });
    writer.release();
  });

  it.each(['e'.repeat(64), null])(
    'retains an orphan with historical vector evidence: %s',
    async (source) => {
      await saveMeta(
        slot,
        metadata({
          repoPath: path.join(root, 'removed-checkout'),
          legacyVectorSource: source as unknown as string,
        }),
      );
      expect((await reclaimSharedStore(layout.root, { gc: true })).droppedMembers).toEqual([]);
      expect(await loadMeta(slot)).toHaveProperty('legacyVectorSource', source);
    },
  );

  it('seeds independent completed vector pins that survive collection of their source', async () => {
    await fs.writeFile(path.join(slot, generation), 'completed graph');
    const original = await writeVector(slot);
    const inode = (await fs.stat(original)).ino;
    await saveMeta(
      slot,
      modern({ graphPath: generation, vectorGeneration: vector(), stats: { embeddings: 1 } }),
    );
    await publishSharedGraph(layout, repo, head, () => {});
    const sibling = path.join(root, 'sibling');
    git('worktree', 'add', '-q', '-b', 'sibling', sibling);
    const next = sharedStoreLayout(path.basename(layout.root), sibling);
    await seedSharedSlot(next, sibling, () => {});
    expect((await fs.stat(vectorFile(next.checkoutSlot))).ino).toBe(inode);
    const seeded = await requireMeta(next.checkoutSlot);
    expect(seeded?.vectorGeneration).toEqual(vector());
    await fs.writeFile(path.join(next.checkoutSlot, generation), 'equivalent private graph');
    await saveMeta(next.checkoutSlot, { ...seeded, graphPath: generation });
    await fs.rm(slot, { recursive: true, force: true });
    expect((await reclaimSharedStore(layout.root)).removed).toHaveLength(1);
    expect(await fs.readFile(vectorFile(next.checkoutSlot), 'utf8')).toBe(
      'sealed vector filesystem fixture',
    );
  });

  it('keeps pending job ownership in its checkout when publishing graph facts', async () => {
    const job = { version: 1 as const, identity: 'b'.repeat(64), graphGeneration: 'a'.repeat(32) };
    await fs.writeFile(path.join(slot, generation), 'ready graph');
    await saveMeta(slot, modern({ graphPath: generation, embeddingJob: job }));
    await publishSharedGraph(layout, repo, head, () => {});
    expect((await loadMeta(slot))?.embeddingJob).toEqual(job);
    const committed = await loadMeta(path.dirname(resolveGraphPath(slot)));
    expect(committed?.graphGeneration).toEqual(modern().graphGeneration);
    expect(committed?.embeddingJob).toBeUndefined();
    expect(committed?.legacyVectorSource).toBeUndefined();
  });

  it('adds completed vectors to an already published graph without replacing that graph', async () => {
    await fs.writeFile(path.join(slot, generation), 'ready graph');
    await saveMeta(slot, modern({ graphPath: generation }));
    await publishSharedGraph(layout, repo, head, () => {});
    const graph = resolveGraphPath(slot);
    const graphInode = (await fs.stat(graph)).ino;
    const original = await writeVector(slot);
    const before = await requireMeta(slot);
    await saveMeta(slot, { ...before, vectorGeneration: vector(), stats: { embeddings: 1 } });
    await publishSharedGraph(layout, repo, head, () => {});
    expect(resolveGraphPath(slot)).toBe(graph);
    expect((await fs.stat(graph)).ino).toBe(graphInode);
    expect((await loadMeta(path.dirname(graph)))?.vectorGeneration).toEqual(vector());
    expect((await fs.stat(vectorFile(path.dirname(graph)))).ino).toBe(
      (await fs.stat(original)).ino,
    );
  });

  it('adopts a completed local generation with its vectors while retaining the source', async () => {
    const source = path.join(repo, '.gitnexus');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, generation), 'local generation');
    const original = await writeVector(source);
    await saveMeta(
      source,
      modern({
        storagePath: source,
        graphPath: generation,
        vectorGeneration: vector(),
        stats: { embeddings: 1 },
      }),
    );
    await seedSharedSlot(layout, repo, () => {});
    expect(await fs.readFile(resolveGraphPath(slot), 'utf8')).toBe('local generation');
    expect((await loadMeta(slot))?.vectorGeneration).toEqual(vector());
    expect((await fs.stat(vectorFile(slot))).ino).toBe((await fs.stat(original)).ino);
    expect(await fs.readFile(path.join(source, generation), 'utf8')).toBe('local generation');
  });

  it('retains historical coverage and the exact-scan limit in shared metadata', async () => {
    await fs.writeFile(path.join(slot, generation), 'ready graph');
    await writeVector(slot);
    const completed = {
      ...vector(),
      graphGeneration: 'f'.repeat(32),
      preservedForGraph: 'a'.repeat(32),
      chunks: 5,
    };
    const meta = modern({
      graphPath: generation,
      vectorGeneration: completed,
      capabilities: {
        graph: { provider: 'ladybugdb', status: 'available' },
        fts: { provider: 'ladybugdb', status: 'available' },
        vectorSearch: { provider: 'exact-scan', status: 'exact-scan', exactScanLimit: 2 },
      },
    });
    await saveMeta(slot, meta);
    await publishSharedGraph(layout, repo, head, () => {});
    const published = await requireMeta(path.dirname(resolveGraphPath(slot)));
    expect(published.vectorGeneration).toEqual(completed);
    expect(published.capabilities?.vectorSearch).toMatchObject({
      status: 'unavailable',
      reason: 'vector-index-pending',
      coverage: 'preserved',
      sourceGraphGeneration: 'f'.repeat(32),
      exactScanLimit: 2,
    });
    expect(featureKeyOf(published)).toBe(featureKeyOf(meta));
  });

  it('keeps a modern private graph when an existing shared graph has no metadata', async () => {
    const meta = modern({ graphPath: generation });
    const target = path.join(layout.commitsDir, `${head}-${featureKeyOf(meta)}`);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'lbug'), 'unverified shared graph');
    await fs.writeFile(path.join(slot, generation), 'verified private graph');
    await saveMeta(slot, meta);
    await publishSharedGraph(layout, repo, head, () => {});
    expect(resolveGraphPath(slot)).toBe(path.join(slot, generation));
    expect(await fs.readFile(resolveGraphPath(slot), 'utf8')).toBe('verified private graph');
  });

  it('keeps a legacy checkpoint with its owner when seeding a sibling', async () => {
    const source = path.join(repo, '.gitnexus');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'lbug'), 'legacy graph');
    const checkpoint = {
      at: '2026-11-07T00:00:00Z',
      nodesProcessed: 1,
      totalNodes: 2,
      chunksProcessed: 1,
      model: 'fixture',
      dimensions: 4,
      provider: 'local',
    };
    await saveMeta(source, metadata({ storagePath: source, embeddingCheckpoint: checkpoint }));
    await expect(seedSharedSlot(layout, repo, () => {})).rejects.toThrow('embedding work');
    expect(await loadMeta(slot)).toBeNull();
    const sibling = path.join(root, 'sibling');
    git('worktree', 'add', '-q', '-b', 'sibling', sibling);
    const next = {
      ...sharedStoreLayout(path.basename(layout.root), sibling),
      canonicalCheckout: repo,
    };
    await seedSharedSlot(next, sibling, () => {});
    expect(await loadMeta(next.checkoutSlot)).toBeNull();
    await expect(fs.stat(path.join(next.checkoutSlot, 'lbug'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await requireMeta(source)).embeddingCheckpoint).toEqual(checkpoint);
    expect(await fs.readFile(path.join(source, 'lbug'), 'utf8')).toBe('legacy graph');
    const completed = await requireMeta(source);
    delete completed.embeddingCheckpoint;
    await saveMeta(source, completed);
    await seedSharedSlot(next, sibling, () => {});
    expect(await fs.readFile(resolveGraphPath(next.checkoutSlot), 'utf8')).toBe('legacy graph');
    expect((await requireMeta(next.checkoutSlot)).embeddingCheckpoint).toBeUndefined();
  });

  it.each(['embeddingJob', 'legacyVectorSource'] as const)(
    "refuses to strand this checkout's %s during adoption",
    async (field) => {
      const source = path.join(repo, '.gitnexus');
      await fs.mkdir(source);
      await fs.writeFile(path.join(source, generation), 'local generation');
      const job = {
        version: 1 as const,
        identity: 'b'.repeat(64),
        graphGeneration: 'a'.repeat(32),
      };
      const retained = field === 'embeddingJob' ? job : 'b'.repeat(64);
      await saveMeta(
        source,
        modern({ storagePath: source, graphPath: generation, [field]: retained }),
      );
      await expect(seedSharedSlot(layout, repo, () => {})).rejects.toThrow('embedding work');
      expect((await loadMeta(source))?.[field]).toEqual(retained);
      expect(await fs.readFile(path.join(source, generation), 'utf8')).toBe('local generation');
      expect(await loadMeta(slot)).toBeNull();
    },
  );

  it.each([true, false])(
    'keeps an owned generation in place without copying or dropping its pointer (copy=%s)',
    async (copy) => {
      const file = path.join(slot, generation);
      await fs.writeFile(file, 'private graph');
      await saveMeta(slot, metadata({ graphPath: generation }));
      const before = await fs.stat(file);
      const copyFile = vi.spyOn(fs, 'copyFile');
      const log = vi.fn();
      expect(await ensurePrivateSharedGraph(slot, log, { copy })).toBe(true);
      expect(resolveGraphPath(slot)).toBe(file);
      expect((await fs.stat(file)).ino).toBe(before.ino);
      await expect(fs.stat(path.join(slot, 'lbug'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(copyFile).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('routes only immutable shared graphs to a new private write target', async () => {
    const commitGraph = path.join(layout.commitsDir, `${head}-deadbeef`, 'lbug');
    await saveMeta(slot, metadata({ graphPath: commitGraph }));
    expect(resolveGraphWritePath(slot)).toBe(path.join(slot, 'lbug'));
    await fs.writeFile(path.join(slot, generation), 'private graph');
    await saveMeta(slot, metadata({ graphPath: generation }));
    expect(resolveGraphWritePath(slot)).toBe(path.join(slot, generation));
    const branch = path.join(slot, 'branches', 'feature');
    await fs.mkdir(branch, { recursive: true });
    await fs.writeFile(path.join(branch, generation), 'branch graph');
    await saveMeta(branch, metadata({ graphPath: generation }));
    expect(resolveGraphWritePath(branch)).toBe(path.join(branch, generation));
  });

  it('publishes a completed private generation by moving its file, preserving the inode', async () => {
    const file = path.join(slot, generation);
    await fs.writeFile(file, 'completed graph');
    const before = await fs.stat(file);
    await saveMeta(slot, metadata({ graphPath: generation }));
    await publishSharedGraph(layout, repo, head, () => {});
    const published = resolveGraphPath(slot);
    expect(path.dirname(path.dirname(published))).toBe(layout.commitsDir);
    expect((await fs.stat(published)).ino).toBe(before.ino);
    expect(await fs.readFile(published, 'utf8')).toBe('completed graph');
  });

  it('keeps an unshareable private generation pointer intact', async () => {
    await fs.writeFile(path.join(slot, generation), 'dirty graph');
    await fs.writeFile(path.join(slot, 'lbug'), 'obsolete canonical graph');
    await fs.writeFile(path.join(repo, 'untracked.ts'), 'export const changed = true;');
    await saveMeta(slot, metadata({ graphPath: generation }));
    await publishSharedGraph(layout, repo, head, () => {});
    expect((await loadMeta(slot))?.graphPath).toBe(generation);
    expect(resolveGraphPath(slot)).toBe(path.join(slot, generation));
  });

  it.each(['prepared', 'pending', 'branch-prepared', 'branch-pending'])(
    'retains an orphan slot with %s analysis work',
    async (kind) => {
      const missingRepo = path.join(root, 'removed-checkout');
      await saveMeta(slot, metadata({ repoPath: missingRepo }));
      const work = kind.startsWith('branch-') ? path.join(slot, 'branches', 'feature') : slot;
      await fs.mkdir(work, { recursive: true });
      if (kind.endsWith('prepared')) {
        // Even an unreadable/incomplete publication receipt is retained evidence.
        await fs.writeFile(path.join(work, 'analysis-publication.json'), '{}');
      } else {
        await saveMeta(
          work,
          metadata({
            repoPath: missingRepo,
            embeddingJob: {
              version: 1,
              identity: 'b'.repeat(64),
              graphGeneration: 'a'.repeat(32),
            },
          }),
        );
      }
      await fs.writeFile(path.join(work, 'paid-work'), 'retained');
      const result = await reclaimSharedStore(layout.root, { gc: true });
      expect(result.droppedMembers).toEqual([]);
      expect(await fs.readFile(path.join(work, 'paid-work'), 'utf8')).toBe('retained');
      await fs.rm(path.join(work, 'analysis-publication.json'), { force: true });
      await saveMeta(work, metadata({ repoPath: missingRepo }));
      expect((await reclaimSharedStore(layout.root, { gc: true })).droppedMembers).toEqual([slot]);
      await expect(fs.stat(slot)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('counts retained branch references before collecting shared graphs', async () => {
    const graph = path.join(layout.commitsDir, `${head}-deadbeef`, 'lbug');
    await fs.mkdir(path.dirname(graph), { recursive: true });
    await fs.writeFile(graph, 'retained graph');
    await saveMeta(slot, metadata());
    const branch = path.join(slot, 'branches', 'feature');
    await fs.mkdir(branch, { recursive: true });
    await saveMeta(branch, metadata({ graphPath: graph }));
    expect((await reclaimSharedStore(layout.root)).removed).toEqual([]);
    expect(await fs.readFile(graph, 'utf8')).toBe('retained graph');
  });

  it('aborts collection when branch ownership cannot be inspected', async () => {
    await saveMeta(slot, metadata({ repoPath: path.join(root, 'removed-checkout') }));
    await fs.writeFile(path.join(slot, 'branches'), 'unverified branch state');
    await expect(reclaimSharedStore(layout.root, { gc: true })).rejects.toThrow(
      'unverified branches directory',
    );
    expect(await fs.readFile(path.join(slot, 'branches'), 'utf8')).toBe('unverified branch state');
  });
});
