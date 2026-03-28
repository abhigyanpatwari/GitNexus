import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lbug-adapter module before importing LocalBackend so the class
// uses the mocked implementations of executeQuery / executeParameterized.
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

// Use the exact import specifier including .js to match runtime imports
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

describe('impact: batching and grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batches 250 IDs into 3 chunked STEP_IN_PROCESS queries', async () => {
    // Prepare backend and a fake repo handle
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

    // executeParameterized: resolve target -> return a symbol row (default)
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      // The initial target-resolution call will not contain STEP_IN_PROCESS
      if (!query.includes('STEP_IN_PROCESS'))
        return [{ id: 'sym1', name: 'Target', filePath: 'f' }];
      // For STEP_IN_PROCESS calls, fall through to test's executeQueryMock logic by returning [] here.
      return [];
    });

    // Track chunk sizes
    const chunkSizes: number[] = [];
    let chunkCallIndex = 0;

    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      // Depth traversal query (find related nodes) -- return 250 impacted ids
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        const res: any[] = [];
        for (let i = 0; i < 250; i++) {
          res.push({
            id: `node-${i}`,
            name: `n${i}`,
            filePath: `file-${i}.js`,
            relType: 'CALLS',
            confidence: null,
          });
        }
        return res;
      }

      // NOTE: process-chunk enrichment previously used executeQuery; our
      // implementation now calls executeParameterized for those chunks. We
      // still keep this branch to support any legacy calls, but primary
      // chunk tracking will be handled via executeParameterizedMock below.

      return [];
    });

    // Handle parameterized calls (including chunked STEP_IN_PROCESS queries)
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('STEP_IN_PROCESS')) {
        // Count ids passed in as params.ids
        const ids = Array.isArray(params.ids) ? params.ids : [];
        const cnt = ids.length;
        chunkSizes.push(cnt);
        const idx = chunkCallIndex++;
        return [
          {
            entryPointId: `ep-${Math.floor(idx)}`,
            epName: `epName-${idx}`,
            epType: 'Function',
            epFilePath: `/path/${idx}`,
            hits: cnt,
            minStep: 1,
          },
        ];
      }
      // Default target resolution
      return [{ id: 'sym1', name: 'Target', filePath: 'f' }];
    });

    const params = { target: 'Target', direction: 'downstream', maxDepth: 1 } as any;

    const res = await (backend as any)._impactImpl(repoHandle, params);

    // Expect 3 chunk calls: 100 + 100 + 50
    expect(chunkSizes.length).toBe(3);
    const total = chunkSizes.reduce((s, v) => s + v, 0);
    expect(total).toBe(250);

    // Result impacted count should be 250
    expect(res.impactedCount).toBe(250);
  });

  it('groups entry points across chunks and deduplicates correctly', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo2',
      name: 'repo2',
      repoPath: '/tmp/repo2',
      storagePath: '/tmp/repo2/.gitnexus',
      lbugPath: '/tmp/repo2/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (!query.includes('STEP_IN_PROCESS'))
        return [{ id: 'symA', name: 'TargetA', filePath: 'f' }];
      // For STEP_IN_PROCESS in this test, return grouping rows
      return [
        {
          entryPointId: 'ep-1',
          epName: 'EP1',
          epType: 'Function',
          epFilePath: '/p/1',
          hits: 2,
          minStep: 1,
        },
        {
          entryPointId: 'ep-2',
          epName: 'EP2',
          epType: 'Function',
          epFilePath: '/p/2',
          hits: 2,
          minStep: 2,
        },
        {
          entryPointId: 'ep-1',
          epName: 'EP1',
          epType: 'Function',
          epFilePath: '/p/1',
          hits: 1,
          minStep: 3,
        },
        {
          entryPointId: 'ep-3',
          epName: 'EP3',
          epType: 'Function',
          epFilePath: '/p/3',
          hits: 1,
          minStep: 1,
        },
      ];
    });

    // Prepare impacted nodes: smaller set for clarity (6 nodes -> chunk size default 100 so single chunk)
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        // return 6 nodes
        const res: any[] = [];
        for (let i = 0; i < 6; i++)
          res.push({
            id: `node-${i}`,
            name: `n${i}`,
            filePath: `file-${i}.js`,
            relType: 'CALLS',
            confidence: null,
          });
        return res;
      }

      return [];
    });

    const params = { target: 'TargetA', direction: 'downstream', maxDepth: 1 } as any;
    const res = await (backend as any)._impactImpl(repoHandle, params);

    // affected_processes should be grouped by entryPointId: ep-1, ep-2, ep-3 => 3 unique
    expect(Array.isArray(res.affected_processes)).toBe(true);
    const names = res.affected_processes.map((p: any) => p.name);
    expect(names.sort()).toEqual(['EP1', 'EP2', 'EP3'].sort());

    const ep1 = res.affected_processes.find((p: any) => p.name === 'EP1');
    expect(ep1.total_hits).toBe(3);

    const ep2 = res.affected_processes.find((p: any) => p.name === 'EP2');
    expect(ep2.total_hits).toBe(2);
  });

  it('caps enrichment to MAX_CHUNKS and sets partial when capped', async () => {
    // Temporarily set MAX_CHUNKS small for deterministic test
    process.env.IMPACT_MAX_CHUNKS = '3'; // CHUNK_SIZE 100 => maxItems = 300

    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo3',
      name: 'repo3',
      repoPath: '/tmp/repo3',
      storagePath: '/tmp/repo3/.gitnexus',
      lbugPath: '/tmp/repo3/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    // Depth traversal returns 500 impacted nodes
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        const res: any[] = [];
        for (let i = 0; i < 500; i++)
          res.push({
            id: `node-${i}`,
            name: `n${i}`,
            filePath: `file-${i}.js`,
            relType: 'CALLS',
            confidence: null,
          });
        return res;
      }
      return [];
    });

    const chunkSizes: number[] = [];

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      if (query.includes('STEP_IN_PROCESS')) {
        const ids = Array.isArray(params.ids) ? params.ids : [];
        chunkSizes.push(ids.length);
        return [
          {
            entryPointId: 'ep-x',
            epName: 'EPX',
            epType: 'Function',
            epFilePath: '/p/x',
            hits: ids.length,
            minStep: 1,
          },
        ];
      }

      if (query.includes('COUNT(DISTINCT s.id)')) {
        // moduleQuery: return a module row
        return [{ name: 'ModuleA', hits: 42 }];
      }

      if (query.includes('RETURN DISTINCT c.heuristicLabel')) {
        // directModuleQuery
        return [{ name: 'ModuleA' }];
      }

      // Default: target resolution
      return [{ id: 'symX', name: 'TargetX', filePath: 'f' }];
    });

    const params = { target: 'TargetX', direction: 'downstream', maxDepth: 1 } as any;
    const res = await (backend as any)._impactImpl(repoHandle, params);

    // Expect we processed only MAX_CHUNKS chunks (3) -> total ids handled = 300
    expect(chunkSizes.length).toBe(3);
    const totalHandled = chunkSizes.reduce((s, v) => s + v, 0);
    expect(totalHandled).toBe(300);

    // Because we capped enrichment, the result should include partial: true
    expect(res.partial).toBe(true);

    // Module enrichment should have been called in chunks (3 calls, totaling 300 ids)
    const memberCalls = (executeParameterizedMock.mock.calls || []).filter((c: any[]) => {
      const q = typeof c[1] === 'string' ? c[1] : String(c[0] ?? '');
      // Only count the module-hits query (which returns COUNT(DISTINCT s.id)).
      // The process-chunk query also uses COUNT(DISTINCT s.id), so require MEMBER_OF
      // to avoid double-counting process-chunk calls.
      return q.includes('COUNT(DISTINCT s.id)') && q.includes('MEMBER_OF');
    });
    // MAX_CHUNKS = 3 in this test, so expect 3 module-enrichment chunk calls
    // DEBUG: print memberCalls and their ids lengths
    expect(memberCalls.length).toBe(3);
    const totalModuleIds = memberCalls.reduce(
      (sum: number, call: any[]) => sum + (Array.isArray(call[2]?.ids) ? call[2].ids.length : 0),
      0,
    );
    // eslint-disable-next-line no-console
    expect(totalModuleIds).toBe(300);

    // Affected modules should include ModuleA
    expect(Array.isArray(res.affected_modules)).toBe(true);
    const modNames = res.affected_modules.map((m: any) => m.name);
    expect(modNames).toContain('ModuleA');

    // Cleanup env
    delete process.env.IMPACT_MAX_CHUNKS;
  });
});
