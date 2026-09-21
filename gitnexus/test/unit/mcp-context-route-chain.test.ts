/**
 * Unit tests: context/query route + chain enrichment (#4, #9, #28).
 *
 * Drives LocalBackend with a mocked executeParameterized (same seam as
 * test/unit/trace-bfs.test.ts) so HANDLES_ROUTE / BFS rows can be injected
 * without a LadybugDB index.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return {
    ...actual,
    listRegisteredRepos: vi.fn().mockResolvedValue([
      {
        name: 'test-project',
        path: '/tmp/test-project',
        storagePath: '/tmp/.gitnexus/test-project',
        indexedAt: '2024-06-01T12:00:00Z',
        lastCommit: 'abc123',
        stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
      },
    ]),
    cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
    findSiblingClones: vi.fn().mockResolvedValue([]),
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

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

const HANDLER = {
  id: 'Function:src/handlers/login.ts:loginHandler',
  name: 'loginHandler',
  type: 'Function',
  filePath: 'src/handlers/login.ts',
  startLine: 10,
  endLine: 40,
};

const ROUTE = { url: '/api/login', method: 'POST' };

const CALLER = {
  uid: 'Function:src/a.ts:callerFn',
  name: 'callerFn',
  filePath: 'src/a.ts',
  kind: 'Function',
  isTest: 0,
};

const CALLEE = {
  uid: 'Function:src/b.ts:calleeFn',
  name: 'calleeFn',
  filePath: 'src/b.ts',
  kind: 'Function',
  isTest: 0,
};

/** Reciprocal peer of HANDLER: CALLS HANDLER→PEER and PEER→HANDLER. */
const PEER = {
  uid: 'Function:src/peer.ts:peerFn',
  name: 'peerFn',
  filePath: 'src/peer.ts',
  kind: 'Function',
  isTest: 0,
};

async function makeBackend(): Promise<LocalBackend> {
  const b = new LocalBackend();
  await b.init();
  (b as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  return b;
}

function isUidLookup(params: any): boolean {
  return params?.uid === HANDLER.id;
}

function isNameLookup(params: any): boolean {
  return params?.symName === HANDLER.name;
}

/**
 * `async` matters: the real executeParameterized returns a promise, and
 * callers chain `.catch()` on it directly (see trace-bfs.test.ts).
 */
function mockGraph(options: {
  handlesRoute?: boolean;
  processRows?: any[];
  chain?: boolean;
  queryProcess?: boolean;
  /** Same peer for both CALLS directions; omit if already in $visited. */
  reciprocalPeer?: typeof PEER;
}) {
  return async (_db: string, query: string, params: any = {}) => {
    if (isUidLookup(params) || isNameLookup(params)) return [HANDLER];

    if (params?.frontier) {
      const visited = new Set(params.visited ?? []);
      if (options.reciprocalPeer) {
        if (visited.has(options.reciprocalPeer.uid)) return [];
        return [options.reciprocalPeer];
      }
      if (!options.chain) return [];
      if (query.includes('MATCH (caller)')) return [CALLER];
      if (query.includes('MATCH (n)-[r:CodeRelation]->(target)')) return [CALLEE];
      return [];
    }

    if (query.includes('STEP_IN_PROCESS')) {
      return options.processRows ?? [];
    }

    // Combined ENTRY_POINT_OF ∪ HANDLES_ROUTE query — only the HANDLES_ROUTE
    // arm is populated in these fixtures (no Process / ENTRY_POINT_OF rows).
    if (query.includes('HANDLES_ROUTE')) {
      if (!options.handlesRoute) return [];
      if (options.queryProcess) {
        return [{ pid: HANDLER.id, url: ROUTE.url, method: ROUTE.method }];
      }
      return [{ url: ROUTE.url, method: ROUTE.method }];
    }

    if (query.includes('ENTRY_POINT_OF')) return [];
    return [];
  };
}

describe('context/query route + chain enrichment', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = await makeBackend();
  });

  it('context() returns routes from HANDLES_ROUTE even with no Process/ENTRY_POINT_OF', async () => {
    (executeParameterized as any).mockImplementation(
      mockGraph({ handlesRoute: true, processRows: [] }),
    );

    const result = await backend.callTool('context', { uid: HANDLER.id });

    expect(result.status).toBe('found');
    expect(result.processes).toEqual([]);
    expect(result.is_entry_point).toBeUndefined();
    expect(result.routes).toEqual([{ url: ROUTE.url, method: ROUTE.method }]);
  });

  it.each([0.1, 1.5, 4] as const)(
    'context rejects non-integer or oversized chain_depth=%s',
    async (value) => {
      const result = await backend.callTool('context', { uid: HANDLER.id, chain_depth: value });
      expect(result).toMatchObject({
        error: expect.stringMatching(/Invalid "chain_depth".*\[0,/),
      });
    },
  );

  it('context({chain_depth:1}) returns chain when BFS rows exist', async () => {
    (executeParameterized as any).mockImplementation(
      mockGraph({ handlesRoute: true, processRows: [], chain: true }),
    );

    const result = await backend.callTool('context', { uid: HANDLER.id, chain_depth: 1 });

    expect(result.status).toBe('found');
    expect(result.chain).toEqual([
      {
        depth: 1,
        upstream: [
          { uid: CALLER.uid, name: CALLER.name, filePath: CALLER.filePath, kind: CALLER.kind },
        ],
        downstream: [
          { uid: CALLEE.uid, name: CALLEE.name, filePath: CALLEE.filePath, kind: CALLEE.kind },
        ],
      },
    ]);
  });

  it('context({chain_depth:1}) de-duplicates a node reached through two frontier edges', async () => {
    (executeParameterized as any).mockImplementation(
      async (_db: string, query: string, params: any = {}) => {
        if (isUidLookup(params) || isNameLookup(params)) return [HANDLER];
        if (params?.frontier) {
          if (query.includes('MATCH (caller)')) {
            expect(query).toContain('WITH DISTINCT caller');
            return [CALLER, { ...CALLER }];
          }
          if (query.includes('MATCH (n)-[r:CodeRelation]->(target)')) {
            expect(query).toContain('WITH DISTINCT target');
            return [CALLEE, { ...CALLEE }];
          }
          return [];
        }
        if (query.includes('STEP_IN_PROCESS')) return [];
        if (query.includes('HANDLES_ROUTE')) return [{ url: ROUTE.url, method: ROUTE.method }];
        if (query.includes('ENTRY_POINT_OF')) return [];
        return [];
      },
    );

    const result = await backend.callTool('context', { uid: HANDLER.id, chain_depth: 1 });

    expect(result.status).toBe('found');
    expect(result.chain).toEqual([
      {
        depth: 1,
        upstream: [
          { uid: CALLER.uid, name: CALLER.name, filePath: CALLER.filePath, kind: CALLER.kind },
        ],
        downstream: [
          { uid: CALLEE.uid, name: CALLEE.name, filePath: CALLEE.filePath, kind: CALLEE.kind },
        ],
      },
    ]);
  });

  it('context({chain_depth:1}) lists a reciprocal peer in both layer-1 directions', async () => {
    (executeParameterized as any).mockImplementation(
      mockGraph({ handlesRoute: true, processRows: [], reciprocalPeer: PEER }),
    );

    const result = await backend.callTool('context', { uid: HANDLER.id, chain_depth: 1 });

    const peerNode = { uid: PEER.uid, name: PEER.name, filePath: PEER.filePath, kind: PEER.kind };
    expect(result.status).toBe('found');
    expect(result.chain).toEqual([
      {
        depth: 1,
        upstream: [peerNode],
        downstream: [peerNode],
      },
    ]);
  });

  it('query process includes route/method/routes and is_entry_point when enrichment rows exist', async () => {
    (backend as any).bm25Search = vi.fn().mockResolvedValue({
      results: [
        {
          nodeId: HANDLER.id,
          name: HANDLER.name,
          type: HANDLER.type,
          filePath: HANDLER.filePath,
          startLine: HANDLER.startLine,
          endLine: HANDLER.endLine,
        },
      ],
      ftsUsed: true,
    });
    (backend as any).semanticSearch = vi.fn().mockResolvedValue([]);
    (executeParameterized as any).mockImplementation(
      mockGraph({
        handlesRoute: true,
        queryProcess: true,
        processRows: [
          {
            nodeId: HANDLER.id,
            pid: 'Process:login',
            label: 'LoginFlow',
            heuristicLabel: 'User login',
            processType: 'request',
            stepCount: 3,
            step: 0,
            entryPointId: HANDLER.id,
          },
        ],
      }),
    );

    const result = await backend.callTool('query', { search_query: 'login' });

    expect(result).not.toHaveProperty('error');
    expect(result.processes).toHaveLength(1);
    expect(result.processes[0]).toMatchObject({
      id: 'Process:login',
      route: ROUTE.url,
      method: ROUTE.method,
      routes: [{ url: ROUTE.url, method: ROUTE.method }],
    });
    const entry = result.process_symbols.find((s: { id: string }) => s.id === HANDLER.id);
    expect(entry).toBeDefined();
    expect(entry.is_entry_point).toBe(true);
  });

  it('query({chain_depth:1}) attaches per-process chain from the entry symbol', async () => {
    (backend as any).bm25Search = vi.fn().mockResolvedValue({
      results: [
        {
          nodeId: HANDLER.id,
          name: HANDLER.name,
          type: HANDLER.type,
          filePath: HANDLER.filePath,
          startLine: HANDLER.startLine,
          endLine: HANDLER.endLine,
        },
      ],
      ftsUsed: true,
    });
    (backend as any).semanticSearch = vi.fn().mockResolvedValue([]);
    (executeParameterized as any).mockImplementation(
      mockGraph({
        handlesRoute: true,
        queryProcess: true,
        chain: true,
        processRows: [
          {
            nodeId: HANDLER.id,
            pid: 'Process:login',
            label: 'LoginFlow',
            heuristicLabel: 'User login',
            processType: 'request',
            stepCount: 3,
            step: 0,
            entryPointId: HANDLER.id,
          },
        ],
      }),
    );

    const result = await backend.callTool('query', { search_query: 'login', chain_depth: 1 });

    expect(result).not.toHaveProperty('error');
    expect(result.processes[0].chain).toEqual([
      {
        depth: 1,
        upstream: [
          { uid: CALLER.uid, name: CALLER.name, filePath: CALLER.filePath, kind: CALLER.kind },
        ],
        downstream: [
          { uid: CALLEE.uid, name: CALLEE.name, filePath: CALLEE.filePath, kind: CALLEE.kind },
        ],
      },
    ]);
  });

  it.each([
    ['limit', -1],
    ['limit', 0],
    ['limit', 1.5],
    ['limit', 101],
    ['limit', Infinity],
    ['max_symbols', 0],
    ['max_symbols', 201],
    ['chain_depth', -1],
    ['chain_depth', 0.1],
    ['chain_depth', 1.5],
    ['chain_depth', 4],
  ] as const)('query rejects out-of-range %s=%s before search', async (field, value) => {
    const bm25Search = vi.fn();
    (backend as any).bm25Search = bm25Search;
    (backend as any).semanticSearch = vi.fn();

    const result = await backend.callTool('query', { search_query: 'login', [field]: value });

    expect(result).toMatchObject({
      error: expect.stringMatching(new RegExp(`Invalid "${field}"`)),
    });
    expect(bm25Search).not.toHaveBeenCalled();
  });

  it('query Route FTS hit without a process attaches HANDLES_ROUTE handler + route_map hint', async () => {
    const routeId = 'Route:/trpc/admin.setSettings';
    const routeUrl = '/trpc/admin.setSettings';
    (backend as any).bm25Search = vi.fn().mockResolvedValue({
      results: [
        {
          nodeId: routeId,
          name: routeUrl,
          type: 'Route',
          filePath: 'src/server/trpc/routers/app.ts',
        },
      ],
      ftsUsed: true,
    });
    (backend as any).semanticSearch = vi.fn().mockResolvedValue([]);
    (executeParameterized as any).mockImplementation(async (_db: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS')) return [];
      if (query.includes('HANDLES_ROUTE') && query.includes('route.id')) {
        return [
          {
            routeId,
            handlerId: HANDLER.id,
            handlerName: HANDLER.name,
            handlerFilePath: HANDLER.filePath,
            url: routeUrl,
            method: 'POST',
          },
        ];
      }
      return [];
    });

    const result = await backend.callTool('query', { search_query: '/trpc/admin.setSettings' });

    expect(result).not.toHaveProperty('error');
    expect(result.processes).toEqual([]);
    expect(result.definitions).toHaveLength(1);
    expect(result.definitions[0]).toMatchObject({
      id: routeId,
      name: routeUrl,
      type: 'Route',
      handlerSymbolId: HANDLER.id,
      handlerName: HANDLER.name,
      routes: [{ url: routeUrl, method: 'POST' }],
      follow_up: { tool: 'route_map', route: routeUrl },
    });
  });

  it('query Route FTS hit stays a definition when HANDLES_ROUTE is empty', async () => {
    const routeId = 'Route:/trpc/orphan';
    const routeUrl = '/trpc/orphan';
    (backend as any).bm25Search = vi.fn().mockResolvedValue({
      results: [
        {
          nodeId: routeId,
          name: routeUrl,
          type: 'Route',
        },
      ],
      ftsUsed: true,
    });
    (backend as any).semanticSearch = vi.fn().mockResolvedValue([]);
    (executeParameterized as any).mockImplementation(async (_db: string, query: string) => {
      if (query.includes('STEP_IN_PROCESS')) return [];
      return [];
    });

    const result = await backend.callTool('query', { search_query: '/trpc/orphan' });

    expect(result).not.toHaveProperty('error');
    expect(result.definitions).toEqual([
      expect.objectContaining({
        id: routeId,
        name: routeUrl,
        type: 'Route',
        follow_up: { tool: 'route_map', route: routeUrl },
      }),
    ]);
    expect(result.definitions[0]).not.toHaveProperty('handlerSymbolId');
  });
});
