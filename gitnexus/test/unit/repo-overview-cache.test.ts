/**
 * Unit tests for the `repo_overview` backend cache and dispatch path.
 *
 * The generator itself is covered in repo-map.test.ts. Here the LadybugDB
 * layer is mocked so query counts, single-flight behavior, publication
 * invalidation and dispatch routing can be asserted exactly.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const { lbugMocks, failOnce, generatorGate } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  failOnce: { value: false },
  generatorGate: {
    entered: 0,
    promise: null as Promise<void> | null,
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/core/lbug-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
    loadMeta: vi.fn(actual.loadMeta),
  };
});

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

vi.mock('../../src/storage/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/git.js')>();
  return { ...actual, getGitRoot: vi.fn().mockReturnValue(null) };
});

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// The real generator runs against the mocked executor; only one opt-in case
// forces it to reject so the cache-failure cleanup can be observed.
vi.mock('../../src/mcp/local/repo-map.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/local/repo-map.js')>();
  return {
    ...actual,
    generateRepoOverview: vi.fn(async (...args: Parameters<typeof actual.generateRepoOverview>) => {
      generatorGate.entered += 1;
      if (generatorGate.promise) await generatorGate.promise;
      if (failOnce.value) {
        failOnce.value = false;
        throw new Error('generator exploded');
      }
      return actual.generateRepoOverview(...args);
    }),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

const tempDirs: string[] = [];

function makeIndexedRepo(indexedAt = '2026-01-01T00:00:00Z') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-repo-overview-'));
  const storagePath = path.join(dir, '.gitnexus');
  mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
  tempDirs.push(dir);
  const entry = {
    name: 'demo',
    path: dir,
    storagePath,
    indexedAt,
    lastCommit: 'abc1234567890',
    stats: { files: 10, nodes: 50, edges: 100, communities: 2, processes: 3 },
  };
  const writeMeta = (stamp: string): void => {
    writeFileSync(
      path.join(storagePath, 'gitnexus.json'),
      JSON.stringify({
        repoPath: dir,
        storagePath,
        lastCommit: entry.lastCommit,
        indexedAt: stamp,
        stats: entry.stats,
      }),
    );
  };
  writeMeta(indexedAt);
  return { entry, writeMeta };
}

/** An empty graph: the generator issues files + communities + processHeaders. */
const EMPTY_GRAPH_QUERY_COUNT = 3;

describe('repo_overview backend cache and dispatch', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    failOnce.value = false;
    generatorGate.entered = 0;
    generatorGate.promise = null;
    (executeParameterized as any).mockReset();
    (executeParameterized as any).mockResolvedValue([]);
    backend = new LocalBackend();
  });

  afterEach(() => {
    failOnce.value = false;
  });

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  async function initBackend(entry: Record<string, unknown>): Promise<void> {
    (listRegisteredRepos as any).mockResolvedValue([entry]);
    await backend.init();
  }

  /** Wait for async repo resolution / metadata I/O before asserting query counts. */
  async function waitFor(predicate: () => boolean, maxTicks = 200): Promise<void> {
    for (let tick = 0; tick < maxTicks && !predicate(); tick += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
  }

  it('serves a warm call with zero Cypher queries and preserves the payload', async () => {
    await initBackend(makeIndexedRepo().entry);

    const first = await backend.callTool('repo_overview', {});
    expect(first).toMatchObject({
      name: 'demo',
      nodeCount: 50,
      edgeCount: 100,
      markdown: expect.stringContaining('# Repository: demo'),
      queryBudget: { executed: EMPTY_GRAPH_QUERY_COUNT },
    });
    const coldQueries = (executeParameterized as any).mock.calls.length;
    expect(coldQueries).toBe(EMPTY_GRAPH_QUERY_COUNT);

    (executeParameterized as any).mockClear();
    const second = await backend.callTool('repo_overview', {});
    expect(second).toEqual(first);
    expect(executeParameterized).not.toHaveBeenCalled();
    expect(second.staleness).toBeDefined();
  });

  it('shares one in-flight generation between concurrent callers', async () => {
    await initBackend(makeIndexedRepo().entry);
    let release!: () => void;
    generatorGate.entered = 0;
    generatorGate.promise = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = backend.callTool('repo_overview', {});
    const second = backend.callTool('repo_overview', {});
    // Hold the generator open until both callers have had a chance to reach
    // the cache check. Without single-flight this would generate twice.
    try {
      await waitFor(() => generatorGate.entered === 1);
      expect(generatorGate.entered).toBe(1);
      expect(executeParameterized).not.toHaveBeenCalled();
    } finally {
      generatorGate.promise = null;
      release();
    }

    const [a, b] = await Promise.all([first, second]);
    expect(generatorGate.entered).toBe(1);
    expect((executeParameterized as any).mock.calls.length).toBe(EMPTY_GRAPH_QUERY_COUNT);
    expect(b).toEqual(a);
  });

  it('invalidates the cached overview when a new publication is stamped', async () => {
    const { entry, writeMeta } = makeIndexedRepo();
    await initBackend(entry);

    await backend.callTool('repo_overview', {});
    expect((executeParameterized as any).mock.calls.length).toBe(EMPTY_GRAPH_QUERY_COUNT);

    writeMeta('2026-02-02T00:00:00Z');
    (executeParameterized as any).mockClear();
    await backend.callTool('repo_overview', {});
    expect((executeParameterized as any).mock.calls.length).toBe(EMPTY_GRAPH_QUERY_COUNT);
  });

  it('does not poison the publication key when generation fails', async () => {
    await initBackend(makeIndexedRepo().entry);

    failOnce.value = true;
    await expect(backend.callTool('repo_overview', {})).rejects.toThrow('generator exploded');

    (executeParameterized as any).mockClear();
    const recovered = await backend.callTool('repo_overview', {});
    expect(recovered).toMatchObject({ name: 'demo' });
    expect((executeParameterized as any).mock.calls.length).toBe(EMPTY_GRAPH_QUERY_COUNT);
  });

  it('rejects @group routing without issuing a query', async () => {
    await initBackend(makeIndexedRepo().entry);

    const result = await backend.callTool('repo_overview', { repo: '@group' });
    expect(result).toEqual({
      error:
        'repo_overview does not support @group routing. Use one indexed repository name or path.',
    });
    expect(executeParameterized).not.toHaveBeenCalled();
  });

  it('keeps the legacy schema-less overview handler callable', async () => {
    await initBackend(makeIndexedRepo().entry);
    const legacySpy = vi.spyOn(backend as any, 'overview').mockResolvedValue({ legacy: true });

    const result = await backend.callTool('overview', {});
    expect(result).toMatchObject({ legacy: true });
    expect(legacySpy).toHaveBeenCalledTimes(1);
    expect(GITNEXUS_TOOLS.map((tool) => tool.name)).not.toContain('overview');
  });
});
