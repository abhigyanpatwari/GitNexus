/** Regression for unusable database lookup identities (#3424). */
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

const SYMBOL = {
  id: 'Method:tests/test_supervisor.py:Supervisor.test_run',
  name: 'test_run',
  type: 'Method',
  filePath: 'tests/test_supervisor.py',
  startLine: 3,
  endLine: 5,
};

const badIds = [
  ['missing', undefined],
  ['null', null],
  ['number', 42],
  ['empty', ''],
  ['blank', ' \t '],
  ['NUL-only', '\0\0'],
  ['embedded NUL', 'Method:tests/test_supervisor.py:\0test_run'],
] as const;

function row(id: unknown, shape: string): unknown {
  return shape === 'tuple'
    ? [id, SYMBOL.name, SYMBOL.type, SYMBOL.filePath, SYMBOL.startLine, SYMBOL.endLine]
    : { ...SYMBOL, id };
}

const surfaces = [
  { tool: 'context', params: { name: SYMBOL.name, file_path: SYMBOL.filePath } },
  { tool: 'impact', params: { target: SYMBOL.name, direction: 'upstream' } },
  { tool: 'impact', params: { target: SYMBOL.name, direction: 'upstream', mode: 'pdg' } },
] as const;

describe('symbol lookup identity validation (#3424)', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    backend = new LocalBackend();
    await backend.init();
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  });

  function lookupRows(rows: unknown[]) {
    vi.mocked(executeParameterized).mockImplementation(async (_db, _query, params) => {
      return params?.symName || params?.uid ? rows : [];
    });
  }

  function expectNoExpansion() {
    const queries = vi.mocked(executeParameterized).mock.calls.map(([, query]) => query);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => !query.includes('CodeRelation'))).toBe(true);
    expect(queries.every((query) => !query.includes('UNION'))).toBe(true);
  }

  function expectIdentityError(result: any, tool: string) {
    expect(result.error).toMatch(/symbol identity/i);
    expect(result.recoverySuggestion).toMatch(/analyze.*--force/);
    expect(result.epistemic).not.toBe('exact');
    expect(result).not.toHaveProperty('symbol');
    expect(result).not.toHaveProperty('incoming');
    if (tool === 'impact') {
      expect(result.risk).toBe('UNKNOWN');
      expect(result.impactedCount).toBeNull();
      expect(result.target).not.toHaveProperty('id');
      expect(result.suggestion ?? '').not.toContain('context');
    }
    expectNoExpansion();
  }

  for (const surface of surfaces) {
    describe(`${surface.tool} ${'mode' in surface.params ? surface.params.mode : 'default'}`, () => {
      for (const shape of ['object', 'tuple']) {
        it.each(badIds)(`rejects %s IDs in ${shape} rows before traversal`, async (_label, id) => {
          lookupRows([row(id, shape)]);
          const result = await backend.callTool(surface.tool, surface.params);
          expectIdentityError(result, surface.tool);
        });
        it.each(badIds)(
          `rejects %s IDs from exact UID lookups in ${shape} rows`,
          async (_label, id) => {
            lookupRows([row(id, shape)]);
            const uidParam =
              surface.tool === 'context' ? { uid: SYMBOL.id } : { target_uid: SYMBOL.id };
            expectIdentityError(
              await backend.callTool(surface.tool, { ...surface.params, ...uidParam }),
              surface.tool,
            );
          },
        );
      }

      it('does not choose a healthy candidate beside a corrupt candidate', async () => {
        lookupRows([SYMBOL, { ...SYMBOL, id: '\0', type: '' }]);
        expectIdentityError(await backend.callTool(surface.tool, surface.params), surface.tool);
      });

      it('rejects a different identity returned for an exact UID', async () => {
        lookupRows([{ ...SYMBOL, id: 'Constructor:Services.swift:Service.init' }]);
        const uidParam =
          surface.tool === 'context' ? { uid: SYMBOL.id } : { target_uid: SYMBOL.id };
        expectIdentityError(
          await backend.callTool(surface.tool, { ...surface.params, ...uidParam }),
          surface.tool,
        );
      });

      it('keeps an empty lookup distinct from an invalid identity', async () => {
        lookupRows([]);
        const result = await backend.callTool(surface.tool, surface.params);
        expect(result.error).toMatch(/not found/);
        expect(result.recoverySuggestion).toBeUndefined();
      });
    });
  }

  it('validates every row before exact File narrowing', async () => {
    lookupRows([
      { ...SYMBOL, id: 'File:tests/test_supervisor.py', name: 'test_supervisor.py' },
      { ...SYMBOL, id: undefined },
    ]);
    expectIdentityError(await backend.callTool('context', { name: SYMBOL.filePath }), 'context');
  });

  for (const shape of ['object', 'tuple']) {
    it(`accepts an opaque legacy identity in a healthy ${shape} row`, async () => {
      lookupRows([row('func:alpha', shape)]);
      const result = await backend.callTool('context', { uid: 'func:alpha' });
      expect(result).not.toHaveProperty('error');
      expect(result.symbol.uid).toBe('func:alpha');
    });
  }

  it('preserves a valid ID byte-for-byte instead of trimming it', async () => {
    lookupRows([{ ...SYMBOL, id: 'func:alpha ' }]);
    const result = await backend.callTool('context', { name: SYMBOL.name });
    expect(result).not.toHaveProperty('error');
    expect(result.symbol.uid).toBe('func:alpha ');
  });

  describe('group impact UID adapter', () => {
    const opts = { maxDepth: 3, relationTypes: ['CALLS'], minConfidence: 0, includeTests: true };

    it.each(badIds)('rejects a %s persisted ID before BFS', async (_label, id) => {
      lookupRows([{ ...SYMBOL, id }]);
      const bfs = vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValue({ byDepth: {} });
      const repoId = [...(backend as any).repos.keys()][0];
      expect(await backend.impactByUid(repoId, SYMBOL.id, 'upstream', opts)).toBeNull();
      expect(bfs).not.toHaveBeenCalled();
    });

    it('rejects an otherwise valid mismatched UID', async () => {
      lookupRows([{ ...SYMBOL, id: 'route:other' }]);
      const bfs = vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValue({ byDepth: {} });
      const repoId = [...(backend as any).repos.keys()][0];
      expect(await backend.impactByUid(repoId, SYMBOL.id, 'upstream', opts)).toBeNull();
      expect(bfs).not.toHaveBeenCalled();
    });

    it('accepts a legitimate synthetic identity', async () => {
      lookupRows([{ ...SYMBOL, id: 'Route:svc:/health' }]);
      const bfs = vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValue({ byDepth: {} });
      const repoId = [...(backend as any).repos.keys()][0];
      expect(await backend.impactByUid(repoId, 'Route:svc:/health', 'upstream', opts)).toEqual({
        byDepth: {},
      });
      expect(bfs).toHaveBeenCalledOnce();
    });
  });
});
