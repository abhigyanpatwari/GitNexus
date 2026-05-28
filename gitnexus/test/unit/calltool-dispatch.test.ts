/**
 * Unit Tests: LocalBackend callTool dispatch & lifecycle
 *
 * Tests the callTool dispatch logic, resolveRepo, init/disconnect,
 * error cases, and silent failure patterns — all with mocked LadybugDB.
 *
 * These are pure unit tests that mock the LadybugDB layer to test
 * the dispatch and error handling logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

// We need to mock the LadybugDB adapter and repo-manager BEFORE importing LocalBackend.
// local-backend.ts imports from core/lbug/pool-adapter.js; the mcp/core/lbug-adapter.js
// re-exports from the same module, so we mock the canonical source.
// vi.hoisted runs before vi.mock hoisting, making the fns available to both factories.
const { lbugMocks, platformMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
  platformMocks: {
    isVectorExtensionSupportedByPlatform: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

// Re-export shim must resolve to the same mocks
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
  };
});

// `core/git-staleness` is also imported by `local-backend.ts` (for
// `checkStaleness` and `checkCwdMatch`). Stub it out here so unit
// tests don't shell out to git.
vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

vi.mock('../../src/storage/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../src/core/platform/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/capabilities.js')>();
  return {
    ...actual,
    isVectorExtensionSupportedByPlatform: platformMocks.isVectorExtensionSupportedByPlatform,
  };
});

// Also mock the search modules to avoid loading onnxruntime
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend, REPO_ID_HASH_LENGTH } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, cleanupOldKuzuFiles } from '../../src/storage/repo-manager.js';
import { getGitRoot } from '../../src/storage/git.js';
import { _captureLogger } from '../../src/core/logger.js';
import {
  initLbug,
  executeQuery,
  executeParameterized,
  isLbugReady,
  closeLbug,
} from '../../src/mcp/core/lbug-adapter.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: '/tmp/test-project',
  storagePath: '/tmp/.gitnexus/test-project',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

function setupSingleRepo() {
  (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
}

function setupMultipleRepos() {
  (listRegisteredRepos as any).mockResolvedValue([
    MOCK_REPO_ENTRY,
    {
      ...MOCK_REPO_ENTRY,
      name: 'other-project',
      path: '/tmp/other-project',
      storagePath: '/tmp/.gitnexus/other-project',
    },
  ]);
}

function setupNoRepos() {
  (listRegisteredRepos as any).mockResolvedValue([]);
}

const duplicateFixtureDirs: string[] = [];

function makeDuplicateNameFixture() {
  const mainDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-shared-main-'));
  const wtDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-shared-wt-'));
  duplicateFixtureDirs.push(mainDir, wtDir);
  for (const dir of [mainDir, wtDir]) {
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(path.join(storagePath, 'meta.json'), '{}');
  }
  return {
    mainDir,
    wtDir,
    entries: [
      {
        ...MOCK_REPO_ENTRY,
        name: 'shared',
        path: mainDir,
        storagePath: path.join(mainDir, '.gitnexus'),
      },
      {
        ...MOCK_REPO_ENTRY,
        name: 'shared',
        path: wtDir,
        storagePath: path.join(wtDir, '.gitnexus'),
      },
    ],
  };
}

function makeSharedPrefixFixture(nameA: string, nameB: string) {
  const dirA = mkdtempSync(path.join(os.tmpdir(), `gnx-${nameA}-`));
  const dirB = mkdtempSync(path.join(os.tmpdir(), `gnx-${nameB}-`));
  duplicateFixtureDirs.push(dirA, dirB);
  for (const dir of [dirA, dirB]) {
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(path.join(storagePath, 'meta.json'), '{}');
  }
  return {
    dirA,
    dirB,
    entries: [
      { ...MOCK_REPO_ENTRY, name: nameA, path: dirA, storagePath: path.join(dirA, '.gitnexus') },
      { ...MOCK_REPO_ENTRY, name: nameB, path: dirB, storagePath: path.join(dirB, '.gitnexus') },
    ],
  };
}

// ─── LocalBackend lifecycle ──────────────────────────────────────────

describe('LocalBackend.init', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    backend = new LocalBackend();
    vi.clearAllMocks();
  });

  it('returns true when repos are available', async () => {
    setupSingleRepo();
    const result = await backend.init();
    expect(result).toBe(true);
  });

  it('returns false when no repos are registered', async () => {
    setupNoRepos();
    const result = await backend.init();
    expect(result).toBe(false);
  });

  it('calls listRegisteredRepos with validate: true', async () => {
    setupSingleRepo();
    await backend.init();
    expect(listRegisteredRepos).toHaveBeenCalledWith({ validate: true });
  });
});

describe('LocalBackend.disconnect', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    backend = new LocalBackend();
    vi.clearAllMocks();
  });

  it('does not throw when no repos are initialized', async () => {
    setupNoRepos();
    await backend.init();
    await expect(backend.disconnect()).resolves.not.toThrow();
  });

  it('calls closeLbug on disconnect', async () => {
    setupSingleRepo();
    await backend.init();
    await backend.disconnect();
    expect(closeLbug).toHaveBeenCalled();
  });
});

// ─── callTool dispatch ───────────────────────────────────────────────

describe('LocalBackend.callTool', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('routes list_repos without needing repo param', async () => {
    const result = await backend.callTool('list_repos', {});
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].name).toBe('test-project');
  });

  it('throws for unknown tool name', async () => {
    await expect(backend.callTool('nonexistent_tool', {})).rejects.toThrow(
      'Unknown tool: nonexistent_tool',
    );
  });

  it('dispatches query tool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'auth' });
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });

  it('includes FTS-unavailable warning when ftsAvailable is false (#1403)', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockResolvedValueOnce({ results: [], ftsAvailable: false });
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', { query: 'ProcessActivity' });

    expect(result).toHaveProperty('warning');
    expect((result as any).warning).toMatch(/gitnexus analyze --repair-fts/);
  });

  it('does not include warning when ftsAvailable is true with zero results', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockResolvedValueOnce({ results: [], ftsAvailable: true });
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', { query: 'nonexistent' });

    expect(result).not.toHaveProperty('warning');
  });

  it('does not crash when searchFTSFromLbug throws (#1489)', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    vi.mocked(searchFTSFromLbug).mockRejectedValueOnce(new Error('bm25Results is not iterable'));
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', { query: 'auth' });

    // Should still return a valid result shape (semantic-only fallback)
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
    expect(result).not.toHaveProperty('error');
  });

  it('skips vector index query when VECTOR is unsupported by the platform', async () => {
    const cap = _captureLogger();
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(false);
    (executeQuery as any).mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      if (cypher.includes('MATCH (e:CodeEmbedding)')) return [];
      return [];
    });
    (executeParameterized as any).mockResolvedValue([]);

    try {
      await backend.callTool('query', { query: 'auth' });

      const queries = (executeQuery as any).mock.calls.map(
        ([, cypher]: [string, string]) => cypher,
      );
      expect(queries.some((cypher: string) => cypher.includes('QUERY_VECTOR_INDEX'))).toBe(false);
      expect(
        queries.some(
          (cypher: string) =>
            cypher.includes('RETURN e.nodeId AS nodeId') &&
            cypher.includes('e.embedding AS embedding'),
        ),
      ).toBe(true);
      expect(
        cap
          .records()
          .some((r) =>
            String(r.msg ?? '').includes(
              'GitNexus [query:vector]: VECTOR extension not supported on this platform',
            ),
          ),
      ).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('issues vector index query when VECTOR is supported by the platform', async () => {
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    (executeQuery as any).mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      return [];
    });
    (executeParameterized as any).mockResolvedValue([]);

    await backend.callTool('query', { query: 'auth' });

    const queries = (executeQuery as any).mock.calls.map(([, cypher]: [string, string]) => cypher);
    expect(queries.some((cypher: string) => cypher.includes('QUERY_VECTOR_INDEX'))).toBe(true);
  });

  it('query tool returns error for empty query', async () => {
    const result = await backend.callTool('query', { query: '' });
    expect(result.error).toContain('query parameter is required');
  });

  it('query tool returns error for whitespace-only query', async () => {
    const result = await backend.callTool('query', { query: '   ' });
    expect(result.error).toContain('query parameter is required');
  });

  it('dispatches cypher tool and blocks write queries', async () => {
    (executeParameterized as any).mockRejectedValueOnce(new Error('read-only database'));
    const result = await backend.callTool('cypher', { query: 'CREATE (n:Test)' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Write operations');
  });

  it('dispatches cypher tool with valid read query', async () => {
    (executeParameterized as any).mockResolvedValue([{ name: 'test', filePath: 'src/test.ts' }]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath LIMIT 5',
    });
    // formatCypherAsMarkdown returns { markdown, row_count } for tabular results
    expect(result).toHaveProperty('markdown');
    expect(result).toHaveProperty('row_count');
    expect(result.row_count).toBe(1);
  });

  it('dispatches context tool', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect(result.status).toBe('found');
    expect(result.symbol.name).toBe('main');
  });

  it('context tool returns error when name and uid are both missing', async () => {
    const result = await backend.callTool('context', {});
    expect(result.error).toContain('Either "name" or "uid"');
  });

  it('context tool returns not-found for missing symbol', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('context', { name: 'doesNotExist' });
    expect(result.error).toContain('not found');
  });

  it('context tool returns disambiguation for multiple matches', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main:1',
        name: 'main',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
      },
      {
        id: 'func:main:2',
        name: 'main',
        type: 'Function',
        filePath: 'src/b.ts',
        startLine: 1,
        endLine: 5,
      },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);

    // #470: every candidate carries a relevance score in [0, 1] and the list
    // is sorted descending by score (with deterministic tiebreakers).
    for (const c of result.candidates) {
      expect(typeof c.score).toBe('number');
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
    expect(result.candidates[0].score).toBeGreaterThanOrEqual(result.candidates[1].score);
  });

  it('context tool ranks file_path match higher than non-match (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:handleConnect:1',
        name: 'handleConnect',
        type: 'Function',
        filePath: 'src/lib/socket.ts',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'func:handleConnect:2',
        name: 'handleConnect',
        type: 'Function',
        filePath: 'src/App.tsx',
        startLine: 42,
        endLine: 60,
      },
    ]);
    const result = await backend.callTool('context', {
      name: 'handleConnect',
      file_path: 'App.tsx',
    });
    // In production, `WHERE n.filePath CONTAINS $filePath` would pre-filter
    // at the DB layer and only `src/App.tsx` would come back — resolving
    // via the single-candidate early return rather than via scoring. The
    // `executeParameterized` mock here returns both rows regardless of the
    // WHERE clause parameters, so this asserts that the resolver ends up
    // picking the App.tsx candidate in either case (via mock-relaxed DB
    // pre-filter or via scoring promotion). The dedicated scoring-promotion
    // path is covered by the next `it()` block below.
    expect(result.status).toBe('found');
    expect(result.symbol.filePath).toBe('src/App.tsx');
  });

  it('context tool promotes top candidate via scoring when multiple rows survive DB pre-filter (#470)', async () => {
    // This test explicitly exercises the scored-promotion path (#470
    // review): both candidates satisfy the file_path hint (so DB
    // pre-filter would return both in production), and promotion is
    // determined purely by the combined file_path + kind score.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'fn:App:1',
        name: 'render',
        type: 'Function',
        filePath: 'src/components/App.tsx',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'method:App:1',
        name: 'render',
        type: 'Method',
        filePath: 'src/pages/App.tsx',
        startLine: 5,
        endLine: 15,
      },
    ]);
    const result = await backend.callTool('context', {
      name: 'render',
      file_path: 'App.tsx',
      kind: 'Function',
    });
    // Expected scoring:
    //   Function candidate: 0.50 base + 0.40 file_path + 0.20 kind = 1.10 → cap 1.00
    //   Method candidate:   0.50 base + 0.40 file_path + 0.00 kind = 0.90
    // Top score ≥ 0.95 and beats runner-up by 0.10 → confident promotion
    // to `{ status: 'found' }` with the Function.
    expect(result.status).toBe('found');
    expect(result.symbol.filePath).toBe('src/components/App.tsx');
    expect(result.symbol.kind).toBe('Function');
  });

  it('context tool returns ranked candidates when file_path only partially narrows (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:foo:1',
        name: 'foo',
        type: 'Function',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
      },
      {
        id: 'func:foo:2',
        name: 'foo',
        type: 'Function',
        filePath: 'src/b.ts',
        startLine: 1,
        endLine: 5,
      },
    ]);
    // No hints → both candidates score 0.56 (0.50 base + 0.06 Function
    // priority). Tied scores fall back to deterministic tiebreakers.
    const result = await backend.callTool('context', { name: 'foo' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].score).toBeCloseTo(0.56, 2);
    expect(result.candidates[1].score).toBeCloseTo(0.56, 2);
  });

  it('context tool boosts the candidate whose kind matches the hint (#470)', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'method:save:1',
        name: 'save',
        type: 'Method',
        filePath: 'src/service.ts',
        startLine: 10,
        endLine: 20,
      },
      {
        id: 'func:save:1',
        name: 'save',
        type: 'Function',
        filePath: 'src/util.ts',
        startLine: 5,
        endLine: 15,
      },
    ]);
    const result = await backend.callTool('context', { name: 'save', kind: 'Function' });
    // When kind hint is given, kind-priority bonus is suppressed and +0.20
    // kind-match bonus applies instead. Function becomes the top candidate.
    expect(result.status).toBe('ambiguous');
    expect(result.candidates[0].kind).toBe('Function');
    expect(result.candidates[0].score).toBeGreaterThan(result.candidates[1].score);
  });

  it('impact tool returns ambiguous shape with ranked candidates when target has multiple matches (#470)', async () => {
    // resolveSymbolCandidates issues a single name query; mock it to return
    // two Function rows in different files with no hints.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:login:1',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 5,
        endLine: 15,
      },
      {
        id: 'func:login:2',
        name: 'login',
        type: 'Function',
        filePath: 'src/admin/login.ts',
        startLine: 8,
        endLine: 20,
      },
    ]);

    const result = await backend.callTool('impact', { target: 'login', direction: 'upstream' });

    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
    expect(result.target.name).toBe('login');
    for (const c of result.candidates) {
      expect(typeof c.score).toBe('number');
      expect(c.uid).toBeDefined();
      expect(c.kind).toBe('Function');
    }
  });

  it('impact tool resolves via target_uid without running the name-based resolver (#470)', async () => {
    // UID path: exactly one executeParameterized call for the lookup, then
    // the BFS issues executeQuery calls (which we mock empty). Crucially,
    // no `WHERE n.name =` query fires.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'uid:1234',
        name: 'pickedByUid',
        type: 'Function',
        filePath: 'src/pick.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', {
      target: 'ignoredName',
      target_uid: 'uid:1234',
      direction: 'upstream',
    });

    // No ambiguous shape and no name-lookup error — the uid short-circuit won.
    expect(result.status).not.toBe('ambiguous');
    expect(result.target).toBeDefined();

    // All executeParameterized calls this test dispatched must have been
    // uid-keyed, never name-keyed. That proves the name resolver was skipped.
    const calls = (executeParameterized as any).mock.calls as Array<
      [string, string, Record<string, unknown>]
    >;
    for (const [, cypher] of calls) {
      expect(cypher).not.toMatch(/WHERE n\.name = \$symName/);
    }
  });

  it('dispatches impact tool', async () => {
    // impact() calls executeParameterized to find target, then executeQuery for traversal
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    expect(result).toBeDefined();
    expect(result.target).toBeDefined();
  });

  it('impact byDepth items include a processes field (default empty when no processes)', async () => {
    // Resolver returns target; BFS returns one frontier caller; no STEP_IN_PROCESS rows.
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
    ]);
    (executeQuery as any).mockResolvedValue([
      {
        id: 'func:caller',
        name: 'caller',
        type: 'Function',
        filePath: 'src/uses-main.ts',
        relType: 'CALLS',
        confidence: 0.9,
      },
    ]);

    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    const d1 = result.byDepth?.[1] || result.byDepth?.['1'] || [];
    expect(d1.length).toBeGreaterThan(0);
    for (const item of d1) {
      expect(item).toHaveProperty('processes');
      expect(Array.isArray(item.processes)).toBe(true);
    }
  });

  it('impact populates byDepth processes when STEP_IN_PROCESS rows exist', async () => {
    (executeParameterized as any).mockImplementation((_repoId: string, cypher: string) => {
      // Symbol resolver name-lookup
      if (cypher.includes('WHERE n.name =')) {
        return Promise.resolve([
          { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
        ]);
      }
      // Aggregation pass (must return at least one row so per-symbol pass is gated open)
      if (cypher.includes('COUNT(DISTINCT s.id)')) {
        return Promise.resolve([
          {
            pId: 'proc:cron_daily',
            name: 'Daily cron',
            heuristicLabel: 'Daily cron',
            processType: 'cron',
            entryPointId: 'func:cron_entry',
            hits: 1,
            minStep: 1,
            stepCount: 5,
            epName: 'cron_entry',
            epType: 'Function',
            epFilePath: 'src/cron.ts',
          },
        ]);
      }
      // New per-symbol pass added by this change
      if (cypher.includes('RETURN s.id AS sid')) {
        return Promise.resolve([
          {
            sid: 'func:caller',
            pid: 'proc:cron_daily',
            pName: 'Daily cron',
            pType: 'cron',
            step: 2,
          },
        ]);
      }
      return Promise.resolve([]);
    });
    (executeQuery as any).mockResolvedValue([
      {
        id: 'func:caller',
        name: 'caller',
        type: 'Function',
        filePath: 'src/uses-main.ts',
        relType: 'CALLS',
        confidence: 0.9,
      },
    ]);

    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    const d1 = result.byDepth?.[1] || result.byDepth?.['1'] || [];
    const caller = d1.find((it: any) => it.id === 'func:caller');
    expect(caller).toBeDefined();
    expect(caller.processes).toHaveLength(1);
    expect(caller.processes[0]).toMatchObject({
      id: 'proc:cron_daily',
      label: 'Daily cron',
      processType: 'cron',
      step: 2,
    });
  });

  it('impact summaryOnly:true skips the per-symbol STEP_IN_PROCESS enrichment pass', async () => {
    // Resolver returns target; BFS returns one caller; aggregation returns one process row.
    (executeParameterized as any).mockImplementation((_repoId: string, cypher: string) => {
      if (cypher.includes('WHERE n.name =')) {
        return Promise.resolve([
          { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
        ]);
      }
      if (cypher.includes('COUNT(DISTINCT s.id)')) {
        return Promise.resolve([
          {
            pId: 'proc:daily',
            name: 'Daily cron',
            heuristicLabel: 'Daily cron',
            processType: 'cron',
            entryPointId: 'func:cron_entry',
            hits: 1,
            minStep: 1,
            stepCount: 5,
            epName: 'cron_entry',
            epType: 'Function',
            epFilePath: 'src/cron.ts',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    (executeQuery as any).mockResolvedValue([
      {
        id: 'func:caller',
        name: 'caller',
        type: 'Function',
        filePath: 'src/a.ts',
        relType: 'CALLS',
        confidence: 0.9,
      },
    ]);

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      summaryOnly: true,
    });

    // summaryOnly should return base fields only, no byDepth
    expect(result.summary).toBeDefined();
    expect(result.byDepth).toBeUndefined();

    // The per-symbol enrichment query contains 'RETURN s.id AS sid'; verify it
    // was never called (the gate should have suppressed it).
    const perSymbolCalls = (executeParameterized as any).mock.calls.filter(
      ([, cypher]: [string, string]) =>
        typeof cypher === 'string' && cypher.includes('RETURN s.id AS sid'),
    );
    expect(perSymbolCalls).toHaveLength(0);
  });

  it('impactByUid preserves byDepth while skipping per-symbol enrichment (group fan-out)', async () => {
    // Regression guard for the cross-repo by_depth contract: impactByUid must
    // suppress only the per-symbol STEP_IN_PROCESS pass, NOT the whole byDepth
    // field. cross-impact.ts reads fan.byDepth to populate group `by_depth`;
    // using summaryOnly here would silently empty it.
    //
    // impactByUid takes an explicit repoId and calls refreshRepos() internally.
    // Use a fresh backend whose repo path is already absolute/resolved so the
    // derived repoId stays stable across that refresh (an unresolved POSIX
    // fixture path triggers the path-collision rehash and drops the key).
    const resolvedRepoPath = path.resolve('/tmp/test-project');
    (listRegisteredRepos as any).mockResolvedValue([
      { ...MOCK_REPO_ENTRY, path: resolvedRepoPath },
    ]);
    backend = new LocalBackend();
    await backend.init();

    (executeParameterized as any).mockImplementation((_repoId: string, cypher: string) => {
      // UID resolver
      if (cypher.includes('WHERE n.id = $uid')) {
        return Promise.resolve([
          { id: 'func:main', name: 'main', filePath: 'src/index.ts', type: 'Function' },
        ]);
      }
      // Aggregation pass (returns a process row so affectedProcesses > 0; if the
      // per-symbol pass were not skipped, this would open its gate)
      if (cypher.includes('COUNT(DISTINCT s.id)')) {
        return Promise.resolve([
          {
            pId: 'proc:daily',
            name: 'Daily cron',
            heuristicLabel: 'Daily cron',
            processType: 'cron',
            entryPointId: 'func:cron_entry',
            hits: 1,
            minStep: 1,
            stepCount: 5,
            epName: 'cron_entry',
            epType: 'Function',
            epFilePath: 'src/cron.ts',
          },
        ]);
      }
      return Promise.resolve([]);
    });
    (executeQuery as any).mockResolvedValue([
      {
        id: 'func:caller',
        name: 'caller',
        type: 'Function',
        filePath: 'src/uses-main.ts',
        relType: 'CALLS',
        confidence: 0.9,
      },
    ]);

    const result = await backend.impactByUid('test-project', 'uid:main', 'upstream', {
      maxDepth: 5,
      relationTypes: ['CALLS'],
      minConfidence: 0,
      includeTests: true,
    });

    // byDepth must survive (Finding A regression guard)
    expect(result).not.toBeNull();
    expect(result.byDepth).toBeDefined();
    const d1 = result.byDepth?.[1] || result.byDepth?.['1'] || [];
    expect(d1.find((it: any) => it.id === 'func:caller')).toBeDefined();

    // The per-symbol enrichment query must never fire under skipPerSymbolEnrichment
    const perSymbolCalls = (executeParameterized as any).mock.calls.filter(
      ([, cypher]: [string, string]) =>
        typeof cypher === 'string' && cypher.includes('RETURN s.id AS sid'),
    );
    expect(perSymbolCalls).toHaveLength(0);
  });

  it('dispatches detect_changes tool', async () => {
    // detect_changes calls execFileSync which we haven't mocked at module level,
    // so it will throw a git error — that's fine, we test the error path
    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    // Should either return changes or a git error
    expect(result).toBeDefined();
    expect(result.error || result.summary).toBeDefined();
  });

  it('dispatches rename tool', async () => {
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          id: 'func:oldName',
          name: 'oldName',
          type: 'Function',
          filePath: 'src/test.ts',
          startLine: 1,
          endLine: 5,
        },
      ])
      .mockResolvedValue([]);

    const result = await backend.callTool('rename', {
      symbol_name: 'oldName',
      new_name: 'newName',
      dry_run: true,
    });
    expect(result).toBeDefined();
  });

  it('rename returns error when both symbol_name and symbol_uid are missing', async () => {
    const result = await backend.callTool('rename', { new_name: 'newName' });
    expect(result.error).toContain('Either symbol_name or symbol_uid');
  });

  // api_impact tool
  it('dispatches api_impact tool with route param', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/grants',
        routeName: '/api/grants',
        handlerFile: 'app/api/grants/route.ts',
        responseKeys: ['data', 'pagination'],
        errorKeys: ['error', 'message'],
        middleware: ['withAuth'],
        consumerName: 'GrantsList',
        consumerFile: 'src/GrantsList.tsx',
        fetchReason: 'fetch-url-match|keys:data,pagination',
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/grants' });
    expect(result).toHaveProperty('route', '/api/grants');
    expect(result).toHaveProperty('handler', 'app/api/grants/route.ts');
    expect(result).toHaveProperty('responseShape');
    expect(result.responseShape.success).toEqual(['data', 'pagination']);
    expect(result.responseShape.error).toEqual(['error', 'message']);
    expect(result).toHaveProperty('middleware', ['withAuth']);
    expect(result).toHaveProperty('consumers');
    expect(result.consumers).toHaveLength(1);
    expect(result).toHaveProperty('impactSummary');
    expect(result.impactSummary.directConsumers).toBe(1);
    expect(result.impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact returns error when no route or file param', async () => {
    const result = await backend.callTool('api_impact', {});
    expect(result.error).toContain('Either "route" or "file"');
  });

  it('api_impact returns error when no routes found', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('api_impact', { route: '/api/nonexistent' });
    expect(result.error).toContain('No routes found');
  });

  it('api_impact detects mismatches and bumps risk level', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/data',
        routeName: '/api/data',
        handlerFile: 'api/data.ts',
        responseKeys: ['items'],
        errorKeys: ['error'],
        middleware: null,
        consumerName: 'DataView',
        consumerFile: 'src/DataView.tsx',
        fetchReason: 'fetch-url-match|keys:items,meta',
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/data' });
    expect(result.mismatches).toBeDefined();
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].field).toBe('meta');
    expect(result.mismatches[0].reason).toContain('not in response shape');
    // 1 consumer = LOW, but mismatch bumps to MEDIUM
    expect(result.impactSummary.riskLevel).toBe('MEDIUM');
  });

  it('api_impact supports file param lookup', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/users',
        routeName: '/api/users',
        handlerFile: 'app/api/users/route.ts',
        responseKeys: ['users'],
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
    ]);
    const result = await backend.callTool('api_impact', { file: 'app/api/users/route.ts' });
    expect(result.route).toBe('/api/users');
    expect(result.impactSummary.directConsumers).toBe(0);
    expect(result.impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact returns array for multiple matching routes', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        routeId: 'Route:/api/a',
        routeName: '/api/a',
        handlerFile: 'api/a.ts',
        responseKeys: null,
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
      {
        routeId: 'Route:/api/b',
        routeName: '/api/b',
        handlerFile: 'api/b.ts',
        responseKeys: null,
        errorKeys: null,
        middleware: null,
        consumerName: null,
        consumerFile: null,
        fetchReason: null,
      },
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/' });
    expect(result.routes).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it('api_impact HIGH risk for 10+ consumers', async () => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      rows.push({
        routeId: 'Route:/api/popular',
        routeName: '/api/popular',
        handlerFile: 'api/popular.ts',
        responseKeys: ['data'],
        errorKeys: null,
        middleware: null,
        consumerName: `Consumer${i}`,
        consumerFile: `src/Consumer${i}.tsx`,
        fetchReason: null,
      });
    }
    (executeParameterized as any).mockResolvedValue(rows);
    const result = await backend.callTool('api_impact', { route: '/api/popular' });
    expect(result.impactSummary.directConsumers).toBe(10);
    expect(result.impactSummary.riskLevel).toBe('HIGH');
  });

  // Legacy tool aliases
  it('dispatches "search" as alias for query', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('search', { query: 'auth' });
    expect(result).toHaveProperty('processes');
  });

  it('dispatches "explore" as alias for context', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);
    const result = await backend.callTool('explore', { name: 'main' });
    // explore calls context — which may return found or ambiguous depending on mock
    expect(result).toBeDefined();
    expect(result.status === 'found' || result.symbol || result.error === undefined).toBeTruthy();
  });
});

// ─── Repo resolution ────────────────────────────────────────────────

describe('LocalBackend.resolveRepo', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    (getGitRoot as any).mockReturnValue(null);
    backend = new LocalBackend();
  });

  afterEach(() => {
    for (const dir of duplicateFixtureDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves single repo without param', async () => {
    setupSingleRepo();
    await backend.init();
    const result = await backend.callTool('list_repos', {});
    expect(result).toHaveLength(1);
  });

  it('throws when no repos are registered', async () => {
    setupNoRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'No indexed repositories',
    );
  });

  it('throws for ambiguous repos without param', async () => {
    setupMultipleRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow(
      'Multiple repositories indexed',
    );
  });

  it('resolves repo by name parameter', async () => {
    setupMultipleRepos();
    await backend.init();
    // With repo param, it should resolve correctly
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', {
      query: 'auth',
      repo: 'test-project',
    });
    expect(result).toHaveProperty('processes');
  });

  it('throws for unknown repo name', async () => {
    setupSingleRepo();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test', repo: 'nonexistent' })).rejects.toThrow(
      'not found',
    );
  });

  it('prefers duplicate-name repo matching process.cwd() git root (#1658)', async () => {
    const { wtDir, entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(wtDir);
    await backend.init();
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('query', { query: 'test', repo: 'shared' });
    const resolved = await backend.resolveRepo('shared');
    expect(resolved.repoPath).toBe(wtDir);
  });

  it('throws RegistryAmbiguousTargetError when duplicate name cannot be disambiguated (#1658)', async () => {
    const { entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(null);
    await backend.init();
    await expect(backend.resolveRepo('shared')).rejects.toThrow(/Multiple registered repos match/);
    await expect(backend.resolveRepo('shared')).rejects.toThrow(/absolute path/i);
  });

  it('resolves duplicate-name repos by absolute path before name (#1658)', async () => {
    const { mainDir, wtDir, entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(mainDir);
    await backend.init();
    (executeParameterized as any).mockResolvedValue([]);
    const resolved = await backend.resolveRepo(wtDir);
    expect(resolved.repoPath).toBe(wtDir);
  });

  it('does not treat a bare duplicate alias as a relative path (#1658)', async () => {
    const { entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(null);
    await backend.init();
    await expect(backend.resolveRepo('shared')).rejects.toThrow(/Multiple registered repos match/);
  });

  it('refreshes registry after ambiguity when duplicates are removed (#1658)', async () => {
    const { mainDir, entries } = makeDuplicateNameFixture();
    const singleEntry = [entries[0]];
    (listRegisteredRepos as any).mockResolvedValueOnce(entries).mockResolvedValueOnce(singleEntry);
    (getGitRoot as any).mockReturnValue(null);
    await backend.init();
    const resolved = await backend.resolveRepo('shared');
    expect(resolved.repoPath).toBe(mainDir);
  });

  it('detect_changes surfaces RegistryAmbiguousTargetError on duplicate repo name (#1658)', async () => {
    const { entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(null);
    await backend.init();
    await expect(
      backend.callTool('detect_changes', { scope: 'unstaged', repo: 'shared' }),
    ).rejects.toThrow(/Multiple registered repos match/);
  });

  it('resolves second duplicate-name repo by its stable hashed id (#1658)', async () => {
    const { wtDir, entries } = makeDuplicateNameFixture();
    (listRegisteredRepos as any).mockResolvedValue(entries);
    // Couples this test to repoId's suffix formula on purpose — if repoId changes
    // its suffix, this assertion should fail and force a re-review of the hashed-id
    // resolution tier. Mirrors LocalBackend.repoId: base64url(repoPath) sliced to
    // REPO_ID_HASH_LENGTH and lowercased so it survives the paramLower lookup in
    // resolveRepoFromCache.
    const wtId = `shared-${Buffer.from(wtDir)
      .toString('base64url')
      .slice(0, REPO_ID_HASH_LENGTH)
      .toLowerCase()}`;
    await backend.init();
    const resolved = await backend.resolveRepo(wtId);
    expect(resolved.repoPath).toBe(wtDir);
  });

  it('does not silently return first partial match for ambiguous prefix (#1658)', async () => {
    const { dirA, entries } = makeSharedPrefixFixture('project-a', 'project-b');
    (listRegisteredRepos as any).mockResolvedValue(entries);
    (getGitRoot as any).mockReturnValue(null);
    await backend.init();

    await expect(backend.resolveRepo('project')).rejects.toThrow(/Repository "project" not found/);

    // Sanity: exact names still resolve unambiguously against the same fixture.
    const exact = await backend.resolveRepo('project-a');
    expect(exact.name).toBe('project-a');
    expect(exact.repoPath).toBe(dirA);
  });

  it('resolves repo case-insensitively', async () => {
    setupSingleRepo();
    await backend.init();
    (executeParameterized as any).mockResolvedValue([]);
    // Should match even with different case
    const result = await backend.callTool('query', {
      query: 'test',
      repo: 'Test-Project',
    });
    expect(result).toHaveProperty('processes');
  });

  it('refreshes registry on repo miss', async () => {
    setupNoRepos();
    await backend.init();

    // Now make a repo appear
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);

    // The resolve should re-read the registry and find the new repo
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', {
      query: 'test',
      repo: 'test-project',
    });
    expect(result).toHaveProperty('processes');
    // listRegisteredRepos should have been called again
    expect(listRegisteredRepos).toHaveBeenCalledTimes(2); // once in init, once in refreshRepos
  });

  it('emits sibling-clone drift warning exactly once per (repo, cwd) pair', async () => {
    // Regression guard for the one-shot stderr warning emitted when
    // the caller's cwd is in a sibling clone of the resolved index.
    // The cache must short-circuit BOTH `console.error` and the
    // underlying `checkCwdMatch` git shellouts on subsequent calls.
    const { checkCwdMatch } = await import('../../src/core/git-staleness.js');
    (listRegisteredRepos as any).mockResolvedValue([
      { ...MOCK_REPO_ENTRY, remoteUrl: 'https://example.com/foo/bar' },
    ]);
    (checkCwdMatch as any).mockResolvedValue({
      match: 'sibling-by-remote',
      entry: { ...MOCK_REPO_ENTRY, remoteUrl: 'https://example.com/foo/bar' },
      cwdGitRoot: '/tmp/sibling-clone',
      cwdHead: 'feedface',
      hint: '⚠️ stale sibling clone',
    });

    const cap = _captureLogger();
    try {
      await backend.init();

      // Three resolveRepo invocations from the same cwd:
      await backend.callTool('list_repos', {}); // resolveRepo not called for list_repos
      // Use a real resolveRepo path:
      await backend.resolveRepo();
      await backend.resolveRepo();
      await backend.resolveRepo();

      const drift = cap
        .records()
        .filter((r) => String(r.msg ?? '').includes('stale sibling clone'));
      expect(drift).toHaveLength(1);
      // checkCwdMatch should also only run once — the cache check
      // happens BEFORE the shellout-heavy match call.
      expect(checkCwdMatch).toHaveBeenCalledTimes(1);
    } finally {
      cap.restore();
      (checkCwdMatch as any).mockResolvedValue({ match: 'none' });
    }
  });
});

// ─── getContext ──────────────────────────────────────────────────────

describe('LocalBackend.getContext', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('returns context for single repo without specifying id', () => {
    const ctx = backend.getContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
    expect(ctx!.stats.fileCount).toBe(10);
    expect(ctx!.stats.functionCount).toBe(50);
  });

  it('returns context by repo id', () => {
    const ctx = backend.getContext('test-project');
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
  });

  it('returns single repo context even with unknown id (single-repo fallback)', () => {
    // When only 1 repo is registered, getContext falls through the id check
    // and returns the single repo's context. This is intentional behavior.
    const ctx = backend.getContext('nonexistent');
    // The id doesn't match, but since repos.size === 1, it returns that single context
    // This is the actual behavior — test documents it
    expect(ctx).not.toBeNull();
    expect(ctx!.projectName).toBe('test-project');
  });
});

// ─── LadybugDB lazy initialization ──────────────────────────────────────

describe('ensureInitialized', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('calls initLbug on first tool call', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalled();
  });

  it('retries initLbug if connection was evicted', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    // First call initializes
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalledTimes(1);

    // Simulate idle eviction
    (isLbugReady as any).mockReturnValueOnce(false);
    await backend.callTool('query', { query: 'test' });
    expect(initLbug).toHaveBeenCalledTimes(2);
  });

  it('handles initLbug failure gracefully', async () => {
    (initLbug as any).mockRejectedValueOnce(new Error('DB locked'));
    await expect(backend.callTool('query', { query: 'test' })).rejects.toThrow('DB locked');
  });
});

// ─── Cypher write blocking through callTool ──────────────────────────

describe('callTool cypher write blocking', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  const writeQueries = [
    'CREATE (n:Function {name: "test"})',
    'MATCH (n) DELETE n',
    'MATCH (n) SET n.name = "hacked"',
    'MERGE (n:Function {name: "test"})',
    'MATCH (n) REMOVE n.name',
    'DROP TABLE Function',
    'ALTER TABLE Function ADD COLUMN foo STRING',
    'COPY Function FROM "file.csv"',
    'MATCH (n) DETACH DELETE n',
  ];

  for (const query of writeQueries) {
    it(`blocks write query: ${query.slice(0, 30)}...`, async () => {
      (executeParameterized as any).mockRejectedValueOnce(new Error('read-only database'));
      const result = await backend.callTool('cypher', { query });
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Write operations');
    });
  }

  it('allows read query through callTool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 5',
    });
    // Should not have error property with write-block message
    expect(result.error).toBeUndefined();
  });
});

// ─── listRepos ──────────────────────────────────────────────────────

describe('LocalBackend.listRepos', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  it('returns empty array when no repos', async () => {
    setupNoRepos();
    await backend.init();
    const repos = await backend.callTool('list_repos', {});
    expect(repos).toEqual([]);
  });

  it('returns repo metadata', async () => {
    setupSingleRepo();
    await backend.init();
    const repos = await backend.callTool('list_repos', {});
    expect(repos).toHaveLength(1);
    expect(repos[0]).toEqual(
      expect.objectContaining({
        name: 'test-project',
        path: '/tmp/test-project',
        indexedAt: expect.any(String),
        lastCommit: expect.any(String),
      }),
    );
  });

  it('re-reads registry on each listRepos call', async () => {
    setupSingleRepo();
    await backend.init();
    await backend.callTool('list_repos', {});
    await backend.callTool('list_repos', {});
    // listRegisteredRepos called: once in init, once per listRepos
    expect(listRegisteredRepos).toHaveBeenCalledTimes(3);
  });
});

// ─── Cypher LadybugDB not ready ────────────────────────────────────────

describe('cypher tool LadybugDB not ready', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('returns error when LadybugDB is not ready', async () => {
    (isLbugReady as any).mockReturnValue(false);
    // initLbug will succeed but isLbugReady returns false after ensureInitialized
    // Actually ensureInitialized checks isLbugReady and re-inits — let's make that pass
    // then the cypher method checks isLbugReady again
    (isLbugReady as any)
      .mockReturnValueOnce(false) // ensureInitialized check
      .mockReturnValueOnce(false); // cypher's own check

    const result = await backend.callTool('cypher', {
      query: 'MATCH (n) RETURN n LIMIT 1',
    });
    expect(result.error).toContain('LadybugDB not ready');
  });
});

// ─── formatCypherAsMarkdown ──────────────────────────────────────────

describe('cypher result formatting', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    // Full reset of all mocks to prevent state leaking from other tests
    vi.resetAllMocks();
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);
    (executeParameterized as any).mockResolvedValue([]);

    backend = new LocalBackend();
    await backend.init();
  });

  it('formats tabular results as markdown table', async () => {
    (executeParameterized as any).mockResolvedValue([
      { name: 'main', filePath: 'src/index.ts' },
      { name: 'helper', filePath: 'src/utils.ts' },
    ]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath',
    });
    expect(result).toHaveProperty('markdown');
    expect(result.markdown).toContain('name');
    expect(result.markdown).toContain('main');
    expect(result.row_count).toBe(2);
  });

  it('returns empty array as-is', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 0',
    });
    expect(result).toEqual([]);
  });

  it('returns error object when cypher fails', async () => {
    (executeParameterized as any).mockRejectedValue(new Error('Syntax error'));
    const result = await backend.callTool('cypher', {
      query: 'INVALID CYPHER SYNTAX',
    });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Syntax error');
  });
});
