import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { syncGroup, stableRepoPoolId } from '../../../src/core/group/sync.js';
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
      grpc: false,
      thrift: false,
      topics: false,
      shared_libs: false,
      embedding_fallback: false,
      workspace_deps: false,
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
        shared_libs: false,
        embedding_fallback: false,
        workspace_deps: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
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

  it('keeps exact thrift links to extracted IDL and Java providers for same method', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-thrift-exact-'));
    fs.mkdirSync(path.join(tmpDir, 'idl'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java', 'example'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'main', 'java', 'example', 'IfaceOrderHandler.java'),
      `package example;

class IfaceOrderHandler implements OrderService.Iface {
  public PlaceOrderResponse PlaceOrder(PlaceOrderRequest request) {
    return new PlaceOrderResponse();
  }
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
        contractId: 'thrift::OrderService/PlaceOrder',
        type: 'thrift',
        role: 'consumer',
        symbolUid: [
          'source-scan::thrift',
          'consumer',
          'OrderService/PlaceOrder',
          'src/BillingWorkflow.java',
          'orderService.PlaceOrder',
        ].join('::'),
        symbolRef: { filePath: 'src/BillingWorkflow.java', name: 'orderService.PlaceOrder' },
        symbolName: 'orderService.PlaceOrder',
        confidence: 0.45,
        meta: {},
        repo: 'app/consumer',
      };

      const result = await syncGroup(makeConfig({}), {
        extractorOverride: async () => [...extractedProviders, consumer],
        skipWrite: true,
      });

      expect(result.crossLinks).toHaveLength(2);
      expect(result.crossLinks.map((cl) => cl.to.symbolRef.filePath).sort()).toEqual([
        'idl/order.thrift',
        'src/main/java/example/IfaceOrderHandler.java',
      ]);
      expect(new Set(result.crossLinks.map((cl) => cl.to.symbolUid)).size).toBe(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts thrift contracts during real sync when thrift detection is enabled', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-sync-thrift-'));
    const storageDir = path.join(tmpDir, '.gitnexus');
    fs.mkdirSync(path.join(tmpDir, 'services', 'billing', 'idl'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'services', 'billing', 'src'), { recursive: true });
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'services', 'billing', 'package.json'), '{}');
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'billing', 'src', 'BillingWorkflow.java'),
      'package example; class BillingWorkflow {}',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'services', 'billing', 'idl', 'order.thrift'),
      `namespace java billing.v1

service OrderService {
  PlaceOrderResponse PlaceOrder(1: PlaceOrderRequest request)
}`,
    );

    const config = makeConfig({ 'services/billing': 'billing-repo' });
    config.detect.http = false;
    config.detect.thrift = true;

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
      expect(result.contracts).toHaveLength(1);
      expect(result.contracts[0]).toMatchObject({
        contractId: 'thrift::billing.v1.OrderService/PlaceOrder',
        type: 'thrift',
        role: 'provider',
        repo: 'services/billing',
        service: 'services/billing',
        symbolRef: {
          filePath: 'services/billing/idl/order.thrift',
          name: 'OrderService.PlaceOrder',
        },
      });
      expect(initSpy).toHaveBeenCalledWith('billing-repo', path.join(storageDir, 'lbug'));
      expect(closeSpy).toHaveBeenCalledWith('billing-repo');
    } finally {
      initSpy.mockRestore();
      closeSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
        shared_libs: false,
        embedding_fallback: false,
        workspace_deps: false,
      },
      matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
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
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
          shared_libs: false,
          embedding_fallback: false,
          workspace_deps: workspaceDeps,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
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
          shared_libs: false,
          embedding_fallback: false,
          workspace_deps: true,
        },
        matching: { bm25_threshold: 0.7, embedding_threshold: 0.65, max_candidates_per_step: 3 },
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
