/**
 * Unit Tests: LocalBackend callTool dispatch & lifecycle
 *
 * Tests the callTool dispatch logic, resolveRepo, init/disconnect,
 * error cases, and silent failure patterns — all with mocked LadybugDB.
 *
 * These are pure unit tests that mock the LadybugDB layer to test
 * the dispatch and error handling logic in isolation.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import fsPromises from 'fs/promises';
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
    // U2: expose loadMeta as a spy that delegates to the REAL implementation by
    // default (so branch-scope resolution, #2106, is unaffected). The
    // impact-mode block overrides it per-test to stamp a READY PDG layer, so the
    // U2 layer-presence probe falls THROUGH to the post-check surface (the
    // `_runImpactPDG` delegate / ambiguous fan-out) those tests assert. The
    // four-state degradation contract itself is covered in
    // test/integration/impact-pdg-degradation.test.ts.
    loadMeta: vi.fn(actual.loadMeta),
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

// #2175: lets the @group-forward path be exercised without real group.yaml infra.
// No existing test in this file uses an @repo, so this mock is inert for them.
const { resolveAtMemberMock } = vi.hoisted(() => ({ resolveAtMemberMock: vi.fn() }));
vi.mock('../../src/core/group/resolve-at-member.js', () => ({
  resolveAtGroupMemberRepoPath: resolveAtMemberMock,
}));

import {
  LocalBackend,
  REPO_ID_HASH_LENGTH,
  parseListReposPagination,
} from '../../src/mcp/local/local-backend.js';
import {
  betterBridgeEvidence,
  pdgBridgeEvidenceForImpact,
} from '../../src/mcp/local/pdg-impact.js';
import { CALLEES_TRUNCATED_SENTINEL } from '../../src/core/ingestion/cfg/emit.js';
import {
  listRegisteredRepos,
  cleanupOldKuzuFiles,
  getStoragePaths,
  loadMeta,
  type RegistryEntry,
} from '../../src/storage/repo-manager.js';
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

// Mirrors the legacy `repoId()` suffix that #2054 replaced for genuine
// collisions: base64url is an *encoding*, not a hash, so paths sharing a long
// prefix produce the same sliced suffix. Used by the #2054 tests to assert the
// collision precondition actually holds (so the regression isn't vacuous).
function legacyPathSuffix(p: string): string {
  return Buffer.from(p).toString('base64url').slice(0, REPO_ID_HASH_LENGTH).toLowerCase();
}

/**
 * Build N sibling clones of one remote under a SINGLE parent directory, named
 * REPO, REPO_2, …, REPO_N. All clones share the remote-inferred registry name
 * ("REPO") and the same remoteUrl — this is the real-world #2054 setup. Because
 * the clones live under one parent, their absolute paths share a long common
 * prefix, which is exactly what made the 6-char base64url suffix collide.
 * (mkdtemp'ing each clone separately would NOT reproduce the bug — the random
 * suffixes diverge in the first few bytes.)
 */
function makeSiblingClonesFixture(count: number, remoteUrl = 'git@github.com:MYCOMPANY/REPO.git') {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'gnx-2054-'));
  duplicateFixtureDirs.push(parent);
  const folders = Array.from({ length: count }, (_, i) => (i === 0 ? 'REPO' : `REPO_${i + 1}`));
  const dirs: string[] = [];
  const entries = folders.map((folder) => {
    const dir = path.join(parent, folder);
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(path.join(storagePath, 'lbug'), { recursive: true });
    writeFileSync(path.join(storagePath, 'meta.json'), '{}');
    dirs.push(dir);
    return { ...MOCK_REPO_ENTRY, name: 'REPO', path: dir, storagePath, remoteUrl };
  });
  return { parent, dirs, entries };
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
    // No-arg compatibility: callTool('list_repos', {}) returns the first page as
    // a { repositories, pagination } object (Strategy A — always paginated, #2119).
    const result = await backend.callTool('list_repos', {});
    expect(Array.isArray(result.repositories)).toBe(true);
    expect(result.repositories[0].name).toBe('test-project');
    expect(result.pagination).toEqual({
      total: 1,
      limit: 50,
      offset: 0,
      returned: 1,
      hasMore: false,
    });
  });

  it('throws for unknown tool name', async () => {
    await expect(backend.callTool('nonexistent_tool', {})).rejects.toThrow(
      'Unknown tool: nonexistent_tool',
    );
  });

  it.each(['name', 'symbol'] as const)(
    'normalizes impact.%s to target once before local dispatch',
    async (alias) => {
      const impactSpy = vi
        .spyOn(backend as any, 'impact')
        .mockResolvedValue({ status: 'normalized' });

      const result = await backend.callTool('impact', {
        [alias]: ' validate ',
        direction: 'upstream',
      });

      expect(result).toEqual({ status: 'normalized' });
      const dispatched = impactSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(dispatched.target).toBe('validate');
      expect(dispatched).not.toHaveProperty('name');
      expect(dispatched).not.toHaveProperty('symbol');
    },
  );

  it('normalizes context.file to file_path once before local dispatch', async () => {
    const contextSpy = vi
      .spyOn(backend as any, 'context')
      .mockResolvedValue({ status: 'normalized' });

    const result = await backend.callTool('context', {
      name: 'validate',
      file: ' src/auth.ts ',
    });

    expect(result).toEqual({ status: 'normalized' });
    const dispatched = contextSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(dispatched.file_path).toBe('src/auth.ts');
    expect(dispatched).not.toHaveProperty('file');
  });

  it('treats undefined optional alias keys from CLI callers as absent', async () => {
    const contextSpy = vi
      .spyOn(backend as any, 'context')
      .mockResolvedValue({ status: 'normalized' });

    const result = await backend.callTool('context', {
      name: 'validate',
      file_path: undefined,
      file: undefined,
    });

    expect(result).toEqual({ status: 'normalized' });
    expect(contextSpy.mock.calls[0][1]).toMatchObject({ name: 'validate' });
  });

  it('allows agreeing canonical and alias values after trimming', async () => {
    const impactSpy = vi
      .spyOn(backend as any, 'impact')
      .mockResolvedValue({ status: 'normalized' });

    await backend.callTool('impact', {
      target: 'validate',
      name: ' validate ',
      symbol: 'validate',
      direction: 'upstream',
    });

    expect(impactSpy.mock.calls[0][1]).toMatchObject({ target: 'validate' });
  });

  it.each([
    ['impact', { target: 'validate', name: 'login', direction: 'upstream' }],
    ['impact', { name: 'validate', symbol: 'login', direction: 'upstream' }],
    ['context', { name: 'validate', file_path: 'src/auth.ts', file: 'src/login.ts' }],
  ])('rejects conflicting %s aliases before repository resolution', async (method, params) => {
    const resolveSpy = vi.spyOn(backend, 'resolveRepo');

    const result = await backend.callTool(method, params);

    expect(result.error).toMatch(/conflicting mcp parameters/i);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['impact', { target: '', direction: 'upstream' }],
    ['impact', { name: 42, direction: 'upstream' }],
    ['context', { name: 'validate', file: '   ' }],
    ['context', { name: 'validate', file: null }],
  ])('rejects invalid %s aliases before repository resolution', async (method, params) => {
    const resolveSpy = vi.spyOn(backend, 'resolveRepo');

    const result = await backend.callTool(method, params);

    expect(result.error).toMatch(/non-empty string/i);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('rejects a missing impact target before repository resolution', async () => {
    const resolveSpy = vi.spyOn(backend, 'resolveRepo');

    const result = await backend.callTool('impact', { direction: 'upstream' });

    expect(result.error).toMatch(/requires target, name, symbol, or target_uid/i);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('preserves target_uid-only impact dispatch', async () => {
    const impactSpy = vi
      .spyOn(backend as any, 'impact')
      .mockResolvedValue({ status: 'normalized' });

    await backend.callTool('impact', {
      target_uid: 'Function:src/auth.ts:validate',
      direction: 'upstream',
    });

    expect(impactSpy.mock.calls[0][1]).toMatchObject({
      target_uid: 'Function:src/auth.ts:validate',
    });
  });

  it('normalizes impact aliases before @group forwarding', async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const groupImpactSpy = vi
      .spyOn(backend.getGroupService(), 'groupImpact')
      .mockResolvedValue({ status: 'normalized' } as any);

    await backend.callTool('impact', {
      symbol: 'validate',
      direction: 'upstream',
      repo: '@grp',
    });

    expect(groupImpactSpy.mock.calls[0][0]).toMatchObject({ target: 'validate' });
  });

  it('dispatches query tool', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { query: 'auth' });
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
  });

  it('checks cycles using only non-synthetic import edges', async () => {
    (executeParameterized as any).mockResolvedValue([
      { source: 'src/a.ts', target: 'src/b.ts' },
      { source: 'src/b.ts', target: 'src/a.ts' },
    ]);

    const result = await backend.callTool('check', { cycles: true });

    expect(result).toEqual({
      status: 'cycles_found',
      cycleCount: 1,
      cycles: [{ files: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }],
    });
    const query = (executeParameterized as any).mock.calls.at(-1)[1] as string;
    expect(query).toContain("r.reason <> 'swift-scope: implicit module visibility'");
    expect(query).toContain("r.reason <> 'markdown-link'");
    expect(query).toContain('LIMIT 100001');
  });

  it('uses the advertised cycles default when check arguments are omitted', async () => {
    (executeParameterized as any).mockResolvedValue([]);

    await expect(backend.callTool('check', undefined)).resolves.toEqual({
      status: 'clean',
      cycleCount: 0,
      cycles: [],
    });
  });

  it('fails closed when the import-edge safety limit is reached', async () => {
    (executeParameterized as any).mockResolvedValue({ length: 100_001 });

    await expect(backend.callTool('check', { cycles: true })).resolves.toEqual({
      error: 'Import graph exceeds the 100000 edge safety limit.',
      truncated: true,
    });
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

    const cap = _captureLogger();
    try {
      const result = await backend.callTool('query', { query: 'auth' });

      // Should still return a valid result shape (semantic-only fallback)
      expect(result).toHaveProperty('processes');
      expect(result).toHaveProperty('definitions');
      expect(result).not.toHaveProperty('error');
      // The FTS fallback is a gracefully-degraded result, not an operation failure:
      // it must log at warn (40), never error (50), matching its sibling
      // import-failure fallback. Pins the severity against regression.
      const fts = cap.records().find((r) => /BM25\/FTS search failed/.test(String(r.msg ?? '')));
      expect(fts).toBeDefined();
      expect(fts?.level).toBe(40);
    } finally {
      cap.restore();
    }
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
    // The configured threshold must reach the WHERE clause (MCP default 0.6), guarding
    // against a regression that drops the filter or re-hardcodes a different value.
    expect(queries.some((cypher: string) => cypher.includes('distance < 0.6'))).toBe(true);
  });

  it('threads GITNEXUS_VECTOR_MAX_DISTANCE into the vector index WHERE clause', async () => {
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    vi.mocked(executeQuery).mockImplementation(async (_repoId: string, cypher: string) => {
      if (cypher.includes('COUNT(*) AS cnt')) return [{ cnt: 1 }];
      return [];
    });
    vi.mocked(executeParameterized).mockResolvedValue([]);

    const previous = process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
    process.env.GITNEXUS_VECTOR_MAX_DISTANCE = '0.42';
    try {
      await backend.callTool('query', { query: 'auth' });
      const queries = vi
        .mocked(executeQuery)
        .mock.calls.map(([, cypher]: [string, string]) => cypher);
      expect(queries.some((cypher: string) => cypher.includes('distance < 0.42'))).toBe(true);
      expect(queries.some((cypher: string) => cypher.includes('distance < 0.6'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_VECTOR_MAX_DISTANCE;
      else process.env.GITNEXUS_VECTOR_MAX_DISTANCE = previous;
    }
  });

  it('query tool returns error for empty query', async () => {
    const result = await backend.callTool('query', { query: '' });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('query tool returns error for whitespace-only query', async () => {
    const result = await backend.callTool('query', { query: '   ' });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
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

  // ── #2175: backward-compatible parameter-alias dispatch ──────────────────
  // Claude Code drops a tool-call argument named exactly "query", so the query
  // and cypher tools advertise search_query / statement. The handlers must accept
  // the new names AND keep accepting the legacy "query" key (verified by the
  // existing tests above, which still pass { query: ... }).

  it('query tool accepts the new search_query parameter (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('query', { search_query: 'auth' });
    expect(result).toHaveProperty('processes');
    expect(result).toHaveProperty('definitions');
    expect(result).not.toHaveProperty('error');
  });

  it('query tool prefers search_query over the legacy query when both are given (#2175)', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    (executeParameterized as any).mockResolvedValue([]);

    await backend.callTool('query', { search_query: 'newName', query: 'oldName' });

    // bm25Search passes the resolved search text as arg 0 to searchFTSFromLbug.
    const lastTerm = String(vi.mocked(searchFTSFromLbug).mock.calls.at(-1)?.[0] ?? '');
    expect(lastTerm).toBe('newName');
  });

  it('query tool returns error when neither search_query nor query is provided (#2175)', async () => {
    const result = await backend.callTool('query', {});
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('cypher tool accepts the new statement parameter (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([{ name: 'test', filePath: 'src/test.ts' }]);
    const result = await backend.callTool('cypher', {
      statement: 'MATCH (n:Function) RETURN n.name AS name, n.filePath AS filePath LIMIT 5',
    });
    expect(result).toHaveProperty('markdown');
    expect(result).toHaveProperty('row_count');
    expect(result.row_count).toBe(1);
  });

  it('cypher tool prefers statement over the legacy query when both are given (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('cypher', {
      statement: 'MATCH (a) RETURN a',
      query: 'MATCH (b) RETURN b',
    });
    const passedCypher = (executeParameterized as any).mock.calls.at(-1)[1] as string;
    expect(passedCypher).toBe('MATCH (a) RETURN a');
  });

  it('executeCypher (internal API) still works via the legacy query field (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([{ name: 'x' }]);
    const result = await backend.executeCypher('test-project', 'MATCH (n) RETURN n LIMIT 1');
    expect(result).not.toHaveProperty('error');
    const passedCypher = (executeParameterized as any).mock.calls.at(-1)[1] as string;
    expect(passedCypher).toBe('MATCH (n) RETURN n LIMIT 1');
  });

  it('query tool returns error for empty search_query (new key) (#2175)', async () => {
    const result = await backend.callTool('query', { search_query: '' });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('query tool returns error for whitespace-only search_query (new key) (#2175)', async () => {
    const result = await backend.callTool('query', { search_query: '   ' });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('search legacy alias accepts the new search_query parameter (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('search', { search_query: 'auth' });
    expect(result).toHaveProperty('processes');
    expect(result).not.toHaveProperty('error');
  });

  it('cypher tool returns a friendly required error when neither statement nor query is given (#2175)', async () => {
    const result = await backend.callTool('cypher', {});
    expect(result.error).toContain('statement');
    expect(result.error).toContain('parameter is required');
  });

  // #2175 review: the @group-forward path reads `query` from the forwarded args, so it
  // must resolve the search_query alias itself (new name wins, mirroring query()).
  it('group-mode query forwards the resolved search_query alias (#2175)', async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const groupQuerySpy = vi
      .spyOn(backend.getGroupService(), 'groupQuery')
      .mockResolvedValue({ ok: true } as any);

    await backend.callTool('query', {
      search_query: 'alias-wins',
      query: 'legacy-loses',
      repo: '@grp',
    });

    expect(groupQuerySpy).toHaveBeenCalledTimes(1);
    expect((groupQuerySpy.mock.calls[0][0] as any).query).toBe('alias-wins');
    groupQuerySpy.mockRestore();
  });

  it('group-mode query still forwards a legacy-only query (#2175)', async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const groupQuerySpy = vi
      .spyOn(backend.getGroupService(), 'groupQuery')
      .mockResolvedValue({ ok: true } as any);

    await backend.callTool('query', { query: 'legacy', repo: '@grp' });

    expect((groupQuerySpy.mock.calls[0][0] as any).query).toBe('legacy');
    groupQuerySpy.mockRestore();
  });

  // U3: `trace` with an @group repo routes to the cross-repo groupTrace path
  // and forwards the trace params (incl. the experimental pdg/crossDepth flags).
  it('group-mode trace routes to groupTrace and forwards trace params', async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const groupTraceSpy = vi
      .spyOn(backend.getGroupService(), 'groupTrace')
      .mockResolvedValue({ status: 'ok' });

    await backend.callTool('trace', {
      from: 'A',
      to: 'B',
      pdg: true,
      crossDepth: 3,
      repo: '@grp',
    });

    expect(groupTraceSpy).toHaveBeenCalledTimes(1);
    const args = groupTraceSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({ name: 'grp', from: 'A', to: 'B', pdg: true, crossDepth: 3 });
    groupTraceSpy.mockRestore();
  });

  // U3: a non-@group trace must NOT route to groupTrace — single-repo behavior
  // is untouched (here it resolves to not_found against the empty mocked graph).
  it('single-repo trace does not route to groupTrace', async () => {
    const groupTraceSpy = vi.spyOn(backend.getGroupService(), 'groupTrace');
    vi.mocked(executeParameterized).mockResolvedValue([]);

    const result = await backend.callTool('trace', { from: 'A', to: 'B' });

    expect(groupTraceSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'not_found' });
    groupTraceSpy.mockRestore();
  });

  // The destination trace (omit `to`) is a cross-repo @group feature; a single-repo
  // trace without `to` must error clearly, not return an opaque "symbol not found".
  it('single-repo trace without `to` returns an actionable error', async () => {
    const result = await backend.callTool('trace', { from: 'A' });
    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('requires `to`'),
    });
  });

  // #2175 review: the MCP envelope is not schema-validated, so a client can send a
  // non-string value for a string param. Resolve it to a friendly required-param error
  // rather than throwing TypeError on `.trim()` (query() and cypher() both).
  it('query tool returns a friendly error (no throw) for a non-string search_query (#2175)', async () => {
    const result = await backend.callTool('query', { search_query: 123 as any });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('cypher tool returns a friendly error (no throw) for a non-string statement (#2175)', async () => {
    const result = await backend.callTool('cypher', { statement: 123 as any });
    expect(result.error).toContain('statement');
    expect(result.error).toContain('parameter is required');
  });

  // #2175 review (PR #2186): resolution prefers the first NON-BLANK string, so a blank
  // new-name value falls back to a valid legacy value instead of clobbering it.
  it('query tool: a blank new search_query falls back to a valid legacy query (#2175)', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', { search_query: '', query: 'real' });

    expect(result).not.toHaveProperty('error');
    expect(result).toHaveProperty('processes');
    const lastTerm = String(vi.mocked(searchFTSFromLbug).mock.calls.at(-1)?.[0] ?? '');
    expect(lastTerm).toBe('real');
  });

  it('query tool: a whitespace-only new search_query falls back to a valid legacy query (#2175)', async () => {
    const { searchFTSFromLbug } = await import('../../src/core/search/bm25-index.js');
    (executeParameterized as any).mockResolvedValue([]);

    const result = await backend.callTool('query', { search_query: '   ', query: 'real' });

    expect(result).not.toHaveProperty('error');
    const lastTerm = String(vi.mocked(searchFTSFromLbug).mock.calls.at(-1)?.[0] ?? '');
    expect(lastTerm).toBe('real');
  });

  it('query tool: both keys blank still returns the required error (#2175)', async () => {
    const result = await backend.callTool('query', { search_query: '', query: '   ' });
    expect(result.error).toContain('search_query');
    expect(result.error).toContain('parameter is required');
  });

  it('cypher tool: a blank statement falls back to a valid legacy query (#2175)', async () => {
    (executeParameterized as any).mockResolvedValue([]);
    await backend.callTool('cypher', { statement: '', query: 'MATCH (n) RETURN n LIMIT 1' });
    const passedCypher = (executeParameterized as any).mock.calls.at(-1)[1] as string;
    expect(passedCypher).toBe('MATCH (n) RETURN n LIMIT 1');
  });

  it('group-mode query: a blank new search_query falls back to the legacy query (#2175)', async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const groupQuerySpy = vi
      .spyOn(backend.getGroupService(), 'groupQuery')
      .mockResolvedValue({ ok: true } as any);

    await backend.callTool('query', { search_query: '', query: 'real', repo: '@grp' });

    expect((groupQuerySpy.mock.calls[0][0] as any).query).toBe('real');
    groupQuerySpy.mockRestore();
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
    (executeParameterized as any).mockImplementation((_repoId: string, cypher: string) => {
      // BFS frontier query is now parameterized (#1907 U3).
      if (cypher.includes('r.type IN') && !cypher.includes('STEP_IN_PROCESS')) {
        return Promise.resolve([
          {
            id: 'func:caller',
            name: 'caller',
            type: 'Function',
            filePath: 'src/uses-main.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ]);
      }
      // Symbol resolution.
      return Promise.resolve([
        { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      ]);
    });
    (executeQuery as any).mockResolvedValue([]);

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
      // BFS frontier query is now parameterized (#1907 U3).
      if (cypher.includes('r.type IN') && !cypher.includes('STEP_IN_PROCESS')) {
        return Promise.resolve([
          {
            id: 'func:caller',
            name: 'caller',
            type: 'Function',
            filePath: 'src/uses-main.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ]);
      }
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
      // BFS frontier query is now parameterized (#1907 U3) — return a caller so
      // the per-symbol-skip assertion below is meaningful (not vacuous).
      if (cypher.includes('r.type IN') && !cypher.includes('STEP_IN_PROCESS')) {
        return Promise.resolve([
          {
            id: 'func:caller',
            name: 'caller',
            type: 'Function',
            filePath: 'src/a.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ]);
      }
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
      // BFS frontier query is now parameterized (#1907 U3).
      if (cypher.includes('r.type IN') && !cypher.includes('STEP_IN_PROCESS')) {
        return Promise.resolve([
          {
            id: 'func:caller',
            name: 'caller',
            type: 'Function',
            filePath: 'src/uses-main.ts',
            relType: 'CALLS',
            confidence: 0.9,
          },
        ]);
      }
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

  it('rename: a swallowed apply-edit write failure degrades to status:partial + failed_files (#2283)', async () => {
    // Resolve the definition, no graph refs. readFile succeeds (so a def edit is
    // recorded), but writeFile fails on apply — the failure is swallowed via
    // logQueryError. The result must NOT report a clean success: it degrades to
    // 'partial' and lists the unwritten file, instead of status:'success'.
    (executeParameterized as any)
      .mockResolvedValueOnce([
        {
          id: 'func:oldName',
          name: 'oldName',
          type: 'Function',
          filePath: 'src/target.ts',
          startLine: 1,
          endLine: 5,
        },
      ])
      .mockResolvedValue([]);
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'gnx-rename-'));
    (listRegisteredRepos as any).mockResolvedValue([
      { ...MOCK_REPO_ENTRY, path: repoDir, storagePath: path.join(repoDir, '.gitnexus') },
    ]);
    backend = new LocalBackend();
    await backend.init();

    // The symbol is stored at 0-based startLine 1; context() presents it 1-based
    // (line 2) and rename subtracts 1 to recover the 0-based file index (1), so
    // `oldName` must sit on the file's 0-based line 1 for the definition edit to
    // fire. (#2380: the mock previously put it on line 0, which stopped matching
    // once context() went 1-based.)
    const readSpy = vi
      .spyOn(fsPromises, 'readFile')
      .mockResolvedValue('\nfunction oldName() {}\n' as unknown as Buffer);
    const writeSpy = vi
      .spyOn(fsPromises, 'writeFile')
      .mockRejectedValue(new Error('EACCES: permission denied'));
    try {
      const result = await backend.callTool('rename', {
        symbol_name: 'oldName',
        new_name: 'newName',
        dry_run: false,
      });
      expect(result.status).toBe('partial');
      expect(result.failed_files).toContain('src/target.ts');
      // It DID attempt to apply (not a dry run) — `applied` stays true; the
      // honest signal is the 'partial' status + failed_files, not `applied`.
      expect(result.applied).toBe(true);
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
      rmSync(repoDir, { recursive: true, force: true });
    }
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

  // ── #2308: same-URL multi-verb route contract ──
  // After #2302 a same URL exposes one Route node per HTTP verb. A bare-URL (or
  // bare-file) api_impact lookup therefore returns the wrapped { routes, total }
  // form; passing `method` collapses it back to the singular shape.
  const verbRow = (
    method: string | null,
    routeName: string,
    handlerFile: string,
    middleware: string[] | null = null,
  ) => ({
    routeId: `Route:${method ? `${method} ` : ''}${routeName}`,
    routeName,
    method,
    handlerFile,
    responseKeys: null,
    errorKeys: null,
    middleware,
    consumerName: null,
    consumerFile: null,
    fetchReason: null,
  });
  const ordersVerbRows = [
    verbRow('GET', '/api/orders', 'api/orders.ts'),
    verbRow('POST', '/api/orders', 'api/orders.ts'),
  ];

  it('api_impact returns the wrapped form for same-URL multi-verb routes, each with its method', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders' });
    expect(result.total).toBe(2);
    expect(result.routes).toHaveLength(2);
    expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
      'GET',
      'POST',
    ]);
    expect(result.routes).toMatchObject([{ route: '/api/orders' }, { route: '/api/orders' }]);
  });

  it('api_impact narrows a multi-verb URL to one route when method is given', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'POST' });
    expect(result.method).toBe('POST');
    expect(result.route).toBe('/api/orders');
    expect(result.routes).toBeUndefined();
    expect(result.total).toBeUndefined();
  });

  it('api_impact matches the method selector case-insensitively', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'post' });
    expect(result.method).toBe('POST');
    expect(result.routes).toBeUndefined();
  });

  it('api_impact returns a verb-not-found error when method matches no route at the URL', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'delete' });
    expect(result.error).toContain('/api/orders');
    expect(result.error).toContain('DELETE');
    expect(result.routes).toBeUndefined();
  });

  it('api_impact omits the verb clause when the URL itself does not exist', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([]);
    const result = await backend.callTool('api_impact', {
      route: '/does/not/exist',
      method: 'GET',
    });
    expect(result.error).toContain('/does/not/exist');
    expect(result.error).not.toContain('with method');
  });

  // #2308: the shared `method` field also surfaces on route_map and shape_check
  // (same fetchRoutesWithConsumers query), so both are documented + covered here.
  it('route_map surfaces each route method', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow('GET', '/api/orders', 'api/orders.ts'),
      verbRow('POST', '/api/orders', 'api/orders.ts'),
    ]);
    const result = await backend.callTool('route_map', { route: '/api/orders' });
    expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
      'GET',
      'POST',
    ]);
  });

  it('route_map surfaces a null method for verbless routes', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow(null, '/blog/[slug]', 'app/blog/[slug]/route.ts'),
    ]);
    const result = await backend.callTool('route_map', { route: '/blog/[slug]' });
    expect(result.routes[0].method).toBeNull();
  });

  it('shape_check surfaces each route method', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      {
        ...verbRow('GET', '/api/orders', 'api/orders.ts'),
        responseKeys: ['data', 'total'],
        consumerName: 'OrdersList',
        consumerFile: 'src/OrdersList.tsx',
        fetchReason: 'fetch-url-match|keys:data',
      },
    ]);
    const result = await backend.callTool('shape_check', { route: '/api/orders' });
    expect(result.routes[0].method).toBe('GET');
  });

  // The partial-middleware warning is driven by a per-handler verb count taken
  // from the UNFILTERED match, so a method-scoped query on a multi-verb handler
  // still flags partial middleware. Counting the filtered set would drop it.
  it('api_impact keeps middlewareDetection partial under a method filter', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow('GET', '/api/orders', 'api/orders.ts', ['withAuth']),
      verbRow('POST', '/api/orders', 'api/orders.ts', ['withAuth']),
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'GET' });
    expect(result.method).toBe('GET');
    expect(result.middlewareDetection).toBe('partial');
    expect(result.middlewareNote).toContain('route exports');
  });

  it('api_impact returns the wrapped form for a same-handler multi-verb file lookup', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow('GET', '/api/orders', 'app/api/orders/route.ts'),
      verbRow('POST', '/api/orders', 'app/api/orders/route.ts'),
    ]);
    const result = await backend.callTool('api_impact', { file: 'app/api/orders/route.ts' });
    expect(result.total).toBe(2);
    expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
      'GET',
      'POST',
    ]);
  });

  it('api_impact surfaces a null method for method-less (verbless) routes', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow(null, '/blog/[slug]', 'app/blog/[slug]/route.ts'),
    ]);
    const result = await backend.callTool('api_impact', { route: '/blog/[slug]' });
    expect(result.method).toBeNull();
    expect(result.route).toBe('/blog/[slug]');
    expect(result.routes).toBeUndefined();
  });

  it('api_impact narrows a multi-verb file lookup to one route when method is given', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow('GET', '/api/orders', 'app/api/orders/route.ts'),
      verbRow('POST', '/api/orders', 'app/api/orders/route.ts'),
    ]);
    const result = await backend.callTool('api_impact', {
      file: 'app/api/orders/route.ts',
      method: 'POST',
    });
    expect(result.method).toBe('POST');
    expect(result.route).toBe('/api/orders');
    expect(result.routes).toBeUndefined();
  });

  it('api_impact excludes verbless routes from a method selector', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow(null, '/api/orders', 'api/orders.ts'),
      verbRow('GET', '/api/orders', 'api/orders.ts'),
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'GET' });
    expect(result.method).toBe('GET');
    expect(result.route).toBe('/api/orders');
    expect(result.routes).toBeUndefined();
  });

  // A method-agnostic route persists with method '*' (Django function views) and
  // handles every verb — unlike a verbless (null) route, a method selector MUST
  // match it, or api_impact reports a false "no routes" for a live handler.
  it('api_impact matches a wildcard (*) route against a specific method selector', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([verbRow('*', '/django/view', 'views.py')]);
    const result = await backend.callTool('api_impact', { route: '/django/view', method: 'POST' });
    expect(result.method).toBe('*');
    expect(result.route).toBe('/django/view');
    expect(result.error).toBeUndefined();
    expect(result.routes).toBeUndefined();
  });

  it('api_impact matches a wildcard (*) route case-insensitively for any verb', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([verbRow('*', '/django/view', 'views.py')]);
    const result = await backend.callTool('api_impact', { route: '/django/view', method: 'get' });
    expect(result.method).toBe('*');
    expect(result.error).toBeUndefined();
    expect(result.routes).toBeUndefined();
  });

  it('api_impact includes a wildcard (*) route alongside a concrete verb under a selector', async () => {
    vi.mocked(executeParameterized).mockResolvedValue([
      verbRow('*', '/api/orders', 'api/orders.ts'),
      verbRow('GET', '/api/orders', 'api/orders.ts'),
    ]);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 'GET' });
    expect(result.total).toBe(2);
    expect(result.routes.map((r: { method: string | null }) => r.method).sort()).toEqual([
      '*',
      'GET',
    ]);
  });

  // The `method` param is not schema-validated at the transport, so api_impact
  // must reject a non-string verb with a structured error (not a thrown
  // TypeError) and treat empty/whitespace as no selector.
  it('api_impact returns a structured error for a non-string method', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: 5 });
    expect(result.error).toContain('method');
    expect(result.error).toContain('string');
    expect(result.routes).toBeUndefined();
  });

  it('api_impact treats an empty-string method as no selector', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: '' });
    expect(result.total).toBe(2);
    expect(result.error).toBeUndefined();
  });

  it('api_impact treats a whitespace-only method as no selector', async () => {
    vi.mocked(executeParameterized).mockResolvedValue(ordersVerbRows);
    const result = await backend.callTool('api_impact', { route: '/api/orders', method: '  ' });
    expect(result.total).toBe(2);
    expect(result.error).toBeUndefined();
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

// ─── impact mode param (KTD1/KTD5/KTD12 — U1) ───────────────────────
//
// The MCP JSON-schema enum is advisory only (server forwards args
// unvalidated, callTool is reachable directly), so the backend `mode`
// validation is load-bearing. These tests pin: callgraph is the unchanged
// default, pdg routes to the extracted traversal plus interprocedural symbol
// reach, invalid modes hard-error, and the remaining incompatible params /
// @group targets are rejected.

describe('LocalBackend impact mode (KTD1/KTD5/KTD12)', () => {
  let backend: LocalBackend;

  // Resolve the target to a single Function so impact reaches the single-branch
  // dispatch (callgraph BFS or the PDG traversal). The callgraph BFS then issues
  // executeQuery for its frontier; the PDG path delegates to runImpactPDG.
  function resolveSingleTarget() {
    (executeParameterized as any).mockResolvedValue([
      { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
    ]);
    (executeQuery as any).mockResolvedValue([]);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    // U2: stamp a READY PDG layer (both caps) so the layer-presence probe in
    // `_impactImpl` falls THROUGH to the mode-dispatch surface these tests pin
    // (the `_runImpactPDG` delegate / the ambiguous fan-out under `mode:'pdg'`).
    // Degraded-layer behavior is owned by the integration degradation suite.
    vi.mocked(loadMeta).mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as any);
    backend = new LocalBackend();
    setupSingleRepo();
    await backend.init();
  });

  it('mode absent → callgraph result (target populated, no mode-error, BFS runs)', async () => {
    resolveSingleTarget();
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const result = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    // A clean callgraph result carries no mode error and runs the BFS.
    expect(result.error ?? '').not.toMatch(/Invalid "mode"/);
    expect(result.error ?? '').not.toMatch(/not yet implemented/);
    expect(result.target).toBeDefined();
    expect(bfsSpy).toHaveBeenCalledTimes(1);
  });

  it("mode:'callgraph' and mode:undefined are byte-identical to absent (regression guard)", async () => {
    resolveSingleTarget();
    const absent = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    const callgraph = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'callgraph',
    });
    const undef = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: undefined,
    });
    expect(callgraph).toEqual(absent);
    expect(undef).toEqual(absent);
  });

  it("mode:'pdg' routes to the PDG traversal and attaches interprocedural symbol reach", async () => {
    resolveSingleTarget();
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'pdg',
    });
    // The call reaches the real `_runImpactPDG` traversal, then composes the
    // interprocedural symbol reach into the same pdg result.
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(Array.isArray(result.reachableBlocks)).toBe(true);
    expect(result.pdgInterprocedural).toBeDefined();
    expect(bfsSpy).toHaveBeenCalledTimes(1);
  });

  it("mode:'pdg' labels interprocedural symbols as a callgraph bridge", async () => {
    resolveSingleTarget();
    vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValueOnce({
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      impactedCount: 1,
      risk: 'LOW',
      summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
      byDepthCounts: { 1: 1 },
      affected_processes: [],
      affected_modules: [],
      byDepth: {
        1: [
          {
            depth: 1,
            id: 'func:callee',
            name: 'callee',
            type: 'Function',
            filePath: 'src/callee.ts',
          },
        ],
      },
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
    });

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(result.pdgInterprocedural.evidence).toBe('callgraph-bridge');
    expect(result.pdgInterprocedural.evidenceCounts['callgraph-bridge']).toBe(1);
    expect(result.pdgEvidence.interprocedural).toBe('callgraph-bridge');
    expect(result.interproceduralByDepth[1][0].pdgEvidence).toBe('callgraph-bridge');
    expect(result.note).toContain('labeled as a PDG evidence bridge');
  });

  it("mode:'pdg' preserves unproven bridge evidence when call-site proof is unavailable", async () => {
    resolveSingleTarget();
    vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValueOnce({
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      impactedCount: 1,
      risk: 'LOW',
      summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
      byDepthCounts: { 1: 1 },
      affected_processes: [],
      affected_modules: [],
      byDepth: {
        1: [
          {
            depth: 1,
            id: 'func:callee',
            name: 'callee',
            type: 'Function',
            filePath: 'src/callee.ts',
            pdgEvidence: 'unproven-bridge',
          },
        ],
      },
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
    });

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(result.pdgInterprocedural.evidence).toBe('unproven-bridge');
    expect(result.pdgInterprocedural.evidenceCounts['unproven-bridge']).toBe(1);
    expect(result.pdgEvidence.interprocedural).toBe('unproven-bridge');
    expect(result.note).toContain('labeled unproven-bridge');
  });

  it.each([['PDG'], ['pgd'], [''], [0], [null]])(
    'invalid mode %j → structured {error}, never a callgraph result (KTD5 anti-silent-fallback)',
    async (bad) => {
      resolveSingleTarget();
      const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'upstream',
        mode: bad as any,
      });
      expect(result.error).toMatch(/Invalid "mode"/);
      expect(result.risk).toBe('UNKNOWN');
      // A typo'd mode must NEVER quietly run callgraph.
      expect(bfsSpy).not.toHaveBeenCalled();
    },
  );

  it.each([['callgraph'], [undefined]])(
    'line param with mode:%j → structured {error} (line is PDG-only), never a callgraph result',
    async (mode) => {
      resolveSingleTarget();
      const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'upstream',
        mode: mode as any,
        line: 8,
      });
      expect(result.error).toMatch(/'line' is only supported with mode:'pdg'/);
      expect(result.risk).toBe('UNKNOWN');
      // A PDG-only param on the callgraph path must NOT silently run the BFS.
      expect(bfsSpy).not.toHaveBeenCalled();
    },
  );

  // #2279: some MCP client/agent adapters serialize an *omitted* optional
  // numeric field as `0`. On the callgraph path `line` is meaningless, so a
  // literal `line: 0` must be tolerated as omitted (NOT the PDG-only error) and
  // route to the normal BFS — distinct from a genuine positive `line` (above),
  // which stays a hard error.
  it.each<['callgraph' | undefined]>([['callgraph'], [undefined]])(
    'mode:%j + adapter-materialized line:0 is treated as omitted and runs the BFS (#2279)',
    async (mode) => {
      resolveSingleTarget();
      const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'upstream',
        mode,
        line: 0,
      });
      // No PDG-only error, no positive-integer error — line:0 is swallowed.
      expect(result.error ?? '').not.toMatch(/'line' is only supported with mode:'pdg'/);
      expect(result.error ?? '').not.toMatch(/'line' must be a positive integer/);
      expect(result.target).toBeDefined();
      expect(bfsSpy).toHaveBeenCalledTimes(1);
    },
  );

  it.each<['callgraph' | undefined]>([['callgraph'], [undefined]])(
    'mode:%j + line:-1 still errors — the line:0 coercion is narrow, only literal 0 (#2279)',
    async (mode) => {
      resolveSingleTarget();
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'upstream',
        mode,
        line: -1,
      });
      // A negative line is a real mistake, not an adapter-materialized "omitted":
      // it must NOT be swallowed like line:0, and stays the PDG-only hard error.
      expect(result.error).toMatch(/'line' is only supported with mode:'pdg'/);
    },
  );

  it("mode:'callgraph'/undefined + line:0 is byte-identical to omitting line (#2279)", async () => {
    resolveSingleTarget();
    const omitted = await backend.callTool('impact', { target: 'main', direction: 'upstream' });
    const callgraphZero = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'callgraph',
      line: 0,
    });
    const undefZero = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: undefined,
      line: 0,
    });
    // The normalization must leave the callgraph result indistinguishable from a
    // call that never carried `line` — the spurious 0 must not leak into output.
    expect(callgraphZero).toEqual(omitted);
    expect(undefZero).toEqual(omitted);
  });

  it.each([[0], [-1], [1.5]])(
    "mode:'pdg' + non-positive-integer line %j → structured {error}, never routed to traversal",
    async (badLine) => {
      resolveSingleTarget();
      const pdgSpy = vi.spyOn(backend as any, '_runImpactPDG');
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'upstream',
        mode: 'pdg',
        line: badLine as any,
      });
      expect(result.error).toMatch(/'line' must be a positive integer/);
      expect(result.risk).toBe('UNKNOWN');
      // The validation fires BEFORE the traversal — a bad line never seeds a slice.
      expect(pdgSpy).not.toHaveBeenCalled();
    },
  );

  it("mode:'pdg' + downstream line:8 routes to the PDG traversal and seeds bridge evidence", async () => {
    resolveSingleTarget();
    // The target-resolution row doubles as the calleesOfBlocks row: `callees`
    // ('callee') is the leaf name persisted on the slice's BasicBlock, the
    // statement-precise substrate the bridge keys on.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        callees: 'callee',
      },
    ]);
    // A line-seeded downstream slice with one reachable block → the dispatch
    // queries that block's callees and seeds the bridge with them.
    const pdgSpy = vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValueOnce({
      mode: 'pdg',
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      risk: 'UNKNOWN',
      impactedCount: 0,
      epistemic: 'pdg-intra-procedural',
      reachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      // Intra-only slice (no inter-procedural hop) ⇒ the intra reach the bridge
      // keys on equals reachableBlocks (FIX 6: bridge keys on intraReachableBlocks).
      intraReachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      blockCount: 1,
      affectedStatements: [{ line: 8, filePath: 'src/index.ts', text: 'callee()' }],
      affectedStatementCount: 1,
      criterionLine: 8,
    });
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });
    // A valid line routes cleanly into the PDG engine — no line/mode error.
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(pdgSpy).toHaveBeenCalledTimes(1);
    expect(bfsSpy).toHaveBeenCalledTimes(1);
    const bridge = bfsSpy.mock.calls[0][4].pdgBridge;
    // The bridge now carries the slice's callee names (statement-precise reach),
    // resolved from BasicBlock.callees — not the dead call-site-line keys.
    expect(bridge).toBeDefined();
    expect([...bridge.sliceCalleeNames]).toContain('callee');
    expect(result.pdgInterprocedural).toBeDefined();
  });

  it("mode:'pdg' downstream: a callee invoked ON the seeded line is proven even with no downstream dependents", async () => {
    // Regression for the PR #2227 tri-review P2: the seed block is excluded from
    // `reachableBlocks` (seed-minus-reachable convention), so a callee called
    // directly on the changed line — with NO downstream-dependent block — used to
    // be dropped from the statement-precise set. The dispatch now unions the seed
    // block's callees, so it must be proven.
    resolveSingleTarget();
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:main',
        name: 'main',
        type: 'Function',
        filePath: 'src/index.ts',
        callees: 'seedCallee',
      },
    ]);
    // reachableBlocks EMPTY (line N has no downstream dependents) but seedBlocks
    // carries the changed line's own block — the case that regressed.
    vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValueOnce({
      mode: 'pdg',
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      risk: 'UNKNOWN',
      impactedCount: 0,
      epistemic: 'pdg-intra-procedural',
      reachableBlocks: [],
      intraReachableBlocks: [],
      seedBlocks: ['BasicBlock:src/index.ts:8:0:0'],
      blockCount: 0,
      affectedStatements: [],
      affectedStatementCount: 0,
      criterionLine: 8,
    });
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });
    const bridge = bfsSpy.mock.calls[0][4].pdgBridge;
    // The bridge is seeded from the seed block (not just reachableBlocks), so the
    // seed-line callee is provable.
    expect(bridge).toBeDefined();
    expect([...bridge.sliceCalleeNames]).toContain('seedCallee');
  });

  it('betterBridgeEvidence keeps callgraph-bridge regardless of parent order (U3 order-independence)', () => {
    const proven = { evidence: 'callgraph-bridge' as const, basis: 'in slice' };
    const unproven = { evidence: 'unproven-bridge' as const, basis: 'not in slice' };
    // A node reached from a proven and an unproven parent is proven either way —
    // the diamond label does not depend on which edge the BFS visits first.
    expect(betterBridgeEvidence(unproven, proven).evidence).toBe('callgraph-bridge');
    expect(betterBridgeEvidence(proven, unproven).evidence).toBe('callgraph-bridge');
    // First verdict wins when neither is stronger; undefined existing takes the candidate.
    expect(betterBridgeEvidence(undefined, unproven).evidence).toBe('unproven-bridge');
    expect(betterBridgeEvidence(unproven, unproven).evidence).toBe('unproven-bridge');
  });

  it('pdgBridgeEvidenceForImpact treats a truncated-slice (sentinel) as callee-unknown → proven', () => {
    // A slice block that hit the per-statement site cap has an incomplete callee
    // list; the sentinel forces callgraph-equal so an absent-but-real callee is
    // not under-proven.
    const truncated = pdgBridgeEvidenceForImpact({
      bridge: {
        sliceCalleeNames: new Set([CALLEES_TRUNCATED_SENTINEL, 'foo']),
        sliceCalleeIds: new Set(),
      },
      depth: 1,
      calleeName: 'unrelatedNotInSlice',
    });
    expect(truncated.evidence).toBe('callgraph-bridge');
    // Without the sentinel, a callee not in the slice is unproven.
    const notTruncated = pdgBridgeEvidenceForImpact({
      bridge: { sliceCalleeNames: new Set(['foo']), sliceCalleeIds: new Set() },
      depth: 1,
      calleeName: 'unrelatedNotInSlice',
    });
    expect(notTruncated.evidence).toBe('unproven-bridge');
  });

  it("mode:'pdg' degrades gracefully when the slice-callees query fails (no bridge, no throw)", async () => {
    // calleesOfBlocks swallows a DB error and returns an empty set, so the bridge
    // is not built and the inter-procedural reach falls back to callgraph-equal —
    // never surfacing the error or producing a partial proven/unproven labeling.
    resolveSingleTarget();
    // The slice-callees query (RETURN b.callees) throws; every other query (target
    // resolution) returns the resolved symbol row.
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.callees')) throw new Error('slice-callees query failed');
      return [{ id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' }];
    });
    // A line-seeded downstream slice so calleesOfBlocks is attempted.
    vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValueOnce({
      mode: 'pdg',
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      risk: 'UNKNOWN',
      impactedCount: 0,
      epistemic: 'pdg-intra-procedural',
      reachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      intraReachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      seedBlocks: ['BasicBlock:src/index.ts:8:0:0'],
      blockCount: 1,
      affectedStatements: [{ line: 8, filePath: 'src/index.ts', text: 'callee()' }],
      affectedStatementCount: 1,
      criterionLine: 8,
    });
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const cap = _captureLogger();
    try {
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'downstream',
        mode: 'pdg',
        line: 8,
      });
      // The error was swallowed: no bridge passed to the BFS, and no error surfaced.
      expect(result.error).toBeUndefined();
      expect(bfsSpy.mock.calls[0][4].pdgBridge).toBeUndefined();
      // The swallowed, gracefully-degraded query failure is logged at warn (40),
      // never error (50): it degraded to a safe fallback and is not an operation
      // failure. Pinning the severity guards against a regression to a false
      // ERROR alarm that would drown genuine, operation-aborting failures.
      const slice = cap.records().find((r) => r.context === 'impact:pdg-slice-callees');
      expect(slice).toBeDefined();
      expect(slice?.level).toBe(40);
    } finally {
      cap.restore();
    }
  });

  it("mode:'pdg' slice-callees failing with a benign missing-table error logs at debug, not warn", async () => {
    // A repo analyzed without the optional column/table (e.g. a pre-v3 PDG index
    // missing `calleeIds`, or a BasicBlock table that simply isn't there) makes the
    // slice-callees query fail with a benign "missing optional data" error. That is a
    // normal configuration, not a degradation, so logQueryError routes it to debug —
    // suppressed at the default info level. We capture AT debug so the record is
    // visible: the assertion is that it was emitted AND at debug (level 10), which
    // distinguishes "logged at debug" from "not logged at all" — an info-level
    // absence check could not tell those apart and would pass vacuously if the
    // logQueryError call were deleted.
    resolveSingleTarget();
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.callees')) throw new Error('Table BasicBlock does not exist');
      return [{ id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' }];
    });
    vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValueOnce({
      mode: 'pdg',
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      risk: 'UNKNOWN',
      impactedCount: 0,
      epistemic: 'pdg-intra-procedural',
      reachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      intraReachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      seedBlocks: ['BasicBlock:src/index.ts:8:0:0'],
      blockCount: 1,
      affectedStatements: [{ line: 8, filePath: 'src/index.ts', text: 'callee()' }],
      affectedStatementCount: 1,
      criterionLine: 8,
    });
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const cap = _captureLogger('debug');
    try {
      const result = await backend.callTool('impact', {
        target: 'main',
        direction: 'downstream',
        mode: 'pdg',
        line: 8,
      });
      // Still degrades cleanly to no bridge / no surfaced error.
      expect(result.error).toBeUndefined();
      expect(bfsSpy.mock.calls[0][4].pdgBridge).toBeUndefined();
      // The benign failure was emitted at debug (20) — NOT warn (40)/error (50).
      // Capturing at debug proves the call fired and chose the suppressed level.
      const slice = cap.records().find((r) => r.context === 'impact:pdg-slice-callees');
      expect(slice).toBeDefined();
      expect(slice?.level).toBe(20);
    } finally {
      cap.restore();
    }
  });

  it("mode:'pdg' slice-callees failing with a non-schema 'not found' error logs at warn, not debug (#2283)", async () => {
    // "Symbol not found" is an operation failure, not a benign missing optional
    // table — isBenignMissingTableError must NOT match an unscoped "not found"
    // (only "<table|column|property|…> … not found"), so it stays visible at warn
    // rather than being demoted to the suppressed debug level.
    resolveSingleTarget();
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.callees')) throw new Error('Symbol not found');
      return [{ id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' }];
    });
    vi.spyOn(backend as any, '_runImpactPDG').mockResolvedValueOnce({
      mode: 'pdg',
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'downstream',
      risk: 'UNKNOWN',
      impactedCount: 0,
      epistemic: 'pdg-intra-procedural',
      reachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      intraReachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
      seedBlocks: ['BasicBlock:src/index.ts:8:0:0'],
      blockCount: 1,
      affectedStatements: [{ line: 8, filePath: 'src/index.ts', text: 'callee()' }],
      affectedStatementCount: 1,
      criterionLine: 8,
    });
    vi.spyOn(backend as any, '_runImpactBFS');
    const cap = _captureLogger();
    try {
      await backend.callTool('impact', {
        target: 'main',
        direction: 'downstream',
        mode: 'pdg',
        line: 8,
      });
      const slice = cap.records().find((r) => r.context === 'impact:pdg-slice-callees');
      expect(slice).toBeDefined();
      expect(slice?.level).toBe(40);
    } finally {
      cap.restore();
    }
  });

  it("mode:'pdg' + crossDepth → hard {error} (single-repo PDG impact)", async () => {
    resolveSingleTarget();
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'pdg',
      crossDepth: 2,
    });
    expect(result.error).toMatch(/not supported with mode:'pdg'/);
    expect(result.error).toContain('crossDepth');
    expect(bfsSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['relationTypes', { relationTypes: ['CALLS'] }, (opts: any) => opts.relationTypes],
    ['minConfidence', { minConfidence: 0.5 }, (opts: any) => opts.minConfidence],
  ])("mode:'pdg' + %s feeds the interprocedural symbol reach", async (_label, extra, readOpt) => {
    resolveSingleTarget();
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS').mockResolvedValueOnce({
      target: { id: 'func:main', name: 'main', type: 'Function', filePath: 'src/index.ts' },
      direction: 'upstream',
      impactedCount: 0,
      risk: 'LOW',
      summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
      byDepthCounts: {},
      affected_processes: [],
      affected_modules: [],
      byDepth: {},
    });
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'pdg',
      ...extra,
    });
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(bfsSpy).toHaveBeenCalledTimes(1);
    expect(readOpt(bfsSpy.mock.calls[0][4])).toBeDefined();
  });

  it("ambiguous target under mode:'pdg' never invokes interprocedural fan-out (KTD5 ambiguous trap)", async () => {
    // Two same-name Functions → resolver returns ambiguous.
    (executeParameterized as any).mockResolvedValue([
      {
        id: 'func:login:1',
        name: 'login',
        type: 'Function',
        filePath: 'src/auth.ts',
        startLine: 5,
      },
      {
        id: 'func:login:2',
        name: 'login',
        type: 'Function',
        filePath: 'src/admin/login.ts',
        startLine: 8,
      },
    ]);
    const bfsSpy = vi.spyOn(backend as any, '_runImpactBFS');
    const result = await backend.callTool('impact', {
      target: 'login',
      direction: 'upstream',
      mode: 'pdg',
    });
    expect(result.status).toBe('ambiguous');
    expect(result.mode).toBe('pdg');
    expect(result.candidates).toHaveLength(2);
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
    // The callgraph per-candidate probe fan-out MUST NOT run under pdg.
    expect(bfsSpy).not.toHaveBeenCalled();
    // No per-candidate blast radius is computed yet (U4), so the candidate
    // entries carry no impactedCount field from a callgraph probe.
    for (const c of result.candidates) {
      expect(c.impactedCount).toBeUndefined();
    }
  });

  it("unknown target with mode:'pdg' returns the normalized PDG error envelope", async () => {
    (executeParameterized as any).mockResolvedValue([]);
    const result = await backend.callTool('impact', {
      target: 'missingSymbol',
      direction: 'upstream',
      mode: 'pdg',
    });
    expect(result.error).toMatch(/not found/);
    expect(result.mode).toBe('pdg');
    expect(result.target).toEqual({ name: 'missingSymbol' });
    expect(result.direction).toBe('upstream');
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
  });

  it("runtime failures with mode:'pdg' return the normalized PDG error envelope", async () => {
    const failing = new Error('pdg query failed');
    const implSpy = vi.spyOn(backend as any, '_impactImpl').mockRejectedValueOnce(failing);
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
    });
    expect(result.error).toBe('pdg query failed');
    expect(result.mode).toBe('pdg');
    expect(result.target).toEqual({ name: 'main' });
    expect(result.direction).toBe('downstream');
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
    expect(result.suggestion).toMatch(/context/);
    implSpy.mockRestore();
  });

  it("@group target with mode:'pdg' is rejected (KTD12 — PDG is single-repo)", async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'pdg',
      repo: '@grp',
    });
    expect(result.error).toMatch(/not supported for @group targets/);
    expect(result.mode).toBe('pdg');
    expect(result.target).toEqual({ name: 'main' });
    expect(result.direction).toBe('upstream');
    expect(result.impactedCount).toBe(0);
    expect(result.risk).toBe('UNKNOWN');
  });

  it("@group target with mode:'callgraph' still forwards to group impact (unchanged)", async () => {
    resolveAtMemberMock.mockResolvedValue({ ok: true, repoPath: '/tmp/test-project' });
    // groupImpact is reached only if the mode gate passes; we don't assert its
    // payload (group infra is stubbed), only that no mode-error short-circuited.
    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'upstream',
      mode: 'callgraph',
      repo: '@grp',
    });
    expect(result?.error ?? '').not.toMatch(/not supported for @group targets/);
    expect(result?.error ?? '').not.toMatch(/Invalid "mode"/);
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
    const result = await backend.listRepos();
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

// ─── repo-id collisions (sibling clones) ────────────────────────────

describe('LocalBackend repo-id collisions (#2054)', () => {
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    (getGitRoot as any).mockReturnValue(null);
    backend = new LocalBackend();
  });

  afterEach(() => {
    for (const dir of duplicateFixtureDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves all sibling clones through the list_repos tool with siblings/remoteUrl intact (#2054, #2119)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(4);
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();

    // Exercise the real TOOL surface (callTool → listReposPage), not just
    // listRepos(): the paginated wrapper must not drop sibling-clone fields
    // during its sort + slice.
    const page = await backend.callTool('list_repos', {});
    expect(page.repositories).toHaveLength(4);
    expect(page.pagination.total).toBe(4);
    const paths = page.repositories.map((r: any) => path.resolve(r.path)).sort();
    expect(paths).toEqual(dirs.map((d) => path.resolve(d)).sort());
    for (const entry of page.repositories) {
      expect(entry.remoteUrl).toBe('git@github.com:MYCOMPANY/REPO.git');
      expect(entry.siblings).toHaveLength(3);
    }
  });

  it('lists all four sibling clones that share a name and remote (#2054)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(4);
    (listRegisteredRepos as any).mockResolvedValue(entries);

    // Precondition: the historical 6-char base64url suffixes really do collide
    // for these sibling paths — otherwise this test would not exercise the bug.
    expect(legacyPathSuffix(dirs[1])).toBe(legacyPathSuffix(dirs[2]));
    expect(legacyPathSuffix(dirs[2])).toBe(legacyPathSuffix(dirs[3]));

    expect(await backend.init()).toBe(true);

    const listed = await backend.listRepos();
    expect(listed).toHaveLength(4);

    // Every distinct on-disk clone survives exactly once — no silent overwrite.
    const listedPaths = listed.map((r: any) => path.resolve(r.path)).sort();
    expect(listedPaths).toEqual(dirs.map((d) => path.resolve(d)).sort());
    expect(new Set(listedPaths).size).toBe(4);

    // The shared remoteUrl must NOT collapse the entries; instead each entry
    // reports the other three as siblings (existing list_repos contract).
    for (const entry of listed) {
      expect(entry.remoteUrl).toBe('git@github.com:MYCOMPANY/REPO.git');
      expect(entry.siblings).toHaveLength(3);
    }

    // Every clone is addressable by its absolute path.
    for (const dir of dirs) {
      const resolved = await backend.resolveRepo(dir);
      expect(resolved.repoPath).toBe(dir);
    }

    // Re-running list_repos (which re-reads the registry) is idempotent.
    const again = await backend.listRepos();
    expect(again).toHaveLength(4);
  });

  it('assigns distinct, resolvable generated ids past the first legacy collision (#2054)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(4);
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();

    // Resolve each clone by path, collect its in-memory id.
    const handles = await Promise.all(dirs.map((d) => backend.resolveRepo(d)));
    const ids = handles.map((h) => h.id);

    // Ids are unique across all four clones.
    expect(new Set(ids).size).toBe(4);
    // First clone keeps the bare name; the rest are name-prefixed generated ids.
    expect(ids[0]).toBe('repo');
    for (const id of ids.slice(1)) expect(id.startsWith('repo-')).toBe(true);

    // Clones that collided on the legacy suffix fall back to a content hash —
    // i.e. they are NOT addressable by the (colliding) legacy id, but ARE
    // addressable by whatever stable id they actually hold.
    const collidedLegacy = `repo-${legacyPathSuffix(dirs[2])}`;
    expect(handles[2].id).not.toBe(collidedLegacy);
    expect(handles[3].id).not.toBe(handles[2].id);

    // Each *suffixed* generated id resolves back to its own clone. The bare
    // "repo" id is intentionally shadowed by the shared repo *name* (the #1658
    // name tier runs before the id tier), so the first clone is addressed by
    // path instead — covered by the headline test.
    for (const h of handles.slice(1)) {
      const viaId = await backend.resolveRepo(h.id);
      expect(viaId.repoPath).toBe(h.repoPath);
    }
  });

  it('keeps each clone’s generated id stable across a registry reorder (#2067)', async () => {
    // Ids are assigned over a path-sorted view, so the same resolved path always
    // gets the same id regardless of registry order — a memorized hashed id
    // can't drift to a different clone after a reorder.
    const { dirs, entries } = makeSiblingClonesFixture(4);
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();
    const before: Record<string, string> = {};
    for (const d of dirs) before[d] = (await backend.resolveRepo(d)).id;

    // Reverse the registry order and refresh.
    (listRegisteredRepos as any).mockResolvedValue([...entries].reverse());
    await backend.callTool('list_repos', {});

    for (const d of dirs) {
      expect((await backend.resolveRepo(d)).id).toBe(before[d]); // same path → same id
    }
  });

  it('refresh stability: reorder, remove-one, and re-add never drop a different clone (#2054)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(4);
    const listedPaths = async () =>
      (await backend.listRepos()).map((r: any) => path.resolve(r.path)).sort();
    const allPaths = dirs.map((d) => path.resolve(d)).sort();

    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();
    expect(await listedPaths()).toEqual(allPaths);

    // Reordering the registry must not silently lose a clone. (Under path-sorted
    // assignment a reorder is a no-op for id assignment; id stability across
    // reorder is asserted separately above. This step remains a set-survival
    // guard.)
    (listRegisteredRepos as any).mockResolvedValue([...entries].reverse());
    expect(await listedPaths()).toEqual(allPaths);

    // Removing one entry prunes only that entry.
    (listRegisteredRepos as any).mockResolvedValue(entries.slice(0, 3));
    expect(await listedPaths()).toEqual(
      dirs
        .slice(0, 3)
        .map((d) => path.resolve(d))
        .sort(),
    );

    // Re-adding it restores it without replacing another clone.
    (listRegisteredRepos as any).mockResolvedValue(entries);
    expect(await listedPaths()).toEqual(allPaths);
  });

  it('gives two same-name clones independent pools and never evicts on id reassignment (#2067)', async () => {
    // The pool (and the init/staleness/reinit maps) are keyed by the immutable
    // lbugPath, so two clones that transiently share a name-derived id get
    // SEPARATE pool entries — neither can be served the other's database — and a
    // pure id reassignment (path still registered) needs no pool eviction.
    const parent = mkdtempSync(path.join(os.tmpdir(), 'gnx-remap-'));
    duplicateFixtureDirs.push(parent);
    const a = path.join(parent, 'A'); // 'A' sorts before 'B'
    const b = path.join(parent, 'B');
    const lbug = (dir: string) => path.join(dir, '.gitnexus', 'lbug');
    const mk = (dir: string) => {
      mkdirSync(lbug(dir), { recursive: true });
      writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{}');
      return {
        ...MOCK_REPO_ENTRY,
        name: 'dup',
        path: dir,
        storagePath: path.join(dir, '.gitnexus'),
      };
    };
    const entryA = mk(a);
    const entryB = mk(b);

    // Start with only B → B owns the bare "dup" id; resolve it.
    (listRegisteredRepos as any).mockResolvedValue([entryB]);
    await backend.init();
    const handleB = await backend.resolveRepo(b);
    expect(handleB.id).toBe('dup');

    // Add A (sorts before B) → the bare "dup" id is reassigned to A.
    (closeLbug as any).mockClear();
    (listRegisteredRepos as any).mockResolvedValue([entryB, entryA]);
    await backend.callTool('list_repos', {});
    const handleA = await backend.resolveRepo(a);
    expect(handleA.id).toBe('dup'); // A now owns the bare id
    expect((await backend.resolveRepo(b)).id).not.toBe('dup'); // B moved to a suffix

    // Reassigning the id evicts nothing — both paths are still registered.
    expect(closeLbug).not.toHaveBeenCalled();

    // Each clone initializes its OWN pool entry, keyed by its own lbugPath — no
    // cross-serving even though they shared the "dup" id.
    (initLbug as any).mockClear();
    await (backend as any).ensureInitialized(handleA);
    await (backend as any).ensureInitialized(handleB);
    expect(initLbug).toHaveBeenCalledWith(lbug(a), lbug(a));
    expect(initLbug).toHaveBeenCalledWith(lbug(b), lbug(b));
  });

  it('releases the pooled connection when a repo path leaves the registry (#2054)', async () => {
    // When a clone's path is unregistered its pooled LadybugDB connection must
    // be released. The pool is keyed by lbugPath, so eviction targets the path.
    const parent = mkdtempSync(path.join(os.tmpdir(), 'gnx-vanish-'));
    duplicateFixtureDirs.push(parent);
    const dir = path.join(parent, 'solo');
    const lbugPath = path.join(dir, '.gitnexus', 'lbug');
    mkdirSync(lbugPath, { recursive: true });
    writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{}');
    const entry = {
      ...MOCK_REPO_ENTRY,
      name: 'solo',
      path: dir,
      storagePath: path.join(dir, '.gitnexus'),
    };

    (listRegisteredRepos as any).mockResolvedValue([entry]);
    await backend.init();
    expect((await backend.resolveRepo(dir)).id).toBe('solo');

    // Registry now empty → the clone's path vanishes on refresh.
    (closeLbug as any).mockClear();
    (listRegisteredRepos as any).mockResolvedValue([]);
    await backend.callTool('list_repos', {});

    expect(closeLbug).toHaveBeenCalledWith(lbugPath);
  });

  it('initializes the resolved clone, not a clone the id was remapped to mid-call (#2067)', async () => {
    // ensureInitialized takes the resolved RepoHandle, so even if a concurrent
    // refresh remaps the (floating) bare id to a different clone between resolve
    // and init, it opens the clone the caller actually resolved — not whatever
    // the id now points at. Pre-fix (by-id re-derivation) it opened the remapped
    // clone's database.
    const parent = mkdtempSync(path.join(os.tmpdir(), 'gnx-race-'));
    duplicateFixtureDirs.push(parent);
    const a = path.join(parent, 'A'); // 'A' sorts before 'B'
    const b = path.join(parent, 'B');
    const mk = (dir: string) => {
      mkdirSync(path.join(dir, '.gitnexus', 'lbug'), { recursive: true });
      writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), '{}');
      return {
        ...MOCK_REPO_ENTRY,
        name: 'dup',
        path: dir,
        storagePath: path.join(dir, '.gitnexus'),
      };
    };
    const entryA = mk(a);
    const entryB = mk(b);

    // Only B registered → B owns the bare "dup" id; resolve it.
    (listRegisteredRepos as any).mockResolvedValue([entryB]);
    await backend.init();
    const resolvedB = await backend.resolveRepo(b);
    expect(resolvedB.id).toBe('dup');

    // Concurrent refresh adds A (sorts first) → the bare "dup" id now maps to A.
    (listRegisteredRepos as any).mockResolvedValue([entryB, entryA]);
    await backend.callTool('list_repos', {});
    expect((await backend.resolveRepo(a)).id).toBe('dup'); // id remapped to A

    // Initialize with the handle resolved BEFORE the remap → must open B's path
    // (pool keyed by B's lbugPath), never A's.
    (initLbug as any).mockClear();
    await (backend as any).ensureInitialized(resolvedB);
    const lbug = (dir: string) => path.join(dir, '.gitnexus', 'lbug');
    expect(initLbug).toHaveBeenCalledWith(lbug(b), lbug(b));
    expect(initLbug).not.toHaveBeenCalledWith(lbug(a), lbug(a));
  });

  it('handles more than four sibling clones — all listed once and resolvable (#2067)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(6);
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();

    const listed = await backend.listRepos();
    expect(listed).toHaveLength(6);

    // All six ids are distinct (clones 3–6 exercise the sha256 fallback tier).
    const ids = await Promise.all(dirs.map(async (d) => (await backend.resolveRepo(d)).id));
    expect(new Set(ids).size).toBe(6);
    for (const d of dirs) expect((await backend.resolveRepo(d)).repoPath).toBe(d);
  });

  it('lists same-name clones with no remoteUrl without grouping or collapse (#2067)', async () => {
    const { dirs, entries } = makeSiblingClonesFixture(2);
    // Strip remoteUrl — same name, no remote fingerprint.
    const noRemote = entries.map((e) => ({ ...e, remoteUrl: undefined }));
    (listRegisteredRepos as any).mockResolvedValue(noRemote);
    await backend.init();

    const listed = await backend.listRepos();
    expect(listed).toHaveLength(2); // both present, not collapsed
    for (const e of listed) {
      expect(e.remoteUrl).toBeUndefined();
      expect(e.siblings).toBeUndefined(); // no remote → no sibling grouping
    }
    for (const d of dirs) expect((await backend.resolveRepo(d)).repoPath).toBe(d);
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
    const repos = await backend.listRepos();
    expect(repos).toEqual([]);
  });

  it('returns repo metadata', async () => {
    setupSingleRepo();
    await backend.init();
    const repos = await backend.listRepos();
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
    await backend.listRepos();
    await backend.listRepos();
    // listRegisteredRepos called: once in init, once per listRepos
    expect(listRegisteredRepos).toHaveBeenCalledTimes(3);
  });
});

// ─── list_repos pagination (#2119) ─────────────────────────────────────

describe('parseListReposPagination', () => {
  const opts = { defaultLimit: 50, maxLimit: 200 };

  it('applies defaults when nothing is supplied', () => {
    expect(parseListReposPagination(undefined, opts)).toEqual({ limit: 50, offset: 0 });
    expect(parseListReposPagination({}, opts)).toEqual({ limit: 50, offset: 0 });
  });

  it('accepts valid integer limit/offset', () => {
    expect(parseListReposPagination({ limit: 10, offset: 20 }, opts)).toEqual({
      limit: 10,
      offset: 20,
    });
  });

  it('rejects a limit above the maximum (does not silently clamp)', () => {
    expect(() => parseListReposPagination({ limit: 201 }, opts)).toThrow(/limit/);
    expect(() => parseListReposPagination({ limit: 99999 }, opts)).toThrow(/limit/);
  });

  it('accepts a valid in-range limit, including the boundary', () => {
    expect(parseListReposPagination({ limit: 200 }, opts).limit).toBe(200);
    expect(parseListReposPagination({ limit: 199 }, opts).limit).toBe(199);
  });

  it('rejects malformed limit values', () => {
    for (const bad of [0, -5, 1.5, NaN, Infinity, '5', null, true, {}]) {
      expect(() => parseListReposPagination({ limit: bad as any }, opts)).toThrow(/limit/);
    }
  });

  it('rejects malformed offset values', () => {
    for (const bad of [-1, 2.5, NaN, Infinity, '0', null, false]) {
      expect(() => parseListReposPagination({ offset: bad as any }, opts)).toThrow(/offset/);
    }
  });
});

describe('LocalBackend.listReposPage / callTool list_repos pagination (#2119)', () => {
  let backend: LocalBackend;

  // Build N registry entries with unique, lexically-ordered names + paths and
  // no remoteUrl (so no sibling grouping). Zero-padding makes lexical order
  // equal numeric order, so page boundaries are predictable.
  const id = (i: number) => `repo-${String(i).padStart(4, '0')}`;
  const makeRepoEntries = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      ...MOCK_REPO_ENTRY,
      name: id(i),
      path: `/tmp/repos/${id(i)}`,
      storagePath: `/tmp/repos/${id(i)}/.gitnexus`,
    }));

  beforeEach(async () => {
    vi.clearAllMocks();
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    backend = new LocalBackend();
  });

  it('default page caps a large registry and reports continuation metadata', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', {});
    expect(page.repositories).toHaveLength(50);
    expect(page.pagination).toEqual({
      total: 437,
      limit: 50,
      offset: 0,
      returned: 50,
      hasMore: true,
      nextOffset: 50,
    });
    // First page starts at the first repo in deterministic order.
    expect(page.repositories[0].name).toBe(id(0));
  });

  it('limit controls the page size', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { limit: 100 });
    expect(page.repositories).toHaveLength(100);
    expect(page.pagination.limit).toBe(100);
    expect(page.pagination.nextOffset).toBe(100);
  });

  it('offset selects a middle page', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { limit: 50, offset: 50 });
    expect(page.repositories[0].name).toBe(id(50));
    expect(page.repositories[49].name).toBe(id(99));
    // Assert total + limit too (a total miscalculation at non-zero offset would
    // otherwise slip past this targeted middle-page test).
    expect(page.pagination).toEqual({
      total: 437,
      limit: 50,
      offset: 50,
      returned: 50,
      hasMore: true,
      nextOffset: 100,
    });
  });

  it('returns the final partial page with hasMore=false and no nextOffset', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { limit: 50, offset: 400 });
    expect(page.repositories).toHaveLength(37); // 437 - 400
    expect(page.pagination.returned).toBe(37);
    expect(page.pagination.hasMore).toBe(false);
    expect(page.pagination).not.toHaveProperty('nextOffset');
  });

  it('limit larger than the remaining count returns only the remaining entries', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { limit: 200, offset: 400 });
    expect(page.repositories).toHaveLength(37);
    expect(page.pagination.hasMore).toBe(false);
  });

  it('offset equal to total returns an empty page (total preserved)', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { offset: 437 });
    expect(page.repositories).toHaveLength(0);
    expect(page.pagination).toMatchObject({ total: 437, returned: 0, hasMore: false });
    expect(page.pagination).not.toHaveProperty('nextOffset');
  });

  it('offset beyond total returns an empty page', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { offset: 1000 });
    expect(page.repositories).toHaveLength(0);
    expect(page.pagination).toMatchObject({
      total: 437,
      offset: 1000,
      returned: 0,
      hasMore: false,
    });
  });

  it('accepts a negative-zero offset (treated as the first page)', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { limit: 5, offset: -0 });
    expect(page.repositories[0].name).toBe(id(0));
    expect(page.pagination.returned).toBe(5);
    // -0 is accepted (not rejected) and behaves as offset 0 (=== treats them equal).
    expect(page.pagination.offset === 0).toBe(true);
  });

  it('accepts a MAX_SAFE_INTEGER offset and returns an empty page', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    const page = await backend.callTool('list_repos', { offset: Number.MAX_SAFE_INTEGER });
    expect(page.repositories).toHaveLength(0);
    expect(page.pagination).toMatchObject({ total: 437, returned: 0, hasMore: false });
    expect(page.pagination).not.toHaveProperty('nextOffset');
  });

  it('returns the full set with metadata when everything fits on one page', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(3));
    await backend.init();

    const page = await backend.callTool('list_repos', {});
    expect(page.repositories).toHaveLength(3);
    expect(page.pagination).toEqual({
      total: 3,
      limit: 50,
      offset: 0,
      returned: 3,
      hasMore: false,
    });
  });

  it('rejects a limit above the maximum through the real callTool path', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(437));
    await backend.init();

    await expect(backend.callTool('list_repos', { limit: 99999 })).rejects.toThrow(/limit/);
    // A request at the documented maximum is still accepted.
    const page = await backend.callTool('list_repos', { limit: 200 });
    expect(page.repositories).toHaveLength(200);
    expect(page.pagination.limit).toBe(200);
    expect(page.pagination.hasMore).toBe(true);
  });

  it('rejects malformed limit/offset through the real callTool path', async () => {
    (listRegisteredRepos as any).mockResolvedValue(makeRepoEntries(3));
    await backend.init();

    await expect(backend.callTool('list_repos', { limit: 0 })).rejects.toThrow(/limit/);
    await expect(backend.callTool('list_repos', { limit: -5 })).rejects.toThrow(/limit/);
    await expect(backend.callTool('list_repos', { limit: 1.5 })).rejects.toThrow(/limit/);
    await expect(backend.callTool('list_repos', { limit: 'all' as any })).rejects.toThrow(/limit/);
    await expect(backend.callTool('list_repos', { offset: -1 })).rejects.toThrow(/offset/);
    await expect(backend.callTool('list_repos', { offset: 2.5 })).rejects.toThrow(/offset/);
  });

  it('traverses every repository exactly once across pages (the #2119 guarantee)', async () => {
    const entries = makeRepoEntries(437);
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();

    const collected: string[] = [];
    let offset = 0;
    const limit = 50;
    // Hard cap iterations to avoid an infinite loop if hasMore were ever wrong.
    for (let guard = 0; guard < 100; guard++) {
      const page = await backend.callTool('list_repos', { limit, offset });
      collected.push(...page.repositories.map((r: any) => r.path));
      expect(page.pagination.total).toBe(437);
      if (!page.pagination.hasMore) break;
      offset = page.pagination.nextOffset;
    }

    expect(collected).toHaveLength(437);
    expect(new Set(collected).size).toBe(437); // no duplicates
    expect(new Set(collected)).toEqual(new Set(entries.map((e) => e.path))); // exact set
  });

  it('orders pages deterministically by name then path, stable across calls', async () => {
    // Scrambled input order; two entries deliberately SHARE a name (collision)
    // and must be tie-broken by path, never collapsed.
    const entries = [
      { ...MOCK_REPO_ENTRY, name: 'zeta', path: '/tmp/z', storagePath: '/tmp/z/.gitnexus' },
      { ...MOCK_REPO_ENTRY, name: 'shared', path: '/tmp/b', storagePath: '/tmp/b/.gitnexus' },
      { ...MOCK_REPO_ENTRY, name: 'Alpha', path: '/tmp/a', storagePath: '/tmp/a/.gitnexus' },
      { ...MOCK_REPO_ENTRY, name: 'shared', path: '/tmp/a2', storagePath: '/tmp/a2/.gitnexus' },
    ];
    (listRegisteredRepos as any).mockResolvedValue(entries);
    await backend.init();

    const first = await backend.callTool('list_repos', {});
    const order = first.repositories.map((r: any) => `${r.name}@${r.path}`);
    // lower-cased name primary (Alpha < shared < zeta), path tie-break for the
    // two "shared" entries (/tmp/a2 < /tmp/b).
    expect(order).toEqual(['Alpha@/tmp/a', 'shared@/tmp/a2', 'shared@/tmp/b', 'zeta@/tmp/z']);
    expect(first.repositories).toHaveLength(4); // collision not collapsed

    // Re-listing yields identical page boundaries.
    const second = await backend.callTool('list_repos', {});
    expect(second.repositories.map((r: any) => `${r.name}@${r.path}`)).toEqual(order);
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

  it('keeps one markdown line per row when a cell value contains newlines (#2310)', async () => {
    // A multi-line `content` value must not split its row across physical lines —
    // otherwise the rendered table is corrupt and the CLI `--limit` line-slice
    // keeps the wrong number of rows.
    (executeParameterized as any).mockResolvedValue([
      { name: 'a', content: 'export function a() {\n  return 1;\n}' },
      { name: 'b', content: 'line1\nline2' },
    ]);
    const result = await backend.callTool('cypher', {
      query: 'MATCH (n:Function) RETURN n.name AS name, n.content AS content',
    });
    const lines = result.markdown.split('\n');
    // header + separator + exactly one line per data row, no embedded newlines.
    expect(lines).toHaveLength(2 + result.row_count);
    expect(result.row_count).toBe(2);
    expect(result.markdown).not.toMatch(/\n[^|]/);
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

// ─── resolveRepo branch scope (#2106) ────────────────────────────────

describe('LocalBackend.resolveRepo branch scope (#2106)', () => {
  let backend: LocalBackend;

  // Per-run unique dir: a fixed shared os.tmpdir() path lets concurrent
  // vitest runs on one host rm each other's materialized sub-index stub
  // mid-test (the documented parallel-agents workflow).
  const MULTI_DIR = mkdtempSync(path.join(os.tmpdir(), 'gnx-2106-multi-'));
  const BRANCH_ENTRY = {
    name: 'multi',
    path: MULTI_DIR,
    storagePath: path.join(MULTI_DIR, '.gitnexus'),
    indexedAt: '2026-06-10T12:00:00Z',
    lastCommit: 'mainsha',
    branch: 'main',
    branches: [{ branch: 'feature/x', indexedAt: '2026-06-10T13:00:00Z', lastCommit: 'featsha' }],
    stats: { files: 1, nodes: 1 },
  };

  const flatLbug = path.join(BRANCH_ENTRY.storagePath, 'lbug');
  // The pinned sub-index must exist on disk: applyBranchScope serves a
  // branches[] summary only when its lbug is really there (#2364 review F1
  // arm ii — a stale summary must not route to an adopt-deleted dir).
  const branchLbug = getStoragePaths(BRANCH_ENTRY.path, 'feature/x').lbugPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    mkdirSync(path.dirname(branchLbug), { recursive: true });
    writeFileSync(branchLbug, 'stub');
    backend = new LocalBackend();
    (listRegisteredRepos as any).mockResolvedValue([BRANCH_ENTRY]);
    await backend.init();
  });

  afterEach(() => {
    rmSync(BRANCH_ENTRY.storagePath, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(MULTI_DIR, { recursive: true, force: true });
  });

  it('no branch param resolves the flat workspace lbug', async () => {
    const handle = await backend.resolveRepo('multi');
    expect(handle.lbugPath).toBe(flatLbug);
  });

  it('the workspace-recorded branch name resolves the flat lbug', async () => {
    const handle = await backend.resolveRepo('multi', 'main');
    expect(handle.lbugPath).toBe(flatLbug);
  });

  it('an indexed pinned branch resolves a branches/<slug> lbug', async () => {
    const handle = await backend.resolveRepo('multi', 'feature/x');
    expect(handle.lbugPath).not.toBe(flatLbug);
    expect(handle.lbugPath).toContain(path.join('.gitnexus', 'branches'));
    expect(path.basename(handle.lbugPath)).toBe('lbug');
    // The branch handle reports the branch's own commit, not the primary's.
    expect(handle.lastCommit).toBe('featsha');
  });

  it('an un-indexed branch throws a clear error', async () => {
    await expect(backend.resolveRepo('multi', 'nope')).rejects.toThrow(/not indexed/i);
    // Post-#2354 guidance: a bare `analyze --branch <X>` refuses unless X is
    // checked out, so the message must lead with the checkout (#2364 F6).
    await expect(backend.resolveRepo('multi', 'nope')).rejects.toThrow(
      /workspace index follows the checked-out branch/,
    );
    await expect(backend.resolveRepo('multi', 'nope')).rejects.toThrow(
      /check out "nope" and re-run: gitnexus analyze/,
    );
  });

  it('a legacy entry with no top-level branch still routes an indexed branch', async () => {
    // Pre-#2106 entries have no `branch` field; branch routing must still work
    // off branches[] alone.
    (listRegisteredRepos as any).mockResolvedValue([{ ...BRANCH_ENTRY, branch: undefined }]);
    await backend.init();
    const handle = await backend.resolveRepo('multi', 'feature/x');
    expect(handle.lbugPath).toContain(path.join('.gitnexus', 'branches'));
  });

  it('a legacy entry resolves --branch <workspace-branch> via the flat meta (#2106 R4)', async () => {
    // Pre-#2106 flat index: registry entry has no `branch`/`branches`, but the
    // flat meta.json records the workspace branch. `--branch <that branch>`
    // must resolve to the flat handle (read from meta), while an unindexed
    // branch still errors.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-2106-legacy-'));
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath: dir, lastCommit: 'abc', indexedAt: 'now', branch: 'main' }),
    );
    try {
      (listRegisteredRepos as any).mockResolvedValue([
        { name: 'legacy', path: dir, storagePath, indexedAt: 'now', lastCommit: 'abc' },
      ]);
      await backend.init();
      const handle = await backend.resolveRepo('legacy', 'main');
      expect(handle.lbugPath).toBe(path.join(storagePath, 'lbug'));
      await expect(backend.resolveRepo('legacy', 'feature')).rejects.toThrow(/not indexed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale cached handle still resolves the restamped workspace branch via flat meta (#2354)', async () => {
    // The flat workspace slot follows the checked-out working tree: a plain
    // analyze after a branch switch restamps the flat meta.json without any
    // repo-resolution miss that would refresh a long-lived server's handle.
    // The cached handle still says branch 'main'; the on-disk flat meta is the
    // truth ('feature/z') and must win over a stale "not indexed" error.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-2354-restamp-'));
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath: dir, lastCommit: 'zzz', indexedAt: 'now', branch: 'feature/z' }),
    );
    try {
      (listRegisteredRepos as any).mockResolvedValue([
        {
          name: 'flipped',
          path: dir,
          storagePath,
          indexedAt: 'now',
          lastCommit: 'aaa',
          branch: 'main',
        },
      ]);
      await backend.init();
      const handle = await backend.resolveRepo('flipped', 'feature/z');
      expect(handle.lbugPath).toBe(path.join(storagePath, 'lbug'));
      // A genuinely unindexed branch still errors (never serves the wrong DB).
      await expect(backend.resolveRepo('flipped', 'nope')).rejects.toThrow(/not indexed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale cached label errors instead of serving the flat handle (#2364 F1 arm i)', async () => {
    // Long-lived server cached branch 'main'; a plain analyze on feature/z
    // restamped the flat meta (and the pool reinit will hot-swap content).
    // Requesting the OLD label must error — the flat DB no longer holds main.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-2364-stale-label-'));
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath: dir, lastCommit: 'zzz', indexedAt: 'now', branch: 'feature/z' }),
    );
    try {
      const entry: RegistryEntry = {
        name: 'flipped',
        path: dir,
        storagePath,
        indexedAt: 'now',
        lastCommit: 'aaa',
        branch: 'main',
      };
      vi.mocked(listRegisteredRepos).mockResolvedValue([entry]);
      await backend.init();
      const callsBefore = vi.mocked(listRegisteredRepos).mock.calls.length;
      await expect(backend.resolveRepo('flipped', 'main')).rejects.toThrow(/not indexed/i);
      // Exactly one refreshRepos fired for cache coherence (observed via its
      // unconditional first call — refreshRepos itself is private).
      expect(vi.mocked(listRegisteredRepos).mock.calls.length - callsBefore).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale summary whose sub-index was adopted falls through to the flat handle (#2364 F1 arm ii)', async () => {
    // The cached branches[] summary still lists feature/z, but adopt deleted
    // branches/<slug>/ and the flat slot now owns the label: serve flat.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-2364-adopted-'));
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath: dir, lastCommit: 'zzz', indexedAt: 'now', branch: 'feature/z' }),
    );
    try {
      const entry: RegistryEntry = {
        name: 'adopted',
        path: dir,
        storagePath,
        indexedAt: 'now',
        lastCommit: 'aaa',
        branch: 'main',
        branches: [{ branch: 'feature/z', indexedAt: 'now', lastCommit: 'zzz' }],
      };
      vi.mocked(listRegisteredRepos).mockResolvedValue([entry]);
      await backend.init();
      const handle = await backend.resolveRepo('adopted', 'feature/z');
      expect(handle.lbugPath).toBe(path.join(storagePath, 'lbug'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dangling summary with a disagreeing flat meta errors honestly (#2364 F3 window)', async () => {
    // Partial fast-path failure: adopt deleted the sub-index but the flat
    // meta was never restamped (saveMeta runs last). The degraded state must
    // yield the not-indexed error — no ghost route, no wrong data.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gnx-2364-dangling-'));
    const storagePath = path.join(dir, '.gitnexus');
    mkdirSync(storagePath, { recursive: true });
    writeFileSync(
      path.join(storagePath, 'meta.json'),
      JSON.stringify({ repoPath: dir, lastCommit: 'aaa', indexedAt: 'now', branch: 'main' }),
    );
    try {
      const entry: RegistryEntry = {
        name: 'dangling',
        path: dir,
        storagePath,
        indexedAt: 'now',
        lastCommit: 'aaa',
        branch: 'main',
        branches: [{ branch: 'feature/z', indexedAt: 'now', lastCommit: 'zzz' }],
      };
      vi.mocked(listRegisteredRepos).mockResolvedValue([entry]);
      await backend.init();
      const callsBefore = vi.mocked(listRegisteredRepos).mock.calls.length;
      await expect(backend.resolveRepo('dangling', 'feature/z')).rejects.toThrow(/not indexed/i);
      expect(vi.mocked(listRegisteredRepos).mock.calls.length - callsBefore).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('callTool threads the branch param through resolveRepo (un-indexed branch errors)', async () => {
    // If callTool dropped `branch` from repoParams, this would resolve the flat
    // handle and NOT throw — so the rejection proves the param is threaded.
    await expect(backend.callTool('query', { repo: 'multi', branch: 'nope' })).rejects.toThrow(
      /not indexed/i,
    );
  });

  it('callTool resolves an indexed branch without error', async () => {
    const res = await backend.callTool('query', {
      query: 'auth',
      repo: 'multi',
      branch: 'feature/x',
    });
    expect(res).toBeDefined();
    expect(res).not.toHaveProperty('error');
  });

  it('evicts an opened branch pool when the repo leaves the registry (#2106 R3)', async () => {
    // Open the branch pool via a tool call (ensureInitialized records its key).
    await backend.callTool('query', { query: 'auth', repo: 'multi', branch: 'feature/x' });
    lbugMocks.closeLbug.mockClear();
    // Unregister the repo, then trigger a refresh (init re-reads the registry).
    (listRegisteredRepos as any).mockResolvedValue([]);
    await backend.init();
    const closedPaths = lbugMocks.closeLbug.mock.calls.map((c: any[]) => String(c[0]));
    expect(closedPaths.some((p) => p.includes(path.join('.gitnexus', 'branches')))).toBe(true);
  });
});
