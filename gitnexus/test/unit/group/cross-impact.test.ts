import { describe, it, expect } from 'vitest';
import { runGroupImpact } from '../../../src/core/group/cross-impact.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

describe('runGroupImpact', () => {
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
    const result = await runGroupImpact({
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
    const result = await runGroupImpact({
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
    const result = await runGroupImpact({
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
    const result = await runGroupImpact({
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
    const result = await runGroupImpact({
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
});
