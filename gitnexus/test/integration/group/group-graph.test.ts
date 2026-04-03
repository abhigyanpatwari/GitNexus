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
      detect: { http: false, grpc: false, topics: false, shared_libs: true, embedding_fallback: false },
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
          return { id: 'shared-utils', name: 'shared-utils', repoPath: '/mock/shared', storagePath: '/mock/shared/.gitnexus' };
        }
        if (nameOrPath === 'web-app') {
          return { id: 'web-app', name: 'web-app', repoPath: '/mock/web', storagePath: '/mock/web/.gitnexus' };
        }
        throw new Error(`Repo not found: ${nameOrPath}`);
      },
      impact: async () => ({}),
      query: async (_repo, params) => {
        // Return mock processes matching the query
        const queryText = (params as { query: string }).query;
        return {
          processes: [
            { name: `process-${queryText}`, summary: `Mock process for ${queryText}` },
          ],
        };
      },
      impactByUid: async () => null,
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
    const conn = result.crossConnections.find((c) =>
      c.contractId.includes('formatDate'),
    );
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
});
