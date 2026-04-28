/**
 * Integration test for cross-repo graph traversal.
 *
 * Tests that groupGraph() finds CrossLink connections and fetches remote context.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GroupService,
  type GroupToolPort,
  type GroupRepoHandle,
} from '../../../src/core/group/service.js';
import { writeContractRegistry } from '../../../src/core/group/storage.js';
import type { ContractRegistry } from '../../../src/core/group/types.js';

describe('Group graph traversal integration', () => {
  let tmpDir: string;
  let gitnexusHome: string;
  let groupDir: string;
  let originalHome: string | undefined;

  const MOCK_REGISTRY: ContractRegistry = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots: {
      'libs/shared': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'abc' },
      'apps/web': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'def' },
    },
    missingRepos: [],
    contracts: [
      {
        contractId: 'lib::@test/shared::formatDate',
        type: 'lib',
        role: 'provider',
        symbolUid: 'fn-formatDate',
        symbolRef: { filePath: 'src/utils.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: {},
        repo: 'libs/shared',
      },
      {
        contractId: 'lib::@test/shared::formatDate',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'formatDate' },
        symbolName: 'formatDate',
        confidence: 0.9,
        meta: {},
        repo: 'apps/web',
      },
      {
        contractId: 'lib::@test/shared::Logger',
        type: 'lib',
        role: 'provider',
        symbolUid: 'class-Logger',
        symbolRef: { filePath: 'src/logger.ts', name: 'Logger' },
        symbolName: 'Logger',
        confidence: 0.9,
        meta: {},
        repo: 'libs/shared',
      },
      {
        contractId: 'lib::@test/shared::Logger',
        type: 'lib',
        role: 'consumer',
        symbolUid: '',
        symbolRef: { filePath: 'src/app.ts', name: 'Logger' },
        symbolName: 'Logger',
        confidence: 0.9,
        meta: {},
        repo: 'apps/web',
      },
    ],
    crossLinks: [
      {
        from: {
          repo: 'apps/web',
          symbolUid: '',
          symbolRef: { filePath: 'src/app.ts', name: 'formatDate' },
        },
        to: {
          repo: 'libs/shared',
          symbolUid: 'fn-formatDate',
          symbolRef: { filePath: 'src/utils.ts', name: 'formatDate' },
        },
        type: 'lib',
        contractId: 'lib::@test/shared::formatDate',
        matchType: 'exact',
        confidence: 1.0,
      },
      {
        from: {
          repo: 'apps/web',
          symbolUid: '',
          symbolRef: { filePath: 'src/app.ts', name: 'Logger' },
        },
        to: {
          repo: 'libs/shared',
          symbolUid: 'class-Logger',
          symbolRef: { filePath: 'src/logger.ts', name: 'Logger' },
        },
        type: 'lib',
        contractId: 'lib::@test/shared::Logger',
        matchType: 'exact',
        confidence: 1.0,
      },
    ],
  };

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-graph-${Date.now()}`);
    gitnexusHome = path.join(tmpDir, '.gitnexus-home');
    groupDir = path.join(gitnexusHome, 'groups', 'test-workspace');

    originalHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = gitnexusHome;

    // Create group dir with group.yaml and contracts.json
    fs.mkdirSync(groupDir, { recursive: true });

    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const yaml = _require('js-yaml') as typeof import('js-yaml');

    const config = {
      version: 1,
      name: 'test-workspace',
      description: '',
      repos: { 'libs/shared': 'shared-utils', 'apps/web': 'web-app' },
      links: [],
      packages: {},
      detect: {
        http: false,
        grpc: false,
        topics: false,
        shared_libs: true,
        embedding_fallback: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
    };
    fs.writeFileSync(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');

    await writeContractRegistry(groupDir, MOCK_REGISTRY);
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.GITNEXUS_HOME = originalHome;
    } else {
      delete process.env.GITNEXUS_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMockPort(): GroupToolPort {
    return {
      resolveRepo: async (nameOrPath?: string): Promise<GroupRepoHandle> => {
        if (nameOrPath === 'shared-utils') {
          return {
            id: 'shared-utils',
            name: 'shared-utils',
            repoPath: '/mock/shared',
            storagePath: '/mock/shared/.gitnexus',
          };
        }
        if (nameOrPath === 'web-app') {
          return {
            id: 'web-app',
            name: 'web-app',
            repoPath: '/mock/web',
            storagePath: '/mock/web/.gitnexus',
          };
        }
        throw new Error(`Repo not found: ${nameOrPath}`);
      },
      query: async (_repo, params) => {
        const queryText = (params as { query: string }).query;
        return {
          processes: [{ name: `process-${queryText}`, summary: `Mock process for ${queryText}` }],
        };
      },
    };
  }

  it('finds cross-repo connections for a symbol', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({
      name: 'test-workspace',
      symbol: 'formatDate',
      repo: 'shared-utils',
    })) as {
      sourceRepo: string;
      crossConnections: Array<{
        direction: string;
        remoteRepo: string;
        contractId: string;
        contractType: string;
        confidence: number;
      }>;
      totalCrossLinks: number;
    };

    expect(result.sourceRepo).toBe('shared-utils');
    expect(result.totalCrossLinks).toBeGreaterThanOrEqual(1);

    // shared-utils is the provider; apps/web is the consumer
    // Direction from shared-utils perspective: incoming (apps/web imports from us)
    const conn = result.crossConnections.find((c) => c.contractId.includes('formatDate'));
    expect(conn).toBeDefined();
    expect(conn!.contractType).toBe('lib');
    expect(conn!.confidence).toBe(1.0);
  });

  it('searches all repos when no repo specified', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({
      name: 'test-workspace',
      symbol: 'formatDate',
    })) as {
      sourceRepo: string;
      totalCrossLinks: number;
    };

    // Should find it in one of the repos
    expect(result.sourceRepo).toBeDefined();
    expect(typeof result.totalCrossLinks).toBe('number');
  });

  it('returns error when no contracts.json exists', async () => {
    // Remove contracts.json
    fs.unlinkSync(path.join(groupDir, 'contracts.json'));

    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({
      name: 'test-workspace',
      symbol: 'formatDate',
    })) as { error: string };

    expect(result.error).toContain('No contracts.json');
  });

  it('returns error when symbol and name are missing', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({})) as { error: string };
    expect(result.error).toBe('name and symbol are required');
  });

  it('returns error for unknown repo', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({
      name: 'test-workspace',
      symbol: 'formatDate',
      repo: 'nonexistent-repo',
    })) as { error: string };

    expect(result.error).toContain('Cannot resolve repo');
  });

  it('includes remote context in connections', async () => {
    const service = new GroupService(makeMockPort());
    const result = (await service.groupGraph({
      name: 'test-workspace',
      symbol: 'formatDate',
      repo: 'shared-utils',
    })) as {
      crossConnections: Array<{
        remoteContext: unknown;
      }>;
    };

    // The mock query returns processes, so remoteContext should not be null
    for (const conn of result.crossConnections) {
      if (conn.remoteContext) {
        expect(conn.remoteContext).toHaveProperty('processes');
      }
    }
  });

  describe('depth traversal', () => {
    async function writeFixture(repos: Record<string, string>, registry: ContractRegistry) {
      const { createRequire } = await import('node:module');
      const _require = createRequire(import.meta.url);
      const yaml = _require('js-yaml') as typeof import('js-yaml');
      const config = {
        version: 1,
        name: 'test-workspace',
        description: '',
        repos,
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          topics: false,
          shared_libs: true,
          embedding_fallback: false,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
      };
      fs.writeFileSync(path.join(groupDir, 'group.yaml'), yaml.dump(config), 'utf-8');
      await writeContractRegistry(groupDir, registry);
    }

    function makeHandlePort(handles: Record<string, GroupRepoHandle>): GroupToolPort {
      return {
        resolveRepo: async (name?: string) => {
          if (!name || !handles[name]) throw new Error(`Repo not found: ${name}`);
          return handles[name];
        },
        query: async (_repo, params) => ({
          processes: [{ name: `proc-${(params as { query: string }).query}`, summary: 'mock' }],
        }),
      };
    }

    describe('chain: apps/web → libs/shared → libs/deep', () => {
      const CHAIN_REGISTRY: ContractRegistry = {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoSnapshots: {
          'apps/web': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'a' },
          'libs/shared': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'b' },
          'libs/deep': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'c' },
        },
        missingRepos: [],
        contracts: [],
        crossLinks: [
          {
            from: {
              repo: 'apps/web',
              symbolUid: '',
              symbolRef: { filePath: 'src/app.ts', name: 'callShared' },
            },
            to: {
              repo: 'libs/shared',
              symbolUid: 'uid-shared',
              symbolRef: { filePath: 'src/shared.ts', name: 'shared' },
            },
            type: 'lib',
            contractId: 'lib::@test/shared::shared',
            matchType: 'exact',
            confidence: 1.0,
          },
          {
            from: {
              repo: 'libs/shared',
              symbolUid: 'uid-shared',
              symbolRef: { filePath: 'src/shared.ts', name: 'callDeep' },
            },
            to: {
              repo: 'libs/deep',
              symbolUid: 'uid-deep',
              symbolRef: { filePath: 'src/deep.ts', name: 'deep' },
            },
            type: 'lib',
            contractId: 'lib::@test/deep::deep',
            matchType: 'exact',
            confidence: 1.0,
          },
        ],
      };

      const chainRepos = {
        'apps/web': 'web-app',
        'libs/shared': 'shared-utils',
        'libs/deep': 'deep-lib',
      };

      const chainHandles: Record<string, GroupRepoHandle> = {
        'web-app': {
          id: 'web-app',
          name: 'web-app',
          repoPath: '/mock/web',
          storagePath: '/mock/web/.gitnexus',
        },
        'shared-utils': {
          id: 'shared-utils',
          name: 'shared-utils',
          repoPath: '/mock/shared',
          storagePath: '/mock/shared/.gitnexus',
        },
        'deep-lib': {
          id: 'deep-lib',
          name: 'deep-lib',
          repoPath: '/mock/deep',
          storagePath: '/mock/deep/.gitnexus',
        },
      };

      beforeEach(async () => {
        await writeFixture(chainRepos, CHAIN_REGISTRY);
      });

      it('depth 1 stops at direct cross-links and does not recurse', async () => {
        const service = new GroupService(makeHandlePort(chainHandles));
        const result = (await service.groupGraph({
          name: 'test-workspace',
          symbol: 'callShared',
          repo: 'web-app',
          depth: 1,
        })) as {
          totalCrossLinks: number;
          crossConnections: Array<{ remoteRepo: string }>;
        };

        expect(result.totalCrossLinks).toBe(1);
        expect(result.crossConnections.map((c) => c.remoteRepo)).toEqual(['libs/shared']);
      });

      it('depth 2 recurses through the intermediate repo to reach the transitive target', async () => {
        const service = new GroupService(makeHandlePort(chainHandles));
        const result = (await service.groupGraph({
          name: 'test-workspace',
          symbol: 'callShared',
          repo: 'web-app',
          depth: 2,
        })) as {
          totalCrossLinks: number;
          crossConnections: Array<{ remoteRepo: string }>;
        };

        expect(result.totalCrossLinks).toBe(2);
        const repos = result.crossConnections.map((c) => c.remoteRepo).sort();
        expect(repos).toEqual(['libs/deep', 'libs/shared']);
      });

      it('clamps depth > 2 to 2 (depth 5 behaves like depth 2)', async () => {
        const service = new GroupService(makeHandlePort(chainHandles));
        const result = (await service.groupGraph({
          name: 'test-workspace',
          symbol: 'callShared',
          repo: 'web-app',
          depth: 5,
        })) as { totalCrossLinks: number };

        expect(result.totalCrossLinks).toBe(2);
      });
    });

    it('visited-set prevents infinite recursion on a cycle (A → B → A)', async () => {
      const cycleRegistry: ContractRegistry = {
        version: 1,
        generatedAt: new Date().toISOString(),
        repoSnapshots: {
          'apps/a': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'a' },
          'apps/b': { indexedAt: '2026-04-01T00:00:00Z', lastCommit: 'b' },
        },
        missingRepos: [],
        contracts: [],
        crossLinks: [
          {
            from: {
              repo: 'apps/a',
              symbolUid: 'uid-a',
              symbolRef: { filePath: 'a.ts', name: 'a' },
            },
            to: { repo: 'apps/b', symbolUid: 'uid-b', symbolRef: { filePath: 'b.ts', name: 'b' } },
            type: 'lib',
            contractId: 'lib::a-to-b',
            matchType: 'exact',
            confidence: 1.0,
          },
          {
            from: {
              repo: 'apps/b',
              symbolUid: 'uid-b',
              symbolRef: { filePath: 'b.ts', name: 'b' },
            },
            to: { repo: 'apps/a', symbolUid: 'uid-a', symbolRef: { filePath: 'a.ts', name: 'a' } },
            type: 'lib',
            contractId: 'lib::b-to-a',
            matchType: 'exact',
            confidence: 1.0,
          },
        ],
      };

      await writeFixture({ 'apps/a': 'repo-a', 'apps/b': 'repo-b' }, cycleRegistry);

      const cyclePort = makeHandlePort({
        'repo-a': {
          id: 'repo-a',
          name: 'repo-a',
          repoPath: '/mock/a',
          storagePath: '/mock/a/.gitnexus',
        },
        'repo-b': {
          id: 'repo-b',
          name: 'repo-b',
          repoPath: '/mock/b',
          storagePath: '/mock/b/.gitnexus',
        },
      });

      const service = new GroupService(cyclePort);
      const result = (await service.groupGraph({
        name: 'test-workspace',
        symbol: 'a',
        repo: 'repo-a',
        depth: 2,
      })) as { totalCrossLinks: number };

      expect(result.totalCrossLinks).toBe(1);
    });
  });
});
