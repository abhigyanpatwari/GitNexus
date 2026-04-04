/**
 * Group impact wiring — mocks `localImpactFn` / `crossImpactFn`. E2E with real graphs is a follow-up.
 */
import { describe, it, expect } from 'vitest';
import { runGroupImpactLegacy } from '../../../src/core/group/cross-impact.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

function minimalRegistry(crossLinks: ContractRegistry['crossLinks']): ContractRegistry {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots: {},
    missingRepos: [],
    contracts: [],
    crossLinks,
  };
}

describe('Group impact integration', () => {
  it('runs phase 1 and fan-out when cross-link matches UID', async () => {
    const registry = minimalRegistry([
      {
        from: {
          repo: 'app/frontend',
          symbolUid: 'remote-1',
          symbolRef: { filePath: 'f.ts', name: 'x' },
        },
        to: {
          repo: 'app/backend',
          symbolUid: 'local-target',
          symbolRef: { filePath: 'b.ts', name: 'y' },
        },
        type: 'http',
        contractId: 'http::GET::/x',
        matchType: 'exact',
        confidence: 1.0,
      },
    ]);

    const localImpactFn = async () => ({
      target: { id: 'local-target', name: 'T', filePath: 'b.ts' },
      direction: 'upstream',
      impactedCount: 1,
      risk: 'LOW',
      summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
      affected_processes: [],
      affected_modules: [],
      byDepth: { '1': [{ id: 'local-target', name: 'T', filePath: 'b.ts' }] },
    });

    let fanOutCalls = 0;
    const crossImpactFn = async (groupPath: string, uid: string, _direction: string) => {
      fanOutCalls++;
      expect(groupPath).toBe('app/frontend');
      expect(uid).toBe('remote-1');
      return { byDepth: {}, affected_processes: [] };
    };

    const result = await runGroupImpactLegacy({
      groupName: 'g',
      target: 'T',
      repoPath: 'app/backend',
      direction: 'upstream',
      registry,
      localImpactFn,
      crossImpactFn,
      crossDepth: 1,
      timeout: 5000,
    });

    expect(result.cross.length).toBe(1);
    expect(fanOutCalls).toBe(1);
    expect(result.summary.cross_repo_hits).toBe(1);
  });
});
