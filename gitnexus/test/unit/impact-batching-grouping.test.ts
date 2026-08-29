import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the lbug-adapter module before importing LocalBackend so the class
// uses the mocked implementations of executeQuery / executeParameterized.
const executeQueryMock = vi.fn();
const executeParameterizedMock = vi.fn();

// Mock both the canonical source (core/lbug/pool-adapter.js — what local-backend.ts
// imports) and the re-export shim (mcp/core/lbug-adapter.js) so the mocks intercept
// regardless of import path.
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

    // BFS frontier query is now parameterized (#1907 U3) — handled in
    // executeParameterizedMock below; executeQuery is unused by the impact path.
    executeQueryMock.mockImplementation(async () => []);

    // Handle parameterized calls (including chunked STEP_IN_PROCESS queries)
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      // Match only the aggregation chunk (which uses COUNT(DISTINCT s.id)),
      // not the per-symbol enrichment pass added by impact byDepth processes
      // (which also matches STEP_IN_PROCESS but has a different RETURN shape).
      if (query.includes('STEP_IN_PROCESS') && query.includes('COUNT(DISTINCT s.id)')) {
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
      // BFS frontier query (parameterized #1907 U3): return the 250 impacted ids.
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
      // BFS frontier query (parameterized #1907 U3): return 6 impacted nodes.
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
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

    // BFS frontier query is now parameterized (#1907 U3) — handled in
    // executeParameterizedMock above; executeQuery is unused by the impact path.
    executeQueryMock.mockImplementation(async () => []);

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

    // BFS frontier query is now parameterized (#1907 U3) — handled in
    // executeParameterizedMock below; executeQuery is unused by the impact path.
    executeQueryMock.mockImplementation(async () => []);

    const chunkSizes: number[] = [];

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      const params = args[2] || {};
      // Match only the aggregation chunk (which uses COUNT(DISTINCT s.id)),
      // not the per-symbol enrichment pass added by impact byDepth processes
      // (which also matches STEP_IN_PROCESS but has a different RETURN shape).
      if (query.includes('STEP_IN_PROCESS') && query.includes('COUNT(DISTINCT s.id)')) {
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

      // BFS frontier query (parameterized #1907 U3): return 500 impacted nodes.
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

    expect(totalModuleIds).toBe(300);

    // Affected modules should include ModuleA
    expect(Array.isArray(res.affected_modules)).toBe(true);
    const modNames = res.affected_modules.map((m: any) => m.name);
    expect(modNames).toContain('ModuleA');

    // Cleanup env
    delete process.env.IMPACT_MAX_CHUNKS;
  });

  it('marks IMPACT_MAX_CHUNKS=0 as unused process/module axes', async () => {
    process.env.IMPACT_MAX_CHUNKS = '0';
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-zero-budget',
      name: 'repo-zero-budget',
      repoPath: '/tmp/repo-zero-budget',
      storagePath: '/tmp/repo-zero-budget/.gitnexus',
      lbugPath: '/tmp/repo-zero-budget/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        return [
          {
            id: 'node-1',
            name: 'n1',
            filePath: 'file-1.js',
            relType: 'CALLS',
            confidence: null,
          },
        ];
      }
      return [{ id: 'symX', name: 'TargetX', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetX',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.riskScale.comparableAcrossKinds).toBe(false);
    expect(res.riskScale.unusedAxes).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'enrichment-budget-exhausted' })]),
    );
    delete process.env.IMPACT_MAX_CHUNKS;
  });

  it('marks swallowed process enrichment failures as unused process axes', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-enrich-fail',
      name: 'repo-enrich-fail',
      repoPath: '/tmp/repo-enrich-fail',
      storagePath: '/tmp/repo-enrich-fail/.gitnexus',
      lbugPath: '/tmp/repo-enrich-fail/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('STEP_IN_PROCESS')) {
        throw new Error('process chunk failed');
      }
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        return [
          {
            id: 'node-1',
            name: 'n1',
            filePath: 'file-1.js',
            relType: 'CALLS',
            confidence: null,
          },
        ];
      }
      return [{ id: 'symFail', name: 'TargetFail', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetFail',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.riskScale.unusedAxes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ axis: 'processes', reason: 'enrichment-query-failed' }),
      ]),
    );
    expect(res.risk).toBe('UNKNOWN');
    expect(res.partial).toBe(true);
    expect(res.riskNote).toContain('enrichment failed');
  });

  it('marks module query failure without discarding a successful process axis', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-module-fail',
      name: 'repo-module-fail',
      repoPath: '/tmp/repo-module-fail',
      storagePath: '/tmp/repo-module-fail/.gitnexus',
      lbugPath: '/tmp/repo-module-fail/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('MEMBER_OF')) throw new Error('module chunk failed');
      if (query.includes('STEP_IN_PROCESS') && query.includes('COUNT(DISTINCT s.id)')) {
        return [
          {
            pId: 'p1',
            entryPointId: 'ep1',
            epName: 'main',
            epType: 'Function',
            hits: 1,
            minStep: 1,
          },
        ];
      }
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        return [
          {
            id: 'node-1',
            name: 'n1',
            filePath: 'file-1.js',
            relType: 'CALLS',
            confidence: null,
          },
        ];
      }
      return [{ id: 'symModule', name: 'TargetModule', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetModule',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.affected_processes).toHaveLength(1);
    expect(res.riskScale.unusedAxes).toEqual([
      { axis: 'modules', reason: 'enrichment-query-failed' },
    ]);
    expect(res.risk).toBe('UNKNOWN');
    expect(res.partial).toBe(true);
  });

  it('keeps process risk measured when only minStep backfill fails', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-backfill-fail',
      name: 'repo-backfill-fail',
      repoPath: '/tmp/repo-backfill-fail',
      storagePath: '/tmp/repo-backfill-fail/.gitnexus',
      lbugPath: '/tmp/repo-backfill-fail/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('MIN(r.step) AS minStep') && !query.includes('COUNT(DISTINCT s.id)')) {
        throw new Error('minStep backfill failed');
      }
      if (query.includes('STEP_IN_PROCESS') && query.includes('COUNT(DISTINCT s.id)')) {
        return [
          {
            pId: 'p1',
            entryPointId: 'ep1',
            epName: 'main',
            epType: 'Function',
            hits: 1,
            minStep: null,
          },
        ];
      }
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        return [
          {
            id: 'node-1',
            name: 'n1',
            filePath: 'file-1.js',
            relType: 'CALLS',
            confidence: null,
          },
        ];
      }
      if (query.includes('MEMBER_OF')) return [];
      return [{ id: 'symBackfill', name: 'TargetBackfill', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetBackfill',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.affected_processes).toHaveLength(1);
    expect(res.riskScale.unusedAxes).toEqual([]);
    expect(res.risk).toBe('LOW');
    expect(res.partial).toBe(true);
  });

  it('keeps observed process warnings when a later enrichment chunk fails', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-later-process-fail',
      name: 'repo-later-process-fail',
      repoPath: '/tmp/repo-later-process-fail',
      storagePath: '/tmp/repo-later-process-fail/.gitnexus',
      lbugPath: '/tmp/repo-later-process-fail/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    let processChunk = 0;
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('STEP_IN_PROCESS') && query.includes('COUNT(DISTINCT s.id)')) {
        processChunk += 1;
        if (processChunk === 2) throw new Error('later process chunk failed');
        return Array.from({ length: 5 }, (_, index) => ({
          pId: `p${index}`,
          entryPointId: `ep${index}`,
          epName: `process-${index}`,
          epType: 'Function',
          hits: 1,
          minStep: 1,
        }));
      }
      if (query.includes('r.type IN') && !query.includes('STEP_IN_PROCESS')) {
        return Array.from({ length: 150 }, (_, index) => ({
          id: `node-${index}`,
          name: `n${index}`,
          filePath: `file-${index}.js`,
          relType: 'CALLS',
          confidence: null,
        }));
      }
      if (query.includes('MEMBER_OF')) return [];
      return [{ id: 'symLaterFail', name: 'TargetLaterFail', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetLaterFail',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.affected_processes).toHaveLength(5);
    expect(res.risk).toBe('CRITICAL');
    expect(res.riskScale.unusedAxes).toContainEqual({
      axis: 'processes',
      reason: 'enrichment-query-failed',
    });
    expect(res.partial).toBe(true);
  });

  it('does not invent direct/indirect module classification after backfill failure', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-module-classification-fail',
      name: 'repo-module-classification-fail',
      repoPath: '/tmp/repo-module-classification-fail',
      storagePath: '/tmp/repo-module-classification-fail/.gitnexus',
      lbugPath: '/tmp/repo-module-classification-fail/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;
    (backend as any).repos.set(repoHandle.id, repoHandle);
    (backend as any).ensureInitialized = vi.fn().mockResolvedValue(undefined);
    executeQueryMock.mockImplementation(async () => []);
    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = typeof args[1] === 'string' ? args[1] : String(args[0] ?? '');
      if (query.includes('MEMBER_OF') && query.includes('RETURN DISTINCT c.heuristicLabel')) {
        throw new Error('module classification failed');
      }
      if (query.includes('MEMBER_OF')) return [{ name: 'ModuleA', hits: 1 }];
      if (query.includes('STEP_IN_PROCESS')) return [];
      if (query.includes('r.type IN')) {
        return [
          {
            id: 'node-1',
            name: 'n1',
            filePath: 'file-1.js',
            relType: 'CALLS',
            confidence: null,
          },
        ];
      }
      return [{ id: 'symClassify', name: 'TargetClassify', filePath: 'f' }];
    });

    const res = await (backend as any)._impactImpl(repoHandle, {
      target: 'TargetClassify',
      direction: 'downstream',
      maxDepth: 1,
    } as any);
    expect(res.affected_modules).toEqual([
      expect.objectContaining({ name: 'ModuleA', impact: 'classification-unavailable' }),
    ]);
    expect(res.riskScale.unusedAxes).toEqual([]);
    expect(res.partial).toBe(true);
  });

  it('caps implicit object-callable expansion and reports partial impact', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-object-cap',
      name: 'repo-object-cap',
      repoPath: '/tmp/repo-object-cap',
      storagePath: '/tmp/repo-object-cap/.gitnexus',
      lbugPath: '/tmp/repo-object-cap/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = String(args[1] ?? '');
      if (
        query.includes("hm.type = 'HAS_METHOD'") &&
        query.includes('member:Function') &&
        query.includes('member:Method')
      ) {
        return Array.from({ length: 5001 }, (_, i) => ({
          id: `member-${i}`,
          name: `member${i}`,
          type: i % 2 === 0 ? 'Function' : 'Method',
          filePath: 'src/object.ts',
        }));
      }
      return [];
    });

    const result = await (backend as any)._runImpactBFS(
      repoHandle,
      { id: 'owner', name: 'owner' },
      'Const',
      'downstream',
      {
        maxDepth: 1,
        relationTypes: ['CALLS'],
        includeTests: false,
        minConfidence: 0,
        skipEpistemic: true,
        skipEnrichment: true,
      },
    );

    const memberCall = executeParameterizedMock.mock.calls.find((args: any[]) =>
      String(args[1] ?? '').includes('member:Function'),
    );
    const traversalCall = executeParameterizedMock.mock.calls.find((args: any[]) =>
      String(args[1] ?? '').includes('r.type IN $relTypes'),
    );
    expect(String(memberCall?.[1])).toContain('RETURN DISTINCT member.id AS id');
    expect(String(memberCall?.[1])).toContain('member:Method');
    expect(String(memberCall?.[1])).toContain('UNION ALL');
    expect(String(memberCall?.[1])).toContain('ORDER BY id');
    expect(String(memberCall?.[1])).toContain('LIMIT 5001');
    expect(traversalCall?.[2]?.frontierIds).toEqual(['owner']);
    expect(result.byDepth['1']).toHaveLength(5000);
    expect(result.partial).toBe(true);
    expect(result.riskScale.comparableAcrossKinds).toBe(false);
    expect(result.riskScale.unusedAxes).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: 'enrichment-skipped' })]),
    );
  });

  it('marks object impact partial when callable seeding fails', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-object-seed-failure',
      name: 'repo-object-seed-failure',
      repoPath: '/tmp/repo-object-seed-failure',
      storagePath: '/tmp/repo-object-seed-failure/.gitnexus',
      lbugPath: '/tmp/repo-object-seed-failure/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = String(args[1] ?? '');
      if (query.includes('member:Function')) throw new Error('seed unavailable');
      return [];
    });

    const result = await (backend as any)._runImpactBFS(
      repoHandle,
      { id: 'owner', name: 'owner' },
      'Const',
      'downstream',
      {
        maxDepth: 1,
        relationTypes: ['CALLS'],
        includeTests: false,
        minConfidence: 0,
        skipEpistemic: true,
        skipEnrichment: true,
      },
    );

    expect(result.partial).toBe(true);
  });

  it('marks class impact partial when structural seeding fails', async () => {
    const backend = new LocalBackend();
    const repoHandle = {
      id: 'repo-class-seed-failure',
      name: 'repo-class-seed-failure',
      repoPath: '/tmp/repo-class-seed-failure',
      storagePath: '/tmp/repo-class-seed-failure/.gitnexus',
      lbugPath: '/tmp/repo-class-seed-failure/.gitnexus/lbug',
      indexedAt: 'now',
      lastCommit: 'c',
      stats: {},
    } as any;

    executeParameterizedMock.mockImplementation(async (...args: any[]) => {
      const query = String(args[1] ?? '');
      if (query.includes('(c:Constructor)')) throw new Error('seed unavailable');
      return [];
    });

    const result = await (backend as any)._runImpactBFS(
      repoHandle,
      { id: 'class-owner', name: 'Owner' },
      'Class',
      'downstream',
      {
        maxDepth: 1,
        relationTypes: ['CALLS'],
        includeTests: false,
        minConfidence: 0,
        skipEpistemic: true,
        skipEnrichment: true,
      },
    );

    expect(result.partial).toBe(true);
  });
});
