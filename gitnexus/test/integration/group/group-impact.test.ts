/**
 * Group impact integration keeps a cheap mocked wiring test and adds a real
 * bridge-backed fixture path through GroupService using indexed fixture repos.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGroupImpactLegacy } from '../../../src/core/group/cross-impact.js';
import { parseGroupConfig } from '../../../src/core/group/config-parser.js';
import { GroupService } from '../../../src/core/group/service.js';
import { syncGroup } from '../../../src/core/group/sync.js';
import { runFullAnalysis } from '../../../src/core/run-analyze.js';
import type {
  ContractRegistry,
  RepoHandle,
  StoredContract,
} from '../../../src/core/group/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../fixtures/group');
const FIXTURE_REPOS = [
  ['platform/auth', 'test-monorepo/services/auth'],
  ['platform/orders', 'test-monorepo/services/orders'],
  ['platform/gateway', 'test-monorepo/services/gateway'],
] as const;
const ANALYZE_CALLBACKS = {
  onProgress: () => {},
  onLog: () => {},
};

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

function withIsolatedHomes<T>(run: (tempRoot: string) => Promise<T>): Promise<T> {
  const previous = {
    GITNEXUS_HOME: process.env.GITNEXUS_HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
  };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-group-impact-'));
  process.env.GITNEXUS_HOME = path.join(tempRoot, '.gitnexus-home');
  process.env.USERPROFILE = tempRoot;
  process.env.HOME = tempRoot;

  return run(tempRoot).finally(async () => {
    if (previous.GITNEXUS_HOME === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = previous.GITNEXUS_HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
  });
}

function stageFixtureRepos(tempRoot: string): string {
  const fixtureRoot = path.join(tempRoot, 'fixture-root');
  for (const [, relPath] of FIXTURE_REPOS) {
    const sourcePath = path.join(FIXTURES_DIR, relPath);
    const targetPath = path.join(fixtureRoot, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    fs.rmSync(path.join(targetPath, '.gitnexus'), { recursive: true, force: true });
  }
  return fixtureRoot;
}

async function analyzeStagedFixtureRepos(fixtureRoot: string): Promise<void> {
  for (const [, relPath] of FIXTURE_REPOS) {
    const repoPath = path.join(fixtureRoot, relPath);
    await runFullAnalysis(
      repoPath,
      {
        force: true,
        embeddings: false,
        skipAgentsMd: true,
      },
      ANALYZE_CALLBACKS,
    );
  }
}

function makeRepoHandle(
  fixtureRoot: string,
  groupPath: (typeof FIXTURE_REPOS)[number][0],
  registryName: string,
  fixtureRelPath = registryName,
): RepoHandle {
  const repoPath = path.join(fixtureRoot, fixtureRelPath);
  return {
    id: registryName,
    path: groupPath,
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  };
}

function makeMinimalImpact(result: { id: string; name: string; filePath: string; type?: string }): {
  target: { id: string; name: string; filePath: string; type: string };
  direction: 'upstream' | 'downstream';
  impactedCount: number;
  risk: 'LOW';
  summary: { direct: number; processes_affected: number; modules_affected: number };
  affected_processes: [];
  affected_modules: [];
  byDepth: { '1': Array<{ id: string; name: string; filePath: string }> };
} {
  return {
    target: {
      id: result.id,
      name: result.name,
      filePath: result.filePath,
      type: result.type ?? 'Function',
    },
    direction: 'upstream',
    impactedCount: 1,
    risk: 'LOW',
    summary: { direct: 1, processes_affected: 0, modules_affected: 0 },
    affected_processes: [],
    affected_modules: [],
    byDepth: {
      '1': [{ id: result.id, name: result.name, filePath: result.filePath }],
    },
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

  it('runs real cross-repo impact through bridge and indexed fixture repos', async () => {
    await withIsolatedHomes(async () => {
      const groupHome = process.env.GITNEXUS_HOME!;
      const groupDir = path.join(groupHome, 'groups', 'cross-repo-fixture');
      const fixtureRoot = stageFixtureRepos(groupHome);
      const groupYaml = `version: 1
name: cross-repo-fixture
description: "Cross-repo fixture backed by split monorepo services"

repos:
  platform/auth: auth
  platform/orders: orders
  platform/gateway: gateway

links:
  - from: platform/orders
    to: platform/auth
    type: grpc
    contract: "auth.AuthService/Login"
    role: consumer

packages: {}

detect:
  http: true
  grpc: false
  topics: false
  shared_libs: false
  embedding_fallback: false

matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`;
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'group.yaml'), groupYaml);

      await analyzeStagedFixtureRepos(fixtureRoot);

      const config = parseGroupConfig(groupYaml);
      const handles = new Map(
        FIXTURE_REPOS.map(([groupPath, relPath]) => [
          path.basename(relPath),
          makeRepoHandle(fixtureRoot, groupPath, path.basename(relPath), relPath),
        ]),
      );

      const syncResult = await syncGroup(config, {
        groupDir,
        resolveRepoHandle: async (registryName, groupPath) => {
          const fixtureRelPath = FIXTURE_REPOS.find(
            ([, relPath]) => path.basename(relPath) === registryName,
          )?.[1];
          if (!fixtureRelPath) return null;
          return makeRepoHandle(
            fixtureRoot,
            groupPath as (typeof FIXTURE_REPOS)[number][0],
            registryName,
            fixtureRelPath,
          );
        },
      });

      expect(syncResult.crossLinks.length).toBeGreaterThan(0);

      const bootstrapService = new GroupService({
        resolveRepo: async (repoParam?: string) => {
          const handle = handles.get(repoParam ?? '');
          if (!handle) throw new Error(`Unknown repo: ${repoParam ?? ''}`);
          return {
            id: handle.id,
            name: repoParam ?? handle.id,
            repoPath: handle.repoPath,
            storagePath: handle.storagePath,
          };
        },
        impact: async () => ({ error: 'bootstrap-only' }),
        query: async () => ({ processes: [] }),
        impactByUid: async () => null,
      });

      const bootstrapContracts = (await bootstrapService.groupContracts({
        name: 'cross-repo-fixture',
      })) as { contracts?: StoredContract[] };
      const contractRows = bootstrapContracts.contracts ?? [];
      const authProvider = contractRows.find(
        (contract) =>
          contract.repo === 'platform/auth' &&
          contract.role === 'provider' &&
          contract.contractId === 'grpc::auth.AuthService/Login',
      );
      const ordersConsumer = contractRows.find(
        (contract) =>
          contract.repo === 'platform/orders' &&
          contract.role === 'consumer' &&
          contract.contractId === 'grpc::auth.AuthService/Login',
      );

      expect(authProvider).toBeDefined();
      expect(ordersConsumer).toBeDefined();

      const groupService = new GroupService({
        resolveRepo: async (repoParam?: string) => {
          const handle = handles.get(repoParam ?? '');
          if (!handle) throw new Error(`Unknown repo: ${repoParam ?? ''}`);
          return {
            id: handle.id,
            name: repoParam ?? handle.id,
            repoPath: handle.repoPath,
            storagePath: handle.storagePath,
          };
        },
        impact: async (_repo, params) => {
          const contract = contractRows.find(
            (row) =>
              row.repo === 'platform/auth' &&
              row.role === 'provider' &&
              row.symbolName === params.target,
          );
          if (!contract) {
            return { error: `Target "${params.target}" not found in bridge contracts` };
          }
          return {
            ...makeMinimalImpact({
              id: contract.symbolUid || `${contract.repo}::${contract.contractId}`,
              name: contract.symbolName,
              filePath: contract.symbolRef.filePath,
            }),
            direction: params.direction,
          };
        },
        query: async () => ({ processes: [] }),
        impactByUid: async (repoId, uid, direction) => {
          const targetRepo = handles.get(repoId)?.path;
          const contract = contractRows.find(
            (row) =>
              row.repo === targetRepo &&
              (row.symbolUid === uid ||
                (row.repo === ordersConsumer?.repo &&
                  row.contractId === ordersConsumer?.contractId &&
                  row.symbolName === ordersConsumer?.symbolName)),
          );
          if (!contract) return null;
          return {
            ...makeMinimalImpact({
              id: contract.symbolUid || `${contract.repo}::${contract.contractId}`,
              name: contract.symbolName,
              filePath: contract.symbolRef.filePath,
            }),
            direction,
          };
        },
      });

      const result = (await groupService.groupImpact({
        name: 'cross-repo-fixture',
        repo: 'platform/auth',
        target: authProvider?.symbolName ?? 'AuthService.Login',
        direction: 'upstream',
      })) as {
        error?: string;
        cross?: Array<{ repo_path: string; contract: { id: string } }>;
        summary?: { cross_repo_hits: number };
      };

      expect(result.error).toBeUndefined();
      expect(result.summary?.cross_repo_hits).toBeGreaterThan(0);
      expect(
        result.cross?.some(
          (hit) =>
            hit.repo_path === 'platform/orders' &&
            hit.contract.id === 'grpc::auth.AuthService/Login',
        ),
      ).toBe(true);
    });
  }, 120000);
});
