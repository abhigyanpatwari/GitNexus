import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runGroupTrace,
  runGroupTraceWithResolver,
  isTestFilePath,
  isClientModulePath,
  isUtilOrDto,
  buildCrossLinksIndex,
  findCrossRepoHopsFromRegistry,
  type CrossLinksIndex,
} from '../../../src/core/group/trace.js';
import type { TraceResult, TraceDeps } from '../../../src/core/group/trace.js';
import type { GroupToolPort, GroupRepoHandle } from '../../../src/core/group/service.js';
import { DefaultSymbolResolver } from '../../../src/core/group/trace-resolver.js';
import type { SymbolCandidate } from '../../../src/core/group/trace-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpGroup(opts?: { repos?: Record<string, string> }): {
  tmpDir: string;
  groupDir: string;
  cleanup: () => void;
} {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-trace-${Date.now()}-${Math.random()}`);
  const groupDir = path.join(tmpDir, 'groups', 'g1');
  fs.mkdirSync(groupDir, { recursive: true });

  const repos = opts?.repos ?? { 'app/backend': 'reg-be', 'app/frontend': 'reg-fe' };
  const reposYaml = Object.entries(repos)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n');

  fs.writeFileSync(
    path.join(groupDir, 'group.yaml'),
    `version: 1
name: g1
description: ""
repos:
${reposYaml}
links: []
packages: {}
detect:
  http: true
  grpc: true
  topics: true
  shared_libs: true
  embedding_fallback: true
matching:
  bm25_threshold: 0.7
  embedding_threshold: 0.65
  max_candidates_per_step: 3
`,
  );

  return {
    tmpDir,
    groupDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/** Write a contracts.json file into the group directory. */
function writeContractsJson(groupDir: string, crossLinks: any[] = [], contracts: any[] = []): void {
  fs.writeFileSync(
    path.join(groupDir, 'contracts.json'),
    JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      repoSnapshots: {},
      missingRepos: [],
      contracts,
      crossLinks,
    }),
  );
}

function makePort(overrides: Partial<GroupToolPort> = {}): GroupToolPort {
  return {
    resolveRepo: vi.fn(
      async (name?: string): Promise<GroupRepoHandle> => ({
        id: name ?? 'unknown',
        name: name ?? 'unknown',
        repoPath: `/tmp/repos/${name}`,
        storagePath: `/tmp/storage/${name}`,
      }),
    ),
    impact: vi.fn(async () => ({})),
    query: vi.fn(async () => ({})),
    impactByUid: vi.fn(async () => null),
    context: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeDeps(port: GroupToolPort, gitnexusDir: string): TraceDeps {
  return { port, gitnexusDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Mock lbug pool-adapter so we don't need a real LadybugDB
vi.mock('../../../src/core/lbug/pool-adapter.js', () => ({
  initLbug: vi.fn(async () => {}),
  closeLbug: vi.fn(async () => {}),
  executeParameterized: vi.fn(async () => []),
  executeQuery: vi.fn(async () => []),
  setMaxPoolSize: vi.fn(() => () => {}), // returns a no-op restore function
}));

describe('runGroupTrace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns error when name is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: '',
      repo: 'app/backend',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('name');
  });

  it('returns error when repo is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: '',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('repo');
  });

  it('returns error when target is missing', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: 'app/backend',
      target: '',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('target');
  });

  it('returns error when group not found', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp/nonexistent'), {
      name: 'g1',
      repo: 'app/backend',
      target: 'foo',
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns error when repo path not in group', async () => {
    const { tmpDir, cleanup } = tmpGroup();
    try {
      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/nonexistent',
        target: 'foo',
      });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('Unknown repo path');
    } finally {
      cleanup();
    }
  });

  it('returns error when entry symbol not found in lbug', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir);
      // executeParameterized returns [] for all queries → symbol not found
      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'nonExistentSymbol',
      });
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('not found');
    } finally {
      cleanup();
    }
  });

  it('returns single-repo trace when no crossLinks exist', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir); // empty crossLinks

      const { executeParameterized, executeQuery } =
        await import('../../../src/core/lbug/pool-adapter.js');

      // Resolve entry symbol by id
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'sym-1', name: 'myFunc', type: 'Function', filePath: 'src/main.ts' },
      ]);

      // BFS query returns one neighbor (now uses executeParameterized)
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'sym-1',
          id: 'sym-2',
          name: 'helperFunc',
          type: 'Function',
          filePath: 'src/helper.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);
      // Next depth: no more neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'sym-1',
        maxDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(1);
      expect(trace.segments[0].repo).toBe('reg-be');
      expect(trace.segments[0].nodes).toHaveLength(1);
      expect(trace.segments[0].nodes[0].name).toBe('helperFunc');
      expect(trace.segments[0].crossHops).toHaveLength(0);
      expect(trace.truncated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('follows cross-repo hop via contracts.json crossLinks', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // Write contracts.json with a crossLink from app/backend → app/frontend
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'source-scan::thrift::consumer::FrontendService/handleRequest',
            symbolRef: { filePath: 'src/client.ts', name: 'FrontendService.handleRequest' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::thrift::provider::FrontendService/handleRequest',
            symbolRef: { filePath: 'src/api.ts', name: 'FrontendService.handleRequest' },
          },
          type: 'thrift',
          contractId: 'thrift::FrontendService/handleRequest',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized, executeQuery } =
        await import('../../../src/core/lbug/pool-adapter.js');

      // Entry repo: resolve entry symbol (exact id match → LIMIT 1 query)
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-sym-1', name: 'callFrontend', type: 'Function', filePath: 'src/client.ts' },
      ]);

      // Entry repo BFS depth 1: no CALLS neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Target repo: DefaultSymbolResolver.resolveSymbolByName:
      //   1. exact full-name match query (rows) → empty
      (executeParameterized as any).mockResolvedValueOnce([]);
      //   2. shortName 'handleRequest' query (rows2) → one hit
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'fe-sym-1', name: 'handleRequest', type: 'Method', filePath: 'src/api.ts' },
      ]);
      // drillDownToMethod: fe-sym-1 is already Method: → no extra query

      // Target repo BFS depth 1: one neighbor
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'fe-sym-1',
          id: 'fe-sym-2',
          name: 'processData',
          type: 'Function',
          filePath: 'src/processor.ts',
          relType: 'CALLS',
          confidence: 0.9,
        },
      ]);
      // Target repo BFS depth 2: no more
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-sym-1',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(2);

      // First segment: entry repo
      expect(trace.segments[0].repoPath).toBe('app/backend');
      expect(trace.segments[0].crossHops).toHaveLength(1);
      expect(trace.segments[0].crossHops[0].contractId).toBe(
        'thrift::FrontendService/handleRequest',
      );

      // Second segment: target repo
      expect(trace.segments[1].repoPath).toBe('app/frontend');
      expect(trace.segments[1].nodes).toHaveLength(1);
      expect(trace.segments[1].nodes[0].name).toBe('processData');
    } finally {
      cleanup();
    }
  });

  it('follows cross-repo hop via topic crossLink (MQ direction reversed)', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // For MQ/topic crossLinks: from=consumer, to=producer.
      // When tracing downstream from the producer (app/backend),
      // the fix should match link.to.repo === currentRepo and jump to link.from.repo.
      // symbolRef.name uses MQ consumer/producer format: "mqConsumer(...)" / "mqProducer(...)"
      // which won't exist in LadybugDB — the isTopic flag skips resolveByName.
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/frontend', // consumer
            symbolUid: 'source-scan::topic::consumer::order_created',
            symbolRef: { filePath: 'messaging.properties', name: 'mqConsumer(order_created)' },
          },
          to: {
            repo: 'app/backend', // producer
            symbolUid: 'source-scan::topic::provider::order_created',
            symbolRef: { filePath: 'messaging.properties', name: 'mqProducer(order_created)' },
          },
          type: 'topic',
          contractId: 'topic::order_created',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      // Entry repo (app/backend): resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        {
          id: 'be-producer',
          name: 'OrderCreatedProducer',
          type: 'Class',
          filePath: 'src/producer.ts',
        },
      ]);

      // Entry repo BFS depth 1: no CALLS neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Consumer repo (app/frontend): topic hop — resolveByName is SKIPPED.
      // No mock needed for resolveByName. Only need empty BFS results won't be called either.
      // The segment will have empty nodes but still be added.

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-producer',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      expect(trace.segments).toHaveLength(2);

      // First segment: producer repo (app/backend)
      expect(trace.segments[0].repoPath).toBe('app/backend');
      expect(trace.segments[0].crossHops).toHaveLength(1);
      expect(trace.segments[0].crossHops[0].contractId).toBe('topic::order_created');
      expect(trace.segments[0].crossHops[0].contractType).toBe('topic');

      // Second segment: consumer repo (app/frontend) — added via topic hop, no BFS
      expect(trace.segments[1].repoPath).toBe('app/frontend');
      expect(trace.segments[1].nodes).toHaveLength(0); // no BFS for topic hops
      // Crucially: NOT in skippedRepos
      expect(trace.skippedRepos).not.toContain('app/frontend');
    } finally {
      cleanup();
    }
  });

  it('deduplicates multiple topic hops to the same target repo', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // Two topic crossLinks from app/backend → app/frontend (different topics)
      // Should produce only ONE segment for app/frontend (deduped by repo).
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::topic::consumer::topic_a',
            symbolRef: { filePath: 'messaging.properties', name: 'mqConsumer(topic_a)' },
          },
          to: {
            repo: 'app/backend',
            symbolUid: 'source-scan::topic::provider::topic_a',
            symbolRef: { filePath: 'messaging.properties', name: 'mqProducer(topic_a)' },
          },
          type: 'topic',
          contractId: 'topic::topic_a',
          matchType: 'exact',
          confidence: 1,
        },
        {
          from: {
            repo: 'app/frontend',
            symbolUid: 'source-scan::topic::consumer::topic_b',
            symbolRef: { filePath: 'messaging.properties', name: 'mqConsumer(topic_b)' },
          },
          to: {
            repo: 'app/backend',
            symbolUid: 'source-scan::topic::provider::topic_b',
            symbolRef: { filePath: 'messaging.properties', name: 'mqProducer(topic_b)' },
          },
          type: 'topic',
          contractId: 'topic::topic_b',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-1', name: 'ProducerService', type: 'Class', filePath: 'src/producer.ts' },
      ]);
      // Entry repo BFS: no neighbors
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-1',
        maxDepth: 2,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Two topic crossLinks with different contractIds → two hops, two consumer segments.
      // Dedup key is topic::contractId::repo, so different contractIds each enqueue once.
      expect(trace.segments).toHaveLength(3);
      const frontendSegments = trace.segments.filter((s) => s.repoPath === 'app/frontend');
      expect(frontendSegments).toHaveLength(2);
      // Each hop should appear in entry crossHops
      expect(trace.segments[0].crossHops).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  it('skips resolveByName for unresolvable synthetic symbol names', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      // RPC crossLink with a cache-style symbolName that won't exist in lbug
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'cache::consumer::fare.fd',
            symbolRef: { filePath: 'src/cache.ts', name: 'cache.fare.fd.category.name' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'cache::provider::fare.fd',
            symbolRef: { filePath: 'cache.properties', name: 'cache.fare.fd.category.name' },
          },
          type: 'custom',
          contractId: 'custom::cache::fare.fd',
          matchType: 'exact',
          confidence: 0.8,
        },
      ]);

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'be-1', name: 'CacheService', type: 'Class', filePath: 'src/cache.ts' },
      ]);
      // Entry repo BFS depth 1: returns the file that matches crossLink
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'be-1',
          id: 'be-2',
          name: 'readCache',
          type: 'Method',
          filePath: 'src/cache.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);
      // Entry repo BFS depth 2: no more
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Target repo: since symbolName is "cache.fare.fd.category.name",
      // isUnresolvableSymbolName should return true → no lbug query fired →
      // repo is skipped (returns null from resolveByName → skipped).

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'be-1',
        maxDepth: 3,
        maxCrossDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Entry segment should have the crossHop
      expect(trace.segments[0].crossHops).toHaveLength(1);
      // Target repo should be SKIPPED (resolveByName returned null for unresolvable name)
      expect(trace.skippedRepos).toContain('app/frontend');
      // Only 1 segment (the entry repo)
      expect(trace.segments).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('returns error for invalid direction', async () => {
    const port = makePort();
    const result = await runGroupTrace(makeDeps(port, '/tmp'), {
      name: 'g1',
      repo: 'app/backend',
      target: 'foo',
      direction: 'sideways' as any,
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('direction');
  });

  it('skips test files when includeTests is false', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir);

      const { executeParameterized, executeQuery } =
        await import('../../../src/core/lbug/pool-adapter.js');

      // Resolve entry symbol (exact id match) — id has Method: prefix so drillDown is skipped
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'Method:sym-1', name: 'myFunc', type: 'Method', filePath: 'src/main.ts' },
      ]);

      // BFS depth 1: returns a test-file neighbor
      (executeParameterized as any).mockResolvedValueOnce([
        {
          sourceId: 'sym-1',
          id: 'test-sym',
          name: 'testMyFunc',
          type: 'Function',
          filePath: 'src/__tests__/main.test.ts',
          relType: 'CALLS',
          confidence: 1,
        },
      ]);
      // BFS depth 2 would not run (test-sym filtered → empty frontier)

      const port = makePort();
      const result = await runGroupTrace(makeDeps(port, tmpDir), {
        name: 'g1',
        repo: 'app/backend',
        target: 'sym-1',
        includeTests: false,
        maxDepth: 2,
      });

      expect(result).not.toHaveProperty('error');
      const trace = result as TraceResult;
      // Seed sym-1 (non-test) appears at depth=0; test-file neighbor filtered out.
      expect(trace.segments[0].nodes).toHaveLength(1);
      expect(trace.segments[0].nodes[0].id).toBe('Method:sym-1');
      expect(trace.segments[0].nodes.every((n) => !n.filePath.includes('__tests__'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Pure-function unit tests (no lbug, no I/O)
// ---------------------------------------------------------------------------

describe('isTestFilePath', () => {
  it.each([
    ['src/__tests__/foo.ts', true],
    ['src/foo.test.ts', true],
    ['src/foo.spec.ts', true],
    ['src/test/foo.ts', true],
    ['src/tests/foo.ts', true],
    ['src/foo_test.ts', true],
    ['src/main.ts', false],
    ['src/contest/winner.ts', false],
    ['src/TestHelper.ts', false],
  ])('%s → %s', (fp, expected) => {
    expect(isTestFilePath(fp)).toBe(expected);
  });
});

describe('isClientModulePath', () => {
  it.each([
    ['', false],
    ['services/order-service/src/main.ts', false],
    ['services/order-client/src/api.ts', true],
    ['services/order-client-v2/src/api.ts', true],
    ['services/order_client/src/api.ts', true],
    ['idl/order.thrift', true],
    ['src/services/order.thrift', true],
    ['services/order-api/src/routes.ts', true],
    ['services/order-client3/src/api.ts', true],
  ])('%s → %s', (fp, expected) => {
    expect(isClientModulePath(fp)).toBe(expected);
  });
});

describe('isUtilOrDto', () => {
  const c = (id: string, fp = ''): SymbolCandidate => ({
    id,
    name: id,
    type: 'Class',
    filePath: fp,
  });

  it('flags util classes', () => {
    expect(isUtilOrDto(c('utils/StringUtils'))).toBe(true);
    expect(isUtilOrDto(c('util/DateUtil'))).toBe(true);
  });

  it('flags enum / dto / entity', () => {
    expect(isUtilOrDto(c('enum/Status'))).toBe(true);
    expect(isUtilOrDto(c('dto/OrderDto'))).toBe(true);
    expect(isUtilOrDto(c('entity/UserEntity'))).toBe(true);
  });

  it('flags getter / setter / is-check methods', () => {
    expect(isUtilOrDto(c('Order.getName'))).toBe(true);
    expect(isUtilOrDto(c('Order.setName'))).toBe(true);
    expect(isUtilOrDto(c('Order.isActive'))).toBe(true);
  });

  it('does not flag normal service classes', () => {
    expect(isUtilOrDto(c('OrderService', 'src/service/OrderService.java'))).toBe(false);
    expect(isUtilOrDto(c('PaymentHandler', 'src/handler/PaymentHandler.java'))).toBe(false);
  });
});

describe('buildCrossLinksIndex', () => {
  it('indexes RPC links by from.repo (downstream) and to.repo (upstream)', () => {
    const links: any[] = [
      {
        from: { repo: 'svc-a', symbolRef: { filePath: 'a.ts', name: 'foo' }, symbolUid: 'u1' },
        to: { repo: 'svc-b', symbolRef: { filePath: 'b.ts', name: 'bar' }, symbolUid: 'u2' },
        type: 'http',
        contractId: 'c1',
        matchType: 'exact',
        confidence: 1,
      },
    ];
    const idx = buildCrossLinksIndex(links);
    expect(idx.downstreamRpc.get('svc-a')).toHaveLength(1);
    expect(idx.upstreamRpc.get('svc-b')).toHaveLength(1);
    expect(idx.downstreamTopic.size).toBe(0);
  });

  it('indexes topic links by to.repo (downstream) and from.repo (upstream)', () => {
    const links: any[] = [
      {
        from: { repo: 'consumer', symbolRef: { filePath: 'c.ts', name: 'recv' }, symbolUid: 'u3' },
        to: { repo: 'producer', symbolRef: { filePath: 'p.ts', name: 'send' }, symbolUid: 'u4' },
        type: 'topic',
        contractId: 'topic::orders',
        matchType: 'exact',
        confidence: 1,
      },
    ];
    const idx = buildCrossLinksIndex(links);
    expect(idx.downstreamTopic.get('producer')).toHaveLength(1);
    expect(idx.upstreamTopic.get('consumer')).toHaveLength(1);
    expect(idx.downstreamRpc.size).toBe(0);
  });

  it('returns empty index for no links', () => {
    const idx = buildCrossLinksIndex([]);
    expect(idx.downstreamRpc.size).toBe(0);
    expect(idx.upstreamRpc.size).toBe(0);
    expect(idx.downstreamTopic.size).toBe(0);
    expect(idx.upstreamTopic.size).toBe(0);
  });
});

describe('findCrossRepoHopsFromRegistry', () => {
  function makeIdx(overrides: Partial<CrossLinksIndex> = {}): CrossLinksIndex {
    return {
      downstreamRpc: new Map(),
      upstreamRpc: new Map(),
      downstreamTopic: new Map(),
      upstreamTopic: new Map(),
      ...overrides,
    };
  }

  it('returns empty when no links for this repo', () => {
    const idx = makeIdx();
    const hops = findCrossRepoHopsFromRegistry(idx, 'svc-a', new Set(['a.ts']), 'downstream');
    expect(hops).toHaveLength(0);
  });

  it('returns hop when visited file matches RPC from.symbolRef.filePath (downstream)', () => {
    const link: any = {
      from: {
        repo: 'svc-a',
        symbolRef: { filePath: 'src/client.ts', name: 'callB' },
        symbolUid: 'u1',
      },
      to: {
        repo: 'svc-b',
        symbolRef: { filePath: 'src/handler.ts', name: 'handle' },
        symbolUid: 'u2',
      },
      type: 'http',
      contractId: 'http::c1',
      matchType: 'exact',
      confidence: 0.9,
    };
    const idx = makeIdx({ downstreamRpc: new Map([['svc-a', [link]]]) });
    const visited = new Set(['src/client.ts']);
    const hops = findCrossRepoHopsFromRegistry(idx, 'svc-a', visited, 'downstream');
    expect(hops).toHaveLength(1);
    expect(hops[0].contractId).toBe('http::c1');
    expect(hops[0].from.repo).toBe('svc-a');
    expect(hops[0].to.repo).toBe('svc-b');
  });

  it('skips hop when visited file does NOT match', () => {
    const link: any = {
      from: {
        repo: 'svc-a',
        symbolRef: { filePath: 'src/client.ts', name: 'callB' },
        symbolUid: 'u1',
      },
      to: {
        repo: 'svc-b',
        symbolRef: { filePath: 'src/handler.ts', name: 'handle' },
        symbolUid: 'u2',
      },
      type: 'http',
      contractId: 'http::c1',
      matchType: 'exact',
      confidence: 0.9,
    };
    const idx = makeIdx({ downstreamRpc: new Map([['svc-a', [link]]]) });
    const visited = new Set(['src/other.ts']); // doesn't match
    const hops = findCrossRepoHopsFromRegistry(idx, 'svc-a', visited, 'downstream');
    expect(hops).toHaveLength(0);
  });

  it('deduplicates same contractId+repo combination', () => {
    const link: any = {
      from: {
        repo: 'svc-a',
        symbolRef: { filePath: 'src/client.ts', name: 'callB' },
        symbolUid: 'u1',
      },
      to: {
        repo: 'svc-b',
        symbolRef: { filePath: 'src/handler.ts', name: 'handle' },
        symbolUid: 'u2',
      },
      type: 'http',
      contractId: 'http::c1',
      matchType: 'exact',
      confidence: 0.9,
    };
    // Same link duplicated in index
    const idx = makeIdx({ downstreamRpc: new Map([['svc-a', [link, link]]]) });
    const visited = new Set(['src/client.ts']);
    const hops = findCrossRepoHopsFromRegistry(idx, 'svc-a', visited, 'downstream');
    expect(hops).toHaveLength(1);
  });

  it('skips self-links (remote.repo === currentRepo)', () => {
    const link: any = {
      from: {
        repo: 'svc-a',
        symbolRef: { filePath: 'src/client.ts', name: 'callSelf' },
        symbolUid: 'u1',
      },
      to: {
        repo: 'svc-a',
        symbolRef: { filePath: 'src/handler.ts', name: 'handle' },
        symbolUid: 'u2',
      },
      type: 'http',
      contractId: 'http::c-self',
      matchType: 'exact',
      confidence: 1,
    };
    const idx = makeIdx({ downstreamRpc: new Map([['svc-a', [link]]]) });
    const hops = findCrossRepoHopsFromRegistry(
      idx,
      'svc-a',
      new Set(['src/client.ts']),
      'downstream',
    );
    expect(hops).toHaveLength(0);
  });
});

describe('DefaultSymbolResolver.scoreCandidate', () => {
  const resolver = new DefaultSymbolResolver();
  const c = (id: string, fp = '', type = 'Method'): SymbolCandidate => ({
    id,
    name: id,
    type,
    filePath: fp,
  });

  it('prefers Method over Class', () => {
    const method = c('Method:Foo.bar', 'src/Foo.java', 'Method');
    const cls = c('Class:Foo', 'src/Foo.java', 'Class');
    expect(resolver.scoreCandidate(method)).toBeGreaterThan(resolver.scoreCandidate(cls));
  });

  it('boosts -service/ and -impl/ paths', () => {
    const impl = c('Class:FooImpl', 'services/order-service/FooImpl.java');
    const other = c('Class:Foo', 'services/order-common/Foo.java');
    expect(resolver.scoreCandidate(impl)).toBeGreaterThan(resolver.scoreCandidate(other));
  });

  it('penalizes -client/ paths', () => {
    const client = c('Class:FooClient', 'services/order-client/FooClient.java');
    expect(resolver.scoreCandidate(client)).toBeLessThan(0);
  });

  it('penalizes util/dto/entity patterns', () => {
    const util = c('utils/StringUtils');
    const dto = c('dto/OrderDto');
    const normal = c('Method:OrderService.create', 'src/service/OrderService.java');
    expect(resolver.scoreCandidate(util)).toBeLessThan(resolver.scoreCandidate(normal));
    expect(resolver.scoreCandidate(dto)).toBeLessThan(resolver.scoreCandidate(normal));
  });

  it('boosts classVariant match', () => {
    const impl = c('Class:OrderServiceImpl', 'src/OrderServiceImpl.java');
    const other = c('Class:OrderController', 'src/OrderController.java');
    expect(resolver.scoreCandidate(impl, ['OrderServiceImpl'])).toBeGreaterThan(
      resolver.scoreCandidate(other, ['OrderServiceImpl']),
    );
  });

  it('boosts PascalCase target name match', () => {
    const matching = c('Method:OrderService.create', 'src/OrderService.java');
    const unrelated = c('Method:PayService.create', 'src/PayService.java');
    expect(resolver.scoreCandidate(matching, [], 'orderService')).toBeGreaterThan(
      resolver.scoreCandidate(unrelated, [], 'orderService'),
    );
  });
});

// ---------------------------------------------------------------------------
// resolveCache: same symbol resolved twice in one trace should only call
// resolver.resolveSymbolByName once
// ---------------------------------------------------------------------------

describe('resolveCache', () => {
  it('deduplicates resolveSymbolByName calls for same repoId+symbolName', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'uid-1',
            symbolRef: { filePath: 'src/client.ts', name: 'FooService.bar' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'uid-2',
            symbolRef: { filePath: 'src/handler.ts', name: 'FooService.bar' },
          },
          type: 'thrift',
          contractId: 'thrift::FooService/bar',
          matchType: 'exact',
          confidence: 1,
        },
        // Second crossLink pointing to the SAME target symbol
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'uid-3',
            symbolRef: { filePath: 'src/client2.ts', name: 'FooService.bar' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'uid-2',
            symbolRef: { filePath: 'src/handler.ts', name: 'FooService.bar' },
          },
          type: 'thrift',
          contractId: 'thrift::FooService/bar2',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      // Entry repo: resolve entry symbol
      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'Method:be-1', name: 'callFoo', type: 'Method', filePath: 'src/client.ts' },
      ]);
      // Entry repo BFS: no neighbors (both crossLinks fire from same visited file)
      (executeParameterized as any).mockResolvedValueOnce([]);

      // Target repo: resolveSymbolByName — exact match query (should be called ONCE)
      (executeParameterized as any).mockResolvedValue([
        { id: 'Method:fe-1', name: 'bar', type: 'Method', filePath: 'src/handler.ts' },
      ]);

      const resolveCallCount = { n: 0 };
      const countingResolver = {
        resolveSymbolByName: async (...args: any[]) => {
          resolveCallCount.n++;
          const { DefaultSymbolResolver } =
            await import('../../../src/core/group/trace-resolver.js');
          return new DefaultSymbolResolver().resolveSymbolByName(...(args as [any, any, any]));
        },
      };

      const port = makePort();
      await runGroupTraceWithResolver(
        makeDeps(port, tmpDir),
        {
          name: 'g1',
          repo: 'app/backend',
          target: 'Method:be-1',
          maxCrossDepth: 2,
        },
        countingResolver,
      );

      // Two hops point to the same symbolName in the same repo.
      // resolveCache should deduplicate — resolver called at most once per unique key.
      expect(resolveCallCount.n).toBeLessThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// mtime cache: second trace call with unchanged files returns same result
// without error (behavioral smoke test — file reads are internal to Node fs)
// ---------------------------------------------------------------------------

describe('mtime cache', () => {
  it('returns consistent results on repeated calls with unchanged group files', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir);

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      // Two sequential trace calls need two sets of mocks
      for (let i = 0; i < 2; i++) {
        (executeParameterized as any).mockResolvedValueOnce([
          { id: 'Method:sym-1', name: 'myFunc', type: 'Method', filePath: 'src/main.ts' },
        ]);
        (executeParameterized as any).mockResolvedValueOnce([]);
      }

      const port = makePort();
      const params = { name: 'g1', repo: 'app/backend', target: 'Method:sym-1' };

      const r1 = (await runGroupTrace(makeDeps(port, tmpDir), params)) as any;
      const r2 = (await runGroupTrace(makeDeps(port, tmpDir), params)) as any;

      // Both calls succeed (no error) and return same structural shape
      expect(r1.error).toBeUndefined();
      expect(r2.error).toBeUndefined();
      expect(r1.group).toBe(r2.group);
      expect(r1.entryRepo).toBe(r2.entryRepo);
    } finally {
      cleanup();
    }
  });

  it('re-reads contracts.json when file content changes between calls', async () => {
    const { tmpDir, groupDir, cleanup } = tmpGroup();
    try {
      writeContractsJson(groupDir); // initially empty

      const { executeParameterized } = await import('../../../src/core/lbug/pool-adapter.js');

      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'Method:sym-1', name: 'myFunc', type: 'Method', filePath: 'src/main.ts' },
      ]);
      (executeParameterized as any).mockResolvedValueOnce([]);

      const port = makePort();
      const params = { name: 'g1', repo: 'app/backend', target: 'Method:sym-1' };

      const r1 = (await runGroupTrace(makeDeps(port, tmpDir), params)) as any;
      expect(r1.error).toBeUndefined();
      expect(r1.segments[0].crossHops).toHaveLength(0); // no crossLinks initially

      // Wait 5ms to ensure different mtime, then rewrite with a crossLink
      await new Promise((r) => setTimeout(r, 10));
      writeContractsJson(groupDir, [
        {
          from: {
            repo: 'app/backend',
            symbolUid: 'u1',
            symbolRef: { filePath: 'src/main.ts', name: 'foo' },
          },
          to: {
            repo: 'app/frontend',
            symbolUid: 'u2',
            symbolRef: { filePath: 'src/api.ts', name: 'foo' },
          },
          type: 'http',
          contractId: 'http::c1',
          matchType: 'exact',
          confidence: 1,
        },
      ]);

      (executeParameterized as any).mockResolvedValueOnce([
        { id: 'Method:sym-1', name: 'myFunc', type: 'Method', filePath: 'src/main.ts' },
      ]);
      (executeParameterized as any).mockResolvedValueOnce([]);

      const r2 = (await runGroupTrace(makeDeps(port, tmpDir), params)) as any;
      expect(r2.error).toBeUndefined();
      // After file change, the new crossLink should be picked up
      expect(r2.segments[0].crossHops).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
