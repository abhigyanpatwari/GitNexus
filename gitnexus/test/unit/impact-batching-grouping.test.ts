import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lbug-adapter module before importing LocalBackend so the class
// uses the mocked implementations of executeQuery / executeParameterized.
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

// Use the exact import specifier including .js to match runtime imports
vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  initLbug: vi.fn(),
  executeQuery: (...args: any[]) => executeQueryMock(...args),
  executeParameterized: (...args: any[]) => executeParameterizedMock(...args),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn().mockReturnValue(true),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend';

describe('impact: batching and grouping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('batches 250 IDs into 3 chunked STEP_IN_PROCESS queries', async () => {
    // Prepare backend and a fake repo handle
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo1', name: 'repo1', repoPath: '/tmp/repo', storagePath: '/tmp/repo/.gitnexus',
      lbugPath: '/tmp/repo/.gitnexus/lbug', indexedAt: 'now', lastCommit: 'c', stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    // executeParameterized: resolve target -> return a symbol row
    executeParameterizedMock.mockResolvedValue([{ id: 'sym1', name: 'Target', filePath: 'f' }]);

    // Track chunk sizes
    const chunkSizes: number[] = [];
    let chunkCallIndex = 0;

    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      // Depth traversal query (find related nodes) -- return 250 impacted ids
      if (query.includes("r.type IN") && !query.includes('STEP_IN_PROCESS')) {
        const res: any[] = [];
        for (let i = 0; i < 250; i++) {
          res.push({ id: `node-${i}`, name: `n${i}`, filePath: `file-${i}.js`, relType: 'CALLS', confidence: null });
        }
        return res;
      }

      // Process-chunk enrichment queries -- called per chunk
      if (query.includes('STEP_IN_PROCESS')) {
        const cnt = (query.match(/'node-/g) || []).length;
        chunkSizes.push(cnt);
        const idx = chunkCallIndex++;
        // Return one row per chunk (entryPointId varies by index)
        return [{ entryPointId: `ep-${Math.floor(idx)}`, epName: `epName-${idx}`, epType: 'Function', epFilePath: `/path/${idx}`, hits: cnt, minStep: 1 }];
      }

      return [];
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
      id: 'repo2', name: 'repo2', repoPath: '/tmp/repo2', storagePath: '/tmp/repo2/.gitnexus',
      lbugPath: '/tmp/repo2/.gitnexus/lbug', indexedAt: 'now', lastCommit: 'c', stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);

    executeParameterizedMock.mockResolvedValue([{ id: 'symA', name: 'TargetA', filePath: 'f' }]);

    // Prepare impacted nodes: smaller set for clarity (6 nodes -> chunk size default 100 so single chunk)
    executeQueryMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes("r.type IN") && !query.includes('STEP_IN_PROCESS')) {
        // return 6 nodes
        const res: any[] = [];
        for (let i = 0; i < 6; i++) res.push({ id: `node-${i}`, name: `n${i}`, filePath: `file-${i}.js`, relType: 'CALLS', confidence: null });
        return res;
      }

      if (query.includes('STEP_IN_PROCESS')) {
        // Simulate rows where entryPointId repeats across nodes
        return [
          { entryPointId: 'ep-1', epName: 'EP1', epType: 'Function', epFilePath: '/p/1', hits: 2, minStep: 1 },
          { entryPointId: 'ep-2', epName: 'EP2', epType: 'Function', epFilePath: '/p/2', hits: 2, minStep: 2 },
          { entryPointId: 'ep-1', epName: 'EP1', epType: 'Function', epFilePath: '/p/1', hits: 1, minStep: 3 },
          { entryPointId: 'ep-3', epName: 'EP3', epType: 'Function', epFilePath: '/p/3', hits: 1, minStep: 1 },
        ];
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
});
