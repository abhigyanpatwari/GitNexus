/**
 * Unit Tests: PDG impact dispatch — resolved-callee-id bridge (U6)
 *
 * Pins the U6 wiring that makes the U5 sound id-match actually fire end-to-end:
 *   1. the dispatch loads the slice blocks' `BasicBlock.calleeIds`
 *      (`calleeIdsOfBlocks`) from the SAME seed ∪ reachable set as the names, and
 *   2. the BFS evidence-stamping loop feeds the reached callee's resolved id
 *      (`relId`) into `pdgBridgeEvidenceForImpact`, so a first-hop callee is proven
 *      by `id ∈ sliceCalleeIds` (KTD3) rather than by leaf name.
 *
 * These drive the REAL `_runImpactBFS` (only `_runImpactPDG` is stubbed to supply
 * the slice blocks) so the `calleeId` wiring in the stamping loop is exercised, and
 * assert the verdict on the composed `interproceduralByDepth[depth][i].pdgEvidence`.
 *
 * Mocking mirrors test/unit/calltool-dispatch.test.ts exactly (same hoisted lbug
 * mocks, same READY-PDG-layer `loadMeta` stamp, `executeParameterized` typed to its
 * real signature via vi.mocked).
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

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));

vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos, loadMeta } from '../../src/storage/repo-manager.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const MOCK_REPO_ENTRY = {
  name: 'test-project',
  path: '/tmp/test-project',
  storagePath: '/tmp/.gitnexus/test-project',
  indexedAt: '2024-06-01T12:00:00Z',
  lastCommit: 'abc1234567890',
  stats: { files: 10, nodes: 50, edges: 100, communities: 3, processes: 5 },
};

const TARGET_ROW = {
  id: 'func:main',
  name: 'main',
  type: 'Function',
  filePath: 'src/index.ts',
};

/**
 * A `_runImpactPDG` stub result whose slice carries one reachable + one seed
 * block — the dispatch queries both for `callees`/`calleeIds` (seed ∪ reachable).
 */
const PDG_SLICE_RESULT = {
  mode: 'pdg',
  target: TARGET_ROW,
  direction: 'downstream',
  risk: 'UNKNOWN',
  impactedCount: 0,
  epistemic: 'pdg-intra-procedural',
  reachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
  // Intra-only slice ⇒ the intra reach the bridge keys on equals reachableBlocks
  // (FIX 6: bridge keys its first-hop-proven set on intraReachableBlocks).
  intraReachableBlocks: ['BasicBlock:src/index.ts:8:0:1'],
  seedBlocks: ['BasicBlock:src/index.ts:8:0:0'],
  blockCount: 1,
  affectedStatements: [{ line: 8, filePath: 'src/index.ts', text: 'callee()' }],
  affectedStatementCount: 1,
  criterionLine: 8,
};

/** Build a downstream BFS frontier row (one reached callee). */
function frontierRow(id: string, name: string) {
  return {
    sourceId: 'func:main',
    id,
    name,
    type: 'Function',
    filePath: 'src/callee.ts',
    relType: 'CALLS',
    confidence: 0.9,
  };
}

describe('LocalBackend PDG impact — resolved-callee-id bridge (U6)', () => {
  let backend: LocalBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    platformMocks.isVectorExtensionSupportedByPlatform.mockReturnValue(true);
    // READY PDG layer so the dispatch reaches the mode-dispatch / bridge surface.
    vi.mocked(loadMeta).mockResolvedValue({
      pdg: { maxCdgEdgesPerFunction: 0, maxReachingDefEdgesPerFunction: 0 },
    } as unknown as Awaited<ReturnType<typeof loadMeta>>);
    vi.mocked(listRegisteredRepos).mockResolvedValue([MOCK_REPO_ENTRY] as unknown as Awaited<
      ReturnType<typeof listRegisteredRepos>
    >);
    backend = new LocalBackend();
    await backend.init();
  });

  it('proves a seed-line callee by resolved id (calleeIds slice match overrides name path)', async () => {
    vi.spyOn(
      backend as unknown as { _runImpactPDG: () => Promise<unknown> },
      '_runImpactPDG',
    ).mockResolvedValueOnce({ ...PDG_SLICE_RESULT });

    // calleeIds carries the reached callee's id; callees carries a leaf name that
    // does NOT match the reached callee's name → only the id path can prove it.
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.calleeIds')) return [{ calleeIds: 'func:callee-A' }];
      if (query.includes('RETURN b.callees')) return [{ callees: 'someOtherLeaf' }];
      if (query.includes('r.type IN $relTypes') && !query.includes('STEP_IN_PROCESS')) {
        return [frontierRow('func:callee-A', 'callee')];
      }
      if (query.includes('COUNT(DISTINCT s.id)') || query.includes('RETURN s.id AS sid')) return [];
      // Target resolution (WHERE n.name = $symName) and any other read.
      return [TARGET_ROW];
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    // The reached callee is proven by id ∈ sliceCalleeIds even though its leaf
    // name is absent from sliceCalleeNames.
    expect(result.interproceduralByDepth[1][0]).toMatchObject({
      id: 'func:callee-A',
      pdgEvidence: 'callgraph-bridge',
    });
  });

  it('falls back to the name path when the calleeIds query errors (empty id set, no crash)', async () => {
    vi.spyOn(
      backend as unknown as { _runImpactPDG: () => Promise<unknown> },
      '_runImpactPDG',
    ).mockResolvedValueOnce({ ...PDG_SLICE_RESULT });

    // The calleeIds query throws → calleeIdsOfBlocks swallows → empty id set → the
    // bridge uses the name path (callees carries the reached callee's leaf name).
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.calleeIds')) throw new Error('calleeIds query failed');
      if (query.includes('RETURN b.callees')) return [{ callees: 'callee' }];
      if (query.includes('r.type IN $relTypes') && !query.includes('STEP_IN_PROCESS')) {
        return [frontierRow('func:callee-A', 'callee')];
      }
      if (query.includes('COUNT(DISTINCT s.id)') || query.includes('RETURN s.id AS sid')) return [];
      return [TARGET_ROW];
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });

    // No crash, no surfaced error; the name path proves the reached callee.
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('pdg');
    expect(result.interproceduralByDepth[1][0]).toMatchObject({
      id: 'func:callee-A',
      pdgEvidence: 'callgraph-bridge',
    });
  });

  it('discriminates same-leaf-name callees by id end-to-end (only the in-slice id is proven)', async () => {
    vi.spyOn(
      backend as unknown as { _runImpactPDG: () => Promise<unknown> },
      '_runImpactPDG',
    ).mockResolvedValueOnce({ ...PDG_SLICE_RESULT });

    // Two reached callees share the leaf name 'callee'. sliceCalleeIds carries ONLY
    // func:callee-A → the id path proves A and leaves B unproven, where the name
    // path (which sees 'callee' for both) would have over-attributed both.
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.calleeIds')) return [{ calleeIds: 'func:callee-A' }];
      if (query.includes('RETURN b.callees')) return [{ callees: 'callee' }];
      if (query.includes('r.type IN $relTypes') && !query.includes('STEP_IN_PROCESS')) {
        return [frontierRow('func:callee-A', 'callee'), frontierRow('func:callee-B', 'callee')];
      }
      if (query.includes('COUNT(DISTINCT s.id)') || query.includes('RETURN s.id AS sid')) return [];
      return [TARGET_ROW];
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });

    expect(result.error).toBeUndefined();
    const items = result.interproceduralByDepth[1] as Array<{ id: string; pdgEvidence: string }>;
    const byId = new Map(items.map((i) => [i.id, i.pdgEvidence]));
    // Only the in-slice id is proven; the same-named sibling is a proof failure.
    expect(byId.get('func:callee-A')).toBe('callgraph-bridge');
    expect(byId.get('func:callee-B')).toBe('unproven-bridge');
  });

  it('drops the truncation sentinel from the slice id set (R7 — never matched as an id)', async () => {
    vi.spyOn(
      backend as unknown as { _runImpactPDG: () => Promise<unknown> },
      '_runImpactPDG',
    ).mockResolvedValueOnce({ ...PDG_SLICE_RESULT });

    // calleeIds carries the sentinel '*' alongside a real id; callees has NO sentinel
    // (so the names-sentinel short-circuit does not fire and the id path runs). A
    // reached callee whose id is literally '*' must be UNPROVEN — the sentinel was
    // filtered out of the id set, so it can never false-match. (TAB-joined per the
    // CALLEE_ID_SEP delimiter — ids can contain spaces, so the cell is not space-joined.)
    vi.mocked(executeParameterized).mockImplementation(async (_repo, query) => {
      if (query.includes('RETURN b.calleeIds')) return [{ calleeIds: 'func:callee-A\t*' }];
      if (query.includes('RETURN b.callees')) return [{ callees: 'callee' }];
      if (query.includes('r.type IN $relTypes') && !query.includes('STEP_IN_PROCESS')) {
        return [frontierRow('func:callee-A', 'callee'), frontierRow('*', 'callee')];
      }
      if (query.includes('COUNT(DISTINCT s.id)') || query.includes('RETURN s.id AS sid')) return [];
      return [TARGET_ROW];
    });

    const result = await backend.callTool('impact', {
      target: 'main',
      direction: 'downstream',
      mode: 'pdg',
      line: 8,
    });

    expect(result.error).toBeUndefined();
    const items = result.interproceduralByDepth[1] as Array<{ id: string; pdgEvidence: string }>;
    const byId = new Map(items.map((i) => [i.id, i.pdgEvidence]));
    expect(byId.get('func:callee-A')).toBe('callgraph-bridge');
    expect(byId.get('*')).toBe('unproven-bridge');
  });
});
