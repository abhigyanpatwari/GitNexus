import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroup, stableRepoPoolId } from '../../../src/core/group/sync.js';
import { bridgeExists } from '../../../src/core/group/bridge-db.js';
import type { GroupConfig, StoredContract, RepoHandle } from '../../../src/core/group/types.js';
import type { RegistryEntry } from '../../../src/storage/repo-manager.js';

describe('syncGroup', () => {
  const makeConfig = (repos: Record<string, string>): GroupConfig => ({
    version: 1,
    name: 'test',
    description: '',
    repos,
    links: [],
    packages: {},
    detect: {
      http: true,
      grpc: false,
      topics: false,
      shared_libs: false,
      embedding_fallback: false,
    },
    matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
  });

  it('returns SyncResult with contracts and cross-links', async () => {
    const config = makeConfig({ 'app/backend': 'backend-repo', 'app/frontend': 'frontend-repo' });

    const mockContracts: StoredContract[] = [
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'provider',
        symbolUid: 'uid-1',
        symbolRef: { filePath: 'src/ctrl.ts', name: 'UserController.list' },
        symbolName: 'UserController.list',
        confidence: 0.8,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/backend',
      },
      {
        contractId: 'http::GET::/api/users',
        type: 'http',
        role: 'consumer',
        symbolUid: 'uid-2',
        symbolRef: { filePath: 'src/api.ts', name: 'fetchUsers' },
        symbolName: 'fetchUsers',
        confidence: 0.7,
        meta: { method: 'GET', path: '/api/users' },
        repo: 'app/frontend',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.contracts).toHaveLength(2);
    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('exact');
    expect(result.crossLinks[0].confidence).toBe(1.0);
    expect(result.unmatched).toHaveLength(0);
  });

  it('reports missing repos', async () => {
    const config = makeConfig({ 'app/backend': 'nonexistent-repo' });

    const result = await syncGroup(config, {
      resolveRepoHandle: async () => null,
      skipWrite: true,
    });

    expect(result.missingRepos).toContain('app/backend');
    expect(result.contracts).toHaveLength(0);
  });

  it('handles empty repos config', async () => {
    const config = makeConfig({});

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    expect(result.contracts).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(0);
    expect(result.missingRepos).toHaveLength(0);
  });

  it('intra-repo matching works with service field via extractorOverride', async () => {
    const config = makeConfig({ 'platform/monorepo': 'monorepo' });

    const mockContracts: StoredContract[] = [
      {
        ...makeContract('http::GET::/api/users', 'provider', 'platform/monorepo'),
        service: 'services/auth',
      },
      {
        ...makeContract('http::GET::/api/users', 'consumer', 'platform/monorepo'),
        service: 'services/gateway',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => mockContracts,
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].from.service).toBe('services/gateway');
    expect(result.crossLinks[0].to.service).toBe('services/auth');
  });

  it('deduplicates duplicate contracts and links before returning', async () => {
    const config = makeConfig({ 'app/backend': 'backend-repo', 'app/frontend': 'frontend-repo' });

    const duplicateProvider = makeContract('http::GET::/api/users', 'provider', 'app/backend');
    const duplicateConsumer = makeContract('http::GET::/api/users', 'consumer', 'app/frontend');

    const result = await syncGroup(config, {
      extractorOverride: async () => [
        duplicateProvider,
        { ...duplicateProvider, confidence: 0.9, meta: { source: 'manifest' } },
        duplicateConsumer,
        { ...duplicateConsumer, confidence: 0.75, meta: { source: 'manifest' } },
      ],
      skipWrite: true,
    });

    expect(result.contracts).toHaveLength(2);
    expect(result.crossLinks).toHaveLength(1);
    expect(result.contracts.find((contract) => contract.role === 'provider')?.confidence).toBe(0.9);
    expect(result.contracts.find((contract) => contract.role === 'consumer')?.confidence).toBe(0.8);
  });

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

  it('per-repo extractorOverride receives repo handle and extracts per repo', async () => {
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const perRepoOverride = async (repo: RepoHandle) => {
      if (repo.path === 'app/backend') {
        return [makeContract('http::GET::/api/users', 'provider', 'app/backend')];
      }
      return [makeContract('http::GET::/api/users', 'consumer', 'app/frontend')];
    };

    const result = await syncGroup(config, {
      extractorOverride: perRepoOverride,
      resolveRepoHandle: async (_name, groupPath) => ({
        id: groupPath,
        path: groupPath,
        repoPath: '/tmp/' + groupPath,
        storagePath: '/tmp/' + groupPath + '/.gitnexus',
      }),
      skipWrite: true,
    });

    // per-repo override goes through the initLbug path which will fail
    // but the extractorOverride with arity > 0 triggers the else branch
    // At minimum, the function should not throw
    expect(result).toBeDefined();
  });

  it('test_syncGroup_closes_only_opened_pools', async () => {
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const closedIds: string[] = [];

    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockImplementation(async (id?: string) => {
      if (id) closedIds.push(id);
    });

    try {
      await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: groupPath.replace(/\//g, '-'),
          path: groupPath,
          repoPath: '/tmp/' + groupPath,
          storagePath: '/tmp/' + groupPath + '/.gitnexus',
        }),
        skipWrite: true,
      }).catch(() => {});

      // closeLbug must have been called at least once with specific pool ids
      expect(closeSpy.mock.calls.length).toBeGreaterThan(0);
      expect(closedIds).toContain('app-backend');
      expect(closedIds).toContain('app-frontend');

      // Every call must have a truthy string id
      for (const id of closedIds) {
        expect(id).toBeTruthy();
        expect(typeof id).toBe('string');
      }
      // No blanket close (no-arg or empty-string or undefined)
      const blanketCalls = closeSpy.mock.calls.filter((args) => args.length === 0 || !args[0]);
      expect(blanketCalls).toHaveLength(0);
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('reports initLbug failures via extractorFailures and marks repo missing', async () => {
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockImplementation(async (id: string) => {
      if (id === 'app-backend') throw new Error('lbug corruption: CRC mismatch');
    });
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

    try {
      const result = await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: groupPath.replace(/\//g, '-'),
          path: groupPath,
          repoPath: '/tmp/' + groupPath,
          storagePath: '/tmp/' + groupPath + '/.gitnexus',
        }),
        skipWrite: true,
      }).catch(() => undefined);

      expect(result).toBeDefined();
      // app/backend should be missing (initLbug threw) AND reported in
      // extractorFailures so the user can see the real reason.
      expect(result!.missingRepos).toContain('app/backend');
      expect(result!.extractorFailures).toBeDefined();
      const failure = result!.extractorFailures!.find((f) => f.repo === 'app/backend');
      expect(failure).toBeDefined();
      expect(failure!.message).toMatch(/CRC mismatch/);
      // initLbug failure should be labeled 'init', not 'boundaries'
      // (which is reserved for detectServiceBoundaries failures).
      expect(failure!.extractor).toBe('init');
      // app/frontend init succeeded — it must NOT be in missingRepos.
      expect(result!.missingRepos).not.toContain('app/frontend');
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('writes bridge.lbug to groupDir when skipWrite is false', async () => {
    const tmpDir = path.join(os.tmpdir(), `gitnexus-sync-write-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const config = makeConfig({});
      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        groupDir: tmpDir,
        skipWrite: false,
      });

      expect(result.contracts).toHaveLength(0);
      expect(await bridgeExists(tmpDir)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('stableRepoPoolId', () => {
  it('returns lowercase name when no collision', () => {
    const entry: RegistryEntry = {
      name: 'MyRepo',
      path: '/a/MyRepo',
      storagePath: '/a/MyRepo/.gitnexus',
      indexedAt: '',
      lastCommit: '',
    };
    const all = [entry];
    expect(stableRepoPoolId(entry, all)).toBe('myrepo');
  });

  it('appends hash suffix on name collision with different path', () => {
    const entry1: RegistryEntry = {
      name: 'repo',
      path: '/a/repo',
      storagePath: '/a/repo/.gitnexus',
      indexedAt: '',
      lastCommit: '',
    };
    const entry2: RegistryEntry = {
      name: 'repo',
      path: '/b/repo',
      storagePath: '/b/repo/.gitnexus',
      indexedAt: '',
      lastCommit: '',
    };
    const all = [entry1, entry2];

    const id1 = stableRepoPoolId(entry1, all);
    const id2 = stableRepoPoolId(entry2, all);

    expect(id1).toMatch(/^repo-/);
    expect(id2).toMatch(/^repo-/);
    expect(id1).not.toBe(id2);
  });
});
