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

// We need to mock the LadybugDB adapter and repo-manager BEFORE importing LocalBackend
vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  initLbug: vi.fn().mockResolvedValue(undefined),
  executeQuery: vi.fn().mockResolvedValue([]),
  executeParameterized: vi.fn().mockResolvedValue([]),
  closeLbug: vi.fn().mockResolvedValue(undefined),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

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

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, cleanupOldKuzuFiles } from '../../src/storage/repo-manager.js';
import { initLbug, executeQuery, executeParameterized, isLbugReady, closeLbug } from '../../src/mcp/core/lbug-adapter.js';

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
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
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
    const result = await backend.callTool('cypher', { query: 'CREATE (n:Test)' });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Write operations');
  });

  it('dispatches cypher tool with valid read query', async () => {
    (executeQuery as any).mockResolvedValue([
      { name: 'test', filePath: 'src/test.ts' },
    ]);
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
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts', startLine: 1, endLine: 10 },
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
      { id: 'func:main:1', name: 'main', type: 'Function', filePath: 'src/a.ts', startLine: 1, endLine: 5 },
      { id: 'func:main:2', name: 'main', type: 'Function', filePath: 'src/b.ts', startLine: 1, endLine: 5 },
    ]);
    const result = await backend.callTool('context', { name: 'main' });
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toHaveLength(2);
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
        { id: 'func:oldName', name: 'oldName', type: 'Function', filePath: 'src/test.ts', startLine: 1, endLine: 5 },
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
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts', startLine: 1, endLine: 10 },
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
    backend = new LocalBackend();
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
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('No indexed repositories');
  });

  it('throws for ambiguous repos without param', async () => {
    setupMultipleRepos();
    await backend.init();
    await expect(backend.callTool('query', { query: 'test' }))
      .rejects.toThrow('Multiple repositories indexed');
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
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Write operations');
    });
  }

  it('allows read query through callTool', async () => {
    (executeQuery as any).mockResolvedValue([]);
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
    (executeQuery as any).mockResolvedValue([
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
    (executeQuery as any).mockResolvedValue([]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name LIMIT 0',
    });
    expect(result).toEqual([]);
  });

  it('returns error object when cypher fails', async () => {
    (executeQuery as any).mockRejectedValue(new Error('Syntax error'));
    const result = await backend.callTool('cypher', {
      query: 'INVALID CYPHER SYNTAX',
    });
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('Syntax error');
  });
});
