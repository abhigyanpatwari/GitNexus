import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  GroupService,
  type GroupToolPort,
  type GroupRepoHandle,
} from '../../../src/core/group/service.js';
import { writeContractRegistry } from '../../../src/core/group/storage.js';
import type { ContractRegistry, StoredContract, CrossLink } from '../../../src/core/group/types.js';

function makeTmpGroup(): { tmpDir: string; groupDir: string; cleanup: () => void } {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-svc-${Date.now()}`);
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
    context: vi.fn(async () => ({
      status: 'found',
      symbol: { filePath: 'services/auth/x.ts', uid: 'u1', name: 'X' },
    })),
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

    it('test_groupContracts_returns_error_when_no_registry', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group' })) as { error: string };
        expect(result.error).toContain('No contracts.json');
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContracts_returns_all_contracts', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          makeContract('http::GET::/api/users', 'consumer', 'app/frontend'),
        ];
        await writeContractRegistry(groupDir, makeRegistry(contracts));

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

    it('test_groupContracts_filters_by_type', async () => {
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
        await writeContractRegistry(groupDir, makeRegistry(contracts));

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

    it('test_groupContracts_filters_by_repo', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const contracts = [
          makeContract('http::GET::/api/users', 'provider', 'app/backend'),
          makeContract('http::GET::/api/users', 'consumer', 'app/frontend'),
        ];
        await writeContractRegistry(groupDir, makeRegistry(contracts));

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

    it('test_groupContracts_unmatchedOnly_filters_matched', async () => {
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
        await writeContractRegistry(
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

    it('test_groupContracts_skips_corrupt_contract_rows', async () => {
      const { groupDir, cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const badJson = `{
          "version": 1,
          "generatedAt": "2026-01-01T00:00:00.000Z",
          "repoSnapshots": {},
          "missingRepos": [],
          "contracts": [
            { "not": "a-contract" },
            {
              "contractId": "http::GET::/ok",
              "type": "http",
              "repo": "app/backend",
              "role": "provider",
              "symbolUid": "u",
              "symbolRef": { "filePath": "a.ts", "name": "f" },
              "symbolName": "f",
              "confidence": 1,
              "meta": {}
            }
          ],
          "crossLinks": []
        }`;
        fs.writeFileSync(path.join(groupDir, 'contracts.json'), badJson, 'utf-8');

        const svc = new GroupService(makePort());
        const result = (await svc.groupContracts({ name: 'test-group' })) as {
          contracts: unknown[];
          skippedCorrupt?: number;
        };
        expect(result.contracts).toHaveLength(1);
        expect(result.skippedCorrupt).toBe(1);
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

    it('test_groupQuery_subgroupExact_skips_descendant_member_paths', async () => {
      const tmpDir = path.join(os.tmpdir(), `gitnexus-svc-nest-${Date.now()}`);
      const groupDir = path.join(tmpDir, 'groups', 'nest-group');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'group.yaml'),
        `version: 1
name: nest-group
repos:
  app/frontend: fe-root
  app/frontend/mobile: fe-nested
  app/backend: be1
`,
      );
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const query = vi.fn(async () => ({ processes: [{ name: 'p1' }] }));
        const port = makePort({ query });
        const svc = new GroupService(port);

        const prefixOnly = (await svc.groupQuery({
          name: 'nest-group',
          query: 'x',
          subgroup: 'app/frontend',
        })) as { per_repo: Array<{ repo: string }> };
        expect(prefixOnly.per_repo.map((r) => r.repo).sort()).toEqual([
          'app/frontend',
          'app/frontend/mobile',
        ]);

        const exact = (await svc.groupQuery({
          name: 'nest-group',
          query: 'x',
          subgroup: 'app/frontend',
          subgroupExact: true,
        })) as { per_repo: Array<{ repo: string }> };
        expect(exact.per_repo).toHaveLength(1);
        expect(exact.per_repo[0].repo).toBe('app/frontend');
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('groupImpact', () => {
    it('test_groupImpact_returns_validation_error', async () => {
      const svc = new GroupService(makePort());
      const r = (await svc.groupImpact({})) as { error: string };
      expect(r.error).toContain('name');
    });
  });

  describe('groupContext', () => {
    it('test_groupContext_requires_target_or_uid', async () => {
      const svc = new GroupService(makePort());
      const r = await svc.groupContext({ name: 'test-group' });
      expect(r.error).toContain('target');
    });

    it('test_groupContext_iterates_repos', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const port = makePort();
        const svc = new GroupService(port);
        const r = await svc.groupContext({ name: 'test-group', target: 'MySym' });
        expect(r.group).toBe('test-group');
        expect(r.results).toHaveLength(2);
        expect(port.context).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllEnvs();
        cleanup();
      }
    });

    it('test_groupContext_subgroupExact_skips_descendant_member_paths', async () => {
      const tmpDir = path.join(os.tmpdir(), `gitnexus-ctx-nest-${Date.now()}`);
      const groupDir = path.join(tmpDir, 'groups', 'nest-group');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'group.yaml'),
        `version: 1
name: nest-group
repos:
  app/frontend: fe-root
  app/frontend/mobile: fe-nested
`,
      );
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const port = makePort();
        const svc = new GroupService(port);
        await svc.groupContext({
          name: 'nest-group',
          target: 'X',
          subgroup: 'app/frontend',
          subgroupExact: true,
        });
        expect(port.context).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('test_groupContext_service_prefix_filters_payload', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);
        const port = makePort({
          context: vi.fn(async () => ({
            status: 'found',
            symbol: { filePath: 'other/path/x.ts', uid: 'u1', name: 'X' },
          })),
        });
        const svc = new GroupService(port);
        const r = await svc.groupContext({
          name: 'test-group',
          target: 'MySym',
          service: 'services/auth',
        });
        expect(r.results.every((x) => Object.keys(x.payload as object).length === 0)).toBe(true);
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

    it('test_groupStatus_marks_unresolvable_repos_as_missing', async () => {
      const { cleanup, tmpDir } = makeTmpGroup();
      try {
        vi.stubEnv('GITNEXUS_HOME', tmpDir);

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
  });
});
