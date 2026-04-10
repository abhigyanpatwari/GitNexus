import { describe, it, expect, vi } from 'vitest';
import { runGroupImpactLegacy, runGroupImpact } from '../../../src/core/group/cross-impact.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

describe('runGroupImpactLegacy', () => {
  const mockRegistry: ContractRegistry = {
    version: 1,
    generatedAt: '2026-03-31T10:00:00Z',
    repoSnapshots: {
      'app/backend': { indexedAt: '2026-03-31T09:00:00Z', lastCommit: 'abc123' },
      'app/frontend': { indexedAt: '2026-03-31T09:00:00Z', lastCommit: 'def456' },
    },
    missingRepos: [],
    contracts: [],
    crossLinks: [
      {
        from: {
          repo: 'app/frontend',
          symbolUid: 'uid-fetch',
          symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
        },
        to: {
          repo: 'app/backend',
          symbolUid: 'uid-ctrl',
          symbolRef: { filePath: 'src/ctrl.ts', name: 'UserController.list' },
        },
        type: 'http',
        contractId: 'http::GET::/api/users',
        matchType: 'exact',
        confidence: 1.0,
      },
    ],
  };

  it('returns local impact when no cross-links match', async () => {
    const result = await runGroupImpactLegacy({
      groupName: 'test',
      target: 'SomeUnrelatedFn',
      repoPath: 'app/backend',
      direction: 'upstream',
      registry: mockRegistry,
      localImpactFn: async () => ({
        target: { id: 'uid-x', name: 'SomeUnrelatedFn', filePath: 'src/x.ts' },
        direction: 'upstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: { '1': [{ id: 'uid-y', name: 'CallerFn', filePath: 'src/y.ts' }] },
      }),
      crossImpactFn: async () => null,
    });

    expect(result.cross).toHaveLength(0);
    expect(result.summary.cross_repo_hits).toBe(0);
    expect(result.risk).toBe('LOW');
  });

  it('fans out through cross-links for upstream direction', async () => {
    const result = await runGroupImpactLegacy({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      registry: mockRegistry,
      localImpactFn: async () => ({
        target: { id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' },
        direction: 'upstream',
        impactedCount: 2,
        risk: 'LOW',
        summary: { direct: 2, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {
          '1': [{ id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' }],
        },
      }),
      crossImpactFn: async () => ({
        target: { id: 'uid-fetch', name: 'fetchUsers', filePath: 'src/api.ts' },
        direction: 'upstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {
          '1': [
            { id: 'uid-profile', name: 'UserProfile', filePath: 'src/components/UserProfile.tsx' },
          ],
        },
      }),
    });

    expect(result.cross).toHaveLength(1);
    expect(result.cross[0].repo_path).toBe('app/frontend');
    expect(result.cross[0].contract.match_type).toBe('exact');
    expect(result.summary.cross_repo_hits).toBe(1);
    expect(['HIGH', 'CRITICAL']).toContain(result.risk);
  });

  it('fans out for downstream direction (consumer repo → provider repo)', async () => {
    const result = await runGroupImpactLegacy({
      groupName: 'test',
      target: 'fetchUsers',
      repoPath: 'app/frontend',
      direction: 'downstream',
      registry: mockRegistry,
      localImpactFn: async () => ({
        target: { id: 'uid-fetch', name: 'fetchUsers', filePath: 'src/api.ts' },
        direction: 'downstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: { '1': [{ id: 'uid-fetch', name: 'fetchUsers', filePath: 'src/api.ts' }] },
      }),
      crossImpactFn: async (groupPath, uid, _direction) => {
        expect(groupPath).toBe('app/backend');
        expect(uid).toBe('uid-ctrl');
        expect(_direction).toBe('downstream');
        return {
          byDepth: {
            '1': [{ id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' }],
          },
          affected_processes: [],
        };
      },
    });

    expect(result.cross).toHaveLength(1);
    expect(result.cross[0].repo_path).toBe('app/backend');
    expect(result.summary.cross_repo_hits).toBe(1);
  });

  it('respects subgroup filter', async () => {
    const result = await runGroupImpactLegacy({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      registry: mockRegistry,
      subgroup: 'other/team',
      localImpactFn: async () => ({
        target: { id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' },
        direction: 'upstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {
          '1': [{ id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' }],
        },
      }),
      crossImpactFn: async () => null,
    });

    expect(result.cross).toHaveLength(0);
    expect(result.outOfScope).toHaveLength(1);
    expect(result.outOfScope[0].from).toBe('app/frontend');
  });

  it('respects timeout and returns truncated result', async () => {
    const result = await runGroupImpactLegacy({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      timeout: 1,
      registry: mockRegistry,
      localImpactFn: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          target: { id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' },
          direction: 'upstream',
          impactedCount: 0,
          risk: 'LOW',
          summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
          affected_processes: [],
          affected_modules: [],
          byDepth: {},
        };
      },
      crossImpactFn: async () => null,
    });

    expect(result.truncated).toBe(true);
  });

  it.each([
    [500, 500],
    [5000, 1500],
    [30000, 9000],
    [60000, 10000],
  ])(
    'test_runGroupImpactLegacy_phase1_timeout_contract_%i_to_%i',
    async (timeout, expectedPhase1Timeout) => {
      const t0 = Date.now();
      const result = await runGroupImpactLegacy({
        groupName: 'test',
        target: 'slowTarget',
        repoPath: 'app/backend',
        direction: 'upstream',
        timeout,
        registry: mockRegistry,
        localImpactFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, expectedPhase1Timeout + 50));
          return {
            target: { id: '', name: 'slowTarget', filePath: '' },
            direction: 'upstream',
            impactedCount: 0,
            risk: 'LOW',
            summary: {},
            affected_processes: [],
            affected_modules: [],
            byDepth: {},
          };
        },
        crossImpactFn: async () => null,
      });
      expect(result.truncated).toBe(true);
      expect(Date.now() - t0).toBeLessThan(expectedPhase1Timeout + 250);
    },
  );
});

describe('runGroupImpact (Cypher-based)', () => {
  function makeBridgeQuery(rows: Record<string, unknown>[]) {
    return vi.fn().mockResolvedValue(rows);
  }

  const localImpactFn = async () => ({
    target: { id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' },
    direction: 'upstream',
    impactedCount: 2,
    risk: 'LOW',
    summary: { direct: 2, processes_affected: 0, modules_affected: 0 },
    affected_processes: [],
    affected_modules: [],
    byDepth: {
      '1': [{ id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' }],
    },
  });

  it('test_runGroupImpact_upstream_calls_bridgeQuery_with_correct_params', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'app/frontend',
        fanOutUid: 'uid-fetch',
        fanOutFilePath: 'src/api.ts',
        fanOutSymbolName: 'fetchUsers',
        matchedLocalUid: 'uid-ctrl',
        matchedLocalFilePath: 'src/ctrl.ts',
        matchedLocalSymbolName: 'UserController.list',
        matchType: 'exact',
        confidence: 1.0,
        contractId: 'http::GET::/api/users',
        contractType: 'http',
      },
    ]);
    const crossImpactFn = vi.fn().mockResolvedValue({
      byDepth: {
        '1': [
          { id: 'uid-profile', name: 'UserProfile', filePath: 'src/components/UserProfile.tsx' },
        ],
      },
      affected_processes: [],
    });

    const result = await runGroupImpact({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      bridgeQuery,
      localImpactFn,
      crossImpactFn,
    });

    expect(bridgeQuery).toHaveBeenCalledOnce();
    const [cypher, params] = bridgeQuery.mock.calls[0];
    expect(cypher).toContain('provider.repo = $sourceRepo');
    expect(params.sourceRepo).toBe('app/backend');
    expect(params.localUids).toContain('uid-ctrl');
    expect(params.minConfidence).toBe(0.5);
    expect(params.subgroup).toBeUndefined();

    expect(result.cross).toHaveLength(1);
    expect(result.cross[0].repo_path).toBe('app/frontend');
    expect(result.cross[0].contract.match_type).toBe('exact');
    expect(result.summary.cross_repo_hits).toBe(1);
    expect(result.outOfScope).toHaveLength(0);
  });

  it('test_runGroupImpact_refs_only_bridge_query_omits_empty_uid_clause', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'app/backend',
        fanOutUid: '',
        fanOutFilePath: 'src/ctrl.ts',
        fanOutSymbolName: 'UserController.list',
        matchedLocalUid: '',
        matchedLocalFilePath: 'src/api.ts',
        matchedLocalSymbolName: 'fetchUsers',
        matchType: 'exact',
        confidence: 1,
        contractId: 'http::GET::/api/users',
        contractType: 'http',
      },
    ]);
    const crossImpactFn = vi.fn().mockResolvedValue({
      byDepth: {},
      affected_processes: [],
    });

    const result = await runGroupImpact({
      groupName: 'test',
      target: 'fetchUsers',
      repoPath: 'app/frontend',
      direction: 'downstream',
      bridgeQuery,
      localImpactFn: async () => ({
        target: { id: '', name: 'fetchUsers', filePath: 'src/api.ts' },
        direction: 'downstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: {},
      }),
      crossImpactFn,
    });

    expect(bridgeQuery).toHaveBeenCalledOnce();
    const [cypher, params] = bridgeQuery.mock.calls[0];
    expect(cypher).toContain("(consumer.filePath + '::' + consumer.symbolName) IN $localRefs");
    expect(cypher).not.toContain('consumer.symbolUid IN $localUids');
    expect(params.localRefs).toEqual(['src/api.ts::fetchUsers']);
    expect(params.localUids).toBeUndefined();
    expect(result.summary.cross_repo_hits).toBe(1);
  });

  it('test_runGroupImpact_downstream_fans_out_to_provider', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'app/backend',
        fanOutUid: 'uid-ctrl',
        fanOutFilePath: 'src/ctrl.ts',
        fanOutSymbolName: 'UserController.list',
        matchedLocalUid: 'uid-fetch',
        matchedLocalFilePath: 'src/api.ts',
        matchedLocalSymbolName: 'fetchUsers',
        matchType: 'exact',
        confidence: 0.9,
        contractId: 'http::GET::/api/users',
        contractType: 'http',
      },
    ]);
    const crossImpactFn = vi.fn().mockResolvedValue({
      byDepth: { '1': [{ id: 'uid-ctrl', name: 'UserController.list', filePath: 'src/ctrl.ts' }] },
      affected_processes: [],
    });

    const result = await runGroupImpact({
      groupName: 'test',
      target: 'fetchUsers',
      repoPath: 'app/frontend',
      direction: 'downstream',
      bridgeQuery,
      localImpactFn: async () => ({
        target: { id: 'uid-fetch', name: 'fetchUsers', filePath: 'src/api.ts' },
        direction: 'downstream',
        impactedCount: 1,
        risk: 'LOW',
        summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
        affected_processes: [],
        affected_modules: [],
        byDepth: { '1': [{ id: 'uid-fetch', name: 'fetchUsers', filePath: 'src/api.ts' }] },
      }),
      crossImpactFn,
    });

    expect(bridgeQuery).toHaveBeenCalledOnce();
    const [cypher] = bridgeQuery.mock.calls[0];
    expect(cypher).toContain('consumer.repo = $sourceRepo');

    expect(crossImpactFn).toHaveBeenCalledWith('app/backend', 'uid-ctrl', 'downstream', undefined);
    expect(result.cross).toHaveLength(1);
    expect(result.cross[0].repo_path).toBe('app/backend');
    expect(result.summary.cross_repo_hits).toBe(1);
  });

  it('test_runGroupImpact_hint_passed_when_uid_empty', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'app/frontend',
        fanOutUid: '',
        fanOutFilePath: 'src/api.ts',
        fanOutSymbolName: 'fetchUsers',
        matchedLocalUid: 'uid-ctrl',
        matchedLocalFilePath: 'src/ctrl.ts',
        matchedLocalSymbolName: 'UserController.list',
        matchType: 'bm25',
        confidence: 0.7,
        contractId: 'grpc::UserService',
        contractType: 'grpc',
      },
    ]);
    const crossImpactFn = vi.fn().mockResolvedValue({
      byDepth: {},
      affected_processes: [],
    });

    await runGroupImpact({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      bridgeQuery,
      localImpactFn,
      crossImpactFn,
    });

    expect(crossImpactFn).toHaveBeenCalledWith('app/frontend', '', 'upstream', {
      filePath: 'src/api.ts',
      symbolName: 'fetchUsers',
    });
  });

  it('test_runGroupImpact_subgroup_passed_to_bridgeQuery', async () => {
    const bridgeQuery = makeBridgeQuery([]);
    const crossImpactFn = vi.fn();

    await runGroupImpact({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      subgroup: 'team/backend',
      bridgeQuery,
      localImpactFn,
      crossImpactFn,
    });

    expect(bridgeQuery).toHaveBeenCalledOnce();
    const [cypher, params] = bridgeQuery.mock.calls[0];
    // When subgroup is provided, the query should include the subgroup filter clause
    expect(params.subgroup).toBe('team/backend');
    // The Cypher should include the subgroup WHERE clause
    expect(cypher).toContain('$subgroup');
  });

  it('test_runGroupImpact_subgroup_filtered_rows_are_reported_out_of_scope', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'other/team/frontend',
        fanOutUid: 'uid-fetch',
        fanOutFilePath: 'src/api.ts',
        fanOutSymbolName: 'fetchUsers',
        matchedLocalUid: 'uid-ctrl',
        matchedLocalFilePath: 'src/ctrl.ts',
        matchedLocalSymbolName: 'UserController.list',
        matchType: 'exact',
        confidence: 1.0,
        contractId: 'http::GET::/api/users',
        contractType: 'http',
      },
    ]);

    const result = await runGroupImpact({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      subgroup: 'team/backend',
      bridgeQuery,
      localImpactFn,
      crossImpactFn: vi.fn().mockResolvedValue(null),
    });

    expect(result.cross).toHaveLength(0);
    expect(result.outOfScope).toEqual([
      expect.objectContaining({
        from: 'other/team/frontend',
        to: 'app/backend',
        contractId: 'http::GET::/api/users',
        matchType: 'exact',
      }),
    ]);
  });

  it('test_runGroupImpact_error_object_not_counted_as_hit', async () => {
    const bridgeQuery = makeBridgeQuery([
      {
        fanOutRepo: 'app/frontend',
        fanOutUid: 'uid-fetch',
        fanOutFilePath: 'src/api.ts',
        fanOutSymbolName: 'fetchUsers',
        matchedLocalUid: 'uid-ctrl',
        matchedLocalFilePath: 'src/ctrl.ts',
        matchedLocalSymbolName: 'UserController.list',
        matchType: 'exact',
        confidence: 1.0,
        contractId: 'http::GET::/api/users',
        contractType: 'http',
      },
    ]);
    const crossImpactFn = vi.fn().mockResolvedValue({ error: 'repo not indexed' });

    const result = await runGroupImpact({
      groupName: 'test',
      target: 'UserController.list',
      repoPath: 'app/backend',
      direction: 'upstream',
      bridgeQuery,
      localImpactFn,
      crossImpactFn,
    });

    expect(result.cross).toHaveLength(0);
    expect(result.summary.cross_repo_hits).toBe(0);
  });

  it.each([
    [500, 500],
    [5000, 1500],
    [30000, 9000],
    [60000, 10000],
  ])(
    'test_runGroupImpact_phase1_timeout_contract_%i_to_%i',
    async (timeout, expectedPhase1Timeout) => {
      const t0 = Date.now();
      const result = await runGroupImpact({
        groupName: 'test',
        target: 'slowTarget',
        repoPath: 'app/backend',
        direction: 'upstream',
        timeout,
        bridgeQuery: vi.fn().mockResolvedValue([]),
        localImpactFn: async () => {
          await new Promise((resolve) => setTimeout(resolve, expectedPhase1Timeout + 50));
          return {
            target: { id: '', name: 'slowTarget', filePath: '' },
            direction: 'upstream',
            impactedCount: 0,
            risk: 'LOW',
            summary: {},
            affected_processes: [],
            affected_modules: [],
            byDepth: {},
          };
        },
        crossImpactFn: vi.fn().mockResolvedValue(null),
      });
      expect(result.truncated).toBe(true);
      expect(Date.now() - t0).toBeLessThan(expectedPhase1Timeout + 250);
    },
  );
});
