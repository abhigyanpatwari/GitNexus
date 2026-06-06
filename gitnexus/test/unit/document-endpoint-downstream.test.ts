/**
 * Unit Tests: extractDownstreamApis — CALLS-graph resolver (Issue #93)
 *
 * Verifies that the new CALLS-graph resolution pass inserted at
 * document-endpoint.ts:2205 (BEFORE the class-name-heuristic fallback)
 * correctly resolves downstream API service names via the call graph
 * when the heuristic-only pass would have produced an unknown-service
 * or a less-accurate class name.
 *
 * The class-name-heuristic fallback at lines 2213-2215 (the existing
 * `if (serviceName === 'unknown-service' && className) { ... }` block)
 * is the [[route-fix-regression]] guard and must remain UNCHANGED.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies - MUST be before imports
vi.mock('../../src/mcp/local/endpoint-query.js', () => ({
  queryEndpoints: vi.fn(),
}));

vi.mock('../../src/mcp/local/trace-executor.js', () => ({
  executeTrace: vi.fn(),
}));

vi.mock('../../src/mcp/core/lbug-adapter.js', () => ({
  executeParameterized: vi.fn(),
  initLbug: vi.fn(),
  closeLbug: vi.fn(),
  isLbugReady: vi.fn(),
}));

// Import after mocks are set up
import { documentEndpoint } from '../../src/mcp/local/document-endpoint.js';
import * as endpointQuery from '../../src/mcp/local/endpoint-query.js';
import * as traceExecutor from '../../src/mcp/local/trace-executor.js';
import { executeParameterized } from '../../src/mcp/core/lbug-adapter.js';

// Type guard: narrow the union return type to the context branch
type DocumentEndpointContextResult = { result: import('../../src/mcp/local/document-endpoint.js').DocumentEndpointResult; error?: string };
function asContextResult(r: DocumentEndpointContextResult | import('../../src/mcp/local/document-endpoint.js').OpenApiModeResult): DocumentEndpointContextResult {
  return r as DocumentEndpointContextResult;
}

// Mock RepoHandle
const mockRepo = {
  id: 'test-repo',
  name: 'test-repo',
  repoPath: '/test/repo',
  storagePath: '/test/storage',
  lbugPath: '/test/lbug',
  indexedAt: new Date().toISOString(),
  lastCommit: 'abc123',
} as any;

// Helper to create empty metadata
const emptyMetadata = () => ({
  httpCalls: [],
  httpCallDetails: [],
  annotations: [],
  eventPublishing: [],
  messagingDetails: [],
  repositoryCalls: [],
  repositoryCallDetails: [],
  valueProperties: [],
  exceptions: [],
  builderDetails: [],
});

// Helper to create empty summary
const emptySummary = () => ({
  totalNodes: 1,
  maxDepthReached: 0,
  cycles: 0,
  httpCalls: 0,
  annotations: 0,
  eventPublishing: 0,
  repositoryCalls: 0,
});

/**
 * Detects whether a given Cypher query string is the CALLS-graph resolver
 * query (issue #93). Detection is STRUCTURAL — matches the graph pattern
 * (MATCH + CodeRelation + CALLS + HAS_METHOD + Route) so the test does
 * NOT depend on the magic `calls-graph-route` comment marker that the
 * production code emits. The marker is treated as a secondary, non-load-
 * bearing hint.
 */
function isCallsGraphResolverQuery(query: string): boolean {
  const hasMatch = /\bMATCH\b/i.test(query);
  const hasCallsRel = /CodeRelation\s*\{[^}]*type\s*:\s*['"]CALLS['"]/i.test(query);
  const hasHasMethodRel = /CodeRelation\s*\{[^}]*type\s*:\s*['"]HAS_METHOD['"]/i.test(query);
  const hasRouteLabel = /\(\s*\w*\s*:\s*Route\b/i.test(query);
  return hasMatch && hasCallsRel && hasHasMethodRel && hasRouteLabel;
}

/**
 * Recognises the CALLS-graph resolver query (inserted by #93) and returns
 * the configured Route row. All other queries return empty so that
 * earlier resolution passes (Pass 1-4 in extractDownstreamApis) miss and
 * the CALLS-graph resolver is the one that produces a service name.
 *
 * The returned mock is a vi.fn that ALSO records every issued query on
 * `issuedQueries` (an array passed in by the test). Tests assert against
 * the structural shape of issued queries, not the magic comment marker.
 */
function createCallsGraphAwareExecuteQuery(opts: {
  enclosingClassName: string;
  routeClassName: string;
  routeHttpMethod: string;
  routePath: string;
  throwOnGraph?: boolean;
  issuedQueries: string[];
}) {
  return vi.fn().mockImplementation(async (_repoId: string, query: string) => {
    opts.issuedQueries.push(query);
    // findEnclosingClass: MATCH (c:Class) WHERE c.filePath = $filePath
    if (query.includes('c.filePath')) {
      return [{ name: opts.enclosingClassName }];
    }
    // The CALLS-graph resolver query (issue #93): caller Method -> callee -> Class -> Route
    if (isCallsGraphResolverQuery(query)) {
      if (opts.throwOnGraph) {
        throw new Error('mocked graph DB failure');
      }
      return [{
        className: opts.routeClassName,
        httpMethod: opts.routeHttpMethod,
        routePath: opts.routePath,
      }];
    }
    // All other queries (Property, Class with @Value, FeignClient, static final, etc.)
    // return empty results so no earlier resolution pass succeeds.
    return [];
  });
}

/**
 * Convenience helper for tests that need a generic mock executeQuery
 * (e.g. for asserting the resolver query is NOT issued). The returned
 * mock records every issued query on `issuedQueries`.
 */
function createRecordingExecuteQuery(opts: {
  enclosingClassName: string;
  issuedQueries: string[];
  resolverRow?: { className: string; httpMethod: string; routePath: string };
  rejectOnResolver?: boolean;
}) {
  return vi.fn().mockImplementation(async (_repoId: string, query: string) => {
    opts.issuedQueries.push(query);
    if (query.includes('c.filePath')) {
      return [{ name: opts.enclosingClassName }];
    }
    if (isCallsGraphResolverQuery(query)) {
      if (opts.rejectOnResolver) {
        throw new Error('CALLS-graph query should NOT be issued for this test case');
      }
      return [opts.resolverRow ?? { className: 'Resolved', httpMethod: 'GET', routePath: '/x' }];
    }
    return [];
  });
}

describe('extractDownstreamApis — CALLS-graph resolver (#93)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: verification query returns the handler UID (method exists)
    vi.mocked(executeParameterized).mockImplementation(async (_repoId: string, query: string, params: any) => {
      if (params?.uid && (query.includes('m.id') || query.includes('Method {id:'))) {
        if (query.includes('parameterAnnotations')) {
          return [{ paramAnns: '[]' }];
        }
        return [{ id: params.uid }];
      }
      return [];
    });
  });

  /**
   * Test 1: CALLS-graph resolver finds a Route for the called method's class.
   *
   * The urlExpression `client.config()` is chosen so that:
   *  - No `Service` suffix → parsed.serviceName is null (Pass 1 misses)
   *  - variableRefs `client` and `config` are both in `genericNames` → Pass 4 misses
   *  - pathStr has no leading `/` after the HTTP method → path-based fallback misses
   *  → serviceName stays 'unknown-service' when the new pass runs.
   *
   * The CALLS-graph resolver walks: TraderClient#getTrades
   *      -> [CALLS] -> ProductController#getProduct
   *      <- [HAS_METHOD] <- ProductController
   *      <- [CALLS] <- Route(/product/{id}, GET)
   *   and resolves serviceName = "ProductController" with resolvedFrom containing
   *   "calls-graph-route".
   */
  it('resolves serviceName from CALLS graph when a Route is found for the callee class', async () => {
    const routeController = 'BondExtController'; // current endpoint
    const callerClass = 'TraderClient';           // enclosing class of the call site
    const calleeClass = 'ProductController';      // resolved class via CALLS graph
    const calleeUid = 'Method:src/services/ProductController.java:getProduct';
    const callerUid = 'Method:src/services/TraderClient.java:getTrades';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/trades',
        controller: routeController,
        handler: 'getTrades',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createCallsGraphAwareExecuteQuery({
      enclosingClassName: callerClass,
      routeClassName: calleeClass,
      routeHttpMethod: 'GET',
      routePath: '/product/{id}',
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: callerUid,
        name: 'getTrades',
        kind: 'Method',
        filePath: 'src/services/TraderClient.java',
        depth: 0,
        content: 'public String getTrades() { return productClient.getProduct("1"); }',
        metadata: {
          ...emptyMetadata(),
          // Use a urlExpression that bypasses every earlier heuristic so the
          // new CALLS-graph pass is the one that resolves the service.
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.config()', lineNumber: 5 }],
        },
        callees: [calleeUid],
      }],
      root: 'getTrades',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/trades',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe(calleeClass);
    // Primary structural assertions: the CALLS-graph resolver issued a
    // query that walks CALLS + HAS_METHOD edges to a Route node. These
    // do NOT depend on the `calls-graph-route` comment marker.
    const resolverQuery = issuedQueries.find(isCallsGraphResolverQuery);
    expect(resolverQuery, 'CALLS-graph resolver query should be issued').toBeDefined();
    expect(resolverQuery).toMatch(/\bMATCH\b/i);
    expect(resolverQuery).toMatch(/CodeRelation\s*\{[^}]*type\s*:\s*['"]CALLS['"]/i);
    expect(resolverQuery).toMatch(/CodeRelation\s*\{[^}]*type\s*:\s*['"]HAS_METHOD['"]/i);
    expect(resolverQuery).toMatch(/\(\s*\w*\s*:\s*Route\b/i);
    // Secondary: the magic comment marker is still emitted by production
    // code, so we keep this as a soft signal — if it ever changes, the
    // structural assertions above still hold.
    expect(apis[0].resolvedFrom).toContain('calls-graph-route');

    // Regression guard for [[route-fix-regression]]: prior route-fix attempts
    // broke document-endpoint output. The CALLS-graph resolver's issued
    // query must RETURN the route's `routePath` column together with
    // `httpMethod` — this is the data-flow guarantee that any future
    // surfacing of the resolved route path (into `endpoint`, OpenAPI
    // `servers`, or downstream spec) has something to read. A refactor
    // that drops `routePath` from the RETURN clause would silently lose
    // route information and slip past the resolver-tag assertions above;
    // this structural assertion catches it. Asserts the query shape, not
    // the magic comment marker, so it does not depend on `calls-graph-route`.
    expect(resolverQuery).toMatch(/routePath\s+AS\s+routePath/i);
    expect(resolverQuery).toMatch(/httpMethod\s+AS\s+httpMethod/i);
    // The mock's row[0].routePath must be the literal '/product/{id}' that
    // the test fed in — if a future refactor silently re-aliases the column
    // (e.g. to `path`), the row shape contract is broken and the test
    // catches it at the mock layer, not the assertion layer.
    // (The mock returns this row; we read it through the structural
    // resolverQuery assertions above. This line documents the contract.)
    expect(apis[0].resolvedFrom).toContain('calls-graph-route');
  });

  /**
   * Test 2: When the CALLS graph returns no rows, the function falls
   * through to the existing class-name heuristic. This is the
   * [[route-fix-regression]] guard — the heuristic MUST remain intact
   * and still produce a service name when the graph lookup is empty.
   */
  it('falls through to class-name heuristic when CALLS graph returns 0 rows', async () => {
    const routeController = 'BondExtController'; // current endpoint
    const callerClass = 'ProductController';       // enclosing class of the call site
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller: routeController,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    // Mock executeQuery: enclosing-class lookup works, but CALLS graph returns 0 rows
    const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string) => {
      issuedQueries.push(query);
      if (query.includes('c.filePath')) {
        return [{ name: callerClass }];
      }
      // CALLS-graph resolver returns 0 rows
      if (isCallsGraphResolverQuery(query)) {
        return [];
      }
      return [];
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/ProductController.java:callProduct',
        name: 'callProduct',
        kind: 'Method',
        filePath: 'src/services/ProductController.java',
        depth: 0,
        content: 'public String callProduct() { return client.url; }',
        metadata: {
          ...emptyMetadata(),
          // Bypass every earlier heuristic: client and url are both generic;
          // 'client.url' has '.' which makes variableName return null. The
          // endpoint 'GET client.url' does NOT match the B15 unresolved-
          // expression regex (no parentheses), so the entry survives.
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.url' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    // The class-name heuristic derives "product" from "ProductController"
    expect(apis[0].serviceName).toBe('product');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
    // Primary structural assertion: the CALLS-graph resolver WAS issued
    // (and returned 0 rows) — verify by the structural shape, not the
    // magic comment.
    const resolverQuery = issuedQueries.find(isCallsGraphResolverQuery);
    expect(resolverQuery, 'CALLS-graph resolver query should be issued').toBeDefined();
    expect(resolverQuery).toMatch(/\bMATCH\b/i);
    expect(resolverQuery).toMatch(/CodeRelation\s*\{[^}]*type\s*:\s*['"]CALLS['"]/i);
    // Critically, it MUST NOT be tagged with calls-graph-route
    expect(apis[0].resolvedFrom ?? '').not.toContain('calls-graph-route');
  });

  /**
   * Test 3: When the CALLS graph resolver itself throws an error
   * (e.g. Cypher syntax error, DB unavailable), the new pass must
   * swallow the error and fall through to the class-name heuristic.
   * This protects against any future breakage of the new pass from
   * taking down the entire downstream API detection.
   */
  it('falls through to class-name heuristic when CALLS graph query throws', async () => {
    const routeController = 'BondExtController';
    const callerClass = 'ProductController';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller: routeController,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createCallsGraphAwareExecuteQuery({
      enclosingClassName: callerClass,
      routeClassName: 'ProductController',
      routeHttpMethod: 'GET',
      routePath: '/product/{id}',
      throwOnGraph: true,
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/ProductController.java:callProduct',
        name: 'callProduct',
        kind: 'Method',
        filePath: 'src/services/ProductController.java',
        depth: 0,
        content: 'public String callProduct() { return client.url; }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.url' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe('product');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
    // Primary structural assertion: the resolver query WAS issued (and
    // threw), verified by graph pattern not magic comment.
    const resolverQuery = issuedQueries.find(isCallsGraphResolverQuery);
    expect(resolverQuery, 'CALLS-graph resolver query should be issued').toBeDefined();
    expect(resolverQuery).toMatch(/Route/i);
  });

  /**
   * Test 4: Self-reference guard. When the CALLS graph resolves to
   * the same service as the current endpoint's controller, the new
   * pass MUST NOT tag the entry as "calls-graph-route" — it falls
   * through to the class-name heuristic. If the class-name heuristic
   * ALSO produces the same service, the entry is excluded.
   */
  it('does not produce calls-graph-route for self-references', async () => {
    const controller = 'BondExtController'; // current endpoint controller
    const callerClass = 'BondExtController'; // enclosing class — also BondExtController
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    // CALLS graph would resolve to BondExtController (the same class)
    const mockExecuteQuery = createCallsGraphAwareExecuteQuery({
      enclosingClassName: callerClass,
      routeClassName: controller, // same as current controller
      routeHttpMethod: 'GET',
      routePath: '/bond-ext/items',
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/controllers/BondExtController.java:getItems',
        name: 'getItems',
        kind: 'Method',
        filePath: 'src/controllers/BondExtController.java',
        depth: 0,
        content: 'public String getItems() { return client.config(); }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.config()' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // Self-reference is excluded entirely — the new pass detects it and
    // skips; the class-name heuristic ALSO detects it (BondExtController
    // -> 'bond-ext' == current controller) and `continue`s the loop.
    expect(apis).toHaveLength(0);
    // Primary structural assertion: the resolver query WAS issued (the
    // mock returned a Route row), but the result was excluded because
    // the resolved class matches the current controller.
    const resolverQuery = issuedQueries.find(isCallsGraphResolverQuery);
    expect(resolverQuery, 'CALLS-graph resolver query should be issued').toBeDefined();
  });

  /**
   * Test 5: Non-Method nodes (Function, Class) are skipped by the
   * CALLS-graph resolver. The new pass is gated on `node.kind === 'Method'`.
   * The test verifies the graph query is NEVER issued for non-Method nodes
   * and that the class-name heuristic still runs.
   */
  it('skips CALLS-graph resolver when node.kind is not Method', async () => {
    const routeController = 'BondExtController';
    const callerClass = 'ProductController';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/items',
        controller: routeController,
        handler: 'getItems',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    // Spy to verify the CALLS-graph query is NOT issued for non-Method nodes
    const mockExecuteQuery = createRecordingExecuteQuery({
      enclosingClassName: callerClass,
      issuedQueries,
      rejectOnResolver: true,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Function:src/utils/ProductController.java:helper',
        name: 'helper',
        kind: 'Function', // not a Method
        filePath: 'src/utils/ProductController.java',
        depth: 0,
        content: 'function helper() { return client.url; }',
        metadata: {
          ...emptyMetadata(),
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.url' }],
        },
        callees: [],
      }],
      root: 'getItems',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/bond-ext/items',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    // The class-name heuristic still works for non-Method nodes
    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].serviceName).toBe('product');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');

    // Primary structural gate assertion: no query matching the CALLS-graph
    // resolver structural pattern (MATCH + CodeRelation/CALLS + HAS_METHOD
    // + Route) was issued for a non-Method node. Without this, a regression
    // that drops the `node.kind === 'Method'` guard would pass the
    // assertions above (the graph query would just return 0 rows, and the
    // heuristic would still run as the fallback) and the gate would be
    // silently lost. The structural check is independent of the
    // `calls-graph-route` comment marker.
    const resolverQuery = issuedQueries.find(isCallsGraphResolverQuery);
    expect(resolverQuery, 'CALLS-graph resolver query should NOT be issued for non-Method node').toBeUndefined();
  });
});
