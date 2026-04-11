import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GroupService,
  type GroupToolPort,
  type GroupRepoHandle,
} from '../../../src/core/group/service.js';
import { writeBridge } from '../../../src/core/group/bridge-db.js';
import type { ContractRegistry, StoredContract, CrossLink } from '../../../src/core/group/types.js';

/** Test helper: write legacy contracts.json for JSON-fallback tests */
async function writeContractRegistryJson(
  groupDir: string,
  registry: ContractRegistry,
): Promise<void> {
  const targetPath = path.join(groupDir, 'contracts.json');
  fs.writeFileSync(targetPath, JSON.stringify(registry, null, 2), 'utf-8');
}

function makeTmpGroup(): { tmpDir: string; groupDir: string; cleanup: () => void } {
  const tmpDir = path.join(
    os.tmpdir(),
    `gitnexus-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const groupDir = path.join(tmpDir, 'groups', 'test-group');
  fs.mkdirSync(groupDir, { recursive: true });

  const yaml = `version: 1
name: test-group
description: Test
repos:
  app/backend: test-backend
  app/frontend: test-frontend
`;
  fs.writeFileSync(path.join(groupDir, 'group.yaml'), yaml);

  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(
      async (name?: string): Promise<GroupRepoHandle> => ({
        id: name || 'test',
        name: name || 'test',
        repoPath: '/tmp/repo',
        storagePath: '/tmp/repo/.gitnexus',
      }),
    ),
    impact: vi.fn(async () => ({ symbols: [] })),
    query: vi.fn(async () => ({ processes: [] })),
    impactByUid: vi.fn(async () => null),
    ...overrides,
  };
}

function makeContract(id: string, role: 'provider' | 'consumer', repo: string): StoredContract {
  return {
    contractId: id,
    type: 'http',
    role,
    symbolUid: `uid-${repo}-${id}`,
    symbolRef: { filePath: `src/${repo}.ts`, name: `fn-${id}` },
    symbolName: `fn-${id}`,
    confidence: 0.8,
    meta: {},
    repo,
  };
}

function makeRegistry(contracts: StoredContract[], crossLinks: CrossLink[] = []): ContractRegistry {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repoSnapshots: {},
    missingRepos: [],
    contracts,
    crossLinks,
  };
}

describe('GroupService', () => {
  describe('groupList', () => {
    it('test_groupList_without_name_returns_group_names', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupList({})) as { groups: string[] };
        expect(result.groups).toContain('test-group');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupList_with_name_returns_config_details', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupList({ name: 'test-group' })) as {
          name: string;
          repos: Record<string, string>;
        };
        expect(result.name).toBe('test-group');
        expect(result.repos['app/backend']).toBe('test-backend');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });
  });

  describe('groupContracts', () => {
    it('test_groupContracts_returns_error_when_name_empty', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupContracts({})) as { error: string };
      expect(result.error).toContain('name is required');
    });

    it('test_groupContracts_no_data_returns_error', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group' })) as { error: string };
        expect(result.error).toContain('No contract data');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_json_fallback_returns_all_contracts', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          makeContract('http::GET::/api/users', 'consumer', 'app/frontend'),
        ];
        await writeContractRegistryJson(groupDir, makeRegistry(contracts));

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group' })) as {
          contracts: StoredContract[];
        };
        expect(result.contracts).toHaveLength(2);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_json_fallback_filters_by_type', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          {
            ...makeContract('grpc::auth.AuthService/Login', 'provider', 'app/backend'),
            type: 'grpc' as const,
          },
        ];
        await writeContractRegistryJson(groupDir, makeRegistry(contracts));

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group', type: 'grpc' })) as {
          contracts: StoredContract[];
        };
        expect(result.contracts).toHaveLength(1);
        expect(result.contracts[0].type).toBe('grpc');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_json_fallback_filters_by_repo', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          makeContract('http::GET::/api/users', 'consumer', 'app/frontend'),
        ];
        await writeContractRegistryJson(groupDir, makeRegistry(contracts));

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group', repo: 'app/backend' })) as {
          contracts: StoredContract[];
        };
        expect(result.contracts).toHaveLength(1);
        expect(result.contracts[0].repo).toBe('app/backend');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_json_fallback_unmatchedOnly_filters_matched', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const provider = makeContract('http::GET::/api/users', 'provider', 'app/backend');
        const consumer = makeContract('http::GET::/api/users', 'consumer', 'app/frontend');
        const orphan = makeContract('http::GET::/api/health', 'provider', 'app/backend');
        const crossLink: CrossLink = {
          from: {
            repo: 'app/frontend',
            symbolUid: 'uid-c',
            symbolRef: { filePath: 'f.ts', name: 'fn' },
          },
          to: {
            repo: 'app/backend',
            symbolUid: 'uid-p',
            symbolRef: { filePath: 'f.ts', name: 'fn' },
          },
          type: 'http',
          contractId: 'http::GET::/api/users',
          matchType: 'exact',
          confidence: 1.0,
        };
        await writeContractRegistryJson(
          groupDir,
          makeRegistry([provider, consumer, orphan], [crossLink]),
        );

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group', unmatchedOnly: true })) as {
          contracts: StoredContract[];
        };
        expect(result.contracts).toHaveLength(1);
        expect(result.contracts[0].contractId).toBe('http::GET::/api/health');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_with_bridge_returns_contracts', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          makeContract('http::GET::/api/users', 'consumer', 'app/frontend'),
        ];
        await writeBridge(groupDir, {
          contracts,
          crossLinks: [],
          repoSnapshots: {},
          missingRepos: [],
        });

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group' })) as {
          contracts: unknown[];
          crossLinks: unknown[];
        };
        expect(result.contracts).toHaveLength(2);
        expect(result.crossLinks).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_bridge_path_filters_by_type', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          {
            ...makeContract('grpc::auth.AuthService/Login', 'provider', 'app/backend'),
            type: 'grpc' as const,
          },
        ];
        await writeBridge(groupDir, {
          contracts,
          crossLinks: [],
          repoSnapshots: {},
          missingRepos: [],
        });

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group', type: 'grpc' })) as {
          contracts: { type: string }[];
        };
        expect(result.contracts).toHaveLength(1);
        expect(result.contracts[0].type).toBe('grpc');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_bridge_path_unmatchedOnly_filters_matched', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const provider = makeContract('http::GET::/api/users', 'provider', 'app/backend');
        const consumer = makeContract('http::GET::/api/users', 'consumer', 'app/frontend');
        const orphan = makeContract('http::GET::/api/health', 'provider', 'app/backend');
        const crossLink: CrossLink = {
          from: {
            repo: 'app/frontend',
            symbolUid: consumer.symbolUid,
            symbolRef: consumer.symbolRef,
          },
          to: {
            repo: 'app/backend',
            symbolUid: provider.symbolUid,
            symbolRef: provider.symbolRef,
          },
          type: 'http',
          contractId: 'http::GET::/api/users',
          matchType: 'exact',
          confidence: 1.0,
        };
        await writeBridge(groupDir, {
          contracts: [provider, consumer, orphan],
          crossLinks: [crossLink],
          repoSnapshots: {},
          missingRepos: [],
        });

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group', unmatchedOnly: true })) as {
          contracts: { contractId: string }[];
        };
        // Only the orphan should remain after filtering out matched ones
        expect(result.contracts).toHaveLength(1);
        expect(result.contracts[0].contractId).toBe('http::GET::/api/health');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });
  });

  describe('groupSync', () => {
    it('test_groupSync_returns_error_when_name_empty', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupSync({})) as { error: string };
      expect(result.error).toContain('name is required');
    });
  });

  describe('groupQuery', () => {
    it('test_groupQuery_returns_error_when_params_missing', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupQuery({})) as { error: string };
      expect(result.error).toContain('name and query are required');
    });

    it('test_groupQuery_merges_results_across_repos', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);

        const port = makePort({
          query: vi.fn(async () => ({
            processes: [{ name: 'process1', score: 0.9 }],
          })),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupQuery({ name: 'test-group', query: 'auth flow' })) as {
          group: string;
          query: string;
          results: unknown[];
          per_repo: Array<{ repo: string; count: number }>;
        };

        expect(result.group).toBe('test-group');
        expect(result.query).toBe('auth flow');
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.per_repo).toHaveLength(2);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupQuery_handles_failing_repo_gracefully', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);

        const port = makePort({
          resolveRepo: vi.fn(async (name?: string) => {
            if (name === 'test-backend') throw new Error('not indexed');
            return { id: 'fe', name: 'fe', repoPath: '/tmp', storagePath: '/tmp/.gitnexus' };
          }),
          query: vi.fn(async () => ({ processes: [{ name: 'p1' }] })),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupQuery({ name: 'test-group', query: 'test' })) as {
          per_repo: Array<{ repo: string; count: number }>;
        };

        const backendRepo = result.per_repo.find((r) => r.repo === 'app/backend');
        expect(backendRepo?.count).toBe(0);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupQuery_respects_subgroup_filter', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);

        const port = makePort({
          query: vi.fn(async () => ({ processes: [{ name: 'p1' }] })),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupQuery({
          name: 'test-group',
          query: 'test',
          subgroup: 'app/backend',
        })) as { per_repo: Array<{ repo: string; count: number }> };

        expect(result.per_repo).toHaveLength(1);
        expect(result.per_repo[0].repo).toBe('app/backend');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });
  });

  describe('groupImpact', () => {
    it('test_groupImpact_no_data_returns_error', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupImpact({
          name: 'test-group',
          target: 'someSymbol',
          repo: 'app/backend',
        })) as { error: string };
        expect(result.error).toContain('No contract data');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupImpact_with_json_fallback_uses_legacy', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [makeContract('http::GET::/api/users', 'provider', 'app/backend')];
        await writeContractRegistryJson(groupDir, makeRegistry(contracts));

        const port = makePort({
          impact: vi.fn(async () => ({
            target: { id: 'uid-1', name: 'someSymbol', filePath: 'src/app.ts' },
            direction: 'upstream',
            impactedCount: 0,
            risk: 'LOW',
            summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
            affected_processes: [],
            affected_modules: [],
            byDepth: {},
          })),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupImpact({
          name: 'test-group',
          target: 'someSymbol',
          repo: 'app/backend',
        })) as { local: unknown; group: string; risk: string };

        expect(result.group).toBe('test-group');
        expect(result.local).toBeDefined();
        expect(result.risk).toBeDefined();
        expect(port.impact).toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupImpact_with_bridge_uses_new_runGroupImpact', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [makeContract('http::GET::/api/users', 'provider', 'app/backend')];
        await writeBridge(groupDir, {
          contracts,
          crossLinks: [],
          repoSnapshots: {},
          missingRepos: [],
        });

        const port = makePort({
          impact: vi.fn(async () => ({
            target: { id: 'uid-1', name: 'someSymbol', filePath: 'src/app.ts' },
            direction: 'upstream',
            impactedCount: 0,
            risk: 'LOW',
            summary: { direct: 0, processes_affected: 0, modules_affected: 0 },
            affected_processes: [],
            affected_modules: [],
            byDepth: {},
          })),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupImpact({
          name: 'test-group',
          target: 'someSymbol',
          repo: 'app/backend',
        })) as { local: unknown; group: string; risk: string; cross: unknown[] };

        expect(result.group).toBe('test-group');
        expect(result.local).toBeDefined();
        expect(result.risk).toBeDefined();
        expect(result.cross).toEqual([]);
        expect(port.impact).toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupImpact_returns_error_when_params_missing', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupImpact({})) as { error: string };
      expect(result.error).toContain('name, target, and repo are required');
    });

    it('test_groupImpact_rejects_unknown_direction', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupImpact({
        name: 'x',
        target: 'x',
        repo: 'x',
        direction: 'upstreem', // typo
      })) as { error: string };
      expect(result.error).toMatch(/direction must be/);
    });

    it('test_groupImpact_rejects_out_of_range_maxDepth', async () => {
      const svc = new GroupService(makePort());
      for (const bad of [-1, 0, 11, 1000, 1.5, Number.NaN]) {
        const result = (await svc.groupImpact({
          name: 'x',
          target: 'x',
          repo: 'x',
          maxDepth: bad,
        })) as { error?: string };
        expect(result.error).toMatch(/maxDepth must be/);
      }
    });

    it('test_groupImpact_rejects_out_of_range_minConfidence', async () => {
      const svc = new GroupService(makePort());
      for (const bad of [-0.1, 1.1, -5, 10]) {
        const result = (await svc.groupImpact({
          name: 'x',
          target: 'x',
          repo: 'x',
          minConfidence: bad,
        })) as { error?: string };
        expect(result.error).toMatch(/minConfidence must be/);
      }
    });

    it('test_groupImpact_rejects_out_of_range_timeout', async () => {
      const svc = new GroupService(makePort());
      for (const bad of [0, 99, 300001, 1e9]) {
        const result = (await svc.groupImpact({
          name: 'x',
          target: 'x',
          repo: 'x',
          timeout: bad,
        })) as { error?: string };
        expect(result.error).toMatch(/timeout must be/);
      }
    });

    it('test_groupImpact_rejects_out_of_range_crossDepth', async () => {
      const svc = new GroupService(makePort());
      for (const bad of [-1, 11, 1.5, Number.NaN]) {
        const result = (await svc.groupImpact({
          name: 'x',
          target: 'x',
          repo: 'x',
          crossDepth: bad,
        })) as { error?: string };
        expect(result.error).toMatch(/crossDepth must be/);
      }
    });

    it('test_groupImpact_wraps_localImpactFn_exception_from_missing_repo', async () => {
      // If the configured repoGroupPath is not in the group's config, the
      // resolveGroupRepo helper throws. That exception must NOT bubble past
      // runPhase1WithTimeout — it should be caught inside safeLocalImpact
      // and surfaced as a local.error field on the result.
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        await writeContractRegistryJson(
          groupDir,
          makeRegistry([makeContract('http::GET::/api/x', 'provider', 'app/backend')]),
        );
        const svc = new GroupService(makePort());
        const result = (await svc.groupImpact({
          name: 'test-group',
          target: 'whatever',
          repo: 'not/in/config',
        })) as { local?: { error?: string } };
        // Should not throw; instead local.error is populated.
        expect(result).toBeDefined();
        expect(result.local?.error).toMatch(/local impact failed/);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });
  });

  describe('groupStatus', () => {
    it('test_groupStatus_returns_error_when_name_empty', async () => {
      const svc = new GroupService(makePort());
      const result = (await svc.groupStatus({})) as { error: string };
      expect(result.error).toContain('name is required');
    });

    it('test_groupStatus_no_data_returns_empty', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupStatus({ name: 'test-group' })) as {
          group: string;
          lastSync: null;
          missingRepos: string[];
          repos: Record<string, unknown>;
        };
        expect(result.group).toBe('test-group');
        expect(result.lastSync).toBeNull();
        expect(result.missingRepos).toEqual([]);
        expect(result.repos).toEqual({});
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupStatus_json_fallback_marks_unresolvable_repos_as_missing', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        await writeContractRegistryJson(groupDir, makeRegistry([]));

        const port = makePort({
          resolveRepo: vi.fn(async () => {
            throw new Error('repo not found');
          }),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupStatus({ name: 'test-group' })) as {
          group: string;
          repos: Record<string, { missing: boolean }>;
        };

        expect(result.group).toBe('test-group');
        expect(result.repos['app/backend'].missing).toBe(true);
        expect(result.repos['app/frontend'].missing).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupStatus_reads_from_bridge_meta_and_snapshots', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        await writeBridge(groupDir, {
          contracts: [],
          crossLinks: [],
          repoSnapshots: {
            'app/backend': { indexedAt: '2026-01-01T00:00:00Z', lastCommit: 'abc123' },
          },
          missingRepos: ['app/frontend'],
        });

        const port = makePort({
          resolveRepo: vi.fn(async () => {
            throw new Error('repo not found');
          }),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupStatus({ name: 'test-group' })) as {
          group: string;
          lastSync: string;
          missingRepos: string[];
          repos: Record<string, { missing: boolean }>;
        };

        expect(result.group).toBe('test-group');
        expect(result.lastSync).toBeTruthy();
        expect(result.missingRepos).toContain('app/frontend');
        expect(result.repos['app/backend'].missing).toBe(true);
        expect(result.repos['app/frontend'].missing).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupStatus_bridge_path_reads_repoSnapshots', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        await writeBridge(groupDir, {
          contracts: [],
          crossLinks: [],
          repoSnapshots: {
            'app/backend': { indexedAt: '2026-02-01T00:00:00Z', lastCommit: 'abc123' },
            'app/frontend': { indexedAt: '2026-02-01T00:00:00Z', lastCommit: 'def456' },
          },
          missingRepos: [],
        });

        const port = makePort({
          resolveRepo: vi.fn(async () => {
            throw new Error('repo not found');
          }),
        });

        const svc = new GroupService(port);
        const result = (await svc.groupStatus({ name: 'test-group' })) as {
          group: string;
          lastSync: string;
          missingRepos: string[];
          repos: Record<string, { missing: boolean }>;
        };

        expect(result.group).toBe('test-group');
        expect(result.lastSync).toBeTruthy();
        expect(result.missingRepos).toEqual([]);
        // Both repos should be marked missing since resolveRepo throws
        expect(result.repos['app/backend'].missing).toBe(true);
        expect(result.repos['app/frontend'].missing).toBe(true);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });
  });
});
