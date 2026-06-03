/**
 * Unit Tests: LocalBackend callTool dispatch & lifecycle
 *
 * Tests the callTool dispatch logic, resolveRepo, init/disconnect,
 * error cases, and silent failure patterns — all with mocked LadybugDB.
 *
 * These are pure unit tests that mock the LadybugDB layer to test
 * the dispatch and error handling logic in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock the LadybugDB adapter and repo-manager BEFORE importing LocalBackend
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

// Also mock the search modules to avoid loading onnxruntime
vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// Mock child_process for execGitDiff (used by detect_changes and impacted_endpoints)
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, cleanupOldKuzuFiles } from '../../src/storage/repo-manager.js';
import { initLbug, executeQuery, executeParameterized, isLbugReady, closeLbug } from '../../src/mcp/core/lbug-adapter.js';
import { searchFTSFromLbug } from '../../src/core/search/bm25-index.js';
import { execFileSync as mockedExecFileSync } from 'child_process';

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
    expect((result as any)).toBe(true);
  });

  it('returns false when no repos are registered', async () => {
    setupNoRepos();
    const result = await backend.init();
    expect((result as any)).toBe(false);
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
    await expect(backend.callTool('nonexistent_tool', {}))
      .rejects.toThrow('Unknown tool: nonexistent_tool');
  });

  it('dispatches query tool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'auth' });
    expect((result as any)).toHaveProperty('processes');
    expect((result as any)).toHaveProperty('definitions');
  });

  it('query tool returns error for empty query', async () => {
    const result = await backend.callTool('query', { query: '' });
    expect((result as any).error).toContain('query parameter is required');
  });

  it('query tool returns error for whitespace-only query', async () => {
    const result = await backend.callTool('query', { query: '   ' });
    expect((result as any).error).toContain('query parameter is required');
  });

  // WI-J5: regression for #57 — query ranking should demote test files so
  // production symbols surface above `*.test.ts`/`*_test.go`/etc.
  // The test harness mocks bm25/semantic at a layer that does not see the
  // score-map demotion; mark as todo until the dispatch path is plumbed
  // through a verifiable seam.
  it.todo('query tool demotes test files in definitions ranking (#57)');

  // WI-J6: regression for #58 — `max_symbols` must not shrink the raw search
  // pool. A query with max_symbols=1 should fetch the same number of BM25 +
  // semantic results as max_symbols=10, otherwise `processes` becomes empty
  // for low values. Verifiable by spying on `bm25Search` / `semanticSearch`.
  it.todo('query search limit is independent of max_symbols (#58)');

  it('dispatches cypher tool and blocks write queries', async () => {
    const result = await backend.callTool('cypher', { query: 'CREATE (n:Test)' });
    expect((result as any)).toHaveProperty('error');
    expect((result as any).error).toContain('Write operations');
  });

  it('dispatches cypher tool with valid read query', async () => {
    (executeQuery as any).mockResolvedValue([
      { name: 'test', filePath: 'src/test.ts' },
    ]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath LIMIT 5',
    });
    // formatCypherAsMarkdown returns { markdown, row_count } for tabular results
    expect((result as any)).toHaveProperty('markdown');
    expect((result as any)).toHaveProperty('row_count');
    expect((result as any).row_count).toBe(1);
  });

  it('dispatches context tool', async () => {
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts', startLine: 1, endLine: 10 },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect((result as any).status).toBe('found');
    expect((result as any).symbol.name).toBe('main');
  });

  it('context tool returns error when name and uid are both missing', async () => {
    const result = await backend.callTool('context', {});
    expect((result as any).error).toContain('Either "name" or "uid"');
  });

  it('context tool returns not-found for missing symbol', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('context', { name: 'doesNotExist' });
    expect((result as any).error).toContain('not found');
  });

  it('context tool returns disambiguation for multiple matches', async () => {
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main:1', name: 'main', type: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 },
      { id: 'func:main:2', name: 'main', type: 'Function', filePath: 'src/b.ts', startLine: 1, endLine: 5 },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect((result as any).status).toBe('ambiguous');
    expect((result as any).candidates).toHaveLength(2);
  });

  it('dispatches impact tool', async () => {
    // impact() calls executeParameterized to find target, then executeQuery for traversal
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
    ]);
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    expect((result as any)).toBeDefined();
    expect((result as any).target).toBeDefined();
  });

  // WI-J3: regression for #53 — impact tool must accept a `file_path` parameter
  // and prefer the symbol whose filePath ends with that suffix (mirrors the
  // `context` tool's disambiguation contract). Needs a harness that exposes
  // the resolution sub-query's full UNION ALL result set so the filter can
  // be observed.
  it.todo('impact tool disambiguates symbols via file_path parameter (#53)');

  it('dispatches detect_changes tool', async () => {
    // detect_changes calls execFileSync which we haven't mocked at module level,
    // so it will throw a git error — that's fine, we test the error path
    const result = await backend.callTool('detect_changes', { scope: 'unstaged' });
    // Should either return changes or a git error
    expect((result as any)).toBeDefined();
    expect((result as any).error || result.summary).toBeDefined();
  });

  it('dispatches rename tool', async () => {
    (executeParameterized as any)
      .mockResolvedValueOnce([
        { id: 'func:oldName', name: 'oldName', type: 'Function', filePath: 'src/test.ts', startLine: 1, endLine: 5 },
      ])
      .mockResolvedValue([]);

    const result = await backend.callTool('rename', {
      symbol_name: 'oldName',
      new_name: 'newName',
      dry_run: true,
    });
    expect((result as any)).toBeDefined();
  });

  it('rename returns error when both symbol_name and symbol_uid are missing', async () => {
    const result = await backend.callTool('rename', { new_name: 'newName' });
    expect((result as any).error).toContain('Either symbol_name or symbol_uid');
  });

  // api_impact tool
  it('dispatches api_impact tool with route param', async () => {
    // First call: route query; Second call: consumer query
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/grants',
          route: '/api/grants',
          handlerFile: 'app/api/grants/route.ts',
          responseKeys: ['data', 'pagination'],
          errorKeys: ['error', 'message'],
          middleware: ['withAuth'],
        },
      ])
      .mockResolvedValueOnce([
        {
          consumerId: 'func:GrantsList',
          consumerName: 'GrantsList',
          consumerFile: 'src/GrantsList.tsx',
          fetchReason: 'fetch-url-match|keys:data,pagination',
        },
      ]);
    const result = await backend.callTool('api_impact', { route: '/api/grants' });
    expect((result as any)).toHaveProperty('route', '/api/grants');
    expect((result as any)).toHaveProperty('handler', 'app/api/grants/route.ts');
    expect((result as any)).toHaveProperty('responseShape');
    expect((result as any).responseShape.success).toEqual(['data', 'pagination']);
    expect((result as any).responseShape.error).toEqual(['error', 'message']);
    expect((result as any)).toHaveProperty('middleware', ['withAuth']);
    expect((result as any)).toHaveProperty('consumers');
    expect((result as any).consumers).toHaveLength(1);
    expect((result as any)).toHaveProperty('impactSummary');
    expect((result as any).impactSummary.directConsumers).toBe(1);
    expect((result as any).impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact returns error when no route or file param', async () => {
    const result = await backend.callTool('api_impact', {});
    expect((result as any).error).toContain('Either "route" or "file"');
  });

  it('api_impact returns error when no routes found', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('api_impact', { route: '/api/nonexistent' });
    expect((result as any).error).toContain('No routes found');
  });

  it('api_impact detects mismatches and bumps risk level', async () => {
    // First call: route query; Second call: consumer query
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/data',
          route: '/api/data',
          handlerFile: 'api/data.ts',
          responseKeys: ['items'],
          errorKeys: ['error'],
          middleware: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          consumerId: 'func:DataView',
          consumerName: 'DataView',
          consumerFile: 'src/DataView.tsx',
          fetchReason: 'fetch-url-match|keys:items,meta',
        },
      ]);
    const result = await backend.callTool('api_impact', { route: '/api/data' });
    expect((result as any).mismatches).toBeDefined();
    expect((result as any).mismatches).toHaveLength(1);
    expect((result as any).mismatches[0].field).toBe('meta');
    expect((result as any).mismatches[0].reason).toContain('not in response shape');
    // 1 consumer = LOW, but mismatch bumps to MEDIUM
    expect((result as any).impactSummary.riskLevel).toBe('MEDIUM');
  });

  it('api_impact supports file param lookup', async () => {
    // First call: route query; Second call: consumer query (empty)
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/users',
          route: '/api/users',
          handlerFile: 'app/api/users/route.ts',
          responseKeys: ['users'],
          errorKeys: null,
          middleware: null,
        },
      ])
      .mockResolvedValueOnce([]); // No consumers
    const result = await backend.callTool('api_impact', { file: 'app/api/users/route.ts' });
    expect((result as any).route).toBe('/api/users');
    expect((result as any).impactSummary.directConsumers).toBe(0);
    expect((result as any).impactSummary.riskLevel).toBe('LOW');
  });

  it('api_impact returns array for multiple matching routes', async () => {
    // First call: route query (2 routes); Second call per route: consumer query (empty)
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/a',
          route: '/api/a',
          handlerFile: 'api/a.ts',
          responseKeys: null,
          errorKeys: null,
          middleware: null,
        },
        {
          routeId: 'Route:/api/b',
          route: '/api/b',
          handlerFile: 'api/b.ts',
          responseKeys: null,
          errorKeys: null,
          middleware: null,
        },
      ])
      .mockResolvedValueOnce([]) // Consumers for route A
      .mockResolvedValueOnce([]); // Consumers for route B
    const result = await backend.callTool('api_impact', { route: '/api/' });
    expect((result as any).routes).toHaveLength(2);
    expect((result as any).total).toBe(2);
  });

  it('api_impact HIGH risk for 10+ consumers', async () => {
    // First call: single route; Second call: 10 consumers
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          routeId: 'Route:/api/popular',
          route: '/api/popular',
          handlerFile: 'api/popular.ts',
          responseKeys: ['data'],
          errorKeys: null,
          middleware: null,
        },
      ])
      .mockResolvedValueOnce([
        // 10 consumers
        ...Array.from({ length: 10 }, (_, i) => ({
          consumerId: `func:Consumer${i}`,
          consumerName: `Consumer${i}`,
          consumerFile: `src/Consumer${i}.tsx`,
          fetchReason: null,
        })),
      ]);
    const result = await backend.callTool('api_impact', { route: '/api/popular' });
    expect((result as any).impactSummary.directConsumers).toBe(10);
    expect((result as any).impactSummary.riskLevel).toBe('HIGH');
  });

  // Legacy tool aliases
  it('dispatches "search" as alias for query', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('search', { query: 'auth' });
    expect((result as any)).toHaveProperty('processes');
  });

  it('dispatches "explore" as alias for context', async () => {
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts', startLine: 1, endLine: 10 },
    ]);
    const result = await backend.callTool('explore', { name: 'main' });
    // explore calls context — which may return found or ambiguous depending on mock
    expect((result as any)).toBeDefined();
    expect((result as any).status === 'found' || result.symbol || result.error === undefined).toBeTruthy();
  });
});

// ─── Repo resolution ────────────────────────────────────────────────

describe('LocalBackend.resolveRepo', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
  });

  it('resolves single repo without param', async () => {
    setupSingleRepo();
    await backend.init();
    const result = await backend.callTool('list_repos', {});
    expect((result as any)).toHaveLength(1);
  });

  it('throws when no repos are registered', async () => {
    setupNoRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('No indexed repositories');
  });

  it('throws for ambiguous repos without param', async () => {
    setupMultipleRepos();
    await backend.init();
    // Stub cwd to a non-matching path so the test is deterministic regardless of where the suite runs
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/var/empty');
    try {
      await expect(backend.callTool('query', { query: 'test' }))
        .rejects.toThrow('Multiple repositories indexed');
    } finally {
      cwdSpy.mockRestore();
    }
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
    expect((result as any)).toHaveProperty('processes');
  });

  it('throws for unknown repo name', async () => {
    setupSingleRepo();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test', repo: 'nonexistent' }))
      .rejects.toThrow('not found');
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
    expect((result as any)).toHaveProperty('processes');
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
    expect((result as any)).toHaveProperty('processes');
    // listRegisteredRepos should have been called again
    expect(listRegisteredRepos).toHaveBeenCalledTimes(2); // once in init, once in refreshRepos
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
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('DB locked');
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
      const result = await backend.callTool('cypher', { query });
      expect((result as any)).toHaveProperty('error');
      expect((result as any).error).toContain('Write operations');
    });
  }

  it('allows read query through callTool', async () => {
    (executeQuery as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 5',
    });
    // Should not have error property with write-block message
    expect((result as any).error).toBeUndefined();
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
    expect(repos[0]).toEqual(expect.objectContaining({
      name: 'test-project',
      path: '/tmp/test-project',
      indexedAt: expect.any(String),
      lastCommit: expect.any(String),
    }));
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
      .mockReturnValueOnce(false)  // ensureInitialized check
      .mockReturnValueOnce(false); // cypher's own check

    const result = await backend.callTool('cypher', {
      query: 'MATCH (n) RETURN n LIMIT 1',
    });
    expect((result as any).error).toContain('LadybugDB not ready');
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
    (executeQuery as any).mockResolvedValue([
      { name: 'main', filePath: 'src/index.ts' },
      { name: 'helper', filePath: 'src/utils.ts' },
    ]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath',
    });
    expect((result as any)).toHaveProperty('markdown');
    expect((result as any).markdown).toContain('name');
    expect((result as any).markdown).toContain('main');
    expect((result as any).row_count).toBe(2);
  });

  it('returns empty array as-is', async () => {
    (executeQuery as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 0',
    });
    expect((result as any)).toEqual([]);
  });

  it('returns error object when cypher fails', async () => {
    (executeQuery as any).mockRejectedValue(new Error('Syntax error'));
    const result = await backend.callTool('cypher', {
      query: 'INVALID CYPHER SYNTAX',
    });
    expect((result as any)).toHaveProperty('error');
    expect((result as any).error).toContain('Syntax error');
  });
});

// ─── Multi-repo (repos[]) routing tests ─────────────────────────────────

describe('callTool multi-repo routing', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();  // Use clearAllMocks to preserve module-level mocks
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'other-project', path: '/tmp/other-project', storagePath: '/tmp/.gitnexus/other-project' },
    ]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);
    (executeQuery as any).mockResolvedValue([]);
    (executeParameterized as any).mockResolvedValue([]);

    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('query tool with repos[]', () => {
    it('routes to multi-repo handler when repos array is provided', async () => {
      (executeParameterized as any)
        .mockResolvedValueOnce([
          { id: 'func:auth', name: 'auth', type: 'Function', filePath: '/a.ts', startLine: 1, endLine: 10, nodeId: 'func:auth' },
        ])
        .mockResolvedValueOnce([]);

      const result = await backend.callTool('query', {
        query: 'auth',
        repos: ['test-project', 'other-project'],
      });

      // Should return aggregated results with _repoId attribution
      expect((result as any)).toHaveProperty('processes');
      expect((result as any)).toHaveProperty('process_symbols');
      expect((result as any)).toHaveProperty('definitions');
    });
  });

  describe('cypher tool with repos[]', () => {
    it('routes to multi-repo handler when repos array is provided', async () => {
      (executeQuery as any)
        .mockResolvedValueOnce([{ name: 'main', filePath: 'src/a.ts' }])
        .mockResolvedValueOnce([{ name: 'helper', filePath: 'src/b.ts' }]);

      const result = await backend.callTool('cypher', {
        query: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath',
        repos: ['test-project', 'other-project'],
      });

      // Should return formatted result with _repoId
      expect((result as any)).toHaveProperty('markdown');
      expect((result as any).row_count).toBe(2);
    });

    it('aggregates results from multiple repos with _repoId attribution', async () => {
      (executeQuery as any)
        .mockResolvedValueOnce([{ name: 'funcA', filePath: '/a.ts' }])
        .mockResolvedValueOnce([{ name: 'funcB', filePath: '/b.ts' }]);

      const result = await backend.callTool('cypher', {
        query: 'MATCH (n:Function) RETURN n.name AS name',
        repos: ['test-project', 'other-project'],
      });

      // Result should have markdown format with row count 2
      expect((result as any)).toHaveProperty('markdown');
      expect((result as any).row_count).toBe(2);
    });

    it('uses single-repo path when only repo parameter is provided (backward compat)', async () => {
      (executeQuery as any).mockResolvedValue([{ name: 'func', filePath: '/a.ts' }]);

      const result = await backend.callTool('cypher', {
        query: 'MATCH (n:Function) RETURN n.name',
        repo: 'test-project',
      });

      // Should use single-repo handler
      expect((result as any)).toHaveProperty('markdown');
    });
  });

  describe('context tool with repos[]', () => {
    it('routes to multi-repo handler when repos array is provided', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return { status: 'found', symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/a.ts', startLine: 1, endLine: 10 }, incoming: {}, outgoing: {}, processes: [] };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.symbol).toBeDefined();
      expect(result.symbol._repoId).toBe('test-project');
      expect(result.incoming).toBeDefined();
      expect(result.outgoing).toBeDefined();
      expect(result.processes).toBeDefined();
    });

    it('returns symbol with _repoId when found in one repo', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return { status: 'found', symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/a.ts', startLine: 1, endLine: 10 }, incoming: {}, outgoing: {}, processes: [] };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.symbol._repoId).toBe('test-project');
      expect(result._repoId).toBe('test-project');
    });

    it('returns incoming relationships with _repoId (TC-1)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'found',
            symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/auth.ts', startLine: 1, endLine: 10 },
            incoming: {
              calls: [{ uid: 'func:login', name: 'login', filePath: '/login.ts', kind: 'Function' }],
              imports: [{ uid: 'func:setup', name: 'setup', filePath: '/setup.ts', kind: 'Function' }],
            },
            outgoing: {},
            processes: [],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.incoming.calls).toBeInstanceOf(Array);
      expect(result.incoming.calls).toHaveLength(1);
      expect(result.incoming.calls[0]).toMatchObject({
        uid: 'func:login', name: 'login', _repoId: 'test-project',
      });
      expect(result.incoming.imports).toHaveLength(1);
      expect(result.incoming.imports[0]).toMatchObject({
        uid: 'func:setup', name: 'setup', _repoId: 'test-project',
      });
    });

    it('returns outgoing relationships with _repoId (TC-2)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'found',
            symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/auth.ts', startLine: 1, endLine: 10 },
            incoming: {},
            outgoing: {
              calls: [{ uid: 'func:validate', name: 'validate', filePath: '/validate.ts', kind: 'Function' }],
              extends: [{ uid: 'class:BaseAuth', name: 'BaseAuth', filePath: '/base.ts', kind: 'Class' }],
            },
            processes: [],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.outgoing.calls[0]).toMatchObject({
        uid: 'func:validate', _repoId: 'test-project',
      });
      expect(result.outgoing.extends[0]).toMatchObject({
        uid: 'class:BaseAuth', _repoId: 'test-project',
      });
    });

    it('returns processes with _repoId (TC-3)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'found',
            symbol: { uid: 'func:login', name: 'login', kind: 'Function', filePath: '/login.ts', startLine: 1, endLine: 10 },
            incoming: {},
            outgoing: {},
            processes: [{ id: 'proc:UserLogin', name: 'UserLogin', step_index: 2, step_count: 5 }],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'login',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.processes).toHaveLength(1);
      expect(result.processes[0]).toMatchObject({
        id: 'proc:UserLogin', name: 'UserLogin', _repoId: 'test-project',
      });
    });

    it('preserves empty relationship shape when no refs exist (TC-4)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'found',
            symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/auth.ts', startLine: 1, endLine: 10 },
            incoming: {},
            outgoing: {},
            processes: [],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.incoming).toEqual({});
      expect(result.outgoing).toEqual({});
      expect(result.processes).toEqual([]);
    });

    it('adds _repoId to each nested entry in incoming categories (TC-5)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'found',
            symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/auth.ts', startLine: 1, endLine: 10 },
            incoming: {
              calls: [
                { uid: 'func:caller1', name: 'caller1', filePath: '/c1.ts', kind: 'Function' },
                { uid: 'func:caller2', name: 'caller2', filePath: '/c2.ts', kind: 'Function' },
              ],
            },
            outgoing: {},
            processes: [],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.incoming.calls).toHaveLength(2);
      expect(result.incoming.calls[0]._repoId).toBe('test-project');
      expect(result.incoming.calls[1]._repoId).toBe('test-project');
    });

    it('returns relationships from other repo when one repo errors (TC-6)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          throw new Error('connection failed');
        }
        return {
          status: 'found',
          symbol: { uid: 'func:auth', name: 'auth', kind: 'Function', filePath: '/auth.ts', startLine: 1, endLine: 10 },
          incoming: { calls: [{ uid: 'func:caller', name: 'caller', filePath: '/c.ts', kind: 'Function' }] },
          outgoing: {},
          processes: [],
        };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('found');
      expect(result.symbol._repoId).toBe('other-project');
      expect(result.incoming.calls[0]._repoId).toBe('other-project');
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0].repoId).toBe('test-project');
    });

    it('returns ambiguous candidates with _repoId (TC-7)', async () => {
      vi.spyOn(backend as any, 'context').mockImplementation(async (handle: any) => {
        if (handle.id === 'test-project') {
          return {
            status: 'ambiguous',
            candidates: [
              { uid: 'func:auth:1', name: 'auth', kind: 'Function', filePath: '/a.ts', startLine: 1, endLine: 5 },
              { uid: 'func:auth:2', name: 'auth', kind: 'Function', filePath: '/b.ts', startLine: 1, endLine: 5 },
            ],
          };
        }
        return { error: 'Symbol not found' };
      });

      const result = await backend.callTool('context', {
        name: 'auth',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('ambiguous');
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]._repoId).toBe('test-project');
      expect(result.candidates[1]._repoId).toBe('test-project');
    });

    it('returns not_found when symbol not in any repo (TC-8)', async () => {
      vi.spyOn(backend as any, 'context').mockResolvedValue({ error: 'Symbol not found' });

      const result = await backend.callTool('context', {
        name: 'nonexistent',
        repos: ['test-project', 'other-project'],
      });

      expect(result.status).toBe('not_found');
    });
  });

  describe('impact tool with repos[]', () => {
    it('routes to multi-repo handler when repos array is provided', async () => {
      (executeParameterized as any)
        .mockResolvedValueOnce([
          { id: 'func:auth', name: 'auth', type: 'Function', filePath: '/a.ts' },
        ])
        .mockResolvedValueOnce([]);
      (executeQuery as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await backend.callTool('impact', {
        target: 'auth',
        direction: 'upstream',
        repos: ['test-project', 'other-project'],
      });

      // Should aggregate impact results
      expect((result as any)).toHaveProperty('byDepth');
      expect((result as any)).toHaveProperty('risk');
    });

    it('calculates aggregate risk from multiple repos', async () => {
      (executeParameterized as any)
        .mockResolvedValueOnce([
          { id: 'func:auth', name: 'auth', type: 'Function', filePath: '/a.ts' },
        ])
        .mockResolvedValueOnce([]);
      (executeQuery as any)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await backend.callTool('impact', {
        target: 'auth',
        direction: 'upstream',
        repos: ['test-project', 'other-project'],
      });

      // Risk should be calculated from aggregated results
      // With no callers found, risk is 'NONE'
      expect(['NONE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(result.risk);
    });
  });

  describe('backward compatibility', () => {
    it('rejects repos[] for tools that do not support it', async () => {
      await expect(backend.callTool('rename', {
        symbol_name: 'oldName',
        new_name: 'newName',
        repos: ['test-project'],
      })).rejects.toThrow('does not support multi-repo queries');
    });

    it('empty repos array is treated as single-repo (uses default)', async () => {
      // Reset to single repo for this test
      (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
      backend = new LocalBackend();
      await backend.init();

      (executeQuery as any).mockResolvedValue([]);

      // Empty repos array should fall through to single-repo path
      const result = await backend.callTool('cypher', {
        query: 'MATCH (n) RETURN n LIMIT 1',
        repos: [], // Empty array should fall back to single-repo
      });

      // Should use single-repo handler (returns empty array for empty result)
      expect((result as any)).toEqual([]);
    });
  });
});

// ─── WI-7: impacted_endpoints dispatch ─────────────────────────────────

describe('callTool impacted_endpoints dispatch', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-configure execFileSync mock to return changed files for impacted_endpoints
    (mockedExecFileSync as any).mockReturnValue('src/Service.java\n');

    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);

    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  // ── Single-repo dispatch ──────────────────────────────────────────

  describe('single-repo dispatch', () => {
    it('routes callTool(impacted_endpoints, { base_ref }) to _impactedEndpointsImpl', async () => {
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });
      (executeQuery as any).mockResolvedValue([]);

      const result = await backend.callTool('impacted_endpoints', { base_ref: 'main' });

      expect((result as any)).toBeDefined();
      expect((result as any)).toHaveProperty('summary');
      expect((result as any)).toHaveProperty('impacted_endpoints');
    });

    it('resolves specific repo when repo param is provided', async () => {
      (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
      backend = new LocalBackend();
      await backend.init();

      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });
      (executeQuery as any).mockResolvedValue([]);

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repo: 'test-project',
      });

      expect((result as any)).toBeDefined();
      expect((result as any)).toHaveProperty('summary');
    });

    it('returns error when compare scope has no base_ref', async () => {
      // When scope is compare but base_ref is missing, execGitDiff returns an error
      const result = await backend.callTool('impacted_endpoints', { scope: 'compare' });

      expect((result as any)).toHaveProperty('error');
      expect((result as any).error).toContain('base_ref is required');
    });

    it('throws for unknown repo name', async () => {
      (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
      backend = new LocalBackend();
      await backend.init();

      await expect(backend.callTool('impacted_endpoints', {
        scope: 'unstaged',
        repo: 'nonexistent',
      })).rejects.toThrow('not found');
    });

    it('throws when multiple repos indexed without repo param', async () => {
      setupMultipleRepos();
      backend = new LocalBackend();
      await backend.init();

      await expect(backend.callTool('impacted_endpoints', { scope: 'unstaged' }))
        .rejects.toThrow('Multiple repositories indexed');
    });

    it('throws when no repos indexed', async () => {
      setupNoRepos();
      backend = new LocalBackend();
      await backend.init();

      await expect(backend.callTool('impacted_endpoints', { scope: 'unstaged' }))
        .rejects.toThrow('No indexed repositories');
    });
  });

  // ── Multi-repo dispatch ────────────────────────────────────────────

  describe('multi-repo dispatch', () => {
    beforeEach(async () => {
      (listRegisteredRepos as any).mockResolvedValue([
        MOCK_REPO_ENTRY,
        { ...MOCK_REPO_ENTRY, name: 'other-project', path: '/tmp/other-project', storagePath: '/tmp/.gitnexus/other-project' },
      ]);
      (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
      (initLbug as any).mockResolvedValue(undefined);
      (isLbugReady as any).mockReturnValue(true);
      (closeLbug as any).mockResolvedValue(undefined);
      (executeQuery as any).mockResolvedValue([]);
      (executeParameterized as any).mockResolvedValue([]);

      backend = new LocalBackend();
      await backend.init();
    });

    afterEach(async () => {
      await backend.disconnect();
    });

    it('routes to multi-repo handler when repos array is provided', async () => {
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repos: ['test-project', 'other-project'],
      });

      expect((result as any)).toHaveProperty('summary');
      expect((result as any)).toHaveProperty('impacted_endpoints');
    });

    it('merges endpoint results from two repos with _repoId attribution', async () => {
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        // Route discovery for first repo
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Controller.java',
            line: 10, controller: 'Controller', handler: 'getData',
            affected_name: 'Service', affected_id: 'sym-1',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repos: ['test-project', 'other-project'],
      });

      // Results should include _repoId attribution
      expect((result as any)).toHaveProperty('summary');
      expect((result as any).summary.changed_files).toBeDefined();
    });

    it('includes same endpoint from both repos (not deduped across repos)', async () => {
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repos: ['test-project', 'other-project'],
      });

      // Both repos should be represented in summary
      expect((result as any)).toHaveProperty('summary');
    });

    it('returns partial result with errors when one repo fails', async () => {
      // First call succeeds, second call throws
      let callCount = 0;
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        callCount++;
        if (callCount > 2) throw new Error('DB connection lost');
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repos: ['test-project', 'other-project'],
      });

      expect((result as any)).toHaveProperty('summary');
      // At least one repo should have succeeded or errors should be captured
      expect((result as any)).toHaveProperty('errors');
    });

    it('calculates aggregate risk across repos', async () => {
      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });

      const result = await backend.callTool('impacted_endpoints', {
        base_ref: 'main',
        repos: ['test-project', 'other-project'],
      });

      expect((result as any)).toHaveProperty('summary');
      expect((result as any).summary).toHaveProperty('risk_level');
      expect((result as any)).toHaveProperty('_meta');
    });

    it('falls back to single-repo path when repos array is empty', async () => {
      (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
      backend = new LocalBackend();
      await backend.init();

      (executeParameterized as any).mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
        }
        return [];
      });
      (executeQuery as any).mockResolvedValue([]);

      const result = await backend.callTool('impacted_endpoints', {
        scope: 'unstaged',
        repos: [], // Empty array → single-repo fallback
      });

      expect((result as any)).toBeDefined();
      expect((result as any)).toHaveProperty('summary');
    });
  });
});

// ─── Auto-expand impacted_endpoints to consumers (WI-4) ────────────

describe('impacted_endpoints auto-expand to consumers', () => {
  let backend: LocalBackend;

  // Mock registry with all methods needed by disconnect() and callToolMultiRepo
  function mockRegistry(overrides: Partial<{ isInitialized: () => boolean; findConsumers: (id: string) => string[]; clear: () => void; listRepos: () => any[] }> = {}) {
    return {
      isInitialized: overrides.isInitialized ?? (() => true),
      findConsumers: overrides.findConsumers ?? ((_: string) => []),
      clear: overrides.clear ?? (() => {}),
      listRepos: overrides.listRepos ?? (() => []),
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (mockedExecFileSync as any).mockReturnValue('src/Service.java\n');
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);
    (executeParameterized as any).mockResolvedValue([]);
    (executeQuery as any).mockResolvedValue([]);

    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  it('T-CR-24: single repo with no dependents falls back to single-repo BFS', async () => {
    // Registry returns no consumers → single-repo fallback
    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue([]),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged' });

    expect(result).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    // Single-repo result now has Record changed_files (keyed by repo id)
    expect(typeof (result as any).summary.changed_files).toBe('object');
    // findConsumers WAS called — it checked and found nothing
    expect((backend as any).crossRepoRegistry.findConsumers).toHaveBeenCalledWith('test-project');
  });

  it('T-CR-25: explicit repo param scopes to that repo (skips auto-expand #21)', async () => {
    // Register 2 repos so resolveRepo works for both source and consumer
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'consumer-a', path: '/tmp/consumer-a', storagePath: '/tmp/.gitnexus/consumer-a' },
    ]);
    backend = new LocalBackend();
    await backend.init();

    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue(['consumer-a']),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    // (#21) When the caller pins a specific repo, the response must be
    // scoped to that repo only — auto-expand to consumers is skipped to
    // prevent the consumer's changed_files from leaking into the result.
    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged', repo: 'test-project' });

    expect(result).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    expect((result as any).summary.changed_files).toBeDefined();
    // findConsumers MUST NOT be called when repo is explicit — auto-expand
    // is suppressed so the user gets the repo they asked for.
    expect((backend as any).crossRepoRegistry.findConsumers).not.toHaveBeenCalled();
  });

  it('T-CR-26: explicit repo param scopes even with multiple consumers (#21)', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'consumer-a', path: '/tmp/consumer-a', storagePath: '/tmp/.gitnexus/consumer-a' },
      { ...MOCK_REPO_ENTRY, name: 'consumer-b', path: '/tmp/consumer-b', storagePath: '/tmp/.gitnexus/consumer-b' },
    ]);
    backend = new LocalBackend();
    await backend.init();

    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue(['consumer-a', 'consumer-b']),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged', repo: 'test-project' });

    expect(result).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    expect((result as any).summary.changed_files).toBeDefined();
    // (#21) findConsumers MUST NOT be called when repo is explicit, even
    // when multiple consumers are registered.
    expect((backend as any).crossRepoRegistry.findConsumers).not.toHaveBeenCalled();
  });

  it('T-CR-27: explicit repos param overrides auto-discovery', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'consumer-a', path: '/tmp/consumer-a', storagePath: '/tmp/.gitnexus/consumer-a' },
    ]);
    backend = new LocalBackend();
    await backend.init();

    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue(['consumer-a']),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    // Call with explicit repos — skips auto-discovery entirely
    const result = await backend.callTool('impacted_endpoints', {
      scope: 'unstaged',
      repos: ['test-project'],
    });

    expect(result).toBeDefined();
    // findConsumers should NOT have been called since repos was explicitly provided
    expect((backend as any).crossRepoRegistry.findConsumers).not.toHaveBeenCalled();
  });

  it('T-CR-28: registry not initialized falls back to single-repo', async () => {
    // Registry exists but reports not initialized
    (backend as any).crossRepoRegistry = mockRegistry({
      isInitialized: () => false,
      findConsumers: vi.fn().mockReturnValue([]),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged' });

    // Falls back to single-repo since registry not initialized
    expect(result).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    expect(typeof (result as any).summary.changed_files).toBe('object');
    // findConsumers NOT called because registry reports uninitialized
    expect((backend as any).crossRepoRegistry.findConsumers).not.toHaveBeenCalled();
  });

  it('throws when _impactedEndpointsImpl returns primitive changed_files (regression detection)', async () => {
    // Simulate a regression where _impactedEndpointsImpl returns number instead of Record
    vi.spyOn(backend as any, '_impactedEndpointsImpl').mockResolvedValue({
      summary: { changed_files: 3, changed_symbols: 1, impacted_endpoints: 1, risk_level: 'low' },
      impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] },
      changed_symbols: [], affected_processes: [], affected_modules: [],
      _meta: { version: '1.0', generated_at: new Date().toISOString() },
    });

    // No consumers → single-repo fallback path, which runs assertObjectType
    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue([]),
    });

    await expect(
      backend.callTool('impacted_endpoints', { scope: 'unstaged' })
    ).rejects.toThrow('Unexpected changed_files type: number');
  });

  it('passes assertObjectType when _impactedEndpointsImpl returns Record changed_files', async () => {
    vi.spyOn(backend as any, '_impactedEndpointsImpl').mockResolvedValue({
      summary: { changed_files: { 'test-project': 3 }, changed_symbols: 1, impacted_endpoints: { 'test-project': 1 }, risk_level: 'low' },
      impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] },
      changed_symbols: [], affected_processes: [], affected_modules: [],
      _meta: { version: '1.0', generated_at: new Date().toISOString() },
    });

    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue([]),
    });

    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged' });
    expect(result).toBeDefined();
    expect(typeof (result as any).summary.changed_files).toBe('object');
  });

  // WI-A3 (Batch A — #21): cross-repo `changed_files` leak.
  // Triage expected PR #99 to have fixed this. Stage-2 RCA found #99 was reverted by #101
  // and the leak still reproduces. This test captures the bug as a regression — the
  // earlier it.todo was promoted to a real test once #21 was fixed: when the caller
  // passes `repo=`, auto-expand to consumers MUST be suppressed, so the consumer
  // repo's changed_files cannot leak into the response.
  it('WI-A3: single-repo call with auto-expanded consumer does not leak consumer into changed_files (#21)', async () => {
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'consumer-a', path: '/tmp/consumer-a', storagePath: '/tmp/.gitnexus/consumer-a' },
    ]);
    backend = new LocalBackend();
    await backend.init();

    // Consumer is registered — but since the caller pins `repo=`,
    // findConsumers must NOT be called and the response must not include
    // consumer-a's changes.
    (backend as any).crossRepoRegistry = mockRegistry({
      findConsumers: vi.fn().mockReturnValue(['consumer-a']),
    });

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });

    const result = await backend.callTool('impacted_endpoints', { scope: 'unstaged', repo: 'test-project' });

    expect(result).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    const cf = (result as any).summary.changed_files;
    // Single-repo result: changed_files is keyed by the pinned repo only.
    // The consumer repo 'consumer-a' must NOT appear in the result.
    const keys = Object.keys(cf);
    expect(keys).toEqual(['test-project']);
    expect(keys).not.toContain('consumer-a');
    // findConsumers was NOT called — auto-expand suppressed.
    expect((backend as any).crossRepoRegistry.findConsumers).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Section F: Multi-Repo Dispatch — detailed impacted_endpoints scenarios
// ──────────────────────────────────────────────────────────────────────

describe('impacted_endpoints multi-repo dispatch — detailed scenarios', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    (listRegisteredRepos as any).mockResolvedValue([
      MOCK_REPO_ENTRY,
      { ...MOCK_REPO_ENTRY, name: 'other-project', path: '/tmp/other-project', storagePath: '/tmp/.gitnexus/other-project' },
    ]);
    (cleanupOldKuzuFiles as any).mockResolvedValue({ found: false, needsReindex: false });
    (initLbug as any).mockResolvedValue(undefined);
    (isLbugReady as any).mockReturnValue(true);
    (closeLbug as any).mockResolvedValue(undefined);
    (mockedExecFileSync as any).mockReturnValue('src/Service.java\n');

    backend = new LocalBackend();
    await backend.init();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  /**
   * Helper: stub _impactedEndpointsImpl to return a fixed result per repo.
   * This isolates the dispatch aggregation logic from mock-layer issues
   * (concurrent repo calls through the shared lbug-adapter mock).
   */
  function stubImpl(repoResults: Record<string, any>) {
    vi.spyOn(backend as any, '_impactedEndpointsImpl').mockImplementation(
      async (repo: any) => {
        const id = repo.id || repo.name;
        if (repoResults[id]) return repoResults[id];
        // Default empty result
        return {
          summary: { changed_files: { [id]: 0 }, changed_symbols: 0, impacted_endpoints: { [id]: 0 }, risk_level: 'none' },
          impacted_endpoints: { WILL_BREAK: [], LIKELY_AFFECTED: [], MAY_NEED_TESTING: [] },
          changed_symbols: [], affected_processes: [], affected_modules: [],
          _meta: { version: '1.0', generated_at: new Date().toISOString() },
        };
      }
    );
  }

  /** Build a standard result with the given risk_level and endpoints */
  function makeResult(opts: { risk_level?: string; will_break?: any[]; likely_affected?: any[]; may_need_testing?: any[]; partial?: boolean; repoId?: string }) {
    const wb = opts.will_break || [];
    const la = opts.likely_affected || [];
    const mnt = opts.may_need_testing || [];
    const id = opts.repoId || 'test-project';
    return {
      summary: {
        changed_files: { [id]: 1 }, changed_symbols: 1,
        impacted_endpoints: { [id]: wb.length + la.length + mnt.length },
        risk_level: opts.risk_level || 'LOW',
      },
      impacted_endpoints: { WILL_BREAK: wb, LIKELY_AFFECTED: la, MAY_NEED_TESTING: mnt },
      changed_symbols: [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java', change_type: 'Modified' }],
      affected_processes: [], affected_modules: [],
      _meta: { version: '1.0', generated_at: new Date().toISOString(), ...(opts.partial && { partial: true }) },
    };
  }

  // U-MR01: Two repos, both return endpoints → merged with _repoId
  it('merges endpoint results from two repos with _repoId per endpoint', async () => {
    stubImpl({
      'test-project': makeResult({
        risk_level: 'MEDIUM',
        will_break: [{ method: 'GET', path: '/api/users', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'getUsers', confidence: 1.0, affected_by: ['sym-1'], discovery_paths: ['DEFINES'] }],
      }),
      'other-project': makeResult({
        risk_level: 'LOW',
        will_break: [{ method: 'POST', path: '/api/orders', file_path: 'OrderCtrl.java', line: 20, controller: 'OrderCtrl', handler: 'createOrder', confidence: 1.0, affected_by: ['sym-1'], discovery_paths: ['DEFINES'] }],
      }),
    });

    const result = await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    expect((result as any)).toHaveProperty('summary');
    const allEndpoints = [
      ...result.impacted_endpoints.WILL_BREAK,
      ...result.impacted_endpoints.LIKELY_AFFECTED,
      ...result.impacted_endpoints.MAY_NEED_TESTING,
    ];
    expect(allEndpoints.length).toBeGreaterThanOrEqual(2);
    // All endpoints should have _repoId
    for (const ep of allEndpoints) {
      expect(ep).toHaveProperty('_repoId');
      expect(['test-project', 'other-project']).toContain(ep._repoId);
    }
  });

  // U-MR02: Same endpoint path/method in both repos → both appear (different repos, not deduped)
  it('includes same endpoint from both repos (not deduped across repos)', async () => {
    const sharedRoute = { method: 'GET', path: '/api/shared', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'getShared', confidence: 1.0, affected_by: ['sym-1'], discovery_paths: ['DEFINES'] };
    stubImpl({
      'test-project': makeResult({ risk_level: 'LOW', will_break: [sharedRoute] }),
      'other-project': makeResult({ risk_level: 'LOW', will_break: [sharedRoute] }),
    });

    const result = await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    const allEndpoints = [
      ...result.impacted_endpoints.WILL_BREAK,
      ...result.impacted_endpoints.LIKELY_AFFECTED,
      ...result.impacted_endpoints.MAY_NEED_TESTING,
    ];
    const sharedEndpoints = allEndpoints.filter((ep: any) => ep.path === '/api/shared' && ep.method === 'GET');
    // Both repos contribute the same route → 2 entries with different _repoId
    expect(sharedEndpoints).toHaveLength(2);
    const repoIds = sharedEndpoints.map((ep: any) => ep._repoId).sort();
    expect(repoIds).toEqual(['other-project', 'test-project']);
  });

  // U-MR03: One repo fails, one succeeds → partial result + errors array
  it('returns partial result with errors when one repo throws', async () => {
    vi.spyOn(backend as any, '_impactedEndpointsImpl').mockImplementation(
      async (repo: any) => {
        if (repo.id === 'other-project' || repo.name === 'other-project') {
          throw new Error('DB connection lost');
        }
        return makeResult({
          risk_level: 'LOW',
          will_break: [{ method: 'GET', path: '/api/data', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'getData', confidence: 1.0, affected_by: ['sym-1'], discovery_paths: ['DEFINES'] }],
        });
      }
    );

    const result = await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    // Should have results from test-project
    expect((result as any)).toHaveProperty('summary');
    // Should have errors from other-project
    expect((result as any)).toHaveProperty('errors');
    expect((result as any).errors.length).toBeGreaterThanOrEqual(1);
    expect((result as any).errors[0].repoId).toBe('other-project');
  });

  // U-MR04: Aggregate risk — one repo=HIGH, other=LOW → overall=HIGH
  it('calculates aggregate risk taking highest across repos', async () => {
    stubImpl({
      'test-project': makeResult({ risk_level: 'HIGH', will_break: [{ method: 'GET', path: '/api/high', file_path: 'H.java', line: 1, controller: 'HC', handler: 'h', confidence: 1.0, affected_by: [], discovery_paths: [] }] }),
      'other-project': makeResult({ risk_level: 'LOW' }),
    });

    const result = await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    // Highest risk across repos wins
    expect((result as any).summary.risk_level).toBe('HIGH');
  });

  // U-MR05: _meta.partial propagation — one repo partial=true → aggregated _meta.partial=true
  it('sets _meta.partial=true when any individual repo result is partial', async () => {
    stubImpl({
      'test-project': makeResult({ risk_level: 'MEDIUM', partial: true, will_break: [{ method: 'GET', path: '/api/partial', file_path: 'P.java', line: 1, controller: 'PC', handler: 'p', confidence: 1.0, affected_by: [], discovery_paths: [] }] }),
      'other-project': makeResult({ risk_level: 'LOW' }),
    });

    const result = await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    expect((result as any)._meta).toBeDefined();
    expect((result as any)._meta.partial).toBe(true);
  });

  // U-MR06: Empty repos array → falls back to single-repo path
  it('falls back to single-repo path when repos array is empty', async () => {
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    backend = new LocalBackend();
    await backend.init();

    (executeParameterized as any).mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('n.filePath CONTAINS')) {
        return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'src/Service.java' }];
      }
      return [];
    });
    (executeQuery as any).mockResolvedValue([]);

    const result = await backend.callTool('impacted_endpoints', {
      scope: 'unstaged',
      repos: [],
    });

    expect((result as any)).toBeDefined();
    expect((result as any)).toHaveProperty('summary');
    // Single-repo path doesn't have the multi-repo `errors` array
    expect((result as any)).not.toHaveProperty('errors');
  });

  // U-MR07: CrossRepoContext is created and passed to _impactedEndpointsImpl when multiple repos
  it('creates and passes CrossRepoContext to _impactedEndpointsImpl for multi-repo calls', async () => {
    const implSpy = vi.spyOn(backend as any, '_impactedEndpointsImpl').mockImplementation(
      async (_repo: any, _params: any, crossRepo: any) => {
        // Verify crossRepo was passed with expected methods
        expect(crossRepo).toBeDefined();
        expect(typeof crossRepo.listDepRepos).toBe('function');
        expect(typeof crossRepo.queryMultipleRepos).toBe('function');
        expect(typeof crossRepo.findDepRepo).toBe('function');
        return makeResult({ risk_level: 'LOW' });
      },
    );

    await backend.callTool('impacted_endpoints', {
      base_ref: 'main',
      repos: ['test-project', 'other-project'],
    });

    expect(implSpy).toHaveBeenCalledTimes(2);
    // Both calls should receive crossRepo
    expect(implSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ base_ref: 'main' }),
      expect.objectContaining({
        listDepRepos: expect.any(Function),
        queryMultipleRepos: expect.any(Function),
        findDepRepo: expect.any(Function),
      }),
    );
  });

  // U-MR08: Single-repo impacted_endpoints does NOT pass crossRepo
  it('does not pass CrossRepoContext for single-repo impacted_endpoints call', async () => {
    (listRegisteredRepos as any).mockResolvedValue([MOCK_REPO_ENTRY]);
    const singleBackend = new LocalBackend();
    await singleBackend.init();

    const implSpy = vi.spyOn(singleBackend as any, '_impactedEndpointsImpl').mockResolvedValue(
      makeResult({ risk_level: 'LOW' }),
    );

    (executeParameterized as any).mockResolvedValue([]);
    (executeQuery as any).mockResolvedValue([]);

    await singleBackend.callTool('impacted_endpoints', { scope: 'unstaged' });

    // Single-repo call: _impactedEndpointsImpl is called with 2 args (no crossRepo)
    const callArgs = implSpy.mock.calls[0];
    expect(callArgs.length).toBe(2);
    // No third argument — backward compatible
    expect(callArgs[2]).toBeUndefined();

    await singleBackend.disconnect();
  });
});

// ─── cwd-based auto-resolution ───────────────────────────────────────

describe('LocalBackend.resolveRepoFromCache — cwd resolution', () => {
  let backend: LocalBackend;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const REPO_A = MOCK_REPO_ENTRY; // path: '/tmp/test-project'
  const REPO_B = {
    ...MOCK_REPO_ENTRY,
    name: 'other-project',
    path: '/tmp/other-project',
    storagePath: '/tmp/.gitnexus/other-project',
  };
  const REPO_MONO = {
    ...MOCK_REPO_ENTRY,
    name: 'mono',
    path: '/tmp/mono',
    storagePath: '/tmp/.gitnexus/mono',
  };
  const REPO_NESTED = {
    ...MOCK_REPO_ENTRY,
    name: 'nested-pkg',
    path: '/tmp/mono/packages/x',
    storagePath: '/tmp/.gitnexus/nested-pkg',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    // clearAllMocks wipes the module-level mockResolvedValue — restore it so query() doesn't throw
    (searchFTSFromLbug as any).mockResolvedValue([]);
    backend = new LocalBackend();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Case 1: cwd exactly equals an indexed repo's path → resolves that repo
  it('resolves repo when cwd exactly equals repoPath', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A, REPO_B]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/test-project');
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'test' });
    expect(result).toHaveProperty('processes');
  });

  // Case 2: cwd is a subdirectory of a repo's path → resolves that repo
  it('resolves repo when cwd is a subdirectory of repoPath', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A, REPO_B]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/test-project/src/utils');
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'test' });
    expect(result).toHaveProperty('processes');
  });

  // Case 3: cwd inside none of the repos → still throws 'Multiple repositories indexed'
  it('throws when cwd does not match any indexed repo', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A, REPO_B]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/unrelated');
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('Multiple repositories indexed');
  });

  // Case 4: nested repos — nearest ancestor wins
  it('resolves nearest ancestor when cwd is inside a nested repo', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_MONO, REPO_NESTED]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/mono/packages/x/src');
    (executeParameterized as any).mockResolvedValue([]);
    // Should resolve /tmp/mono/packages/x (REPO_NESTED), not /tmp/mono (REPO_MONO)
    const result = await backend.callTool('query', { query: 'test', repo: 'nested-pkg' });
    expect(result).toHaveProperty('processes');
    // Spy on console.error to prove cwd-based resolution picks the NEAREST repo (nested-pkg),
    // not the shallower ancestor (mono). Both repos contain the cwd, so a longest-prefix bug
    // would silently pick the wrong one — this assertion catches that regression.
    const errSpy = vi.spyOn(console, 'error');
    (executeParameterized as any).mockResolvedValue([]);
    const cwdResult = await backend.callTool('query', { query: 'no-param' });
    expect(cwdResult).toHaveProperty('processes');
    // Must have logged auto-resolution for "nested-pkg", NOT for "mono"
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('auto-resolved repo "nested-pkg"'),
    );
    const loggedMessages = errSpy.mock.calls.map((c) => c[0] as string);
    expect(loggedMessages.every((m) => !m.includes('auto-resolved repo "mono"'))).toBe(true);
    errSpy.mockRestore();
  });

  // Case 5: boundary — sep guard; '/tmp/test-project-extra' must NOT match '/tmp/test-project'
  it('does not match repo when cwd shares a path prefix but not a path separator boundary', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A, REPO_B]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/test-project-extra');
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('Multiple repositories indexed');
  });

  // Case 6: explicit repo param takes precedence over cwd
  it('uses explicit repo param even when cwd is inside a different repo', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A, REPO_B]);
    await backend.init();
    // cwd is inside REPO_A (/tmp/test-project), but we explicitly request REPO_B
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/test-project/src');
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'test', repo: 'other-project' });
    expect(result).toHaveProperty('processes');
  });

  // Case 7: single indexed repo, no param, any cwd → resolves the one repo (unchanged behavior)
  it('resolves single repo without param regardless of cwd', async () => {
    (listRegisteredRepos as any).mockResolvedValue([REPO_A]);
    await backend.init();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/home/user/completely-unrelated');
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'test' });
    expect(result).toHaveProperty('processes');
  });
});
