import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend } from '../../src/mcp/local/local-backend';
import { collectImpactSymbolUids } from '../../src/core/group/cross-impact';

function makeBackend() {
  const backend = new LocalBackend();
  const repoHandle = {
    id: 'repo1',
    name: 'repo1',
    repoPath: '/tmp/repo',
    storagePath: '/tmp/repo/.gitnexus',
    lbugPath: '/tmp/repo/.gitnexus/lbug',
    indexedAt: 'now',
    lastCommit: 'c',
    stats: {},
  } as any;
  (backend as any).repos.set(repoHandle.id, repoHandle);
  (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
  return { backend, repoHandle };
}

// The BFS frontier query is now parameterized (bound $frontierIds/$relTypes,
// #1907 U3), so the caller rows come back through executeParameterizedMock
// (matched on `r.type IN`) rather than executeQueryMock. Symbol resolution and
// the label-enrichment UNION still fall through to the default symbol row.
function setupMultiDepthHub(d1Count: number, d2Count: number) {
  let depth = 0;
  executeParameterizedMock.mockImplementation(async (...args: any[]) => {
    const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
    if (query.includes('STEP_IN_PROCESS')) return [];
    if (query.includes('MEMBER_OF')) return [];
    // The #1858 epistemic-boundary probe (computeEpistemicBoundary) runs
    // concurrently with the BFS and also matches `r.type IN`, but targets the
    // `iface` alias. Return empty so it stays `epistemic: 'exact'` and does not
    // consume a depth slot from the frontier counter below.
    if (query.includes('iface')) return [];
    if (query.includes('r.type IN')) {
      depth++;
      const count = depth === 1 ? d1Count : depth === 2 ? d2Count : 0;
      const res: any[] = [];
      for (let i = 0; i < count; i++) {
        res.push({
          id: `d${depth}-caller-${i}`,
          name: `d${depth}caller${i}`,
          filePath: `src/d${depth}-caller-${i}.ts`,
          relType: 'CALLS',
          confidence: null,
        });
      }
      return res;
    }
    return [{ id: 'hub1', name: 'HubSymbol', filePath: 'hub.ts' }];
  });

  executeQueryMock.mockImplementation(async () => []);
}

function setupHubSymbol(count: number) {
  executeParameterizedMock.mockImplementation(async (...args: any[]) => {
    const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
    if (query.includes('STEP_IN_PROCESS')) return [];
    if (query.includes('MEMBER_OF')) return [];
    // See setupMultiDepthHub — keep the #1858 epistemic probe from matching the
    // `r.type IN` caller branch below.
    if (query.includes('iface')) return [];
    if (query.includes('r.type IN')) {
      const res: any[] = [];
      for (let i = 0; i < count; i++) {
        res.push({
          id: `caller-${i}`,
          name: `caller${i}`,
          filePath: `src/caller-${i}.ts`,
          relType: 'CALLS',
          confidence: null,
        });
      }
      return res;
    }
    return [{ id: 'hub1', name: 'HubSymbol', filePath: 'hub.ts' }];
  });

  executeQueryMock.mockImplementation(async () => []);
}

describe('impact: pagination and summaryOnly (#414)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns byDepthCounts in default response', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(50);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(res.byDepthCounts).toEqual({ 1: 50 });
    expect(res.impactedCount).toBe(50);
    expect(res.byDepth).toBeDefined();
    expect(res.byDepth[1].length).toBe(50);
  });

  it('limit caps byDepth symbols per depth level', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(200);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 20,
    });

    expect(res.impactedCount).toBe(200);
    expect(res.byDepthCounts).toEqual({ 1: 200 });
    expect(res.byDepth[1].length).toBe(20);
    expect(res.pagination).toEqual({
      limit: 20,
      offset: 0,
      truncated: true,
    });
  });

  it('offset skips symbols before applying limit', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(200);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 20,
      offset: 10,
    });

    expect(res.byDepth[1].length).toBe(20);
    expect(res.byDepth[1][0].name).toBe('caller10');
    expect(res.pagination).toEqual({
      limit: 20,
      offset: 10,
      truncated: true,
    });
  });

  it('no pagination metadata when all results fit within limit', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(30);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 50,
    });

    expect(res.byDepth[1].length).toBe(30);
    expect(res.pagination).toBeUndefined();
  });

  it('default limit of 100 caps large result sets', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(400);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
    });

    expect(res.impactedCount).toBe(400);
    expect(res.byDepthCounts).toEqual({ 1: 400 });
    expect(res.byDepth[1].length).toBe(100);
    expect(res.pagination).toEqual({
      limit: 100,
      offset: 0,
      truncated: true,
    });
  });

  it('summaryOnly omits byDepth entirely', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(400);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      summaryOnly: true,
    });

    expect(res.impactedCount).toBe(400);
    expect(res.risk).toBe('CRITICAL');
    expect(res.byDepthCounts).toEqual({ 1: 400 });
    expect(res.summary.direct).toBe(400);
    expect(res.affected_processes).toBeDefined();
    expect(res.affected_modules).toBeDefined();
    expect(res.byDepth).toBeUndefined();
    expect(res.pagination).toBeUndefined();
  });

  it('summaryOnly response is small even for hub symbols', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(800);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      summaryOnly: true,
    });

    expect(res.impactedCount).toBe(800);
    expect(res.byDepthCounts).toEqual({ 1: 800 });
    expect(res.byDepth).toBeUndefined();
    expect(res.pagination).toBeUndefined();
  });

  it('limit clamps to 1–10000 range', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(10);

    const resZero = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 0,
    });
    expect(resZero.byDepth[1].length).toBe(1);

    const resNeg = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: -5,
    });
    expect(resNeg.byDepth[1].length).toBe(1);
  });

  it('multi-depth: each depth paginates independently', async () => {
    const { backend, repoHandle } = makeBackend();
    setupMultiDepthHub(150, 50);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 2,
      limit: 30,
    });

    expect(res.impactedCount).toBe(200);
    expect(res.byDepthCounts).toEqual({ 1: 150, 2: 50 });
    expect(res.byDepth[1].length).toBe(30);
    expect(res.byDepth[2].length).toBe(30);
    expect(res.pagination.truncated).toBe(true);
  });

  it('offset-only truncation: pagination metadata present when offset > 0 even if tail fits', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(50);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 100,
      offset: 10,
    });

    expect(res.byDepth[1].length).toBe(40);
    expect(res.pagination).toBeDefined();
    expect(res.pagination.truncated).toBe(true);
    expect(res.pagination.offset).toBe(10);
  });

  it('offset past end: returns empty byDepth with pagination metadata', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(50);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 20,
      offset: 100,
    });

    expect(res.impactedCount).toBe(50);
    expect(res.byDepthCounts).toEqual({ 1: 50 });
    expect(res.byDepth[1].length).toBe(0);
    expect(res.pagination).toBeDefined();
    expect(res.pagination.truncated).toBe(true);
  });

  it('float limit/offset are truncated to integers', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(50);

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'HubSymbol',
      direction: 'upstream',
      maxDepth: 1,
      limit: 20.7,
      offset: 5.9,
    });

    expect(res.byDepth[1].length).toBe(20);
    expect(res.byDepth[1][0].name).toBe('caller5');
    expect(res.pagination.limit).toBe(20);
    expect(res.pagination.offset).toBe(5);
  });

  it('_runImpactBFS without limit returns all symbols (internal caller path)', async () => {
    const { backend, repoHandle } = makeBackend();
    setupHubSymbol(400);

    const sym = { id: 'hub1', name: 'HubSymbol', filePath: 'hub.ts' };
    const res = await (backend as any)._runImpactBFS(repoHandle, sym, 'Function', 'upstream', {
      maxDepth: 1,
      relationTypes: ['CALLS'],
      includeTests: false,
      minConfidence: 0,
    });

    expect(res.impactedCount).toBe(400);
    expect(res.byDepth[1].length).toBe(400);
    expect(res.pagination).toBeUndefined();
  });
});

describe('collectImpactSymbolUids with paginated results', () => {
  it('collects all UIDs from complete byDepth', () => {
    const impact = {
      target: { id: 'target1', filePath: 'src/target.ts' },
      byDepth: {
        1: [
          { id: 'a', filePath: 'src/a.ts' },
          { id: 'b', filePath: 'src/b.ts' },
          { id: 'c', filePath: 'src/c.ts' },
        ],
      },
    };
    const { uids } = collectImpactSymbolUids(impact, undefined);
    expect(uids).toContain('target1');
    expect(uids).toContain('a');
    expect(uids).toContain('b');
    expect(uids).toContain('c');
    expect(uids.length).toBe(4);
  });

  it('only gets paginated subset when byDepth is capped', () => {
    const impact = {
      target: { id: 'target1', filePath: 'src/target.ts' },
      byDepthCounts: { 1: 300 },
      byDepth: {
        1: Array.from({ length: 100 }, (_, i) => ({
          id: `sym-${i}`,
          filePath: `src/sym-${i}.ts`,
        })),
      },
      pagination: { limit: 100, offset: 0, truncated: true },
    };
    const { uids } = collectImpactSymbolUids(impact, undefined);
    expect(uids.length).toBe(101);
  });
});
