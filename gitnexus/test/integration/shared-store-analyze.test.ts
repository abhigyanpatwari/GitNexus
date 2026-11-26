import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLASS_FRAMEWORK_ANNOTATIONS_FEATURE } from '../../src/core/analysis-features.js';
import { resolveAnalyzerRunnerIdentity } from '../../src/core/analyzer-identity.js';
import { RebuildReasonCollector } from '../../src/core/rebuild-reasons.js';

import { runtimeParseIdentity } from '../helpers/runtime-parse-identity.js';
import { SCHEMA_FINGERPRINT } from '../../src/core/lbug/schema.js';
import { featureKeyOf, listStoreMetaRoots } from '../../src/core/shared-store-analyze.js';
import { loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import type { RepoMeta } from '../../src/storage/repo-meta.js';
import {
  commitGraphDir,
  resolveGraphPath,
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

import { git, layoutOf } from '../helpers/shared-store-checkout.js';
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
        graphCompaction: { version: 1, compactBytes: 1024, incrementalWrites: 7 },
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
      parseCacheIdentity: { base: (await runtimeParseIdentity()).base },
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
