import { describe, it, expect } from 'vitest';
import type {
  GroupConfig,
  ContractType,
  ExtractedContract,
  CrossLink,
  ContractRegistry,
  GroupManifestLink,
  MatchType,
} from '../../../src/core/group/types.js';

describe('Group types', () => {
  it('GroupConfig has required fields', () => {
    const config: GroupConfig = {
      version: 1,
      name: 'company',
      description: 'All company microservices',
      repos: { 'hr/hiring/backend': 'hr-hiring-backend' },
      links: [],
      packages: {},
      detect: {
        http: true,
        grpc: true,
        topics: true,
        shared_libs: true,
        embedding_fallback: true,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
    };
    expect(config.version).toBe(1);
    expect(config.name).toBe('company');
  });

  it('ContractRegistry has required structure', () => {
    const registry: ContractRegistry = {
      version: 1,
      generatedAt: '2026-03-31T10:00:00Z',
      repoSnapshots: {
        'hr/hiring/backend': { indexedAt: '2026-03-30T21:14:14Z', lastCommit: '5838fb8d' },
      },
      missingRepos: [],
      contracts: [],
      crossLinks: [],
    };
    expect(registry.version).toBe(1);
    expect(registry.contracts).toHaveLength(0);
  });

  it('ExtractedContract accepts all contract types', () => {
    const types: ContractType[] = ['http', 'grpc', 'topic', 'lib', 'custom'];
    types.forEach((t) => {
      const contract: ExtractedContract = {
        contractId: `${t}::test`,
        type: t,
        role: 'provider',
        symbolUid: 'uid-123',
        symbolRef: { filePath: 'src/test.ts', name: 'testFn' },
        symbolName: 'testFn',
        confidence: 1.0,
        meta: {},
      };
      expect(contract.type).toBe(t);
    });
  });

  it('CrossLink stores match metadata', () => {
    const link: CrossLink = {
      from: {
        repo: 'frontend',
        symbolUid: 'uid-1',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
      },
      to: {
        repo: 'backend',
        symbolUid: 'uid-2',
        symbolRef: { filePath: 'src/ctrl.ts', name: 'UserController.list' },
      },
      type: 'http',
      contractId: 'http::GET::/api/users',
      matchType: 'exact',
      confidence: 1.0,
    };
    const _m: MatchType = link.matchType;
    expect(_m).toBe('exact');
  });

  it('GroupManifestLink is valid', () => {
    const l: GroupManifestLink = {
      from: 'a',
      to: 'b',
      type: 'http',
      contract: '/x',
      role: 'provider',
    };
    expect(l.contract).toBe('/x');
  });
});
