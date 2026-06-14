/**
 * Unit Tests: trace tool — BFS pathfinding, symbol resolution, gap reporting
 *
 * Drives the implementation of the `trace` MCP tool via TDD.
 * Mocks LadybugDB; tests the LocalBackend trace() logic in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../src/core/platform/capabilities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/platform/capabilities.js')>();
  return { ...actual, ...platformMocks };
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

// ─── Helpers ─────────────────────────────────────────────────────────

const SYMBOL_A = {
  id: 'func:A',
  name: 'A',
  type: 'Function',
  filePath: 'src/a.ts',
  startLine: 1,
  endLine: 10,
};
const SYMBOL_B = {
  id: 'func:B',
  name: 'B',
  type: 'Function',
  filePath: 'src/b.ts',
  startLine: 1,
  endLine: 5,
};

function makeResolveMock(
  fromRows: any[],
  toRows: any[],
  bfsRowsByFrontier?: Record<string, any[]>,
) {
  const bfsMap = bfsRowsByFrontier ?? {};
  return (_db: string, _query: string, params: any) => {
    // UID lookup keys on params.uid — the real query is `MATCH (n {id: $uid})`,
    // so matching on query text ('WHERE n.id = $uid') never fired.
    if (params.uid) {
      if (fromRows.length === 1 && fromRows[0].id === params.uid) return fromRows;
      if (toRows.length === 1 && toRows[0].id === params.uid) return toRows;
    }
    if (params.symName !== undefined) {
      if (params.symName === fromRows[0]?.name && fromRows.length > 0) return fromRows;
      if (params.symName === toRows[0]?.name && toRows.length > 0) return toRows;
    }
    if (params.frontierIds) {
      // The real per-level query fetches neighbors for ALL frontier ids at
      // once; concatenate so a multi-node frontier is modelled faithfully.
      const rows: any[] = [];
      for (const frontierId of params.frontierIds) {
        if (bfsMap[frontierId]) rows.push(...bfsMap[frontierId]);
      }
      return rows;
    }
    return [];
  };
}

async function makeBackend(): Promise<LocalBackend> {
  const b = new LocalBackend();
  await b.init();
  return b;
}

describe('trace: dispatch', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = await makeBackend();
  });

  it('dispatches trace tool without throwing', async () => {
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('trace', { from: 'foo', to: 'bar' });

    expect(result).toBeDefined();
    expect(result.status).toBe('not_found');
  });

  it('returns not_found when source symbol does not exist', async () => {
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('trace', { from: 'nonexistent', to: 'bar' });

    expect(result.status).toBe('not_found');
    expect(result.error).toContain('nonexistent');
  });
  it('returns ambiguous with candidates when source has multiple matches', async () => {
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:login:1',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 1,
        endLine: 10,
      },
      {
        id: 'func:login:2',
        name: 'login',
        type: 'Function',
        filePath: 'src/admin.ts',
        startLine: 5,
        endLine: 15,
      },
    ]);

    const result = await backend.callTool('trace', { from: 'login', to: 'bar' });

    expect(result.status).toBe('ambiguous');
    expect(result.role).toBe('from');
    expect(result.candidates).toHaveLength(2);
  });

  it('returns ambiguous with candidates when target has multiple matches', async () => {
    (executeParameterized as any).mockResolvedValueOnce([SYMBOL_A]).mockResolvedValue([
      {
        id: 'func:db:1',
        name: 'db',
        type: 'Function',
        filePath: 'src/db.ts',
        startLine: 1,
        endLine: 10,
      },
      {
        id: 'func:db:2',
        name: 'db',
        type: 'Function',
        filePath: 'src/db2.ts',
        startLine: 1,
        endLine: 10,
      },
    ]);

    const result = await backend.callTool('trace', { from: 'A', to: 'db' });

    expect(result.status).toBe('ambiguous');
    expect(result.role).toBe('to');
    expect(result.candidates).toHaveLength(2);
  });
});

// ─── Group 2: BFS Core ──────────────────────────────────────────────

describe('trace: BFS core', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = await makeBackend();
  });

  it('returns 0-hop path when from and to are the same symbol', async () => {
    (executeParameterized as any).mockResolvedValue([SYMBOL_A]);

    const result = await backend.callTool('trace', { from: 'A', to: 'A' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(0);
    expect(result.hops).toHaveLength(1);
    expect(result.hops[0].name).toBe('A');
    expect(result.edges).toHaveLength(0);
  });

  it('finds direct 1-hop path A→B', async () => {
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(1);
    expect(result.hops).toHaveLength(2);
    expect(result.hops[0].name).toBe('A');
    expect(result.hops[1].name).toBe('B');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].relType).toBe('CALLS');
    expect(result.edges[0].confidence).toBe(1.0);
  });

  it('finds 2-hop path A→C→B', async () => {
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:C',
            name: 'C',
            type: 'Function',
            filePath: 'src/c.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:C': [
          {
            sourceId: 'func:C',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 0.95,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(2);
    expect(result.hops).toHaveLength(3);
    expect(result.hops.map((h: any) => h.name)).toEqual(['A', 'C', 'B']);
    expect(result.edges[0].confidence).toBe(1.0);
    expect(result.edges[1].confidence).toBe(0.95);
  });

  it('reports furthest reachable node when no path exists', async () => {
    const SYMBOL_X = {
      id: 'func:X',
      name: 'X',
      type: 'Function',
      filePath: 'src/x.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_X], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:C',
            name: 'C',
            type: 'Function',
            filePath: 'src/c.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'X' });

    expect(result.status).toBe('no_path');
    expect(result.furthest).toBeDefined();
    expect(result.furthest.name).toBe('C');
    expect(result.furthest.depth).toBe(1);
    expect(result.suggestion).toBeDefined();
  });

  it('handles cycles without infinite loop', async () => {
    const SYMBOL_X = {
      id: 'func:X',
      name: 'X',
      type: 'Function',
      filePath: 'src/x.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_X], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
          {
            sourceId: 'func:A',
            id: 'func:A',
            name: 'A',
            type: 'Function',
            filePath: 'src/a.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:B': [
          {
            sourceId: 'func:B',
            id: 'func:A',
            name: 'A',
            type: 'Function',
            filePath: 'src/a.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'X' });

    expect(result.status).toBe('no_path');
  }, 5000);

  it('respects maxDepth limit', async () => {
    const SYMBOL_E = {
      id: 'func:E',
      name: 'E',
      type: 'Function',
      filePath: 'src/e.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_E], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:B': [
          {
            sourceId: 'func:B',
            id: 'func:C',
            name: 'C',
            type: 'Function',
            filePath: 'src/c.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:C': [
          {
            sourceId: 'func:C',
            id: 'func:D',
            name: 'D',
            type: 'Function',
            filePath: 'src/d.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:D': [
          {
            sourceId: 'func:D',
            id: 'func:E',
            name: 'E',
            type: 'Function',
            filePath: 'src/e.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'E', maxDepth: 2 });

    expect(result.status).toBe('no_path');
  });

  it('treats maxDepth 0 / negative / NaN as the default rather than a false no_path', async () => {
    const oneHop = {
      'func:A': [
        {
          sourceId: 'func:A',
          id: 'func:B',
          name: 'B',
          type: 'Function',
          filePath: 'src/b.ts',
          startLine: 1,
          edgeType: 'CALLS',
          confidence: 1.0,
        },
      ],
    };
    for (const badDepth of [0, -5, NaN]) {
      (executeParameterized as any).mockImplementation(
        makeResolveMock([SYMBOL_A], [SYMBOL_B], oneHop),
      );
      const result = await backend.callTool('trace', { from: 'A', to: 'B', maxDepth: badDepth });
      expect(result.status, `maxDepth=${badDepth}`).toBe('ok');
      expect(result.hopCount, `maxDepth=${badDepth}`).toBe(1);
    }
  });

  it('reaches a target that lives in a test file even when includeTests is false', async () => {
    const SYMBOL_T = {
      id: 'func:T',
      name: 'T',
      type: 'Function',
      filePath: 'src/t.test.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_T], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:T',
            name: 'T',
            type: 'Function',
            filePath: 'src/t.test.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'T' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(1);
    expect(result.hops[1].name).toBe('T');
  });

  it('still filters a non-target test-file hop when includeTests is false', async () => {
    const graph = {
      'func:A': [
        {
          sourceId: 'func:A',
          id: 'func:M',
          name: 'M',
          type: 'Function',
          filePath: 'src/m.test.ts',
          startLine: 1,
          edgeType: 'CALLS',
          confidence: 1.0,
        },
      ],
      'func:M': [
        {
          sourceId: 'func:M',
          id: 'func:B',
          name: 'B',
          type: 'Function',
          filePath: 'src/b.ts',
          startLine: 1,
          edgeType: 'CALLS',
          confidence: 1.0,
        },
      ],
    };

    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], graph),
    );
    const filtered = await backend.callTool('trace', { from: 'A', to: 'B' });
    expect(filtered.status).toBe('no_path');

    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], graph),
    );
    const included = await backend.callTool('trace', { from: 'A', to: 'B', includeTests: true });
    expect(included.status).toBe('ok');
    expect(included.hops.map((h: any) => h.name)).toEqual(['A', 'M', 'B']);
  });

  it('caps the per-level query with a LIMIT and does not truncate a normal trace', async () => {
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(result.status).toBe('ok');
    expect(result.truncated).toBeUndefined();
    const bfsQueries = ((executeParameterized as any).mock.calls as Array<[string, string, any]>)
      .map(([, cypher]) => cypher)
      .filter((c) => c.includes('r:CodeRelation'));
    expect(bfsQueries.length).toBeGreaterThan(0);
    expect(bfsQueries.every((c) => /LIMIT\s+\d+/.test(c))).toBe(true);
  });

  it('flags truncated when a frontier level hits the per-node row cap', async () => {
    // _traceImpl caps a single-node frontier at PER_NODE_FANOUT_CAP (200) rows;
    // returning exactly that many (none being the target) trips the cap.
    const ROW_CAP = 200;
    const hubRows = Array.from({ length: ROW_CAP }, (_, i) => ({
      sourceId: 'func:A',
      id: `func:N${i}`,
      name: `N${i}`,
      type: 'Function',
      filePath: 'src/n.ts',
      startLine: 1,
      edgeType: 'CALLS',
      confidence: 1.0,
    }));
    const SYMBOL_Z = {
      id: 'func:Z',
      name: 'Z',
      type: 'Function',
      filePath: 'src/z.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_Z], { 'func:A': hubRows }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'Z' });

    expect(result.status).toBe('no_path');
    expect(result.truncated).toBe(true);
  });

  it('returns status:error for a non-string from/to instead of a low-level TypeError', async () => {
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('trace', { from: 42 as any, to: 'realSymbol' });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/must be strings/);
  });

  it('returns status:error with a suggestion when the BFS query throws', async () => {
    (executeParameterized as any).mockImplementation((_db: string, _q: string, params: any) => {
      if (params.frontierIds) throw new Error('boom: graph exploded');
      if (params.symName === 'A') return [SYMBOL_A];
      if (params.symName === 'B') return [SYMBOL_B];
      return [];
    });

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(result.status).toBe('error');
    expect(result.error).toContain('boom');
    expect(result.suggestion).toBeDefined();
  });

  it('resolves from_uid/to_uid without name-based lookup', async () => {
    (executeParameterized as any).mockImplementation((_db: string, query: string, params: any) => {
      if (params.uid === 'uid:from')
        return [
          {
            id: 'uid:from',
            name: 'A',
            type: 'Function',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 10,
          },
        ];
      if (params.uid === 'uid:to')
        return [
          {
            id: 'uid:to',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            endLine: 5,
          },
        ];
      if (params.frontierIds?.includes('uid:from')) {
        return [
          {
            sourceId: 'uid:from',
            id: 'uid:to',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ];
      }
      return [];
    });

    const result = await backend.callTool('trace', { from_uid: 'uid:from', to_uid: 'uid:to' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(1);
    const calls = (executeParameterized as any).mock.calls as Array<
      [string, string, Record<string, unknown>]
    >;
    for (const [, cypher] of calls) {
      expect(cypher).not.toMatch(/WHERE n\.name = \$symName/);
    }
  });

  it('finds a shortest path that runs through the second node of a multi-node frontier', async () => {
    // A→B→E (dead end) and A→C→D (target). The path is only reachable via the
    // second frontier node (C); a mock that returned just the first frontier
    // node's neighbors would (wrongly) report no_path.
    const SYMBOL_D = {
      id: 'func:D',
      name: 'D',
      type: 'Function',
      filePath: 'src/d.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_D], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
          {
            sourceId: 'func:A',
            id: 'func:C',
            name: 'C',
            type: 'Function',
            filePath: 'src/c.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:B': [
          {
            sourceId: 'func:B',
            id: 'func:E',
            name: 'E',
            type: 'Function',
            filePath: 'src/e.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
        'func:C': [
          {
            sourceId: 'func:C',
            id: 'func:D',
            name: 'D',
            type: 'Function',
            filePath: 'src/d.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'D' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(2);
    expect(result.hops.map((h: any) => h.name)).toEqual(['A', 'C', 'D']);
  });

  it('falls back to the relation-type confidence when stored confidence is 0', async () => {
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_A], [SYMBOL_B], {
        'func:A': [
          {
            sourceId: 'func:A',
            id: 'func:B',
            name: 'B',
            type: 'Function',
            filePath: 'src/b.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(result.status).toBe('ok');
    expect(result.edges[0].confidence).toBe(0.9); // CALLS confidence floor
  });

  it('traverses HAS_METHOD edges and reports a mixed per-hop edge-type chain', async () => {
    const SYMBOL_CLASS = {
      id: 'class:K',
      name: 'K',
      type: 'Class',
      filePath: 'src/k.ts',
      startLine: 1,
      endLine: 20,
    };
    const SYMBOL_TGT = {
      id: 'func:T2',
      name: 'T2',
      type: 'Function',
      filePath: 'src/t2.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(
      makeResolveMock([SYMBOL_CLASS], [SYMBOL_TGT], {
        'class:K': [
          {
            sourceId: 'class:K',
            id: 'func:m',
            name: 'm',
            type: 'Method',
            filePath: 'src/k.ts',
            startLine: 5,
            edgeType: 'HAS_METHOD',
            confidence: 0.95,
          },
        ],
        'func:m': [
          {
            sourceId: 'func:m',
            id: 'func:T2',
            name: 'T2',
            type: 'Function',
            filePath: 'src/t2.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ],
      }),
    );

    const result = await backend.callTool('trace', { from: 'K', to: 'T2' });

    expect(result.status).toBe('ok');
    expect(result.hopCount).toBe(2);
    expect(result.edges.map((e: any) => e.relType)).toEqual(['HAS_METHOD', 'CALLS']);
    expect(result.hops.map((h: any) => h.name)).toEqual(['K', 'm', 'T2']);
  });

  it('returns no_path with furthest null when the source has no outgoing edges', async () => {
    const SYMBOL_X = {
      id: 'func:X',
      name: 'X',
      type: 'Function',
      filePath: 'src/x.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation(makeResolveMock([SYMBOL_A], [SYMBOL_X], {}));

    const result = await backend.callTool('trace', { from: 'A', to: 'X' });

    expect(result.status).toBe('no_path');
    expect(result.furthest).toBeNull();
  });

  it('uses from_file to disambiguate same-named symbols', async () => {
    const helperA = {
      id: 'func:helperA',
      name: 'helper',
      type: 'Function',
      filePath: 'src/a.ts',
      startLine: 1,
      endLine: 5,
    };
    const target = {
      id: 'func:target',
      name: 'target',
      type: 'Function',
      filePath: 'src/t.ts',
      startLine: 1,
      endLine: 5,
    };
    (executeParameterized as any).mockImplementation((_db: string, _q: string, params: any) => {
      if (params.symName === 'helper' && params.filePath === 'src/a.ts') return [helperA];
      if (params.symName === 'target') return [target];
      if (params.frontierIds?.includes('func:helperA')) {
        return [
          {
            sourceId: 'func:helperA',
            id: 'func:target',
            name: 'target',
            type: 'Function',
            filePath: 'src/t.ts',
            startLine: 1,
            edgeType: 'CALLS',
            confidence: 1.0,
          },
        ];
      }
      return [];
    });

    const result = await backend.callTool('trace', {
      from: 'helper',
      from_file: 'src/a.ts',
      to: 'target',
    });

    expect(result.status).toBe('ok');
    expect(result.from.filePath).toBe('src/a.ts');
    expect(result.hopCount).toBe(1);
  });
});
