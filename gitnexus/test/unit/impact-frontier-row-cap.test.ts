/**
 * #3696 — the impact BFS reads at most IMPACT_FRONTIER_ROW_CAP relationship
 * rows per depth level. A capped level stops the walk, marks the result
 * partial, and cannot publish a LOW/MEDIUM risk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
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
  const actual = await importOriginal<typeof import('../../src/mcp/core/lbug-adapter.js')>();
  return {
    ...actual,
    initLbug: vi.fn(),
    executeQuery: (...args: any[]) => executeQueryMock(...args),
    executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
    closeLbug: vi.fn(),
    isLbugReady: vi.fn().mockReturnValue(true),
  };
});

import { LocalBackend, IMPACT_FRONTIER_ROW_CAP } from '../../src/mcp/local/local-backend.js';

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

/**
 * Every frontier query returns `rowCount` CALLS rows spread over
 * `distinctCallers` caller ids — duplicate edges, the shape a row-multiplying
 * query produces. Returns the frontier query texts seen.
 */
function setupFrontier(rowCount: number, distinctCallers: number): string[] {
  const frontierQueries: string[] = [];
  executeParameterizedMock.mockImplementation(async (...args: any[]) => {
    const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
    if (query.includes('STEP_IN_PROCESS')) return [];
    if (query.includes('MEMBER_OF')) return [];
    if (query.includes('RETURN h.id AS hid')) return [];
    if (query.includes('iface')) return [];
    if (query.includes('r.type IN')) {
      frontierQueries.push(query);
      const rows: any[] = new Array(rowCount);
      for (let i = 0; i < rowCount; i++) {
        const c = i % distinctCallers;
        rows[i] = {
          sourceId: 'hub1',
          id: `caller-${c}`,
          name: `caller${c}`,
          filePath: `src/caller-${c}.ts`,
          relType: 'CALLS',
          confidence: null,
        };
      }
      return rows;
    }
    return [{ id: 'hub1', name: 'HubSymbol', filePath: 'hub.ts' }];
  });
  executeQueryMock.mockImplementation(async () => []);
  return frontierQueries;
}

const impact = (backend: any, repoHandle: any, direction = 'upstream') =>
  backend._impactImpl(repoHandle, { target: 'HubSymbol', direction, maxDepth: 3 });

describe('impact: per-level frontier row cap (#3696)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the engine for at most one row past the cap', async () => {
    const { backend, repoHandle } = makeBackend();
    const queries = setupFrontier(1, 1);
    await impact(backend, repoHandle);
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q).toContain(`LIMIT ${IMPACT_FRONTIER_ROW_CAP + 1}`);
  });

  it('a level exactly at the cap is complete and keeps its measured risk', async () => {
    const { backend, repoHandle } = makeBackend();
    setupFrontier(IMPACT_FRONTIER_ROW_CAP, 1);
    const res = await impact(backend, repoHandle);
    expect(res.impactedCount).toBe(1);
    expect(res.risk).toBe('LOW');
    expect(res.partial).toBeUndefined();
  });

  it('a capped level stops the walk and cannot read as LOW', async () => {
    const { backend, repoHandle } = makeBackend();
    const queries = setupFrontier(IMPACT_FRONTIER_ROW_CAP + 1, 1);
    const res = await impact(backend, repoHandle);

    // No depth-2 query from an arbitrary subset of depth 1.
    expect(queries).toHaveLength(1);
    expect(res.impactedCount).toBe(1);
    expect(res.partial).toBe(true);
    expect(res.risk).toBe('UNKNOWN');
    expect(res.riskNote).toContain('depth 1');
    expect(res.riskNote).toContain(String(IMPACT_FRONTIER_ROW_CAP));
  });

  it('a capped level keeps a CRITICAL its counts already prove', async () => {
    const { backend, repoHandle } = makeBackend();
    setupFrontier(IMPACT_FRONTIER_ROW_CAP + 1, 300);
    const res = await impact(backend, repoHandle);
    expect(res.impactedCount).toBe(300);
    expect(res.risk).toBe('CRITICAL');
    expect(res.partial).toBe(true);
  });

  it('also bounds downstream traversal and reports its truncated counts', async () => {
    const { backend, repoHandle } = makeBackend();
    const queries = setupFrontier(IMPACT_FRONTIER_ROW_CAP + 1, 1);
    const res = await impact(backend, repoHandle, 'downstream');
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain(`LIMIT ${IMPACT_FRONTIER_ROW_CAP + 1}`);
    expect(res.impactedCount).toBe(1);
    expect(res.partial).toBe(true);
    expect(res.risk).toBe('UNKNOWN');
  });
});
