import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroup, stableRepoPoolId } from '../../../src/core/group/sync.js';
import { cleanupTempDir } from '../../helpers/test-db.js';
import { _captureLogger } from '../../../src/core/logger.js';
import type {
  GroupConfig,
  StoredContract,
  RepoHandle,
  GroupManifestLink,
} from '../../../src/core/group/types.js';
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
      graphql: false,
      grpc: false,
      thrift: false,
      topics: false,
      includes: false,
      workspace_deps: false,
    },
    matching: {},
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

  it('exact-matches GraphQL root fields across repositories', async () => {
    const config = makeConfig({ api: 'api-repo', web: 'web-repo' });
    const contracts: StoredContract[] = [
      {
        ...makeContract('graphql::query::widget', 'provider', 'api'),
        type: 'graphql',
      },
      {
        ...makeContract('graphql::query::widget', 'consumer', 'web'),
        type: 'graphql',
      },
    ];

    const result = await syncGroup(config, {
      extractorOverride: async () => contracts,
      skipWrite: true,
    });

    expect(result.crossLinks).toEqual([
      expect.objectContaining({
        type: 'graphql',
        contractId: 'graphql::query::widget',
        matchType: 'exact',
      }),
    ]);
  });
  it('marks a cross-link degraded when the PROVIDER endpoint carries no resolved symbolUid', async () => {
    // A provider whose symbol never resolved (empty symbolUid — e.g. a
    // source-scan provider in a repo without graph symbols) still proves the
    // service boundary, but cross-impact fan-out cannot anchor the link.
    // isUnresolvedEndpoint is evaluated at the persistence boundary so exact,
    // wildcard and manifest origins are covered by one truth point.
    const config = makeConfig({ 'app/backend': 'backend-repo', 'app/frontend': 'frontend-repo' });
    const mk = (role: 'provider' | 'consumer', uid: string): StoredContract => ({
      contractId: 'http::GET::/api/users',
      type: 'http',
      role,
      symbolUid: uid,
      symbolRef: { filePath: `src/${role}.ts`, name: `fn-${role}` },
      symbolName: `fn-${role}`,
      confidence: 0.8,
      meta: {},
      repo: role === 'provider' ? 'app/backend' : 'app/frontend',
    });

    const degraded = await syncGroup(config, {
      extractorOverride: async () => [mk('provider', ''), mk('consumer', 'uid-2')],
      skipWrite: true,
    });
    expect(degraded.crossLinks).toHaveLength(1);
    expect(degraded.crossLinks[0].degraded).toBe(true);
    expect(degraded.degradedLinks).toBe(1);

    // Control: a resolved provider keeps the flag absent (not false) so the
    // field stays "carried only when meaningful" in contracts.json.
    const resolved = await syncGroup(config, {
      extractorOverride: async () => [mk('provider', 'uid-1'), mk('consumer', 'uid-2')],
      skipWrite: true,
    });
    expect(resolved.crossLinks).toHaveLength(1);
    expect('degraded' in resolved.crossLinks[0]).toBe(false);
    expect(resolved.degradedLinks).toBe(0);
  });

  it('does NOT mark a manifest synthetic-UID link degraded — the manifest:: uid anchors fan-out', async () => {
    // Manifest endpoints fall back to a deterministic
    // `manifest::<repo>::<contractId>` uid exactly when the graph holds no
    // symbol for them (dangling repo, or a string-dispatch provider with no
    // symbol at all). Their `symbolRef.filePath` is empty by construction —
    // which trips isUnresolvedEndpoint's field checks — but cross-impact
    // anchors the crossing anyway (#2722: preserved with `fanout_status:
    // 'not_attempted'` instead of cross=0). So the degraded flag ("cannot
    // anchor a fan-out") must stay off: types.ts pins it as "distinct from
    // manifest::… synthetic UIDs", which have their own downstream channel.
    const links: GroupManifestLink[] = [
      {
        from: 'app/consumer',
        to: 'app/dangling', // not in config.repos → unresolved → synthetic uid
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];
    const config: GroupConfig = { ...makeConfig({ 'app/consumer': 'consumer-repo' }), links };

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('manifest');
    expect(result.crossLinks[0].to.symbolUid).toBe(
      'manifest::app/dangling::http::GET::/api/orders',
    );
    // The empty filePath is what makes this a regression guard: without the
    // manifest:: exemption in isUnresolvedEndpoint the flag fires on it.
    expect(result.crossLinks[0].to.symbolRef.filePath).toBe('');
    expect('degraded' in result.crossLinks[0]).toBe(false);
    expect(result.degradedLinks).toBe(0);
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

  it('test_syncGroup_does_not_force_close_pools (release-not-close, #2191 review)', async () => {
    // Post windowed-resolution refactor, syncGroup releases its eviction leases
    // and lets the pool's LRU reclaim repos — it does NOT call closeLbug. This
    // avoids tearing down a pool entry a concurrent MCP reader may share.
    const config = makeConfig({
      'app/backend': 'backend-repo',
      'app/frontend': 'frontend-repo',
    });

    const { vi } = await import('vitest');
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

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

      // No closeLbug — repos are left evictable for the LRU to reclaim.
      expect(closeSpy.mock.calls.length).toBe(0);
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
    }
  });

  it('manifest links in config.links produce cross-links with matchType manifest', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'app/consumer',
        to: 'app/provider',
        type: 'http',
        contract: 'GET::/api/orders',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'app/consumer': 'consumer-repo', 'app/provider': 'provider-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: false,
      },
      matching: {},
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    // ManifestExtractor should inject 2 contracts (provider + consumer) and 1 cross-link
    expect(result.contracts).toHaveLength(2);
    const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
    expect(manifestLinks).toHaveLength(1);
    expect(manifestLinks[0].contractId).toBe('http::GET::/api/orders');
    expect(manifestLinks[0].from.repo).toBe('app/consumer');
    expect(manifestLinks[0].to.repo).toBe('app/provider');
    expect(manifestLinks[0].confidence).toBe(1.0);

    // With no DB executors available, UIDs fall back to the deterministic
    // synthetic form `manifest::<repo>::<contractId>`.
    expect(manifestLinks[0].from.symbolUid).toBe('manifest::app/consumer::http::GET::/api/orders');
    expect(manifestLinks[0].to.symbolUid).toBe('manifest::app/provider::http::GET::/api/orders');

    // Manifest contracts also participate in runExactMatch; we must not emit a
    // duplicate matchType:'exact' cross-link for the same endpoint pair.
    const exactForSameContract = result.crossLinks.filter(
      (cl) => cl.matchType === 'exact' && cl.contractId === 'http::GET::/api/orders',
    );
    expect(exactForSameContract).toHaveLength(0);
    expect(result.crossLinks).toHaveLength(1);
  });

  it('runs thrift wildcard matching after exact matching and returns wildcard remaining', async () => {
    const config = makeConfig({ 'app/provider': 'provider-repo', 'app/consumer': 'consumer-repo' });
    const provider: StoredContract = {
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolUid: 'uid-provider-place-order',
      symbolRef: { filePath: 'src/provider.ts', name: 'OrderService.PlaceOrder' },
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.9,
      meta: {},
      repo: 'app/provider',
    };
    const consumer: StoredContract = {
      contractId: 'thrift::OrderService/*',
      type: 'thrift',
      role: 'consumer',
      symbolUid: 'uid-consumer-order-service',
      symbolRef: { filePath: 'src/consumer.ts', name: 'OrderClient' },
      symbolName: 'OrderClient',
      confidence: 0.8,
      meta: {},
      repo: 'app/consumer',
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [provider, consumer],
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('wildcard');
    expect(result.crossLinks[0].contractId).toBe('thrift::OrderService/*');
    expect(result.crossLinks[0].from.repo).toBe('app/consumer');
    expect(result.crossLinks[0].to.repo).toBe('app/provider');
    expect(result.unmatched).toEqual([provider]);
  });

  it('keeps wildcard thrift links to multiple extracted IDL provider methods', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-thrift-wildcard-'));
    fs.mkdirSync(path.join(tmpDir, 'idl'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
  OrderResponse GetOrder(1: string orderId)
}`,
    );

    try {
      const { ThriftExtractor } =
        await import('../../../src/core/group/extractors/thrift-extractor.js');
      const extractedProviders = (
        await new ThriftExtractor().extract(null, tmpDir, {
          id: 'provider-repo',
          path: 'app/provider',
          repoPath: tmpDir,
          storagePath: path.join(tmpDir, '.gitnexus'),
        })
      )
        .filter((c) => c.role === 'provider')
        .map(
          (c): StoredContract => ({
            ...c,
            repo: 'app/provider',
          }),
        );

      const consumer: StoredContract = {
        contractId: 'thrift::OrderService/*',
        type: 'thrift',
        role: 'consumer',
        symbolUid: 'manifest::app/consumer::thrift::OrderService/*',
        symbolRef: { filePath: 'group.yaml', name: 'OrderService' },
        symbolName: 'OrderService',
        confidence: 1,
        meta: {},
        repo: 'app/consumer',
      };

      const result = await syncGroup(makeConfig({}), {
        extractorOverride: async () => [...extractedProviders, consumer],
        skipWrite: true,
      });

      expect(result.crossLinks).toHaveLength(2);
      expect(result.crossLinks.map((cl) => cl.to.symbolRef.name).sort()).toEqual([
        'OrderService.GetOrder',
        'OrderService.PlaceOrder',
      ]);
      expect(new Set(result.crossLinks.map((cl) => cl.to.symbolUid)).size).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches weak thrift method consumers to namespace-qualified providers during sync', async () => {
    const config = makeConfig({ 'app/provider': 'provider-repo', 'app/consumer': 'consumer-repo' });
    const provider: StoredContract = {
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolUid: 'uid-provider-place-order',
      symbolRef: { filePath: 'idl/order.thrift', name: 'OrderService.PlaceOrder' },
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.85,
      meta: {},
      repo: 'app/provider',
    };
    const consumer: StoredContract = {
      contractId: 'thrift::OrderService/PlaceOrder',
      type: 'thrift',
      role: 'consumer',
      symbolUid: 'uid-consumer-place-order',
      symbolRef: { filePath: 'src/BillingWorkflow.java', name: 'orderService.PlaceOrder' },
      symbolName: 'orderService.PlaceOrder',
      confidence: 0.45,
      meta: {},
      repo: 'app/consumer',
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [provider, consumer],
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('exact');
    expect(result.crossLinks[0].contractId).toBe('thrift::OrderService/PlaceOrder');
    expect(result.crossLinks[0].from.repo).toBe('app/consumer');
    expect(result.crossLinks[0].to.repo).toBe('app/provider');
    expect(result.unmatched).toHaveLength(0);
  });

  it('does not extract thrift contracts during real sync when thrift detection is disabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-thrift-off-'));
    const storageDir = path.join(tmpDir, '.gitnexus');
    fs.mkdirSync(path.join(tmpDir, 'services', 'billing', 'idl'), { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'billing', 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const config = makeConfig({ 'services/billing': 'billing-repo' });
    config.detect.http = false;
    config.detect.thrift = false;

    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

    try {
      const result = await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: 'billing-repo',
          path: groupPath,
          repoPath: tmpDir,
          storagePath: storageDir,
        }),
        skipWrite: true,
      });

      expect(result.missingRepos).toHaveLength(0);
      expect(result.contracts).toHaveLength(0);
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not extract include contracts during real sync when includes detection is disabled', async () => {
    // PR #1156 Codex follow-up: ce-code-review T1 — verifies the gate at
    // sync.ts:174 honors `detect.includes: false`. Mirrors the existing
    // thrift-off pattern at sync.test.ts:545.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-includes-off-'));
    const storageDir = path.join(tmpDir, '.gitnexus');
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'view.h'), '#pragma once\nclass View {};');

    const config = makeConfig({ 'app/cpp-lib': 'cpp-lib-repo' });
    config.detect.http = false;
    config.detect.grpc = false;
    config.detect.thrift = false;
    config.detect.topics = false;
    config.detect.includes = false;

    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockResolvedValue(undefined);

    try {
      const result = await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: 'cpp-lib-repo',
          path: groupPath,
          repoPath: tmpDir,
          storagePath: storageDir,
        }),
        skipWrite: true,
      });

      expect(result.missingRepos).toHaveLength(0);
      expect(result.contracts.filter((c) => c.type === 'include')).toHaveLength(0);
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
      await cleanupTempDir(tmpDir);
    }
  });

  it('dedupes duplicate wildcard cross-links during sync', async () => {
    const config = makeConfig({ 'app/provider': 'provider-repo', 'app/consumer': 'consumer-repo' });
    const provider: StoredContract = {
      contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
      type: 'thrift',
      role: 'provider',
      symbolUid: 'uid-provider-place-order',
      symbolRef: { filePath: 'src/provider.ts', name: 'OrderService.PlaceOrder' },
      symbolName: 'OrderService.PlaceOrder',
      confidence: 0.9,
      meta: {},
      repo: 'app/provider',
    };
    const duplicateProvider: StoredContract = {
      ...provider,
      confidence: 0.7,
    };
    const consumer: StoredContract = {
      contractId: 'thrift::OrderService/*',
      type: 'thrift',
      role: 'consumer',
      symbolUid: 'uid-consumer-order-service',
      symbolRef: { filePath: 'src/consumer.ts', name: 'OrderClient' },
      symbolName: 'OrderClient',
      confidence: 0.8,
      meta: {},
      repo: 'app/consumer',
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [provider, duplicateProvider, consumer],
      skipWrite: true,
    });

    expect(result.crossLinks).toHaveLength(1);
    expect(result.crossLinks[0].matchType).toBe('wildcard');
  });

  it('manifest links referencing unknown repos still produce cross-links via synthetic UIDs', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'app/known',
        to: 'app/dangling', // not present in config.repos
        type: 'http',
        contract: 'POST::/api/missing',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'app/known': 'known-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: false,
      },
      matching: {},
    };

    const cap = _captureLogger();
    try {
      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      expect(result.crossLinks).toHaveLength(1);
      expect(result.crossLinks[0].matchType).toBe('manifest');
      expect(result.crossLinks[0].to.symbolUid).toBe(
        'manifest::app/dangling::http::POST::/api/missing',
      );
      expect(cap.records().some((r) => String(r.msg ?? '').includes('app/dangling'))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it('writes registry to groupDir when skipWrite is false', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-write-'));

    try {
      const config = makeConfig({});
      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        groupDir: tmpDir,
        skipWrite: false,
      });

      expect(result.contracts).toHaveLength(0);

      const registryPath = path.join(tmpDir, 'contracts.json');
      expect(fs.existsSync(registryPath)).toBe(true);

      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
      expect(registry.version).toBe(1);
      expect(registry.contracts).toHaveLength(0);
    } finally {
      // syncGroup now writes bridge.lbug + WAL/shadow sidecars when
      // skipWrite is false. On Windows, LadybugDB's checkpoint thread can
      // briefly outlive closeBridgeDb, holding a Win32 lock on the file.
      // cleanupTempDir tolerates the documented Windows-native lock codes
      // (EBUSY/EPERM/EACCES/ENOTEMPTY) with bounded retries.
      await cleanupTempDir(tmpDir);
    }
  });

  describe('workspace_deps integration', () => {
    let tmpDir: string;

    function makeWsConfig(repos: Record<string, string>, workspaceDeps: boolean): GroupConfig {
      return {
        version: 1,
        name: 'test',
        description: '',
        repos,
        links: [],
        packages: {},
        detect: {
          http: false,
          grpc: false,
          thrift: false,
          topics: false,
          includes: false,
          workspace_deps: workspaceDeps,
        },
        matching: {},
      };
    }

    function writeFileSync(relPath: string, content: string) {
      const absPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, 'utf-8');
    }

    afterEach(() => {
      vi.restoreAllMocks();
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('workspace_deps: true discovers Rust crate links through syncGroup', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-ws-'));

      writeFileSync(
        'crate-a/Cargo.toml',
        '[package]\nname = "mathlex"\nversion = "0.1.0"\n\n[dependencies]\n',
      );
      writeFileSync('crate-a/src/lib.rs', 'pub struct Expression {}\n');

      writeFileSync(
        'crate-b/Cargo.toml',
        '[package]\nname = "thales"\nversion = "0.1.0"\n\n[dependencies]\nmathlex = { workspace = true }\n',
      );
      writeFileSync('crate-b/src/main.rs', 'use mathlex::Expression;\n');

      const mockEntries: RegistryEntry[] = [
        {
          name: 'mathlex',
          path: path.join(tmpDir, 'crate-a'),
          storagePath: path.join(tmpDir, 'crate-a', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
        {
          name: 'thales',
          path: path.join(tmpDir, 'crate-b'),
          storagePath: path.join(tmpDir, 'crate-b', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
      ];

      const repoManager = await import('../../../src/storage/repo-manager.js');
      vi.spyOn(repoManager, 'readRegistry').mockResolvedValue(mockEntries);

      const config = makeWsConfig({ 'parser/mathlex': 'mathlex', 'engine/thales': 'thales' }, true);

      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
      expect(manifestLinks).toHaveLength(1);
      expect(manifestLinks[0].contractId).toBe('custom::mathlex::Expression');
      expect(manifestLinks[0].from.repo).toBe('engine/thales');
      expect(manifestLinks[0].to.repo).toBe('parser/mathlex');
    });

    it('workspace_deps: false skips workspace extraction entirely', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-ws-off-'));

      writeFileSync(
        'crate-a/Cargo.toml',
        '[package]\nname = "mathlex"\nversion = "0.1.0"\n\n[dependencies]\n',
      );
      writeFileSync('crate-a/src/lib.rs', 'pub struct Expression {}\n');

      writeFileSync(
        'crate-b/Cargo.toml',
        '[package]\nname = "thales"\nversion = "0.1.0"\n\n[dependencies]\nmathlex = { workspace = true }\n',
      );
      writeFileSync('crate-b/src/main.rs', 'use mathlex::Expression;\n');

      const repoManager = await import('../../../src/storage/repo-manager.js');
      vi.spyOn(repoManager, 'readRegistry').mockResolvedValue([]);

      const config = makeWsConfig(
        { 'parser/mathlex': 'mathlex', 'engine/thales': 'thales' },
        false,
      );

      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      expect(result.crossLinks).toHaveLength(0);
      expect(result.contracts).toHaveLength(0);
    });

    it('discovered workspace links merge with explicit manifest links', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-ws-merge-'));

      writeFileSync(
        'crate-a/Cargo.toml',
        '[package]\nname = "mathlex"\nversion = "0.1.0"\n\n[dependencies]\n',
      );
      writeFileSync('crate-a/src/lib.rs', 'pub struct Expression {}\n');

      writeFileSync(
        'crate-b/Cargo.toml',
        '[package]\nname = "thales"\nversion = "0.1.0"\n\n[dependencies]\nmathlex = { workspace = true }\n',
      );
      writeFileSync('crate-b/src/main.rs', 'use mathlex::Expression;\n');

      const mockEntries: RegistryEntry[] = [
        {
          name: 'mathlex',
          path: path.join(tmpDir, 'crate-a'),
          storagePath: path.join(tmpDir, 'crate-a', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
        {
          name: 'thales',
          path: path.join(tmpDir, 'crate-b'),
          storagePath: path.join(tmpDir, 'crate-b', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
      ];

      const repoManager = await import('../../../src/storage/repo-manager.js');
      vi.spyOn(repoManager, 'readRegistry').mockResolvedValue(mockEntries);

      const explicitLinks: GroupManifestLink[] = [
        {
          from: 'parser/mathlex',
          to: 'engine/thales',
          type: 'http',
          contract: 'GET::/api/parse',
          role: 'provider',
        },
      ];

      const config: GroupConfig = {
        version: 1,
        name: 'test',
        description: '',
        repos: { 'parser/mathlex': 'mathlex', 'engine/thales': 'thales' },
        links: explicitLinks,
        packages: {},
        detect: {
          http: false,
          grpc: false,
          thrift: false,
          topics: false,
          includes: false,
          workspace_deps: true,
        },
        matching: {},
      };

      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
      expect(manifestLinks).toHaveLength(2);

      const contractIds = manifestLinks.map((cl) => cl.contractId);
      expect(contractIds).toContain('http::GET::/api/parse');
      expect(contractIds).toContain('custom::mathlex::Expression');
    });

    it('discovers Node workspace links through syncGroup orchestrator', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-ws-node-'));

      writeFileSync('shared/package.json', '{"name": "@myorg/shared", "version": "1.0.0"}');
      writeFileSync('shared/src/index.ts', 'export class Config {}\n');

      writeFileSync(
        'app/package.json',
        '{"name": "@myorg/app", "version": "1.0.0", "dependencies": {"@myorg/shared": "workspace:*"}}',
      );
      writeFileSync('app/src/index.ts', "import { Config } from '@myorg/shared';\n");

      const mockEntries: RegistryEntry[] = [
        {
          name: 'shared',
          path: path.join(tmpDir, 'shared'),
          storagePath: path.join(tmpDir, 'shared', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
        {
          name: 'app',
          path: path.join(tmpDir, 'app'),
          storagePath: path.join(tmpDir, 'app', '.gitnexus'),
          indexedAt: '',
          lastCommit: '',
        },
      ];

      const repoManager = await import('../../../src/storage/repo-manager.js');
      vi.spyOn(repoManager, 'readRegistry').mockResolvedValue(mockEntries);

      const config = makeWsConfig({ 'pkg/shared': 'shared', 'pkg/app': 'app' }, true);

      const result = await syncGroup(config, {
        extractorOverride: async () => [],
        skipWrite: true,
      });

      const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
      expect(manifestLinks).toHaveLength(1);
      const nodeLink = manifestLinks.find(
        (cl) => cl.contractId === 'custom::@myorg/shared::Config',
      );
      expect(nodeLink).toBeDefined();
    });
  });

  it('manifest symbol resolution runs before closeLbug (issue #1802)', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'svc/orders',
        to: 'svc/payments',
        type: 'http',
        contract: 'GET::/api/checkout',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'svc/orders': 'orders-repo', 'svc/payments': 'payments-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: false,
      },
      matching: {},
    };

    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');

    let closeLbugCalled = false;
    let manifestResolvedWhilePoolOpen = false;

    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const closeSpy = vi.spyOn(poolAdapter, 'closeLbug').mockImplementation(async () => {
      closeLbugCalled = true;
    });
    const execSpy = vi
      .spyOn(poolAdapter, 'executeParameterized')
      .mockImplementation(
        async (_poolId: string, query: string, _params: Record<string, unknown>) => {
          if (query.includes('HANDLES_ROUTE')) {
            manifestResolvedWhilePoolOpen = !closeLbugCalled;
          }
          return [
            { uid: 'real-uid-checkout', name: 'CheckoutHandler', filePath: 'src/checkout.ts' },
          ];
        },
      );

    try {
      const result = await syncGroup(config, {
        resolveRepoHandle: async (_name, groupPath) => ({
          id: groupPath.replace(/\//g, '-'),
          path: groupPath,
          repoPath: '/tmp/' + groupPath,
          storagePath: '/tmp/' + groupPath + '/.gitnexus',
        }),
        skipWrite: true,
      });

      // Manifest symbol resolution runs against live (leased) pools.
      expect(manifestResolvedWhilePoolOpen).toBe(true);

      // The manifest cross-link must use the real UID from the DB, not synthetic
      // — the #2189 fix, now via windowed resolution (the svc/orders↔svc/payments
      // link forms one window whose repos are re-inited + leased for resolution).
      const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
      expect(manifestLinks).toHaveLength(1);
      expect(manifestLinks[0].to.symbolUid).toBe('real-uid-checkout');
      expect(manifestLinks[0].to.symbolUid).not.toContain('manifest::');

      // syncGroup no longer force-closes pools (release-not-close, #2191 review).
      expect(closeLbugCalled).toBe(false);
      expect(closeSpy).not.toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
      execSpy.mockRestore();
    }
  });

  it('a manifest link does not spread to another repo exposing the same route (#1188)', async () => {
    const importRoute = (repo: string, name: string): StoredContract => ({
      contractId: 'http::POST::/import',
      type: 'http',
      role: 'provider',
      symbolUid: `uid-${name}`,
      symbolRef: { filePath: `src/${name}.ts`, name },
      symbolName: name,
      confidence: 0.9,
      meta: { method: 'POST', path: '/import' },
      repo,
    });
    const config: GroupConfig = {
      ...makeConfig({
        'backend/gen-question': 'gen-question',
        'backend/learning': 'learning',
        'backend/user-service': 'user-service',
      }),
      links: [
        {
          from: 'backend/gen-question',
          to: 'backend/learning',
          type: 'http',
          contract: 'POST::/import',
          role: 'consumer',
        },
      ],
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [
        importRoute('backend/learning', 'importLessons'),
        importRoute('backend/user-service', 'importUsers'),
      ],
      skipWrite: true,
    });

    expect(
      result.crossLinks.map((l) => [l.matchType, l.from.repo, l.to.repo, l.to.symbolRef.name]),
    ).toEqual([
      ['manifest', 'backend/gen-question', 'backend/learning', 'POST::/import'],
      ['exact', 'backend/gen-question', 'backend/learning', 'importLessons'],
    ]);
    // The declared provider only steers matching; the registry keeps its shape.
    const consumer = result.contracts.find((c) => c.role === 'consumer');
    expect(consumer?.meta).toEqual({ source: 'manifest' });
  });

  it('a service-wildcard manifest link matches only the repo it names (#1188)', async () => {
    // The wildcard pass runs on what the exact pass left over, so the declared
    // repo has to survive from one pass to the next.
    const login = (repo: string): StoredContract => ({
      contractId: 'grpc::auth.AuthService/Login',
      type: 'grpc',
      role: 'provider',
      symbolUid: `uid-login-${repo}`,
      symbolRef: { filePath: 'src/auth.ts', name: 'Login' },
      symbolName: 'Login',
      confidence: 0.9,
      meta: {},
      repo,
    });
    const config: GroupConfig = {
      ...makeConfig({ orders: 'orders', auth: 'auth', 'legacy-auth': 'legacy-auth' }),
      links: [
        {
          from: 'orders',
          to: 'auth',
          type: 'grpc',
          contract: 'auth.AuthService/*',
          role: 'consumer',
        },
      ],
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [login('auth'), login('legacy-auth')],
      skipWrite: true,
    });

    expect(
      result.crossLinks.filter((l) => l.matchType === 'wildcard').map((l) => l.to.repo),
    ).toEqual(['auth']);
  });

  it('an unmatched manifest consumer is reported without the declared provider repo (#1188)', async () => {
    const config: GroupConfig = {
      ...makeConfig({ orders: 'orders', auth: 'auth' }),
      links: [
        {
          from: 'orders',
          to: 'auth',
          type: 'grpc',
          contract: 'auth.AuthService/*',
          role: 'consumer',
        },
      ],
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    expect(result.unmatched.filter((c) => c.role === 'consumer').map((c) => c.meta)).toEqual([
      { source: 'manifest' },
    ]);
  });

  it('extractorOverride no-DB path still produces synthetic manifest UIDs', async () => {
    const links: GroupManifestLink[] = [
      {
        from: 'svc/orders',
        to: 'svc/payments',
        type: 'http',
        contract: 'GET::/api/checkout',
        role: 'consumer',
      },
    ];

    const config: GroupConfig = {
      version: 1,
      name: 'test',
      description: '',
      repos: { 'svc/orders': 'orders-repo', 'svc/payments': 'payments-repo' },
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: false,
      },
      matching: {},
    };

    const result = await syncGroup(config, {
      extractorOverride: async () => [],
      skipWrite: true,
    });

    const manifestLinks = result.crossLinks.filter((cl) => cl.matchType === 'manifest');
    expect(manifestLinks).toHaveLength(1);
    expect(manifestLinks[0].from.symbolUid).toBe('manifest::svc/orders::http::GET::/api/checkout');
    expect(manifestLinks[0].to.symbolUid).toBe('manifest::svc/payments::http::GET::/api/checkout');
  });
});

// Lifecycle wiring for issue #2189: syncGroup must pin every repo it
// initializes (so a group larger than MAX_POOL_SIZE survives deferred
// manifest/workspace resolution) and release those pins on completion AND on
// error. The eviction-survival MECHANISM itself is proven against real
// evictLRU in test/unit/lbug-pool-pinning.test.ts; these tests prove the sync
// loop drives that mechanism correctly. (A full end-to-end proof through the
// real pool — real symbolUid instead of synthetic after >5 repos — would
// require a real or fully-native-mocked LadybugDB stack; mechanism + wiring
// coverage stands in for it here.)
describe('syncGroup windowed manifest resolution (issue #2189 / PR #2191 review)', () => {
  const groupConfig = (count: number, links: GroupManifestLink[] = []): GroupConfig => {
    const repos: Record<string, string> = {};
    for (let i = 1; i <= count; i++) repos[`app/repo-${i}`] = `repo-${i}`;
    return {
      version: 1,
      name: 'test',
      description: '',
      repos,
      links,
      packages: {},
      detect: {
        http: true,
        grpc: false,
        thrift: false,
        topics: false,
        includes: false,
        workspace_deps: false,
      },
      matching: {},
    };
  };

  const okHandle = async (_name: string, groupPath: string): Promise<RepoHandle> => ({
    id: groupPath.replace(/\//g, '-'),
    path: groupPath,
    repoPath: '/tmp/' + groupPath,
    storagePath: '/tmp/' + groupPath + '/.gitnexus',
  });

  const httpLink = (from: string, to: string): GroupManifestLink => ({
    from,
    to,
    type: 'http',
    contract: 'GET::/api/x',
    role: 'consumer',
  });

  // pinRepo now returns a release disposer; the spy returns a tracked spy fn so
  // tests can assert every acquired lease was released.
  const setupPoolSpies = async () => {
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const releaseSpies: Array<ReturnType<typeof vi.fn>> = [];
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockResolvedValue(undefined);
    const execSpy = vi.spyOn(poolAdapter, 'executeParameterized').mockResolvedValue([]);
    // Leases held at the moment of each pinRepo call, in call order.
    const heldAtPin: number[] = [];
    let held = 0;
    const pinSpy = vi.spyOn(poolAdapter, 'pinRepo').mockImplementation(() => {
      heldAtPin.push(held);
      held += 1;
      const release = vi.fn(() => {
        held -= 1;
      });
      releaseSpies.push(release);
      return release;
    });
    const restore = () => {
      initSpy.mockRestore();
      execSpy.mockRestore();
      pinSpy.mockRestore();
    };
    return { releaseSpies, heldAtPin, initSpy, execSpy, pinSpy, restore };
  };

  const repoIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `app-repo-${i + 1}`);

  it('leases each repo only while its contracts are extracted, and windows only the linked repos', async () => {
    const { pinSpy, heldAtPin, restore } = await setupPoolSpies();
    try {
      await syncGroup(groupConfig(8, [httpLink('app/repo-1', 'app/repo-2')]), {
        resolveRepoHandle: okHandle,
        skipWrite: true,
      });
      const pinnedIds = pinSpy.mock.calls.map((c) => c[0]);
      // One extraction lease per repo, in repo order, each released before
      // the next repo's: residency stays bounded, never the whole 8-repo group.
      expect(pinnedIds.slice(0, 8)).toEqual(repoIds(8));
      expect(heldAtPin.slice(0, 8)).toEqual(Array(8).fill(0));
      // Then only the windowed (link-referenced) repos are leased.
      expect(pinnedIds.slice(8).sort()).toEqual(['app-repo-1', 'app-repo-2']);
    } finally {
      restore();
    }
  });

  it('holds one extraction lease at a time when there are no manifest links', async () => {
    const { pinSpy, heldAtPin, releaseSpies, restore } = await setupPoolSpies();
    try {
      await syncGroup(groupConfig(8, []), { resolveRepoHandle: okHandle, skipWrite: true });
      // With no links there are no resolution windows: the only leases are the
      // per-repo extraction leases, taken one at a time and all released.
      expect(pinSpy.mock.calls.map((c) => c[0])).toEqual(repoIds(8));
      expect(heldAtPin).toEqual(Array(8).fill(0));
      for (const release of releaseSpies) expect(release).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('releases the extraction lease of a repo whose extraction throws before leasing the next', async () => {
    const { HttpRouteExtractor } =
      await import('../../../src/core/group/extractors/http-route-extractor.js');
    const { pinSpy, heldAtPin, releaseSpies, restore } = await setupPoolSpies();
    const extractSpy = vi
      .spyOn(HttpRouteExtractor.prototype, 'extract')
      .mockImplementation(async (_executor, repoPath) => {
        if (repoPath.endsWith('repo-2')) throw new Error('extract boom');
        return [];
      });
    try {
      const result = await syncGroup(groupConfig(3, []), {
        resolveRepoHandle: okHandle,
        skipWrite: true,
      });
      expect(result.failedRepos.map((f) => f.repo)).toEqual(['app/repo-2']);
      expect(pinSpy.mock.calls.map((c) => c[0])).toEqual(repoIds(3));
      // The failed repo's lease was released before repo-3 was leased.
      expect(heldAtPin).toEqual([0, 0, 0]);
      for (const release of releaseSpies) expect(release).toHaveBeenCalledTimes(1);
    } finally {
      extractSpy.mockRestore();
      restore();
    }
  });

  it('releases every window lease on successful completion', async () => {
    const { releaseSpies, restore } = await setupPoolSpies();
    try {
      await syncGroup(
        groupConfig(8, [
          httpLink('app/repo-1', 'app/repo-2'),
          httpLink('app/repo-7', 'app/repo-8'),
        ]),
        { resolveRepoHandle: okHandle, skipWrite: true },
      );
      expect(releaseSpies.length).toBeGreaterThan(0);
      for (const release of releaseSpies) expect(release).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('releases the window leases even when resolution throws mid-window', async () => {
    const { ManifestExtractor } =
      await import('../../../src/core/group/extractors/manifest-extractor.js');
    const { releaseSpies, restore } = await setupPoolSpies();
    const manifestSpy = vi
      .spyOn(ManifestExtractor.prototype, 'extractFromManifest')
      .mockRejectedValue(new Error('resolution boom'));
    try {
      await expect(
        syncGroup(groupConfig(8, [httpLink('app/repo-1', 'app/repo-2')]), {
          resolveRepoHandle: okHandle,
          skipWrite: true,
        }),
      ).rejects.toThrow('resolution boom');
      // The window's finally released its acquired leases despite the throw.
      expect(releaseSpies.length).toBeGreaterThan(0);
      for (const release of releaseSpies) expect(release).toHaveBeenCalled();
    } finally {
      restore();
      manifestSpy.mockRestore();
    }
  });

  it('does not pin a repo that fails to resolve (no pool handle)', async () => {
    const { pinSpy, restore } = await setupPoolSpies();
    try {
      await syncGroup(groupConfig(3, [httpLink('app/repo-1', 'app/repo-2')]), {
        resolveRepoHandle: async (_name, groupPath) =>
          groupPath === 'app/repo-2' ? null : okHandle(_name, groupPath),
        skipWrite: true,
      });
      const pinnedIds = pinSpy.mock.calls.map((c) => c[0]);
      // repo-2 has no handle (resolve returned null) → not in knownRepos →
      // never windowed, never leased; repo-1 (resolved) is.
      expect(pinnedIds).toContain('app-repo-1');
      expect(pinnedIds).not.toContain('app-repo-2');
    } finally {
      restore();
    }
  });

  it('releases an already-acquired lease when a later init in the same window throws', async () => {
    const poolAdapter = await import('../../../src/core/lbug/pool-adapter.js');
    const releaseSpies: Array<ReturnType<typeof vi.fn>> = [];
    // Throw on the SECOND init of app-repo-2 — the first is the init-loop
    // extraction; the second is the window re-init. This isolates the failure
    // to window setup, after app-repo-1's lease was already acquired.
    const initCounts = new Map<string, number>();
    const initSpy = vi.spyOn(poolAdapter, 'initLbug').mockImplementation(async (id: string) => {
      const n = (initCounts.get(id) ?? 0) + 1;
      initCounts.set(id, n);
      if (id === 'app-repo-2' && n === 2) throw new Error('window init boom');
      return true;
    });
    const execSpy = vi.spyOn(poolAdapter, 'executeParameterized').mockResolvedValue([]);
    const pinSpy = vi.spyOn(poolAdapter, 'pinRepo').mockImplementation(() => {
      const release = vi.fn();
      releaseSpies.push(release);
      return release;
    });
    try {
      await expect(
        syncGroup(groupConfig(2, [httpLink('app/repo-1', 'app/repo-2')]), {
          resolveRepoHandle: okHandle,
          skipWrite: true,
        }),
      ).rejects.toThrow('window init boom');
      // Two extraction leases (one per repo, released after extraction), then
      // one window lease (app-repo-1) acquired before app-repo-2's window init
      // threw. The window finally released it — no leaked lease.
      expect(releaseSpies.length).toBe(3);
      for (const release of releaseSpies) expect(release).toHaveBeenCalled();
    } finally {
      initSpy.mockRestore();
      execSpy.mockRestore();
      pinSpy.mockRestore();
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
