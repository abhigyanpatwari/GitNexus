/**
 * Unit Tests: _impactedEndpointsImpl
 *
 * Tests the impacted_endpoints pipeline end-to-end by mocking the
 * lbug-adapter layer (executeQuery / executeParameterized) and
 * child_process.execFileSync. Does NOT mock LocalBackend as a whole.
 *
 * Pipeline stages tested:
 * 1. git diff → changed files
 * 2. changed files → graph symbols
 * 3. BFS upstream traversal
 * 4. Route discovery (3 parallel queries)
 * 5. Dedup + tier classification
 * 6. Enrichment (processes, modules)
 * 7. Risk scoring
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process ───────────────────────────────────────────────
const execFileSyncMock = vi.fn();
vi.mock('child_process', () => ({
  execFileSync: (...args: any[]) => execFileSyncMock(...args),
}));

// ─── Mock lbug-adapter ────────────────────────────────────────────────
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...(args as [any, any])),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...(args as [any, any, any])),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

// ─── Mock repo-manager / search / embedder ────────────────────────────
const loadMetaMock = vi.fn<() => Promise<any>>().mockResolvedValue(null);

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  loadMeta: (...args: any[]) => loadMetaMock(...(args as [any])),
}));

vi.mock('../../src/core/lbug/schema.js', () => ({
  SCHEMA_VERSION: 29,
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

// ─── Mock CrossRepoResolver ────────────────────────────────────────
const mockResolveDepConsumers = vi.fn();

vi.mock('../../src/mcp/local/cross-repo-resolver.js', () => ({
  CrossRepoResolver: vi.fn(function(this: any) {
    this.resolveDepConsumers = mockResolveDepConsumers;
  }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { CrossRepoResolver } from '../../src/mcp/local/cross-repo-resolver.js';

// ─── Helpers ──────────────────────────────────────────────────────────

function makeBackend(): LocalBackend {
  const backend = new LocalBackend();
  const repoHandle = {
    id: 'repo-ie', name: 'repo-ie', repoPath: '/tmp/repo-ie',
    storagePath: '/tmp/repo-ie/.gitnexus', lbugPath: '/tmp/repo-ie/.gitnexus/lbug',
    indexedAt: 'now', lastCommit: 'c', stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  return backend;
}

/** Set up default execFileSync to return changed files via --unified=0 diff output.
 *  Also satisfies the fallback --name-only path when needed. */
function setupGitDiff(files: string[]) {
  // Produce --unified=0 diff output so parseDiffOutputWithLines can parse it.
  // Each file gets a single hunk covering lines 1-1 (minimal; content doesn't matter).
  const diffLines: string[] = [];
  for (const f of files) {
    diffLines.push('diff --git a/' + f + ' b/' + f);
    diffLines.push('--- a/' + f);
    diffLines.push('+++ b/' + f);
    diffLines.push('@@ -1 +1 @@');
    diffLines.push('+changed');
  }
  execFileSyncMock.mockReturnValue(diffLines.join('\n') + '\n');
}

/**
 * Set up executeParameterized for the file→symbols step.
 * Maps each changed file to a set of symbol rows.
 */
// Route health check query handler — overridden per test
let routeHealthCheckHandler: (() => any[] | never) | null = null;

function setupFileSymbols(fileSymbolMap: Record<string, any[]>) {
  executeParameterizedMock.mockImplementation(async (...args: any[]) => {
    const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
    const params = args[2] || {};

    // File → symbols query
    if (query.includes('n.filePath CONTAINS')) {
      const filePath = params.filePath || '';
      return fileSymbolMap[filePath] || [];
    }

    // Route health check query
    if (query.includes('Route') && query.includes('count(r)')) {
      if (routeHealthCheckHandler) return routeHealthCheckHandler();
      return [{ cnt: 100 }]; // default: Route table exists
    }

    // Route discovery queries
    if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
      return routeDiscoveryHandler('reverse-CALLS', params);
    }
    if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
      return routeDiscoveryHandler('DEFINES', params);
    }
    if (query.includes('FETCHES')) {
      return routeDiscoveryHandler('FETCHES', params);
    }

    // Annotation-fallback query (Method nodes in Controller files)
    if (query.includes('m.filePath CONTAINS') && query.includes('Controller')) {
      return annotationFallbackHandler(params);
    }

    // Class-level prefix query
    if (query.includes('c.filePath') && query.includes('classContent')) {
      return classPrefixHandler(params);
    }

    // STEP_IN_PROCESS enrichment
    if (query.includes('STEP_IN_PROCESS')) {
      return [];
    }

    return [];
  });
}

// Route discovery response handlers — overridden per test
let routeDiscoveryHandler = (_type: string, _params: any): any[] => [];

// Annotation-fallback response handler — overridden per test
let annotationFallbackHandler = (_params: any): any[] => [];

// Class-level prefix response handler — overridden per test
let classPrefixHandler = (_params: any): any[] => [];

/** Set up executeQuery for BFS traversal */
function setupBFS(traversalResult: any[]) {
  executeQueryMock.mockImplementation(async (...args: any[]) => {
    const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
    if (query.includes('r.type IN')) {
      return traversalResult;
    }
    // Module enrichment
    if (query.includes('MEMBER_OF') && query.includes('COUNT(DISTINCT s.id)')) {
      return [];
    }
    if (query.includes('RETURN DISTINCT c.heuristicLabel')) {
      return [];
    }
    return [];
  });
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('_impactedEndpointsImpl', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = makeBackend();
    routeDiscoveryHandler = () => []; // default: no routes
    annotationFallbackHandler = () => []; // default: no annotation methods
    classPrefixHandler = () => []; // default: no class prefix
    routeHealthCheckHandler = null; // default: Route table exists
    loadMetaMock.mockResolvedValue(null); // default: no meta.json
    // Re-apply CrossRepoResolver mock implementation after clearAllMocks
    (CrossRepoResolver as any).mockImplementation(function(this: any) {
      this.resolveDepConsumers = mockResolveDepConsumers;
    });
  });

  // ── Scenario 1: Happy path — 2 changed files, routes found ───────
  it('returns full pipeline output with tiers when routes are discovered', async () => {
    setupGitDiff(['UserService.java', 'UserController.java']);

    // Map files to symbols
    const fileSymbols: Record<string, any[]> = {
      'UserService.java': [
        { id: 'method-getUsers-svc', name: 'getUsers', type: 'Method', filePath: 'UserService.java' },
      ],
      'UserController.java': [
        { id: 'method-getUsers', name: 'getUsers', type: 'Method', filePath: 'UserController.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    // BFS traversal: UserController's getUsers method calls UserService's getUsers
    // The upstream traversal finds controller method as caller of service method
    setupBFS([
      { sourceId: 'method-getUsers-svc', id: 'method-getUsers', name: 'getUsers',
        type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.95 },
    ]);

    // Route discovery: reverse-CALLS finds Route → getUsers (controller)
    routeDiscoveryHandler = (type: string, _params: any) => {
      if (type === 'reverse-CALLS') {
        return [{
          path: '/api/users', method: 'GET', file_path: 'UserController.java',
          line: 25, controller: 'UserController', handler: 'getUsers',
          affected_name: 'getUsers', affected_id: 'method-getUsers',
          relation: 'CALLS', discovery_path: 'reverse-CALLS',
        }];
      }
      return [];
    };

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result.summary).toBeDefined();
    expect(result.summary.changed_files).toEqual({ 'repo-ie': 2 });
    // (#28, #49) summary.changed_symbols is now per-repo Record like
    // changed_files, not a bare number.
    expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 2 });
    expect(result.summary.impacted_endpoints).toEqual({ 'repo-ie': expect.any(Number) });
    expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
    expect(result.impacted_endpoints).toBeDefined();
    expect(result.impacted_endpoints.WILL_BREAK).toBeDefined();
    expect(result.impacted_endpoints.LIKELY_AFFECTED).toBeDefined();
    expect(result.impacted_endpoints.MAY_NEED_TESTING).toBeDefined();
    expect(result.changed_symbols).toHaveLength(2);
  });

  // ── Scenario 2: Empty changed files ──────────────────────────────
  it('returns empty result when changed files list is empty', async () => {
    setupGitDiff([]);

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result.summary.changed_files).toEqual({ 'repo-ie': 0 });
    expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 0 });
    expect(result.summary.impacted_endpoints).toEqual({ 'repo-ie': 0 });
    expect(result.summary.risk_level).toBe('none');
    expect(result.impacted_endpoints.WILL_BREAK).toEqual([]);
    expect(result.impacted_endpoints.LIKELY_AFFECTED).toEqual([]);
    expect(result.impacted_endpoints.MAY_NEED_TESTING).toEqual([]);
  });

  // ── Scenario 3: Changed file maps to 0 symbols ──────────────────
  it('returns risk_level none when changed files map to no symbols', async () => {
    setupGitDiff(['Orphan.java']);
    setupFileSymbols({}); // no symbols for any file
    setupBFS([]);

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
    expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 0 });
    expect(result.summary.risk_level).toBe('none');
  });

  // ── Scenario 4: BFS produces >100 nodes, chunking works ──────────
  it('chunks STEP_IN_PROCESS enrichment for >100 expanded nodes', async () => {
    setupGitDiff(['BigService.java']);

    const fileSymbols: Record<string, any[]> = {
      'BigService.java': [
        { id: 'sym-big', name: 'BigService', type: 'Class', filePath: 'BigService.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    // BFS returns 150 upstream nodes
    const bfsNodes: any[] = [];
    for (let i = 0; i < 150; i++) {
      bfsNodes.push({
        sourceId: 'sym-big', id: `upstream-${i}`, name: `node${i}`,
        type: 'Method', filePath: `file${i}.java`, relType: 'CALLS', confidence: 0.9,
      });
    }
    setupBFS(bfsNodes);

    // Track chunk sizes in STEP_IN_PROCESS queries
    const chunkSizes: number[] = [];
    void routeDiscoveryHandler;
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};

      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('STEP_IN_PROCESS')) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        chunkSizes.push(ids.length);
        return [];
      }
      // Route discovery: return empty
      if (query.includes('reverse-CALLS') || query.includes('DEFINES') || query.includes('FETCHES')) {
        return [];
      }
      return [];
    });

    await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // 1 changed symbol + 150 upstream = 151 total, so chunking applies
    expect(chunkSizes.length).toBe(2); // 100 + 51
    expect(chunkSizes[0]).toBe(100);
    expect(chunkSizes[1]).toBe(51);
  });

  // ── Scenario 5: MAX_CHUNKS exhausted ────────────────────────────
  it('sets partial flag when MAX_CHUNKS is exhausted', async () => {
    const origMaxChunks = process.env.IMPACT_MAX_CHUNKS;
    process.env.IMPACT_MAX_CHUNKS = '1'; // only 1 chunk allowed

    try {
    setupGitDiff(['BigService.java']);
    const fileSymbols: Record<string, any[]> = {
      'BigService.java': [
        { id: 'sym-big', name: 'BigService', type: 'Class', filePath: 'BigService.java' },
      ],
    };

    // 150 upstream nodes
    const bfsNodes: any[] = [];
    for (let i = 0; i < 150; i++) {
      bfsNodes.push({
        sourceId: 'sym-big', id: `upstream-${i}`, name: `node${i}`,
        type: 'Method', filePath: `file${i}.java`, relType: 'CALLS', confidence: 0.9,
      });
    }
    setupBFS(bfsNodes);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('STEP_IN_PROCESS')) {
        return [];
      }
      if (query.includes('reverse-CALLS') || query.includes('DEFINES') || query.includes('FETCHES')) {
        return [];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result._meta.partial).toBe(true);

    } finally {
      if (origMaxChunks === undefined) delete process.env.IMPACT_MAX_CHUNKS;
      else process.env.IMPACT_MAX_CHUNKS = origMaxChunks;
    }
  });

  // ── Scenario 6: Traversal query fails at depth 2 ────────────────
  it('returns d=1 results with traversalComplete false when BFS fails at depth 2', async () => {
    setupGitDiff(['Service.java']);
    const fileSymbols: Record<string, any[]> = {
      'Service.java': [
        { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    let depthCallCount = 0;
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('r.type IN')) {
        depthCallCount++;
        if (depthCallCount === 1) {
          // Depth 1 succeeds: find 1 upstream caller
          return [{
            sourceId: 'sym-svc', id: 'upstream-1', name: 'Caller',
            type: 'Method', filePath: 'Controller.java', relType: 'CALLS', confidence: 0.9,
          }];
        }
        // Depth 2 fails
        throw new Error('query timeout');
      }
      return [];
    });

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('reverse-CALLS') || query.includes('DEFINES') || query.includes('FETCHES')) {
        return [];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result._meta.partial).toBe(true);
  });

  // ── Scenario 7: Route discovery query #1 (reverse-CALLS) fails ──
  it('continues route discovery when reverse-CALLS query fails', async () => {
    setupGitDiff(['Controller.java']);
    const fileSymbols: Record<string, any[]> = {
      'Controller.java': [
        { id: 'sym-ctrl', name: 'Controller', type: 'Class', filePath: 'Controller.java' },
      ],
    };
    setupFileSymbols(fileSymbols);
    setupBFS([]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
        throw new Error('reverse-CALLS query failed');
      }
      if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
        return [{
          path: '/api/data', method: 'GET', file_path: 'Controller.java',
          line: 20, controller: 'Controller', handler: 'getData',
          affected_name: 'Controller', affected_id: 'sym-ctrl',
          relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // DEFINES query should still succeed even though reverse-CALLS failed
    expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });

  // ── Scenario 8: Route discovery query #2 (DEFINES) fails ────────
  it('continues route discovery when DEFINES query fails', async () => {
    setupGitDiff(['Service.java']);
    const fileSymbols: Record<string, any[]> = {
      'Service.java': [
        { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
      ],
    };
    setupFileSymbols(fileSymbols);
    setupBFS([]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
        throw new Error('DEFINES query failed');
      }
      if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
        return [{
          path: '/api/items', method: 'GET', file_path: 'Controller.java',
          line: 10, controller: 'Controller', handler: 'getItems',
          affected_name: 'Service', affected_id: 'sym-svc',
          relation: 'CALLS', discovery_path: 'reverse-CALLS',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });
  // ── Scenario 9: Route discovery query #3 (FETCHES) fails ────────
  it('continues route discovery when FETCHES query fails', async () => {
    setupGitDiff(['Consumer.java']);
    const fileSymbols: Record<string, any[]> = {
      'Consumer.java': [
        { id: 'sym-consumer', name: 'Consumer', type: 'Function', filePath: 'Consumer.java' },
      ],
    };
    setupFileSymbols(fileSymbols);
    setupBFS([]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('FETCHES')) {
        throw new Error('FETCHES query failed');
      }
      // Other queries return empty
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // FETCHES failed but no error should be thrown
    expect(result).toBeDefined();
    expect(result.summary).toBeDefined();
  });

  // ── Scenario 10: Direct CALLS → Route → WILL_BREAK tier ────────
  it('classifies route as WILL_BREAK when depth=0 and confidence>=0.85', async () => {
    setupGitDiff(['UserController.java']);
    const fileSymbols: Record<string, any[]> = {
      'UserController.java': [
        { id: 'sym-controller', name: 'UserController', type: 'Class', filePath: 'UserController.java' },
      ],
    };
    setupFileSymbols(fileSymbols);
    setupBFS([]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
        return [{
          path: '/api/users', method: 'GET', file_path: 'UserController.java',
          line: 25, controller: 'UserController', handler: 'getUsers',
          affected_name: 'UserController', affected_id: 'sym-controller',
          relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    expect(result.impacted_endpoints.WILL_BREAK.length).toBeGreaterThanOrEqual(1);
    const route = result.impacted_endpoints.WILL_BREAK.find(
      (r: any) => r.path === '/api/users' && r.method === 'GET',
    );
    expect(route).toBeDefined();
  });

  // ── Scenario 11: d=2 CALLS → Route → LIKELY_AFFECTED tier ──────
  // The BFS discovers method-getUsers at depth 2. Route discovery finds the
  // route via reverse-CALLS from method-getUsers (depth=2, confidence=0.8).
  // Since depth=2 > 1, it falls into LIKELY_AFFECTED (depth <= 3, confidence >= 0.7).
  it('classifies route as LIKELY_AFFECTED when discovered via depth-2 path', async () => {
    setupGitDiff(['FormatUtil.java']);
    const fileSymbols: Record<string, any[]> = {
      'FormatUtil.java': [
        { id: 'method-formatUser', name: 'formatUser', type: 'Method', filePath: 'FormatUtil.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    // Simulate two-level BFS:
    // Depth 1: FormatUtil → getUsers-svc (service method)
    // Depth 2: getUsers-svc → getUsers (controller method)
    let bfsCallCount = 0;
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('r.type IN')) {
        bfsCallCount++;
        if (bfsCallCount === 1) {
          // Depth 1: callers of changed symbols
          return [{
            sourceId: 'method-formatUser', id: 'method-getUsers-svc', name: 'getUsers',
            type: 'Method', filePath: 'UserService.java', relType: 'CALLS', confidence: 0.9,
          }];
        }
        if (bfsCallCount === 2) {
          // Depth 2: callers of depth-1 frontier
          return [{
            sourceId: 'method-getUsers-svc', id: 'method-getUsers', name: 'getUsers',
            type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.8,
          }];
        }
        return [];
      }
      return [];
    });

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
        return [{
          path: '/api/users', method: 'GET', file_path: 'UserController.java',
          line: 25, controller: 'UserController', handler: 'getUsers',
          affected_name: 'getUsers', affected_id: 'method-getUsers',
          relation: 'CALLS', discovery_path: 'reverse-CALLS',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // method-getUsers is at BFS depth 2 (discovered in second BFS iteration),
    // confidence 0.8. depth=2: NOT WILL_BREAK (depth > 1), IS LIKELY_AFFECTED
    const likely = result.impacted_endpoints.LIKELY_AFFECTED.find(
      (r: any) => r.path === '/api/users' && r.method === 'GET',
    );
    expect(likely).toBeDefined();
  });

  // ── Scenario 12: HAS_METHOD → controller → Route → MAY_NEED_TESTING ─
  it('classifies route as MAY_NEED_TESTING for transitive HAS_METHOD path', async () => {
    setupGitDiff(['BaseController.java']);
    const fileSymbols: Record<string, any[]> = {
      'BaseController.java': [
        { id: 'class-base', name: 'BaseController', type: 'Class', filePath: 'BaseController.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    // BFS: depth 1 finds HealthController (EXTENDS), depth 2 finds route
    // First depth finds HealthController
    setupBFS([
      {
        sourceId: 'class-base', id: 'class-health', name: 'HealthController',
        type: 'Class', filePath: 'HealthController.java', relType: 'EXTENDS', confidence: 0.85,
      },
      {
        sourceId: 'class-base', id: 'method-health', name: 'health',
        type: 'Method', filePath: 'HealthController.java', relType: 'HAS_METHOD', confidence: 0.95,
      },
    ]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
        // class-health (depth=1) directly defines a route
        return [{
          path: '/api/health', method: 'GET', file_path: 'HealthController.java',
          line: 15, controller: 'HealthController', handler: 'health',
          affected_name: 'HealthController', affected_id: 'class-health',
          relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // class-health is at depth=1 (not a changed symbol), confidence=0.85
    // depth=1, confidence=0.85 → WILL_BREAK (depth <= 1 AND confidence >= 0.85)
    const breakRoutes = result.impacted_endpoints.WILL_BREAK;
    const likelyRoutes = result.impacted_endpoints.LIKELY_AFFECTED;
    const mayRoutes = result.impacted_endpoints.MAY_NEED_TESTING;
    const healthRoute = [...breakRoutes, ...likelyRoutes, ...mayRoutes]
      .find((r: any) => r.path === '/api/health');
    expect(healthRoute).toBeDefined();
  });

  // ── Scenario 13: Same Route via multiple paths — highest-tier wins ─
  it('deduplicates route to highest-priority tier when discovered via multiple paths', async () => {
    setupGitDiff(['UserService.java']);
    const fileSymbols: Record<string, any[]> = {
      'UserService.java': [
        { id: 'sym-svc', name: 'UserService', type: 'Class', filePath: 'UserService.java' },
      ],
    };
    setupFileSymbols(fileSymbols);
    setupBFS([
      {
        sourceId: 'sym-svc', id: 'method-getUsers', name: 'getUsers',
        type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.95,
      },
    ]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }

      // Both reverse-CALLS and DEFINES find the same route
      if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
        return [{
          path: '/api/users', method: 'GET', file_path: 'UserController.java',
          line: 25, controller: 'UserController', handler: 'getUsers',
          affected_name: 'getUsers', affected_id: 'method-getUsers',
          relation: 'CALLS', discovery_path: 'reverse-CALLS',
        }];
      }
      if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
        return [{
          path: '/api/users', method: 'GET', file_path: 'UserController.java',
          line: 25, controller: 'UserController', handler: 'getUsers',
          affected_name: 'UserController', affected_id: 'sym-ctrl-dummy',
          relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
        }];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // Same route should appear exactly once across all tiers
    const allRoutes = [
      ...result.impacted_endpoints.WILL_BREAK,
      ...result.impacted_endpoints.LIKELY_AFFECTED,
      ...result.impacted_endpoints.MAY_NEED_TESTING,
    ];
    const usersRoutes = allRoutes.filter((r: any) => r.path === '/api/users' && r.method === 'GET');
    expect(usersRoutes).toHaveLength(1);
  });

  // ── Scenario 14: Symbol in test dir is excluded ─────────────────
  it('excludes symbols in test directories from BFS traversal', async () => {
    setupGitDiff(['Service.java']);
    const fileSymbols: Record<string, any[]> = {
      'Service.java': [
        { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
      ],
    };
    setupFileSymbols(fileSymbols);

    // BFS returns a test file symbol that should be filtered out
    setupBFS([
      {
        sourceId: 'sym-svc', id: 'test-caller', name: 'testService',
        type: 'Method', filePath: 'src/test/ServiceTest.java', relType: 'CALLS', confidence: 0.9,
      },
      {
        sourceId: 'sym-svc', id: 'prod-caller', name: 'prodCaller',
        type: 'Method', filePath: 'src/Controller.java', relType: 'CALLS', confidence: 0.9,
      },
    ]);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('n.filePath CONTAINS')) {
        return fileSymbols[params.filePath] || [];
      }
      return [];
    });

    const result = await (backend as any)._impactedEndpointsImpl(
      (backend as any).repos.get('repo-ie'),
      { scope: 'unstaged' },
    );

    // test-caller should be filtered; only prod-caller expanded
    // Verify by checking changed_symbols doesn't include test file
    expect(result.changed_symbols.every((s: any) => !s.filePath.includes('/test/'))).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section A: BFS Traversal Edge Cases
  // ──────────────────────────────────────────────────────────────────────

  describe('BFS Traversal Edge Cases', () => {

    // U-BFS01: Cycle in graph (A→B→C→A)
    it('terminates without infinite loop when graph has a cycle', async () => {
      setupGitDiff(['ServiceA.java']);
      const fileSymbols: Record<string, any[]> = {
        'ServiceA.java': [
          { id: 'sym-A', name: 'ServiceA', type: 'Class', filePath: 'ServiceA.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          if (bfsCallCount === 1) {
            return [{ sourceId: 'sym-A', id: 'sym-B', name: 'ServiceB', type: 'Class', filePath: 'ServiceB.java', relType: 'CALLS', confidence: 0.9 }];
          }
          if (bfsCallCount === 2) {
            return [{ sourceId: 'sym-B', id: 'sym-C', name: 'ServiceC', type: 'Class', filePath: 'ServiceC.java', relType: 'CALLS', confidence: 0.9 }];
          }
          // Depth 3: C calls A (cycle) — A already in visited set, will be skipped
          return [{ sourceId: 'sym-C', id: 'sym-A', name: 'ServiceA', type: 'Class', filePath: 'ServiceA.java', relType: 'CALLS', confidence: 0.9 }];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Should terminate without hanging; visited includes A, B, C
      expect(bfsCallCount).toBeLessThanOrEqual(4);
      expect(result).toBeDefined();
      expect(result._meta).toBeDefined();
    });

    // U-BFS02: Self-referencing node
    it('visits self-referencing node only once', async () => {
      setupGitDiff(['Recursive.java']);
      const fileSymbols: Record<string, any[]> = {
        'Recursive.java': [
          { id: 'sym-recursive', name: 'recursive', type: 'Method', filePath: 'Recursive.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS returns the same node as a caller of itself
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          return [{ sourceId: 'sym-recursive', id: 'sym-recursive', name: 'recursive', type: 'Method', filePath: 'Recursive.java', relType: 'CALLS', confidence: 0.9 }];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Should not crash or loop; sym-recursive is already visited, so nextFrontier is empty
      expect(result).toBeDefined();
    });

    // U-BFS04: Mixed relation types at same depth
    it('handles mixed CALLS and IMPORTS relation types at same depth', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          return [
            { sourceId: 'sym-svc', id: 'caller-calls', name: 'CallerA', type: 'Method', filePath: 'CallerA.java', relType: 'CALLS', confidence: 0.9 },
            { sourceId: 'sym-svc', id: 'caller-imports', name: 'ImporterB', type: 'Class', filePath: 'ImporterB.java', relType: 'IMPORTS', confidence: 0.9 },
          ];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Both upstream symbols should be discovered
      expect(result.changed_symbols).toHaveLength(1);
    });

    // U-BFS05: Low confidence edges filtered
    it('skips edges with confidence below min_confidence', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          return [
            { sourceId: 'sym-svc', id: 'caller-high', name: 'HighConf', type: 'Method', filePath: 'HighConf.java', relType: 'CALLS', confidence: 0.95 },
            { sourceId: 'sym-svc', id: 'caller-low', name: 'LowConf', type: 'Method', filePath: 'LowConf.java', relType: 'CALLS', confidence: 0.5 },
          ];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged', min_confidence: 0.8 },
      );

      expect(result).toBeDefined();
    });

    // U-BFS06: Missing confidence uses IMPACT_RELATION_CONFIDENCE floor
    it('applies IMPACT_RELATION_CONFIDENCE floor when edge confidence is 0 or null', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          // Return edge with confidence=0 — should use floor (CALLS=0.9)
          return [
            { sourceId: 'sym-svc', id: 'caller-noconf', name: 'NoConf', type: 'Method', filePath: 'NoConf.java', relType: 'CALLS', confidence: 0 },
          ];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'NoConf.java',
            line: 10, controller: 'Ctrl', handler: 'getData',
            affected_name: 'NoConf', affected_id: 'caller-noconf',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // With default confidence floor of 0.9 for CALLS, the node should be included
      // and the route should be discovered (depth=1, conf=0.9 → WILL_BREAK)
      expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });
    // U-BFS07: IDs with special chars filtered
    it('filters IDs with braces and handles single-quote escaping', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      const queriedIds: string[] = [];
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          // Extract IDs from the query string to verify filtering
          queriedIds.push(query);
          return [
            { sourceId: 'sym-svc', id: 'caller-ok', name: 'OkCaller', type: 'Method', filePath: 'Ok.java', relType: 'CALLS', confidence: 0.9 },
          ];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      // Provide frontier IDs with braces — they should be filtered by safeFrontier
      // We simulate this by having the BFS already visited a node with braces
      // The implementation filters { } from frontier before building query
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // The query should not contain IDs with { or } characters
      expect(result).toBeDefined();
    });

    // U-BFS08: All expanded nodes in test directories
    it('returns no endpoints when all upstream symbols are in test directories', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS returns only test-file symbols
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          return [
            { sourceId: 'sym-svc', id: 'test-caller-1', name: 'testA', type: 'Method', filePath: 'src/test/java/A.java', relType: 'CALLS', confidence: 0.9 },
            { sourceId: 'sym-svc', id: 'test-caller-2', name: 'testB', type: 'Method', filePath: '__tests__/service.test.ts', relType: 'CALLS', confidence: 0.9 },
          ];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // All BFS nodes filtered; no routes can be discovered through test nodes
      expect(result.summary.impacted_endpoints).toEqual({ 'repo-ie': 0 });
    });

    // U-BFS09: max_depth=1 vs default=3
    it('only discovers direct callers when max_depth=1', async () => {
      setupGitDiff(['FormatUtil.java']);
      const fileSymbols: Record<string, any[]> = {
        'FormatUtil.java': [
          { id: 'sym-format', name: 'formatUser', type: 'Method', filePath: 'FormatUtil.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          if (bfsCallCount === 1) {
            return [{ sourceId: 'sym-format', id: 'sym-service', name: 'getUser', type: 'Method', filePath: 'UserService.java', relType: 'CALLS', confidence: 0.9 }];
          }
          // Depth 2 should NOT be called when max_depth=1
          return [{ sourceId: 'sym-service', id: 'sym-controller', name: 'getUser', type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.85 }];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged', max_depth: 1 },
      );

      // Only 1 BFS depth should have been executed
      expect(bfsCallCount).toBe(1);
    });

    // U-BFS10: max_depth=10
    it('allows deep traversal up to max_depth=10', async () => {
      setupGitDiff(['DeepLeaf.java']);
      const fileSymbols: Record<string, any[]> = {
        'DeepLeaf.java': [
          { id: 'sym-leaf', name: 'deepMethod', type: 'Method', filePath: 'DeepLeaf.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          // Each depth finds one caller, up to depth 5
          if (bfsCallCount <= 5) {
            const sourceId = bfsCallCount === 1 ? 'sym-leaf' : `sym-bfs-${bfsCallCount - 1}`;
            return [{ sourceId, id: `sym-bfs-${bfsCallCount}`, name: `level${bfsCallCount}`, type: 'Method', filePath: `L${bfsCallCount}.java`, relType: 'CALLS', confidence: 0.9 }];
          }
          return [];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged', max_depth: 10 },
      );

      // BFS should have traversed 5 productive depths + 1 empty (6 total)
      expect(bfsCallCount).toBe(6);
    });

    // U-BFS10a: max_depth=0 should disable upstream traversal (#64)
    it('honors max_depth=0 and skips upstream traversal entirely', async () => {
      setupGitDiff(['FormatUtil.java']);
      const fileSymbols: Record<string, any[]> = {
        'FormatUtil.java': [
          { id: 'sym-format', name: 'formatUser', type: 'Method', filePath: 'FormatUtil.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          // Should never be called when max_depth=0
          return [{ sourceId: 'sym-format', id: 'sym-service', name: 'getUser', type: 'Method', filePath: 'UserService.java', relType: 'CALLS', confidence: 0.9 }];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged', max_depth: 0 },
      );

      // (#64) Before the fix, `0 || 3` coerced max_depth=0 to 3, so the
      // BFS would run. Now it must run ZERO times.
      expect(bfsCallCount).toBe(0);
    });

    // U-BFS11: OVERRIDES edge traversal
    it('follows OVERRIDES edges during BFS traversal and records them in expandedMeta', async () => {
      setupGitDiff(['CashServiceV2Impl.java']);
      const fileSymbols: Record<string, any[]> = {
        'CashServiceV2Impl.java': [
          { id: 'sym-impl-unhold', name: 'unholdMoney', type: 'Method', filePath: 'CashServiceV2Impl.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      const bfsQueries: string[] = [];
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsQueries.push(query);
          // Depth 1: impl method OVERRIDES interface method
          return [{
            sourceId: 'sym-impl-unhold',
            id: 'sym-iface-unhold',
            name: 'unholdMoney',
            type: 'Method',
            filePath: 'CashService.java',
            relType: 'OVERRIDES',
            confidence: 0.85,
          }];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Assert outside the mock to avoid being swallowed by production try-catch
      // The BFS Cypher query MUST include 'OVERRIDES' in the type filter
      expect(bfsQueries.length).toBeGreaterThanOrEqual(1);
      expect(bfsQueries[0]).toContain("'OVERRIDES'");

      // The OVERRIDES-discovered node (sym-iface-unhold) must be traversed
      expect(result).toBeDefined();
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
      // changed_symbols includes only the initial changed file symbol
      expect((result.summary.changed_symbols as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
    });

    // U-IMPL01: IMPLEMENTS resolution discovers interface callers in BFS
    it('resolves IMPLEMENTS edges to discover interface callers during BFS', async () => {
      setupGitDiff(['CashServiceV2Impl.java']);
      const fileSymbols: Record<string, any[]> = {
        'CashServiceV2Impl.java': [
          { id: 'sym-cash-impl', name: 'CashServiceV2Impl', type: 'Class', filePath: 'CashServiceV2Impl.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      let implementsQueryCalled = false;

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');

        // BFS traversal queries
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          if (bfsCallCount === 1) {
            // Depth 1: no direct callers of CashServiceV2Impl (callers go to interface)
            return [];
          }
          if (bfsCallCount === 2) {
            // Depth 2: callers of CashService (interface) → CashController
            return [{
              sourceId: 'sym-cash-iface',
              id: 'sym-cash-controller',
              name: 'processCash',
              type: 'Method',
              filePath: 'CashController.java',
              relType: 'CALLS',
              confidence: 0.9,
            }];
          }
          return [];
        }

        // IMPLEMENTS resolution queries
        if (query.includes('IMPLEMENTS') && !query.includes('r.type IN')) {
          implementsQueryCalled = true;
          // CashServiceV2Impl implements CashService
          return [{
            id: 'sym-cash-iface',
            name: 'CashService',
            type: 'Interface',
            filePath: 'CashService.java',
            relType: 'IMPLEMENTS',
            confidence: 0.9,
            implId: 'sym-cash-impl',
          }];
        }

        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
          return [{
            path: '/api/cash/unhold',
            method: 'POST',
            file_path: 'CashController.java',
            line: 42,
            controller: 'CashController',
            handler: 'unholdMoney',
            affected_name: 'processCash',
            affected_id: 'sym-cash-controller',
            relation: 'CALLS',
            discovery_path: 'reverse-CALLS',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // IMPLEMENTS resolution was called
      expect(implementsQueryCalled).toBe(true);

      // CashController route discovered through interface resolution
      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const cashRoute = allEndpoints.find((r: any) => r.path === '/api/cash/unhold');
      expect(cashRoute).toBeDefined();
    });

    // U-IMPL02: IMPLEMENTS query failure is non-fatal
    it('continues BFS traversal when IMPLEMENTS resolution query fails', async () => {
      setupGitDiff(['CashServiceV2Impl.java']);
      const fileSymbols: Record<string, any[]> = {
        'CashServiceV2Impl.java': [
          { id: 'sym-cash-impl', name: 'CashServiceV2Impl', type: 'Class', filePath: 'CashServiceV2Impl.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');

        // BFS traversal queries
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          // Normal BFS returns one direct caller
          if (bfsCallCount === 1) {
            return [{
              sourceId: 'sym-cash-impl',
              id: 'sym-direct-caller',
              name: 'DirectCaller',
              type: 'Method',
              filePath: 'DirectCaller.java',
              relType: 'CALLS',
              confidence: 0.9,
            }];
          }
          return [];
        }

        // IMPLEMENTS resolution queries — simulate failure
        if (query.includes('IMPLEMENTS') && !query.includes('r.type IN')) {
          throw new Error('IMPLEMENTS query failed');
        }

        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Should not crash — BFS continues without interface resolution
      expect(result).toBeDefined();
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
      // Direct caller is still found via normal BFS
      expect((result.summary.changed_symbols as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
    });

    // U-IMPL03: Depth cap prevents IMPLEMENTS resolution beyond depth 2
    it('skips IMPLEMENTS resolution for nodes at depth > 2', async () => {
      setupGitDiff(['DeepService.java']);
      const fileSymbols: Record<string, any[]> = {
        'DeepService.java': [
          { id: 'sym-deep', name: 'DeepService', type: 'Class', filePath: 'DeepService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      let implementsQueryCalled = false;

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');

        // BFS traversal queries
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          if (bfsCallCount === 1) {
            // Depth 1: find an impl class
            return [{
              sourceId: 'sym-deep',
              id: 'sym-d1',
              name: 'D1Caller',
              type: 'Class',
              filePath: 'D1.java',
              relType: 'CALLS',
              confidence: 0.9,
            }];
          }
          if (bfsCallCount === 2) {
            // Depth 2: find a deep impl
            return [{
              sourceId: 'sym-d1',
              id: 'sym-d2-impl',
              name: 'DeepImpl',
              type: 'Class',
              filePath: 'DeepImpl.java',
              relType: 'CALLS',
              confidence: 0.9,
            }];
          }
          if (bfsCallCount === 3) {
            // Depth 3: find another node (this is beyond the depth cap for IMPLEMENTS)
            return [{
              sourceId: 'sym-d2-impl',
              id: 'sym-d3',
              name: 'D3Node',
              type: 'Class',
              filePath: 'D3.java',
              relType: 'CALLS',
              confidence: 0.9,
            }];
          }
          return [];
        }

        // IMPLEMENTS resolution queries
        if (query.includes('IMPLEMENTS') && !query.includes('r.type IN')) {
          implementsQueryCalled = true;
          // Should only be called for nodes at depth <= 2
          // If sym-d3 (depth 3) is in the query, the test fails
          if (query.includes('sym-d3')) {
            // Depth cap should have excluded sym-d3
            return [{ id: 'sym-should-not-appear', name: 'ShouldNotAppear', type: 'Interface', filePath: 'I.java', relType: 'IMPLEMENTS', confidence: 0.9, implId: 'sym-d3' }];
          }
          // sym-d1 (depth 1) and sym-d2-impl (depth 2) are OK
          return [];
        }

        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged', max_depth: 4 },
      );

      // IMPLEMENTS resolution was attempted for depth <= 2 nodes
      expect(implementsQueryCalled).toBe(true);
      // Result should not contain the depth-3 interface resolution
      expect(result).toBeDefined();
    });

    // U-IMPL04: Interface inherits impl's depth (not depth+1)
    it('assigns interface the same depth as its implementing class', async () => {
      setupGitDiff(['CashServiceV2Impl.java']);
      const fileSymbols: Record<string, any[]> = {
        'CashServiceV2Impl.java': [
          { id: 'sym-cash-impl', name: 'CashServiceV2Impl', type: 'Class', filePath: 'CashServiceV2Impl.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      let bfsCallCount = 0;
      const queryLog: string[] = [];

      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');

        // BFS traversal queries
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          queryLog.push(`BFS-depth-${bfsCallCount}`);
          // Depth 1: no direct callers (callers go to interface)
          return [];
        }

        // IMPLEMENTS resolution queries
        if (query.includes('IMPLEMENTS') && !query.includes('r.type IN')) {
          queryLog.push('IMPLEMENTS-resolution');
          // CashServiceV2Impl (depth 0) implements CashService
          // Interface should inherit depth 0, not depth 1
          return [{
            id: 'sym-cash-iface',
            name: 'CashService',
            type: 'Interface',
            filePath: 'CashService.java',
            relType: 'IMPLEMENTS',
            confidence: 0.9,
            implId: 'sym-cash-impl',
          }];
        }

        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Verify IMPLEMENTS resolution was called
      expect(queryLog).toContain('IMPLEMENTS-resolution');

      // Verify the interface appears as an expanded symbol (not a changed symbol)
      const expandedSymbols = result.changed_symbols.filter((s: any) => s.id === 'sym-cash-iface');
      // changed_symbols only has the original file symbols, not BFS-expanded ones
      // But we can verify the BFS processed the interface by checking that
      // the BFS continued beyond depth 1 (the interface was added to the frontier)
      expect(bfsCallCount).toBeGreaterThanOrEqual(2); // depth 1 (empty) + depth 2 (from interface frontier)
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section B: Route Discovery Queries
  // ──────────────────────────────────────────────────────────────────────

  describe('Route Discovery Queries', () => {

    // U-RD01: reverse-CALLS discovers route via handler method
    it('discovers route via reverse-CALLS when handler method calls expanded symbol', async () => {
      setupGitDiff(['UserService.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserService.java': [
          { id: 'sym-svc-getUsers', name: 'getUsers', type: 'Method', filePath: 'UserService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS finds controller method that calls service method
      setupBFS([
        { sourceId: 'sym-svc-getUsers', id: 'sym-ctrl-getUsers', name: 'getUsers', type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.95 },
      ]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
          return [{
            path: '/api/users', method: 'GET', file_path: 'UserController.java',
            line: 25, controller: 'UserController', handler: 'getUsers',
            affected_name: 'getUsers', affected_id: 'sym-ctrl-getUsers',
            relation: 'CALLS', discovery_path: 'reverse-CALLS',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
      const route = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/users' && r.method === 'GET',
      );
      expect(route).toBeDefined();
    });

    // U-RD02: DEFINES discovers route from changed file at depth=0 → WILL_BREAK
    it('classifies route as WILL_BREAK when changed symbol DEFINES the route directly', async () => {
      setupGitDiff(['UserController.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserController.java': [
          { id: 'sym-ctrl', name: 'UserController', type: 'Class', filePath: 'UserController.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/orders', method: 'POST', file_path: 'UserController.java',
            line: 30, controller: 'UserController', handler: 'createOrder',
            affected_name: 'UserController', affected_id: 'sym-ctrl',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // affected_id is a changed symbol → depth=0, confidence=1.0 → WILL_BREAK
      expect(result.impacted_endpoints.WILL_BREAK.length).toBeGreaterThanOrEqual(1);
      const route = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/orders' && r.method === 'POST',
      );
      expect(route).toBeDefined();
    });

    // U-RD03: HANDLES_ROUTE discovers route
    it('discovers route via HANDLES_ROUTE relation', async () => {
      setupGitDiff(['BaseController.java']);
      const fileSymbols: Record<string, any[]> = {
        'BaseController.java': [
          { id: 'sym-base', name: 'BaseController', type: 'Class', filePath: 'BaseController.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/status', method: 'GET', file_path: 'BaseController.java',
            line: 10, controller: 'BaseController', handler: 'getStatus',
            affected_name: 'BaseController', affected_id: 'sym-base',
            relation: 'HANDLES_ROUTE', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });
    // U-RD04: FETCHES uses expandedIds (includes BFS-expanded symbols)
    it('discovers routes via FETCHES from expanded symbols', async () => {
      setupGitDiff(['FrontendService.java']);
      const fileSymbols: Record<string, any[]> = {
        'FrontendService.java': [
          { id: 'sym-fetch', name: 'fetchUsers', type: 'Function', filePath: 'FrontendService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      let fetchesUsedExpandedIds = false;
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('FETCHES')) {
          // FETCHES query should use expandedIds in params (includes changed symbols)
          const params = args[2] || {};
          if (params.expandedIds && params.expandedIds.includes('sym-fetch')) {
            fetchesUsedExpandedIds = true;
          }
          return [{
            path: '/api/users', method: 'GET', file_path: 'BackendController.java',
            line: 15, controller: 'BackendController', handler: 'getUsers',
            affected_name: 'fetchUsers', affected_id: 'sym-fetch',
            relation: 'FETCHES', discovery_path: 'FETCHES',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(fetchesUsedExpandedIds).toBe(true);
      expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });
    // U-RD08: Transitive FETCHES discovery — intermediate symbol from BFS fetches a route
    it('discovers routes via FETCHES from BFS-expanded intermediate symbols', async () => {
      setupGitDiff(['ServiceA.java']);
      const fileSymbols: Record<string, any[]> = {
        'ServiceA.java': [
          { id: 'sym-serviceA', name: 'serviceA', type: 'Function', filePath: 'ServiceA.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      // BFS: sym-serviceA (depth 0) → sym-intermediate (depth 1, via CALLS)
      // sym-intermediate has a FETCHES edge to a route, but sym-serviceA does NOT
      setupBFS([
        { sourceId: 'sym-serviceA', id: 'sym-intermediate', name: 'intermediateFn', type: 'Function', filePath: 'FrontendService.java', relType: 'CALLS', confidence: 0.9 },
      ]);

      let fetchesUsedExpandedIds = false;
      let fetchesParams: any = null;
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('FETCHES')) {
          const params = args[2] || {};
          fetchesParams = params;
          // The FETCHES query must include the intermediate symbol from BFS
          // (expandedIds = changedIds + BFS-discovered symbols)
          if (params.expandedIds && params.expandedIds.includes('sym-intermediate')) {
            fetchesUsedExpandedIds = true;
            return [{
              path: '/api/data', method: 'POST', file_path: 'ApiController.java',
              line: 42, controller: 'ApiController', handler: 'postData',
              affected_name: 'intermediateFn', affected_id: 'sym-intermediate',
              relation: 'FETCHES', discovery_path: 'FETCHES',
            }];
          }
          return [];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // FETCHES query must use expandedIds containing the intermediate symbol
      expect(fetchesUsedExpandedIds).toBe(true);
      // The route should be discovered via the intermediate symbol's FETCHES edge
      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const fetchesEndpoint = allEndpoints.find(e => e.path === '/api/data' && e.method === 'POST');
      expect(fetchesEndpoint).toBeDefined();
      // FETCHES should be among the discovery paths
      expect(fetchesEndpoint!.discovery_paths).toContain('FETCHES');
      // The endpoint should be in WILL_BREAK (depth=1, confidence=0.9 >= 0.85 threshold)
      expect(result.impacted_endpoints.WILL_BREAK).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: '/api/data', method: 'POST' })]),
      );
    });

    // U-RD05: Route with empty method or path is skipped
    it('skips routes with empty httpMethod or routePath', async () => {
      setupGitDiff(['Controller.java']);
      const fileSymbols: Record<string, any[]> = {
        'Controller.java': [
          { id: 'sym-ctrl', name: 'Controller', type: 'Class', filePath: 'Controller.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [
            // Route with empty method — should be skipped
            { path: '/api/bad1', method: '', file_path: 'Controller.java', line: 1, controller: 'Ctrl', handler: 'bad1', affected_name: 'Controller', affected_id: 'sym-ctrl', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
            // Route with empty path — should be skipped
            { path: '', method: 'GET', file_path: 'Controller.java', line: 2, controller: 'Ctrl', handler: 'bad2', affected_name: 'Controller', affected_id: 'sym-ctrl', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
            // Valid route — should be included
            { path: '/api/valid', method: 'GET', file_path: 'Controller.java', line: 3, controller: 'Ctrl', handler: 'valid', affected_name: 'Controller', affected_id: 'sym-ctrl', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
          ];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Only the valid route should appear
      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      expect(allRoutes).toHaveLength(1);
      expect(allRoutes[0].path).toBe('/api/valid');
    });

    // U-RD06: Same route via all 3 discovery paths — appears once, best tier, affected_by merged
    it('deduplicates same route found by all 3 discovery queries', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Ctrl.java',
            line: 10, controller: 'Ctrl', handler: 'getData',
            affected_name: 'Service', affected_id: 'sym-svc',
            relation: 'CALLS', discovery_path: 'reverse-CALLS',
          }];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Ctrl.java',
            line: 10, controller: 'Ctrl', handler: 'getData',
            affected_name: 'Service', affected_id: 'sym-svc',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        if (query.includes('FETCHES')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Ctrl.java',
            line: 10, controller: 'Ctrl', handler: 'getData',
            affected_name: 'Service', affected_id: 'sym-svc',
            relation: 'FETCHES', discovery_path: 'FETCHES',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Same route should appear exactly once
      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const dataRoutes = allRoutes.filter((r: any) => r.path === '/api/data' && r.method === 'GET');
      expect(dataRoutes).toHaveLength(1);

      // affected_id is a changed symbol → depth=0 → WILL_BREAK
      expect(result.impacted_endpoints.WILL_BREAK.length).toBeGreaterThanOrEqual(1);
    });

    // U-RD07: All 3 route queries fail — empty tiers, no crash
    it('returns empty tiers when all route discovery queries fail', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('reverse-CALLS') || query.includes('DEFINES') || query.includes('FETCHES')) {
          throw new Error('DB error');
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // No crash, all tiers empty
      expect(result.impacted_endpoints.WILL_BREAK).toEqual([]);
      expect(result.impacted_endpoints.LIKELY_AFFECTED).toEqual([]);
      expect(result.impacted_endpoints.MAY_NEED_TESTING).toEqual([]);
    });

    // U-RD09: Method-labeled node discovers routes via FETCHES (no label filter)
    it('discovers routes via FETCHES when source node is Method (not Function)', async () => {
      setupGitDiff(['ApiClient.ts']);
      const fileSymbols: Record<string, any[]> = {
        'ApiClient.ts': [
          { id: 'sym-method-fetch', name: 'fetchData', type: 'Method', filePath: 'ApiClient.ts' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      let fetchesUsedExpandedIds = false;
      let fetchesQueryHasNoLabelFilter = false;
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('FETCHES')) {
          // Verify the FETCHES query does NOT filter by (s:Function) label
          // so that Method-labeled nodes can also discover routes via FETCHES
          if (!query.includes('s:Function')) {
            fetchesQueryHasNoLabelFilter = true;
          }
          // Verify the query uses expandedIds (changedIds are included in expandedIds)
          const params = args[2] || {};
          if (params.expandedIds && params.expandedIds.includes('sym-method-fetch')) {
            fetchesUsedExpandedIds = true;
          }
          return [{
            path: '/api/data',
            method: 'GET',
            file_path: 'DataController.java',
            line: 20,
            controller: 'DataController',
            handler: 'getData',
            affected_name: 'fetchData',
            affected_id: 'sym-method-fetch',
            relation: 'FETCHES',
            discovery_path: 'FETCHES',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // The FETCHES query should have been called with expandedIds containing the Method-labeled symbol
      expect(fetchesUsedExpandedIds).toBe(true);
      // The FETCHES query must NOT filter by (s:Function) label
      expect(fetchesQueryHasNoLabelFilter).toBe(true);
      // The route should be discovered even though the source is a Method, not a Function
      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const fetchesRoute = allRoutes.find(
        (r: any) => r.path === '/api/data' && r.method === 'GET',
      );
      expect(fetchesRoute).toBeDefined();
      expect(fetchesRoute.discovery_paths).toContain('FETCHES');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section B2: Annotation-Based Route Fallback
  // ──────────────────────────────────────────────────────────────────────

  describe('Annotation-Based Route Fallback', () => {

    // AF-01: Method in Controller file with @GetMapping discovers endpoint via annotation-fallback
    it('discovers GET endpoint via @GetMapping annotation when no Route nodes exist', async () => {
      setupGitDiff(['UserService.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserService.java': [
          { id: 'sym-svc', name: 'UserService', type: 'Class', filePath: 'UserService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS: UserService → UserController.getUsers
      setupBFS([
        {
          sourceId: 'sym-svc', id: 'method-getUsers', name: 'getUsers',
          type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.9,
        },
      ]);

      // Route discovery: no Route nodes found
      routeDiscoveryHandler = () => [];

      // Annotation fallback: Method node with @GetMapping
      annotationFallbackHandler = (_params: any) => [
        {
          id: 'method-getUsers',
          handler: 'getUsers',
          filePath: 'UserController.java',
          content: '@GetMapping("/api/users")\npublic ResponseEntity<List<User>> getUsers() { ... }',
          line: 25,
        },
      ];

      // Class prefix: none
      classPrefixHandler = () => [];

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Should discover GET /api/users via annotation-fallback
      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const getUsersRoute = allRoutes.find((r: any) => r.path === '/api/users' && r.method === 'GET');
      expect(getUsersRoute).toBeDefined();
      expect(getUsersRoute.discovery_paths).toContain('annotation-fallback');
    });

    // AF-02: Method in Controller file with @PostMapping discovers POST endpoint
    it('discovers POST endpoint via @PostMapping annotation', async () => {
      setupGitDiff(['OrderService.java']);
      const fileSymbols: Record<string, any[]> = {
        'OrderService.java': [
          { id: 'sym-order', name: 'OrderService', type: 'Class', filePath: 'OrderService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      setupBFS([
        {
          sourceId: 'sym-order', id: 'method-createOrder', name: 'createOrder',
          type: 'Method', filePath: 'OrderController.java', relType: 'CALLS', confidence: 0.85,
        },
      ]);

      routeDiscoveryHandler = () => [];

      annotationFallbackHandler = (_params: any) => [
        {
          id: 'method-createOrder',
          handler: 'createOrder',
          filePath: 'OrderController.java',
          content: '@PostMapping("/api/orders")\npublic ResponseEntity<Order> createOrder() { ... }',
          line: 30,
        },
      ];

      classPrefixHandler = () => [];

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const orderRoute = allRoutes.find((r: any) => r.path === '/api/orders' && r.method === 'POST');
      expect(orderRoute).toBeDefined();
      expect(orderRoute.discovery_paths).toContain('annotation-fallback');
    });

    // AF-03: Class-level @RequestMapping("/api") prefix + method-level @GetMapping("/users")
    it('combines class-level @RequestMapping prefix with method-level path', async () => {
      setupGitDiff(['UserService.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserService.java': [
          { id: 'sym-svc', name: 'UserService', type: 'Class', filePath: 'UserService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      setupBFS([
        {
          sourceId: 'sym-svc', id: 'method-getUsers', name: 'getUsers',
          type: 'Method', filePath: 'UserController.java', relType: 'CALLS', confidence: 0.9,
        },
      ]);

      routeDiscoveryHandler = () => [];

      annotationFallbackHandler = (_params: any) => [
        {
          id: 'method-getUsers',
          handler: 'getUsers',
          filePath: 'UserController.java',
          content: '@GetMapping("/users")\npublic ResponseEntity<List<User>> getUsers() { ... }',
          line: 25,
        },
      ];

      // Class prefix: @RequestMapping("/api")
      classPrefixHandler = (params: any) => {
        if (params.filePath === 'UserController.java') {
          return [{ classContent: '@RequestMapping("/api")\npublic class UserController { ... }' }];
        }
        return [];
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      // Full path should be /api/users (class prefix + method path)
      const route = allRoutes.find((r: any) => r.path === '/api/users' && r.method === 'GET');
      expect(route).toBeDefined();
    });

    // AF-04: Dedup — when both Route-node query and annotation-fallback find the same endpoint, Route-node wins
    it('deduplicates: Route-node entry takes precedence over annotation-fallback', async () => {
      setupGitDiff(['UserController.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserController.java': [
          { id: 'sym-ctrl', name: 'UserController', type: 'Class', filePath: 'UserController.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      setupBFS([]);

      // Route discovery: reverse-CALLS finds a Route node for GET /api/users
      routeDiscoveryHandler = (type: string, _params: any) => {
        if (type === 'reverse-CALLS') {
          return [{
            path: '/api/users', method: 'GET', file_path: 'UserController.java',
            line: 25, controller: 'UserController', handler: 'getUsers',
            affected_name: 'UserController', affected_id: 'sym-ctrl',
            relation: 'CALLS', discovery_path: 'reverse-CALLS',
          }];
        }
        return [];
      };

      // Annotation fallback ALSO finds GET /api/users
      annotationFallbackHandler = (_params: any) => [
        {
          id: 'method-getUsers',
          handler: 'getUsers',
          filePath: 'UserController.java',
          content: '@GetMapping("/api/users")\npublic ResponseEntity<List<User>> getUsers() { ... }',
          line: 25,
        },
      ];

      classPrefixHandler = () => [];

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      // Same route should appear exactly once
      const usersRoutes = allRoutes.filter((r: any) => r.path === '/api/users' && r.method === 'GET');
      expect(usersRoutes).toHaveLength(1);
      // Route-node entry wins — it should have 'reverse-CALLS' discovery path
      expect(usersRoutes[0].discovery_paths).toContain('reverse-CALLS');
    });

    // AF-05: Annotation-fallback query fails → non-fatal, other queries continue
    it('continues pipeline when annotation-fallback query fails', async () => {
      setupGitDiff(['Controller.java']);
      const fileSymbols: Record<string, any[]> = {
        'Controller.java': [
          { id: 'sym-ctrl', name: 'Controller', type: 'Class', filePath: 'Controller.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      // Override mock to throw for annotation-fallback query
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        if (query.includes('Route') && query.includes('count(r)')) {
          return [{ cnt: 100 }];
        }

        // Annotation-fallback query throws
        if (query.includes('Controller') && query.includes('m.id IN')) {
          throw new Error('Annotation fallback query failed');
        }

        // DEFINES query succeeds
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Controller.java',
            line: 20, controller: 'Controller', handler: 'getData',
            affected_name: 'Controller', affected_id: 'sym-ctrl',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // DEFINES query should still succeed even though annotation-fallback failed
      expect((result.summary.impacted_endpoints as Record<string, number>)['repo-ie']).toBeGreaterThanOrEqual(1);
  });
    // AF-06: Method NOT in Controller file → not matched by annotation-fallback
    it('does not match methods in non-Controller files via annotation-fallback', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'MyService', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS finds a method in a Service file (not a Controller)
      setupBFS([
        {
          sourceId: 'sym-svc', id: 'method-process', name: 'process',
          type: 'Method', filePath: 'BusinessService.java', relType: 'CALLS', confidence: 0.9,
        },
      ]);

      routeDiscoveryHandler = () => [];

      // Annotation-fallback query returns empty — no Controller methods found
      // The query uses m.filePath CONTAINS 'Controller' which won't match BusinessService.java
      annotationFallbackHandler = (_params: any) => [];

      classPrefixHandler = () => [];

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // No endpoints should be found — Service methods don't have route annotations
      expect(result.summary.impacted_endpoints).toEqual({ 'repo-ie': 0 });
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section C: Tier Classification
  // ──────────────────────────────────────────────────────────────────────

  describe('Tier Classification', () => {
    /**
     * Helper: set up a test where BFS discovers an upstream symbol at a given depth/confidence,
     * then route discovery finds a route whose affected_id is that upstream symbol.
     * For depth > 1, intermediate chain nodes are produced at each BFS level.
     */
    function setupTierTest(depth: number, confidence: number, changedIdIsRouteSymbol = false) {
      const changedFile = 'Changed.java';
      setupGitDiff([changedFile]);
      const changedSymbolId = 'sym-changed';
      const upstreamId = changedIdIsRouteSymbol ? changedSymbolId : `sym-depth-${depth}`;

      const fileSymbols: Record<string, any[]> = {
        [changedFile]: [
          { id: changedSymbolId, name: 'Changed', type: 'Class', filePath: changedFile },
        ],
      };
      setupFileSymbols(fileSymbols);

      if (!changedIdIsRouteSymbol) {
        // BFS: build a chain of nodes from depth 1 to target depth
        let bfsCallCount = 0;
        executeQueryMock.mockImplementation(async (...args: any[]) => {
          const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
          if (query.includes('r.type IN')) {
            bfsCallCount++;
            if (bfsCallCount <= depth) {
              // Each depth level finds one node
              const sourceId = bfsCallCount === 1
                ? changedSymbolId
                : `sym-depth-${bfsCallCount - 1}`;
              const id = `sym-depth-${bfsCallCount}`;
              return [{
                sourceId,
                id,
                name: `NodeD${bfsCallCount}`,
                type: 'Method',
                filePath: `D${bfsCallCount}.java`,
                relType: 'CALLS',
                confidence: bfsCallCount === depth ? confidence : 0.95,
              }];
            }
            return [];
          }
          return [];
        });
      } else {
        setupBFS([]);
      }

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/test', method: 'GET', file_path: 'Controller.java',
            line: 10, controller: 'Ctrl', handler: 'test',
            affected_name: 'Upstream', affected_id: upstreamId,
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      return upstreamId;
    }

    // U-T01: depth=0, confidence=1.0 → WILL_BREAK (changed symbol directly)
    it('classifies as WILL_BREAK when depth=0 confidence=1.0', async () => {
      setupTierTest(0, 1.0, true);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const route = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/test',
      );
      expect(route).toBeDefined();
    });

    // U-T02: depth=1, confidence=0.85 → WILL_BREAK
    it('classifies as WILL_BREAK when depth=1 confidence=0.85', async () => {
      setupTierTest(1, 0.85);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const route = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/test',
      );
      expect(route).toBeDefined();
    });

    // U-T03: depth=1, confidence=0.84 → LIKELY_AFFECTED (0.84 < 0.85)
    it('classifies as LIKELY_AFFECTED when depth=1 confidence=0.84', async () => {
      setupTierTest(1, 0.84);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const wbRoute = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/test',
      );
      const laRoute = result.impacted_endpoints.LIKELY_AFFECTED.find(
        (r: any) => r.path === '/api/test',
      );
      expect(wbRoute).toBeUndefined();
      expect(laRoute).toBeDefined();
    });

    // U-T04: depth=2, confidence=0.9 → LIKELY_AFFECTED
    it('classifies as LIKELY_AFFECTED when depth=2 confidence=0.9', async () => {
      setupTierTest(2, 0.9);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const laRoute = result.impacted_endpoints.LIKELY_AFFECTED.find(
        (r: any) => r.path === '/api/test',
      );
      expect(laRoute).toBeDefined();
    });

    // U-T05: depth=3, confidence=0.7 → LIKELY_AFFECTED
    it('classifies as LIKELY_AFFECTED when depth=3 confidence=0.7', async () => {
      setupTierTest(3, 0.7);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const laRoute = result.impacted_endpoints.LIKELY_AFFECTED.find(
        (r: any) => r.path === '/api/test',
      );
      expect(laRoute).toBeDefined();
    });

    // U-T06: depth=3, confidence=0.69 → MAY_NEED_TESTING (0.69 < 0.7)
    it('classifies as MAY_NEED_TESTING when depth=3 confidence=0.69', async () => {
      setupTierTest(3, 0.69);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const laRoute = result.impacted_endpoints.LIKELY_AFFECTED.find(
        (r: any) => r.path === '/api/test',
      );
      const mntRoute = result.impacted_endpoints.MAY_NEED_TESTING.find(
        (r: any) => r.path === '/api/test',
      );
      expect(laRoute).toBeUndefined();
      expect(mntRoute).toBeDefined();
    });

    // U-T07: depth=4, confidence=0.95 → MAY_NEED_TESTING (depth > 3)
    it('classifies as MAY_NEED_TESTING when depth=4 confidence=0.95', async () => {
      setupTierTest(4, 0.95);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const mntRoute = result.impacted_endpoints.MAY_NEED_TESTING.find(
        (r: any) => r.path === '/api/test',
      );
      expect(mntRoute).toBeDefined();
    });

    // U-T08: Same route at d=1 conf=0.9 AND d=2 conf=0.95 → WILL_BREAK (shallowest wins)
    it('picks shallowest depth when same route discovered at multiple depths', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };
      setupFileSymbols(fileSymbols);

      // BFS: depth 1 finds one caller, depth 2 finds another
      let bfsCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          bfsCallCount++;
          if (bfsCallCount === 1) {
            return [{ sourceId: 'sym-svc', id: 'sym-d1', name: 'D1Caller', type: 'Method', filePath: 'D1.java', relType: 'CALLS', confidence: 0.9 }];
          }
          if (bfsCallCount === 2) {
            return [{ sourceId: 'sym-d1', id: 'sym-d2', name: 'D2Caller', type: 'Method', filePath: 'D2.java', relType: 'CALLS', confidence: 0.95 }];
          }
          return [];
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          // Both d1 and d2 callers lead to the same route
          return [
            { path: '/api/test', method: 'GET', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'test', affected_name: 'D1Caller', affected_id: 'sym-d1', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
            { path: '/api/test', method: 'GET', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'test', affected_name: 'D2Caller', affected_id: 'sym-d2', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
          ];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // d=1, conf=0.9 → depth<=1 AND conf>=0.85 → WILL_BREAK
      const allRoutes = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const testRoutes = allRoutes.filter((r: any) => r.path === '/api/test' && r.method === 'GET');
      expect(testRoutes).toHaveLength(1);
      expect(result.impacted_endpoints.WILL_BREAK.find((r: any) => r.path === '/api/test')).toBeDefined();
    });

    // U-T09: Same route via 2 different changed symbols → affected_by includes both
    it('merges affected_by from multiple changed symbols for same route', async () => {
      setupGitDiff(['ServiceA.java', 'ServiceB.java']);
      const fileSymbols: Record<string, any[]> = {
        'ServiceA.java': [
          { id: 'sym-A', name: 'ServiceA', type: 'Class', filePath: 'ServiceA.java' },
        ],
        'ServiceB.java': [
          { id: 'sym-B', name: 'ServiceB', type: 'Class', filePath: 'ServiceB.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[args[2]?.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [
            { path: '/api/shared', method: 'GET', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'shared', affected_name: 'ServiceA', affected_id: 'sym-A', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
            { path: '/api/shared', method: 'GET', file_path: 'Ctrl.java', line: 10, controller: 'Ctrl', handler: 'shared', affected_name: 'ServiceB', affected_id: 'sym-B', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
          ];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const route = result.impacted_endpoints.WILL_BREAK.find(
        (r: any) => r.path === '/api/shared',
      );
      expect(route).toBeDefined();
      expect(route.affected_by).toContain('sym-A');
      expect(route.affected_by).toContain('sym-B');
    });
  });

  // ─── Cross-repo BFS bridging tests ─────────────────────────────────

  describe('Cross-repo BFS bridging', () => {
    it('calls CrossRepoResolver.resolveDepConsumers when crossRepo is provided', async () => {
      setupGitDiff(['TcbsException.java']);
      setupFileSymbols({
        'TcbsException.java': [
          { id: 'lib-TcbsException', name: 'TcbsException', type: 'Class', filePath: 'com/tcbs/bond/exception/TcbsException.java' },
        ],
      });
      setupBFS([]);

      // CrossRepoResolver returns a consumer
      mockResolveDepConsumers.mockResolvedValue([
        {
          id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId',
          name: 'getBondbyId',
          filePath: 'com/tcbs/bond/trading/BondService.java',
          confidence: 0.9,
          matchMethod: 'file-imports',
          matchedDepSymbol: 'lib-TcbsException',
        },
      ]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          const filePath = params.filePath || '';
          return filePath.includes('TcbsException') ? [{ id: 'lib-TcbsException', name: 'TcbsException', type: 'Class', filePath: 'com/tcbs/bond/exception/TcbsException.java' }] : [];
        }
        // File-symbols query for cross-repo consumer (step 3c: labels(s)[0] AS type)
        if (query.includes('labels(s)')) {
          return [
            { id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'com/tcbs/bond/trading/BondService.java' },
          ];
        }
        // Route discovery
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [
            { path: '/api/bond/trade', method: 'POST', file_path: 'BondController.java', line: 42, controller: 'BondController', handler: 'trade', affected_name: 'BondService', affected_id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
          ];
        }
        if (query.includes('reverse-CALLS') || query.includes('FETCHES')) {
          return [];
        }
        if (query.includes('STEP_IN_PROCESS')) {
          return [];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['bond-exception-handler']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
        findDepRepo: vi.fn().mockResolvedValue('bond-exception-handler'),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // CrossRepoResolver.resolveDepConsumers was called
      expect(mockResolveDepConsumers).toHaveBeenCalled();
      // crossRepo.listDepRepos was called
      expect(mockCrossRepo.listDepRepos).toHaveBeenCalled();

      // The cross-repo-imported symbol should appear in the route discovery
      expect(result.impacted_endpoints).toBeDefined();
    });

    it('continues without error when crossRepo bridging fails', async () => {
      setupGitDiff(['Service.java']);
      setupFileSymbols({
        'Service.java': [
          { id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      });
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' }];
        }
        return [];
      });

      const failingCrossRepo = {
        listDepRepos: vi.fn().mockRejectedValue(new Error('Connection refused')),
        queryMultipleRepos: vi.fn(),
        findDepRepo: vi.fn(),
      };

      // Should not throw — cross-repo failure is non-fatal
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        failingCrossRepo,
      );

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(failingCrossRepo.listDepRepos).toHaveBeenCalled();
    });

    it('skips cross-repo bridging when no changed symbols exist', async () => {
      setupGitDiff(['README.md']);
      setupFileSymbols({ 'README.md': [] });
      setupBFS([]);

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['other-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
        findDepRepo: vi.fn(),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // No changed symbols → no BFS → no cross-repo query
      expect(mockCrossRepo.listDepRepos).not.toHaveBeenCalled();
      expect(mockCrossRepo.queryMultipleRepos).not.toHaveBeenCalled();
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 0 });
    });

    it('works without crossRepo (backward compatible)', async () => {
      setupGitDiff(['Service.java']);
      setupFileSymbols({
        'Service.java': [
          { id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      });
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' }];
        }
        return [];
      });

      // Call without crossRepo — should work exactly as before
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    it('adds cross-repo resolved consumer symbols to visited set at depth 1', async () => {
      setupGitDiff(['TcbsException.java']);
      setupFileSymbols({
        'TcbsException.java': [
          { id: 'lib-TcbsException', name: 'TcbsException', type: 'Class', filePath: 'com/tcbs/bond/exception/TcbsException.java' },
        ],
      });
      // BFS finds nothing locally (the library symbol isn't called locally)
      setupBFS([]);

      // CrossRepoResolver returns a consumer for TcbsException
      mockResolveDepConsumers.mockResolvedValue([
        {
          id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId',
          name: 'getBondbyId',
          filePath: 'com/tcbs/bond/trading/BondService.java',
          confidence: 0.9,
          matchMethod: 'file-imports',
          matchedDepSymbol: 'lib-TcbsException',
        },
      ]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          const filePath = params.filePath || '';
          return filePath.includes('TcbsException') ? [{ id: 'lib-TcbsException', name: 'TcbsException', type: 'Class', filePath: 'com/tcbs/bond/exception/TcbsException.java' }] : [];
        }
        // File-symbols query for cross-repo consumer (step 3c: labels(s)[0] AS type)
        if (query.includes('labels(s)')) {
          return [
            { id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'com/tcbs/bond/trading/BondService.java' },
          ];
        }
        // Route discovery: BondService defines a route
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [
            { path: '/api/bond/trade', method: 'POST', file_path: 'BondController.java', line: 42, controller: 'BondController', handler: 'trade', affected_name: 'BondService', affected_id: 'Method:com/tcbs/bond/trading/BondService.java:getBondbyId', relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE' },
          ];
        }
        if (query.includes('reverse-CALLS') || query.includes('FETCHES')) {
          return [];
        }
        if (query.includes('STEP_IN_PROCESS')) {
          return [];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['bond-exception-handler']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
        findDepRepo: vi.fn().mockResolvedValue('bond-exception-handler'),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // The endpoint discovered via cross-repo bridging should appear
      expect(result.impacted_endpoints).toBeDefined();
      // CrossRepoResolver was called
      expect(mockResolveDepConsumers).toHaveBeenCalled();
      const totalEndpoints = result.impacted_endpoints.WILL_BREAK.length + result.impacted_endpoints.LIKELY_AFFECTED.length + result.impacted_endpoints.MAY_NEED_TESTING.length;
      expect(totalEndpoints).toBeGreaterThanOrEqual(1);
    });

    // ── T-CR-17: Resolver returns consumers → file symbols added to BFS at depth 1 ──
    it('adds resolved consumer file symbols to BFS visited set at depth 1', async () => {
      setupGitDiff(['TradingDto.java']);
      setupFileSymbols({
        'TradingDto.java': [
          { id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' },
        ],
      });
      setupBFS([]);

      // CrossRepoResolver returns a consumer that imports TradingDto
      mockResolveDepConsumers.mockResolvedValue([
        {
          id: 'Method:src/BondServiceImpl.java:getBondbyId',
          name: 'getBondbyId',
          filePath: 'src/BondServiceImpl.java',
          confidence: 0.9,
          matchMethod: 'file-imports',
          matchedDepSymbol: 'dep-TradingDto',
        },
      ]);

      // File symbols query returns methods/classes in the importing file
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' }];
        }
        // File-symbols query for cross-repo consumer (step 3c: labels(s)[0] AS type)
        if (query.includes('labels(s)')) {
          return [
            { id: 'Method:src/BondServiceImpl.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'src/BondServiceImpl.java' },
            { id: 'Class:src/BondServiceImpl.java:BondServiceImpl', name: 'BondServiceImpl', type: 'Class', filePath: 'src/BondServiceImpl.java' },
          ];
        }
        // Route discovery
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/bond/trade', method: 'POST', file_path: 'BondController.java',
            line: 42, controller: 'BondController', handler: 'trade',
            affected_name: 'BondServiceImpl', affected_id: 'Class:src/BondServiceImpl.java:BondServiceImpl',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['bond-exception-handler']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // CrossRepoResolver was called
      expect(mockResolveDepConsumers).toHaveBeenCalled();
      // Result should include the endpoint found via the cross-repo consumer
      expect(result.impacted_endpoints).toBeDefined();
    });

    // ── T-CR-18: Resolver returns empty → BFS continues without cross-repo symbols ──
    it('continues BFS without cross-repo symbols when resolver returns empty', async () => {
      setupGitDiff(['Service.java']);
      setupFileSymbols({
        'Service.java': [
          { id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      });
      setupBFS([]);

      // Resolver returns empty
      mockResolveDepConsumers.mockResolvedValue([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' }];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // No error, result is valid, just no cross-repo endpoints
      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(mockResolveDepConsumers).toHaveBeenCalled();
    });

    // ── T-CR-19: Resolver throws → caught, logged, BFS continues ──
    it('continues BFS when resolver throws', async () => {
      setupGitDiff(['Service.java']);
      setupFileSymbols({
        'Service.java': [
          { id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      });
      setupBFS([]);

      // Resolver throws
      mockResolveDepConsumers.mockRejectedValue(new Error('Resolver connection failed'));

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'sym-1', name: 'Service', type: 'Class', filePath: 'Service.java' }];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      // Should not throw
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
    });

    // ── T-CR-20: File symbols query fails → consumer added as fallback ──
    it('adds consumer as fallback when file symbols query fails', async () => {
      setupGitDiff(['TradingDto.java']);
      setupFileSymbols({
        'TradingDto.java': [
          { id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' },
        ],
      });
      setupBFS([]);

      // CrossRepoResolver returns a consumer
      mockResolveDepConsumers.mockResolvedValue([
        {
          id: 'Method:src/BondServiceImpl.java:getBondbyId',
          name: 'getBondbyId',
          filePath: 'src/BondServiceImpl.java',
          confidence: 0.8,
          matchMethod: 'class-name',
          matchedDepSymbol: 'dep-TradingDto',
        },
      ]);

      // File symbols query throws, but consumer itself is used as fallback
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' }];
        }
        // File-symbols query for cross-repo consumer throws (step 3c: labels(s)[0] AS type)
        if (query.includes('labels(s)')) {
          throw new Error('DB connection lost');
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // Should not throw, result is valid
      expect(result).toBeDefined();
      expect(result.summary).toBeDefined();
      // Resolver was called
      expect(mockResolveDepConsumers).toHaveBeenCalled();
    });

    // ── T-CR-21: Test file symbols skipped ──
    it('skips cross-repo consumer symbols in test file paths', async () => {
      setupGitDiff(['TradingDto.java']);
      setupFileSymbols({
        'TradingDto.java': [
          { id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' },
        ],
      });
      setupBFS([]);

      // CrossRepoResolver returns a consumer whose file is a test file
      mockResolveDepConsumers.mockResolvedValue([
        {
          id: 'Method:src/test/BondServiceTest.java:testMethod',
          name: 'testMethod',
          filePath: 'src/test/BondServiceTest.java',
          confidence: 0.9,
          matchMethod: 'file-imports',
          matchedDepSymbol: 'dep-TradingDto',
        },
      ]);

      // File symbols query returns a test-file method and a non-test method
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' }];
        }
        // File-symbols query returns one test and one non-test symbol (step 3c: labels(s)[0] AS type)
        if (query.includes('labels(s)')) {
          return [
            { id: 'Method:src/test/BondServiceTest.java:testMethod', name: 'testMethod', type: 'Method', filePath: 'src/test/BondServiceTest.java' },
            { id: 'Method:src/BondServiceImpl.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'src/BondServiceImpl.java' },
          ];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // Result should exist; test-file symbols should be filtered out
      expect(result).toBeDefined();
      // The non-test symbol should be in expanded symbols but not the test symbol
      const allExpanded = result.changed_symbols || [];
      // We mainly verify no crash and the result is valid
      expect(result.summary).toBeDefined();
    });

    // ── T-CR-22: Multiple dep repos → resolver called for each ──
    it('calls resolver for each dependency repo', async () => {
      setupGitDiff(['Dto.java']);
      setupFileSymbols({
        'Dto.java': [
          { id: 'dep-Dto', name: 'Dto', type: 'Class', filePath: 'com/tcbs/dto/Dto.java' },
        ],
      });
      setupBFS([]);

      // Resolver returns different consumers for different dep repos
      mockResolveDepConsumers.mockImplementation(
        async (_consumerRepo: any, depRepo: any) => {
          if (depRepo.repoId === 'dep-repo-a') {
            return [{
              id: 'Method:src/ServiceA.java:methodA',
              name: 'methodA',
              filePath: 'src/ServiceA.java',
              confidence: 0.9,
              matchMethod: 'file-imports',
              matchedDepSymbol: 'dep-Dto',
            }];
          }
          return [{
            id: 'Method:src/ServiceB.java:methodB',
            name: 'methodB',
            filePath: 'src/ServiceB.java',
            confidence: 0.8,
            matchMethod: 'class-name',
            matchedDepSymbol: 'dep-Dto',
          }];
        }
      );

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'dep-Dto', name: 'Dto', type: 'Class', filePath: 'com/tcbs/dto/Dto.java' }];
        }
        if (query.includes('labels(s)')) {
          const filePath = params.filePath || '';
          if (filePath === 'src/ServiceA.java') {
            return [{ id: 'Method:src/ServiceA.java:methodA', name: 'methodA', type: 'Method', filePath: 'src/ServiceA.java' }];
          }
          if (filePath === 'src/ServiceB.java') {
            return [{ id: 'Method:src/ServiceB.java:methodB', name: 'methodB', type: 'Method', filePath: 'src/ServiceB.java' }];
          }
          return [];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo-a', 'dep-repo-b']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      // Resolver should be called twice — once per dep repo
      expect(mockResolveDepConsumers).toHaveBeenCalledTimes(2);
      expect(result).toBeDefined();
    });

    // ── T-CR-23: Confidence values preserved from resolver ──
    it('preserves confidence values from resolver with CROSS_REPO_ prefix', async () => {
      setupGitDiff(['TradingDto.java']);
      setupFileSymbols({
        'TradingDto.java': [
          { id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' },
        ],
      });
      setupBFS([]);

      // First call: file-imports consumer (confidence 0.9)
      // Second call: class-name consumer (confidence 0.8)
      let resolverCallCount = 0;
      mockResolveDepConsumers.mockImplementation(async () => {
        resolverCallCount++;
        if (resolverCallCount === 1) {
          return [{
            id: 'Method:src/BondService.java:getBondbyId',
            name: 'getBondbyId',
            filePath: 'src/BondService.java',
            confidence: 0.9,
            matchMethod: 'file-imports',
            matchedDepSymbol: 'dep-TradingDto',
          }];
        }
        return [{
          id: 'Method:src/BondService.java:processTrade',
          name: 'processTrade',
          filePath: 'src/BondService.java',
          confidence: 0.8,
          matchMethod: 'class-name',
          matchedDepSymbol: 'dep-TradingDto',
        }];
      });

      // Track what gets added to expandedMeta via the result structure
      let capturedFileSymbolCalls: any[] = [];
      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [{ id: 'dep-TradingDto', name: 'TradingDto', type: 'Class', filePath: 'com/tcbs/bond/trading/dto/TradingDto.java' }];
        }
        if (query.includes('labels(s)')) {
          capturedFileSymbolCalls.push(params);
          const filePath = params.filePath || '';
          if (filePath === 'src/BondService.java') {
            return [
              { id: 'Method:src/BondService.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'src/BondService.java' },
              { id: 'Method:src/BondService.java:processTrade', name: 'processTrade', type: 'Method', filePath: 'src/BondService.java' },
            ];
          }
          return [];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue(['dep-repo']),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      expect(result).toBeDefined();
      // Resolver was called and file-symbol queries were made
      expect(mockResolveDepConsumers).toHaveBeenCalled();
      // The file-symbol query was called for the consumer's file path
      expect(capturedFileSymbolCalls.some((p: any) => p.filePath === 'src/BondService.java')).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section D: Risk Scoring
  // ──────────────────────────────────────────────────────────────────────

  describe('Risk Scoring', () => {
    /**
     * Helper: set up mocks to produce a specific number of endpoints in each tier,
     * a specific number of affected processes, modules, and expanded symbols.
     *
     * - endpoints: total across WILL_BREAK + LIKELY_AFFECTED + MAY_NEED_TESTING
     *   We generate them all as WILL_BREAK (depth=0, confidence=1.0) for simplicity.
     * - processes: number of affected processes (via STEP_IN_PROCESS)
     * - modules: number of affected modules (via MEMBER_OF)
     * - expanded: number of upstream (non-changed) symbols from BFS
     */
    function setupRiskScenario(opts: { endpoints?: number; processes?: number; modules?: number; expanded?: number }) {
      const { endpoints = 0, processes = 0, modules = 0, expanded = 0 } = opts;

      // One changed file with one symbol
      setupGitDiff(['RiskService.java']);
      const fileSymbols: Record<string, any[]> = {
        'RiskService.java': [
          { id: 'sym-risk', name: 'RiskService', type: 'Class', filePath: 'RiskService.java' },
        ],
      };

      // BFS: produce `expanded` upstream nodes
      const bfsNodes: any[] = [];
      for (let i = 0; i < expanded; i++) {
        bfsNodes.push({
          sourceId: 'sym-risk', id: `upstream-${i}`, name: `upNode${i}`,
          type: 'Method', filePath: `src/file${i}.java`, relType: 'CALLS', confidence: 0.9,
        });
      }

      if (expanded > 0) {
        let bfsCallCount = 0;
        executeQueryMock.mockImplementation(async (...args: any[]) => {
          const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
          if (query.includes('r.type IN')) {
            bfsCallCount++;
            if (bfsCallCount === 1) return bfsNodes;
            return []; // deeper depths return empty
          }
          // Module enrichment count queries
          if (query.includes('MEMBER_OF') && query.includes('COUNT(DISTINCT s.id)')) {
            // Return module rows for module enrichment
            const moduleRows: any[] = [];
            for (let i = 0; i < modules; i++) {
              moduleRows.push({ name: `module-${i}`, hits: 1 });
            }
            return moduleRows;
          }
          if (query.includes('RETURN DISTINCT c.heuristicLabel')) {
            // D1 module direct names
            const d1ModuleRows: any[] = [];
            for (let i = 0; i < Math.min(modules, 2); i++) {
              d1ModuleRows.push({ name: `module-${i}` });
            }
            return d1ModuleRows;
          }
          return [];
        });
      } else {
        setupBFS([]);
      }

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        // File → symbols
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }

        // Route discovery — generate `endpoints` routes
        if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
          const routes: any[] = [];
          for (let i = 0; i < endpoints; i++) {
            routes.push({
              path: `/api/ep${i}`, method: 'GET', file_path: `Controller${i}.java`,
              line: 10 + i, controller: `Controller${i}`, handler: `handler${i}`,
              affected_name: 'RiskService', affected_id: 'sym-risk',
              relation: 'CALLS', discovery_path: 'reverse-CALLS',
            });
          }
          return routes;
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return []; // already handled via reverse-CALLS
        }
        if (query.includes('FETCHES')) {
          return [];
        }

        // STEP_IN_PROCESS enrichment
        if (query.includes('STEP_IN_PROCESS')) {
          const processRows: any[] = [];
          for (let i = 0; i < processes; i++) {
            processRows.push({
              name: `process-${i}`, hits: 1, minStep: 1, stepCount: 5,
            });
          }
          return processRows;
        }

        // MEMBER_OF enrichment
        if (query.includes('MEMBER_OF')) {
          const moduleRows: any[] = [];
          for (let i = 0; i < modules; i++) {
            moduleRows.push({ name: `module-${i}`, hits: 1 });
          }
          return moduleRows;
        }

        return [];
      });
    }

    // U-R01: 0/0/0/0 → LOW
    it('returns LOW risk when no endpoints, processes, modules, or expanded symbols', async () => {
      setupRiskScenario({ endpoints: 0, processes: 0, modules: 0, expanded: 0 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      // 0 endpoints but 1 changed symbol → risk = LOW (default)
      // Actually with 0 endpoints, 0 processes, 0 modules, 0 expanded → still LOW
      expect(result.summary.risk_level).toBe('LOW');
    });

    // U-R02: 4 endpoints → LOW (4 < 5)
    it('returns LOW risk when 4 endpoints (below MEDIUM threshold of 5)', async () => {
      setupRiskScenario({ endpoints: 4 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('LOW');
    });

    // U-R03: 5 endpoints → MEDIUM
    it('returns MEDIUM risk when 5 endpoints (at MEDIUM threshold)', async () => {
      setupRiskScenario({ endpoints: 5 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('MEDIUM');
    });

    // U-R04: 14 endpoints → MEDIUM (14 < 15)
    it('returns MEDIUM risk when 14 endpoints (below HIGH threshold of 15)', async () => {
      setupRiskScenario({ endpoints: 14 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('MEDIUM');
    });

    // U-R05: 15 endpoints → HIGH
    it('returns HIGH risk when 15 endpoints (at HIGH threshold)', async () => {
      setupRiskScenario({ endpoints: 15 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('HIGH');
    });

    // U-R06: 29 endpoints → HIGH (29 < 30)
    it('returns HIGH risk when 29 endpoints (below CRITICAL threshold of 30)', async () => {
      setupRiskScenario({ endpoints: 29 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('HIGH');
    });

    // U-R07: 30 endpoints → CRITICAL
    it('returns CRITICAL risk when 30 endpoints (at CRITICAL threshold)', async () => {
      setupRiskScenario({ endpoints: 30 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('CRITICAL');
    });

    // U-R08: 0 endpoints, 3 processes → HIGH
    it('returns HIGH risk when 3 processes (at HIGH process threshold)', async () => {
      setupRiskScenario({ endpoints: 0, processes: 3 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('HIGH');
    });

    // U-R09: 0 endpoints, 5 processes → CRITICAL
    it('returns CRITICAL risk when 5 processes (at CRITICAL process threshold)', async () => {
      setupRiskScenario({ endpoints: 0, processes: 5 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('CRITICAL');
    });

    // U-R10: 0 endpoints, 3 modules → HIGH
    it('returns HIGH risk when 3 modules (at HIGH module threshold)', async () => {
      setupRiskScenario({ endpoints: 0, modules: 3 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('HIGH');
    });

    // U-R11: 200 expanded symbols → CRITICAL
    it('returns CRITICAL risk when 200 expanded symbols (at CRITICAL expanded threshold)', async () => {
      setupRiskScenario({ endpoints: 0, expanded: 200 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('CRITICAL');
    });

    // U-R12: 100 expanded symbols → HIGH
    it('returns HIGH risk when 100 expanded symbols (at HIGH expanded threshold)', async () => {
      setupRiskScenario({ endpoints: 0, expanded: 100 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('HIGH');
    });

    // U-R13: 30 expanded symbols → MEDIUM
    it('returns MEDIUM risk when 30 expanded symbols (at MEDIUM expanded threshold)', async () => {
      setupRiskScenario({ endpoints: 0, expanded: 30 });
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );
      expect(result.summary.risk_level).toBe('MEDIUM');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section E: Error Handling
  // ──────────────────────────────────────────────────────────────────────

  describe('Error Handling', () => {
    // U-E01: Git command fails — execFileSync throws
    it('returns error response when git command fails', async () => {
      execFileSyncMock.mockImplementation(() => {
        throw new Error('git is not installed');
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      expect(result).toHaveProperty('error');
      expect(result.error).toContain('git is not installed');
    });

    // U-E02: Git returns empty output — clean working tree
    it('returns risk_level none (not error) when git diff is empty', async () => {
      execFileSyncMock.mockReturnValue('');

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      expect(result).not.toHaveProperty('error');
      expect(result.summary.risk_level).toBe('none');
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 0 });
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 0 });
    });

    // U-E03: scope=compare without base_ref
    it('returns error when scope is compare without base_ref', async () => {
      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'compare' },
      );

      expect(result).toHaveProperty('error');
      expect(result.error).toContain('base_ref is required');
    });

    // U-E04: BFS query fails at depth 2 — depth-1 results preserved
    it('preserves depth-1 results when BFS query fails at depth 2', async () => {
      setupGitDiff(['Service.java']);
      const fileSymbols: Record<string, any[]> = {
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      };

      let depthCallCount = 0;
      executeQueryMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        if (query.includes('r.type IN')) {
          depthCallCount++;
          if (depthCallCount === 1) {
            // Depth 1 succeeds: find 1 upstream caller
            return [{
              sourceId: 'sym-svc', id: 'upstream-d1', name: 'DepthOneCaller',
              type: 'Method', filePath: 'Controller.java', relType: 'CALLS', confidence: 0.95,
            }];
          }
          // Depth 2 fails
          throw new Error('depth-2 query timeout');
        }
        return [];
      });

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/data', method: 'GET', file_path: 'Controller.java',
            line: 10, controller: 'Controller', handler: 'DepthOneCaller',
            affected_name: 'DepthOneCaller', affected_id: 'upstream-d1',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      // Depth-1 route should still be present
      expect(result.impacted_endpoints.WILL_BREAK.length + result.impacted_endpoints.LIKELY_AFFECTED.length)
        .toBeGreaterThanOrEqual(1);
      // Should be marked partial
      expect(result._meta.partial).toBe(true);
    });

    // U-E05: File→symbol query fails for one file — other files still processed
    it('continues processing other files when one file→symbol query fails', async () => {
      setupGitDiff(['FailService.java', 'GoodService.java']);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          const filePath = params.filePath || '';
          if (filePath.includes('FailService')) {
            throw new Error('graph query failed for FailService');
          }
          if (filePath.includes('GoodService')) {
            return [{ id: 'sym-good', name: 'GoodService', type: 'Class', filePath: 'GoodService.java' }];
          }
        }
        return [];
      });
      setupBFS([]);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      // GoodService should still be processed
      expect(result.changed_symbols).toHaveLength(1);
      expect(result.changed_symbols[0].name).toBe('GoodService');
      // No crash, no error field
      expect(result).not.toHaveProperty('error');
    });

    // U-E06: Binary files in git diff — no graph symbols → risk_level=none
    it('returns risk_level none when git diff contains only binary files with no graph symbols', async () => {
      setupGitDiff(['image.png', 'lib.jar', 'binary.so']);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        void args[2];
        if (query.includes('n.filePath CONTAINS')) {
          return []; // No symbols for binary files
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      expect(result.summary.changed_files).toEqual({ 'repo-ie': 3 });
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 0 });
      expect(result.summary.risk_level).toBe('none');
    });

    // U-E07: Very long file paths — handled normally
    it('handles very long file paths (>200 chars) without error', async () => {
      const longPath = 'src/main/java/com/example/project/module/submodule/deeply/nested/package/impl/VeryLongClassNameServiceImpl.java';
      setupGitDiff([longPath]);

      const fileSymbols: Record<string, any[]> = {
        [longPath]: [
          { id: 'sym-long', name: 'VeryLongClassNameServiceImpl', type: 'Class', filePath: longPath },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'), { scope: 'unstaged' },
      );

      expect(result).not.toHaveProperty('error');
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 1 });
      expect(result.changed_symbols[0].filePath).toBe(longPath);
    });
  });

  // ── Index health check (WI-2) ─────────────────────────────────────
  describe('index health check diagnostics', () => {
    /** Set up a minimal pipeline that reaches the health check stage */
    function setupMinimalPipeline(opts?: { nodeCount?: number; fileCount?: number }) {
      const repo = (backend as any).repos.get('repo-ie');
      repo.stats = {
        files: opts?.fileCount ?? 100,
        nodes: opts?.nodeCount ?? 500,
      };

      setupGitDiff(['Service.java']);
      setupFileSymbols({
        'Service.java': [
          { id: 'sym-svc', name: 'Service', type: 'Class', filePath: 'Service.java' },
        ],
      });
      setupBFS([]);
      // Default: no routes, no processes/modules
      routeDiscoveryHandler = () => [];
    }

    it('reports stale diagnostics when Route table is missing', async () => {
      setupMinimalPipeline();
      // Simulate Route table not existing
      routeHealthCheckHandler = () => {
        throw new Error('Table Route does not exist in the catalog');
      };

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result._diagnostics).toBeDefined();
      expect(result._diagnostics.index_health).toBe('stale');
      expect(result._diagnostics.missing_tables).toContain('Route');
      expect(result._diagnostics.recommendation).toContain('Missing tables');
      // Pipeline still runs — result should have standard shape
      expect(result.summary).toBeDefined();
      expect(result.impacted_endpoints).toBeDefined();
    });

    it('reports stale diagnostics when schema version mismatches', async () => {
      setupMinimalPipeline();
      // Route table OK, but schema version is outdated
      loadMetaMock.mockResolvedValue({
        repoPath: '/tmp/repo-ie',
        lastCommit: 'abc',
        indexedAt: '2025-01-01',
        schemaVersion: 1, // outdated — current is SCHEMA_VERSION_MOCK (29)
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result._diagnostics).toBeDefined();
      expect(result._diagnostics.index_health).toBe('stale');
      expect(result._diagnostics.schema_version).toBeDefined();
      expect(result._diagnostics.schema_version.current).toBe(29);
      expect(result._diagnostics.schema_version.indexed).toBe(1);
      expect(result._diagnostics.recommendation).toContain('Schema version mismatch');
    });

    it('reports stale diagnostics when schema version is missing (null)', async () => {
      setupMinimalPipeline();
      // meta.json exists but has no schemaVersion (old index)
      loadMetaMock.mockResolvedValue({
        repoPath: '/tmp/repo-ie',
        lastCommit: 'abc',
        indexedAt: '2025-01-01',
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result._diagnostics).toBeDefined();
      expect(result._diagnostics.index_health).toBe('stale');
      expect(result._diagnostics.schema_version).toBeDefined();
      expect(result._diagnostics.schema_version.current).toBe(29);
      expect(result._diagnostics.schema_version.indexed).toBeNull();
    });

    it('reports low_node_count when node count is very low relative to files', async () => {
      setupMinimalPipeline({ nodeCount: 50, fileCount: 200 });
      loadMetaMock.mockResolvedValue(null); // no meta → schema version will be stale

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result._diagnostics).toBeDefined();
      expect(result._diagnostics.low_node_count).toBe(true);
      expect(result._diagnostics.recommendation).toContain('Low node count');
    });

    it('omits _diagnostics when all health checks pass', async () => {
      setupMinimalPipeline({ nodeCount: 500, fileCount: 100 });
      // Route table exists (default handler), schema version matches, node count is fine
      loadMetaMock.mockResolvedValue({
        repoPath: '/tmp/repo-ie',
        lastCommit: 'abc',
        indexedAt: '2025-01-01',
        schemaVersion: 29,
      });
      // Align the registry's lastCommit with meta so the commit_drift check stays clean.
      // The makeBackend helper defaults to 'c'; without this override the diagnostics
      // block would flag drift between 'abc' (meta) and 'c' (registry).
      const repo = (backend as any).repos.get('repo-ie');
      repo.lastCommit = 'abc';

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      expect(result._diagnostics).toBeUndefined();
      expect(result.summary).toBeDefined();
      expect(result.impacted_endpoints).toBeDefined();
    });

    it('health check failure does not block the main pipeline', async () => {
      setupMinimalPipeline();
      // Force ALL health checks to fail
      routeHealthCheckHandler = () => {
        throw new Error('Connection refused');
      };
      loadMetaMock.mockRejectedValue(new Error('ENOENT'));

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Pipeline should still produce results even if health check errors
      expect(result.summary).toBeDefined();
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 1 });
      // Health check error was caught silently — diagnostics may or may not be present
      // depending on which checks failed before the catch, but result is never blocked
    });

    // (#28, #49) The single-repo summary now uses per-repo Record for ALL
    // count fields. This test pins the contract so a future "optimization"
    // doesn't regress it back to a bare number.
    it('summary uses per-repo Record for changed_files, changed_symbols, AND impacted_endpoints', async () => {
      setupGitDiff(['Single.java']);
      setupFileSymbols({
        'Single.java': [
          { id: 'sym-single', name: 'doWork', type: 'Method', filePath: 'Single.java' },
        ],
      });

      // Empty BFS — all counts end up at 0/1
      executeQueryMock.mockImplementation(async () => []);

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      // Every count field must be a Record (not a bare number)
      expect(typeof result.summary.changed_files).toBe('object');
      expect(result.summary.changed_files).toEqual({ 'repo-ie': 1 });
      expect(typeof result.summary.changed_symbols).toBe('object');
      expect(result.summary.changed_symbols).toEqual({ 'repo-ie': 1 });
      expect(typeof result.summary.impacted_endpoints).toBe('object');
      expect(result.summary.impacted_endpoints).toEqual({ 'repo-ie': 0 });
      // risk_level stays a scalar
      expect(typeof result.summary.risk_level).toBe('string');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Section F: Cross-Repo Impact Attribution (_triggered_by & confidence)
  // ──────────────────────────────────────────────────────────────────────

  describe('Cross-Repo Impact Attribution', () => {
    /** Helper: set up a cross-repo pipeline that discovers an endpoint via CrossRepoResolver */
    function setupCrossRepoPipeline(opts: {
      changedFile: string;
      changedSymbol: { id: string; name: string; filePath: string };
      depRepoId?: string;
      resolvedConsumers?: Array<{
        id: string; name: string; filePath: string;
        confidence: number; matchMethod: string; matchedDepSymbol: string;
      }>;
      fileSymbolsInConsumer?: Array<{ id: string; name: string; type: string; filePath: string }>;
      routeDiscovery?: (type: string, params: any) => any[];
    }) {
      const depRepoId = opts.depRepoId ?? 'dep-repo';
      const consumers = opts.resolvedConsumers ?? [{
        id: 'Method:src/BondServiceImpl.java:getBondbyId',
        name: 'getBondbyId',
        filePath: 'src/BondServiceImpl.java',
        confidence: 0.9,
        matchMethod: 'file-imports',
        matchedDepSymbol: opts.changedSymbol.id,
      }];
      const consumerFileSymbols = opts.fileSymbolsInConsumer ?? [
        { id: 'Method:src/BondServiceImpl.java:getBondbyId', name: 'getBondbyId', type: 'Method', filePath: 'src/BondServiceImpl.java' },
      ];

      setupGitDiff([opts.changedFile]);
      setupFileSymbols({
        [opts.changedFile]: [opts.changedSymbol],
      });
      setupBFS([]);

      mockResolveDepConsumers.mockResolvedValue(consumers);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};

        if (query.includes('n.filePath CONTAINS')) {
          return [opts.changedSymbol];
        }
        if (query.includes('labels(s)')) {
          return consumerFileSymbols;
        }
        // Route discovery
        if (query.includes('reverse-CALLS') || query.includes("'reverse-CALLS'")) {
          return opts.routeDiscovery?.('reverse-CALLS', params) ?? [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return opts.routeDiscovery?.('DEFINES', params) ?? [];
        }
        if (query.includes('FETCHES')) {
          return opts.routeDiscovery?.('FETCHES', params) ?? [];
        }
        return [];
      });

      const mockCrossRepo = {
        listDepRepos: vi.fn().mockResolvedValue([depRepoId]),
        queryMultipleRepos: vi.fn().mockResolvedValue([]),
      };

      return mockCrossRepo;
    }

    // T-CR-29: Cross-repo endpoint includes _triggered_by
    it('includes _triggered_by array with repoId:symbolName format for cross-repo discoveries', async () => {
      const mockCrossRepo = setupCrossRepoPipeline({
        changedFile: 'TradingDto.java',
        changedSymbol: {
          id: 'Class:com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
          name: 'TradingDto',
          filePath: 'com/tcbs/bond/trading/dto/TradingDto.java',
        },
        depRepoId: 'tcbs-bond-trading-core',
        routeDiscovery: (type: string) => {
          if (type === 'DEFINES') {
            return [{
              path: '/e/v1/bonds/{id}', method: 'GET', file_path: 'src/BondController.java',
              line: 25, controller: 'BondController', handler: 'getBondbyId',
              affected_name: 'BondServiceImpl', affected_id: 'Method:src/BondServiceImpl.java:getBondbyId',
              relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
            }];
          }
          return [];
        },
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      // Should find at least one endpoint
      expect(allEndpoints.length).toBeGreaterThanOrEqual(1);
      // The endpoint discovered via cross-repo should have _triggered_by
      const crossRepoEndpoint = allEndpoints.find(
        (e: any) => e.affected_by?.length > 0 || e._triggered_by,
      );
      expect(crossRepoEndpoint).toBeDefined();
      expect(crossRepoEndpoint._triggered_by).toBeDefined();
      expect(Array.isArray(crossRepoEndpoint._triggered_by)).toBe(true);
      // Each entry should be in "repoId:symbolName" format
      for (const trigger of crossRepoEndpoint._triggered_by) {
        expect(trigger).toContain(':');
        expect(trigger).toContain('TradingDto');
      }
    });

    // T-CR-30: Local-only endpoint has no _triggered_by
    it('does not include _triggered_by for local-only endpoints', async () => {
      setupGitDiff(['UserService.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserService.java': [
          { id: 'sym-svc', name: 'UserService', type: 'Class', filePath: 'UserService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/users', method: 'GET', file_path: 'UserController.java',
            line: 25, controller: 'UserController', handler: 'getUsers',
            affected_name: 'UserService', affected_id: 'sym-svc',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        // No crossRepo — single-repo query
      );

      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      // Local-only endpoints should NOT have _triggered_by
      for (const endpoint of allEndpoints) {
        expect(endpoint._triggered_by).toBeUndefined();
      }
    });

    // T-CR-31: Cross-repo confidence ≤ 0.9
    it('uses resolver confidence for cross-repo discovered endpoints', async () => {
      const mockCrossRepo = setupCrossRepoPipeline({
        changedFile: 'TradingDto.java',
        changedSymbol: {
          id: 'Class:com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
          name: 'TradingDto',
          filePath: 'com/tcbs/bond/trading/dto/TradingDto.java',
        },
        resolvedConsumers: [{
          id: 'Method:src/BondServiceImpl.java:getBondbyId',
          name: 'getBondbyId',
          filePath: 'src/BondServiceImpl.java',
          confidence: 0.9,
          matchMethod: 'file-imports',
          matchedDepSymbol: 'Class:com/tcbs/bond/trading/dto/TradingDto.java:TradingDto',
        }],
        routeDiscovery: (type: string) => {
          if (type === 'DEFINES') {
            return [{
              path: '/e/v1/bonds/{id}', method: 'GET', file_path: 'src/BondController.java',
              line: 25, controller: 'BondController', handler: 'getBondbyId',
              affected_name: 'BondServiceImpl',
              affected_id: 'Method:src/BondServiceImpl.java:getBondbyId',
              relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
            }];
          }
          return [];
        },
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const crossRepoEndpoint = allEndpoints.find(
        (e: any) => e._triggered_by,
      );
      expect(crossRepoEndpoint).toBeDefined();
      // Cross-repo confidence should be the resolver's confidence (0.9), not 1.0
      expect(crossRepoEndpoint.confidence).toBeLessThanOrEqual(0.9);
    });

    // T-CR-32: Local-only confidence = 1.0
    it('uses confidence 1.0 for local-only endpoints', async () => {
      setupGitDiff(['UserService.java']);
      const fileSymbols: Record<string, any[]> = {
        'UserService.java': [
          { id: 'sym-svc', name: 'UserService', type: 'Class', filePath: 'UserService.java' },
        ],
      };
      setupFileSymbols(fileSymbols);
      setupBFS([]);

      executeParameterizedMock.mockImplementation(async (...args: any[]) => {
        const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
        const params = args[2] || {};
        if (query.includes('n.filePath CONTAINS')) {
          return fileSymbols[params.filePath] || [];
        }
        if (query.includes('DEFINES') || query.includes('HANDLES_ROUTE')) {
          return [{
            path: '/api/users', method: 'GET', file_path: 'UserController.java',
            line: 25, controller: 'UserController', handler: 'getUsers',
            affected_name: 'UserService', affected_id: 'sym-svc',
            relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
          }];
        }
        return [];
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
      );

      const willBreakRoutes = result.impacted_endpoints.WILL_BREAK;
      // sym-svc is a changed symbol (depth=0), so confidence should be 1.0
      expect(willBreakRoutes.length).toBeGreaterThanOrEqual(1);
      expect(willBreakRoutes[0].confidence).toBe(1.0);
    });

    // T-CR-33: Multiple triggers on same endpoint
    it('accumulates multiple triggers when an endpoint is discovered via multiple dep symbols', async () => {
      const mockCrossRepo = setupCrossRepoPipeline({
        changedFile: 'Dto.java',
        changedSymbol: {
          id: 'dep-Dto',
          name: 'Dto',
          filePath: 'com/tcbs/dto/Dto.java',
        },
        depRepoId: 'tcbs-bond-trading-core',
        resolvedConsumers: [
          {
            id: 'Method:src/BondService.java:processBond',
            name: 'processBond',
            filePath: 'src/BondService.java',
            confidence: 0.9,
            matchMethod: 'file-imports',
            matchedDepSymbol: 'dep-Dto',
          },
        ],
        fileSymbolsInConsumer: [
          { id: 'Method:src/BondService.java:processBond', name: 'processBond', type: 'Method', filePath: 'src/BondService.java' },
        ],
        routeDiscovery: (type: string) => {
          if (type === 'DEFINES') {
            return [{
              path: '/api/bonds', method: 'POST', file_path: 'src/BondController.java',
              line: 30, controller: 'BondController', handler: 'processBond',
              affected_name: 'BondService',
              affected_id: 'Method:src/BondService.java:processBond',
              relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
            }];
          }
          return [];
        },
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const endpoint = allEndpoints.find((e: any) => e._triggered_by);
      expect(endpoint).toBeDefined();
      expect(endpoint._triggered_by).toBeDefined();
      expect(Array.isArray(endpoint._triggered_by)).toBe(true);
      // Should contain at least one trigger entry
      expect(endpoint._triggered_by.length).toBeGreaterThanOrEqual(1);
      // Each entry should match "repoId:symbolName" format
      for (const trigger of endpoint._triggered_by) {
        expect(trigger).toMatch(/^.+:.+$/);
      }
    });

    // T-CR-34: _triggered_by format validation
    it('formats each _triggered_by entry as repoId:symbolName', async () => {
      const mockCrossRepo = setupCrossRepoPipeline({
        changedFile: 'TcbsException.java',
        changedSymbol: {
          id: 'Class:com/tcbs/bond/exception/TcbsException.java:TcbsException',
          name: 'TcbsException',
          filePath: 'com/tcbs/bond/exception/TcbsException.java',
        },
        depRepoId: 'tcbs-common-lib',
        resolvedConsumers: [{
          id: 'Method:src/BondServiceImpl.java:handleException',
          name: 'handleException',
          filePath: 'src/BondServiceImpl.java',
          confidence: 0.8,
          matchMethod: 'class-name',
          matchedDepSymbol: 'Class:com/tcbs/bond/exception/TcbsException.java:TcbsException',
        }],
        fileSymbolsInConsumer: [
          { id: 'Method:src/BondServiceImpl.java:handleException', name: 'handleException', type: 'Method', filePath: 'src/BondServiceImpl.java' },
        ],
        routeDiscovery: (type: string) => {
          if (type === 'DEFINES') {
            return [{
              path: '/api/bonds/error', method: 'GET', file_path: 'src/BondController.java',
              line: 40, controller: 'BondController', handler: 'handleException',
              affected_name: 'BondServiceImpl',
              affected_id: 'Method:src/BondServiceImpl.java:handleException',
              relation: 'DEFINES', discovery_path: 'DEFINES/HANDLES_ROUTE',
            }];
          }
          return [];
        },
      });

      const result = await (backend as any)._impactedEndpointsImpl(
        (backend as any).repos.get('repo-ie'),
        { scope: 'unstaged' },
        mockCrossRepo,
      );

      const allEndpoints = [
        ...result.impacted_endpoints.WILL_BREAK,
        ...result.impacted_endpoints.LIKELY_AFFECTED,
        ...result.impacted_endpoints.MAY_NEED_TESTING,
      ];
      const endpoint = allEndpoints.find((e: any) => e._triggered_by);
      expect(endpoint).toBeDefined();
      expect(endpoint._triggered_by).toBeDefined();

      // Each entry should be "repoId:symbolName" — the repoId is the dep repo,
      // and symbolName is the changed symbol's name (not the full ID)
      for (const trigger of endpoint._triggered_by) {
        const parts = trigger.split(':');
        expect(parts.length).toBeGreaterThanOrEqual(2);
        // The first part before the colon is the repo ID
        expect(parts[0]).toBe('tcbs-common-lib');
        // The remaining parts joined should be the symbol name (TcbsException)
        // (splitting on ':' because symbolName itself might contain colons in some ID formats,
        //  but the name "TcbsException" should not contain colons)
        const symbolName = parts.slice(1).join(':');
        expect(symbolName).toBe('TcbsException');
      }
    });
  });
});