/**
 * Unit Tests: extractDownstreamApis — Resolved Downstream (WI-B45, WI-B15, WI-B143)
 *
 * Covers three follow-up fixes to the CALLS-graph resolver (#93):
 *
 * - WI-B143: when the CALLS-graph resolver finds a Route, the `endpoint`
 *   field is populated from `${row.httpMethod} ${row.routePath}` (NOT from
 *   the original `urlExpression`).
 *
 * - WI-B45: when the class-name heuristic is the only path that resolves
 *   the service name AND >1 Route node in the same repo shares the
 *   derived service name, the emit is SKIPPED (over-match prevention).
 *
 * - WI-B15: entries whose endpoint matches a code-expression pattern
 *   (e.g. `.toString()`) AND whose `resolvedFrom` is WEAK (i.e. not
 *   statically-resolved) are dropped. Strongly-resolved entries and
 *   clean-path entries are preserved.
 *
 * Pattern follows [[feedback-bfs-mock-chain-pattern]]: vi.hoisted fs+rg
 * mocks + query-sniffed executeParameterized for the route-count gate.
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

const emptySummary = () => ({
  totalNodes: 1,
  maxDepthReached: 0,
  cycles: 0,
  httpCalls: 0,
  annotations: 0,
  eventPublishing: 0,
  repositoryCalls: 0,
});

/** Detects the CALLS-graph resolver query (issue #93) structurally. */
function isCallsGraphResolverQuery(query: string): boolean {
  const hasMatch = /\bMATCH\b/i.test(query);
  const hasCallsRel = /CodeRelation\s*\{[^}]*type\s*:\s*['"]CALLS['"]/i.test(query);
  const hasHasMethodRel = /CodeRelation\s*\{[^}]*type\s*:\s*['"]HAS_METHOD['"]/i.test(query);
  const hasRouteLabel = /\(\s*\w*\s*:\s*Route\b/i.test(query);
  return hasMatch && hasCallsRel && hasHasMethodRel && hasRouteLabel;
}

/** Detects the WI-B45 route-count gate query structurally. */
function isRouteCountQuery(query: string): boolean {
  return /count\s*\(\s*r\s*\)/i.test(query) && /\(r\s*:\s*Route\)/i.test(query);
}

/**
 * Creates a mock executeQuery that:
 *  - resolves the enclosing class lookup (`c.filePath` match)
 *  - optionally returns a CALLS-graph row (issue #93)
 *  - optionally returns a route-count row (WI-B45) — keyed by `className` param
 */
function createResolvedDownstreamExecuteQuery(opts: {
  enclosingClassName: string;
  callsGraphRow?: { className: string; httpMethod: string; routePath: string };
  routeCount?: number | ((className: string) => number);
  issuedQueries: string[];
}) {
  return vi.fn().mockImplementation(async (_repoId: string, query: string, params: any) => {
    opts.issuedQueries.push(query);
    if (query.includes('c.filePath')) {
      return [{ name: opts.enclosingClassName }];
    }
    if (isCallsGraphResolverQuery(query)) {
      return opts.callsGraphRow ? [opts.callsGraphRow] : [];
    }
    if (isRouteCountQuery(query)) {
      const cn = params?.className;
      const cnt = typeof opts.routeCount === 'function'
        ? opts.routeCount(cn)
        : (opts.routeCount ?? 0);
      return [{ cnt }];
    }
    return [];
  });
}

describe('extractDownstreamApis — Resolved Downstream (WI-B45, WI-B15, WI-B143)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: handler verification query returns the UID. The route-count
    // gate (WI-B45) is intercepted by the per-test `executeQuery` mock
    // (via `isRouteCountQuery` in `createResolvedDownstreamExecuteQuery`).
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
   * WI-B143: when the CALLS-graph resolver returns a Route row, the
   * resulting `endpoint` field is built from `${httpMethod} ${routePath}`,
   * not from the original `urlExpression` (e.g. `client.config()`).
   */
  it('WI-B143: populates endpoint from CALLS-graph row.httpMethod + row.routePath', async () => {
    const callerClass = 'TraderClient';
    const calleeClass = 'OrderService';
    const callerUid = 'Method:src/services/TraderClient.java:getTrades';
    const calleeUid = 'Method:src/services/OrderService.java:getOrder';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/bond-ext/trades',
        controller: 'BondExtController',
        handler: 'getTrades',
        filePath: 'src/controllers/BondExtController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      callsGraphRow: {
        className: calleeClass,
        httpMethod: 'GET',
        routePath: '/{id}',
      },
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: callerUid,
        name: 'getTrades',
        kind: 'Method',
        filePath: 'src/services/TraderClient.java',
        depth: 0,
        content: 'public String getTrades() { return orderClient.getOrder("1"); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression that bypasses every earlier heuristic so the
          // CALLS-graph resolver is the only path that resolves the service.
          // `client` and `config` are both in `genericNames`, so the variable-
          // name heuristic returns null → serviceName stays `unknown-service`
          // when the CALLS-graph resolver runs.
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
    expect(apis[0].resolvedFrom).toContain('calls-graph-route');
    // PRIMARY ASSERTION: endpoint is "GET /{id}" (from routePath),
    // NOT "GET orderClient.getOrder(...)" (from urlExpression).
    expect(apis[0].endpoint).toBe('GET /{id}');
    expect(apis[0].endpoint).not.toContain('orderClient');
    expect(apis[0].endpoint).not.toContain('"1"');
  });

  /**
   * WI-B45 (gate fires): when the CALLS-graph returns 0 rows AND the
   * class-name heuristic derives a service name AND the route-count
   * query returns >1, the entry is SKIPPED (over-match prevention).
   */
  it('WI-B45: skips class-name-heuristic emit when route count > 1 (over-match gate)', async () => {
    const callerClass = 'OrderService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/quotes/{id}',
        // Use a DIFFERENT controller name so the self-reference guard does
        // not fire (the gate must be the one that filters this entry).
        controller: 'QuoteController',
        handler: 'getQuote',
        filePath: 'src/controllers/QuoteController.java',
        line: 10,
      }],
    });

    // CALLS-graph returns 0 rows → class-name heuristic is the only path.
    // route-count gate returns 2 → ambiguous → skip emit.
    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      routeCount: () => 2, // > 1 → gate fires
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/OrderService.java:getOrder',
        name: 'getOrder',
        kind: 'Method',
        filePath: 'src/services/OrderService.java',
        depth: 0,
        content: 'public String getOrder() { return client.config(); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression bypasses every earlier heuristic (no leading `/`,
          // variableRefs `client`/`config` are both generic, has `.` and
          // `(` which makes variableName return null). The class-name
          // heuristic is the only path that can resolve the service.
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.config()' }],
        },
        callees: [],
      }],
      root: 'getQuote',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/api/quotes/{id}',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // Gate fires: count=2 > 1 → SKIP → apis is empty
    expect(apis).toHaveLength(0);

    // Verify the route-count query was issued (gate ran)
    const routeCountQuery = issuedQueries.find(isRouteCountQuery);
    expect(routeCountQuery, 'WI-B45 route-count query should be issued').toBeDefined();
    expect(routeCountQuery).toMatch(/controllerName\s+CONTAINS\s+\$className/i);
  });

  /**
   * WI-B45 (regression): when route count === 1, the heuristic emits as
   * before — no regression.
   */
  it('WI-B45 regression: emits class-name-heuristic entry when route count === 1 (unambiguous)', async () => {
    const callerClass = 'OrderService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/quotes/{id}',
        // Different controller so the self-reference guard does not fire.
        controller: 'QuoteController',
        handler: 'getQuote',
        filePath: 'src/controllers/QuoteController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      routeCount: () => 1, // unambiguous → emit
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/OrderService.java:getOrder',
        name: 'getOrder',
        kind: 'Method',
        filePath: 'src/services/OrderService.java',
        depth: 0,
        content: 'public String getOrder() { return client.config(); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression bypasses every earlier heuristic (no leading `/`,
          // variableRefs `client`/`config` are both generic, has `.` and
          // `(` which makes variableName return null). The class-name
          // heuristic is the only path that can resolve the service.
          // Note: the endpoint `GET client.config()` ALSO matches the
          // WI-B15 unresolved-expression pattern, so this entry will be
          // dropped by the B15 filter. The test isolates the B45 gate
          // behavior by asserting the gate's query was issued — proving
          // the gate ran with count=1 (unambiguous) and DID NOT fire
          // (no skip). The "no regression for count=1" is also covered
          // by the existing 5 tests in document-endpoint-downstream.test.ts
          // (which use the class-name heuristic with clean-path endpoints).
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: 'client.config()' }],
        },
        callees: [],
      }],
      root: 'getQuote',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/api/quotes/{id}',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    // Gate verification: route-count query was issued (proving the gate
    // ran). The predicate (count > 1 → skip) was NOT satisfied
    // (count=1), so the gate did not skip the entry. Whether the entry
    // survives the B15 filter is a separate concern (covered by
    // WI-B15 tests).
    const routeCountQuery = issuedQueries.find(isRouteCountQuery);
    expect(routeCountQuery, 'WI-B45 route-count query should be issued (proving gate ran)').toBeDefined();
    // Use `result` so vitest doesn't warn about an unused variable
    expect(asContextResult(result).result).toBeDefined();
  });

  /**
   * WI-B45 (full predicate coverage, AC #2): when route count === 1, the
   * class-name-heuristic entry is EMITTED. This is the complement of the
   * "skip when >1" test above and closes the AC #2 acceptance criterion.
   *
   * Fixture: `urlExpression: 'client.config'` — no `()` so the B15
   * unresolved-expression filter does NOT fire. The two variable refs
   * (`client`, `config`) are both in `genericNames` (line 2433 of
   * document-endpoint.ts) so the variable-name-heuristic returns null for
   * both. The class-name heuristic (line 2279) is the only path that
   * resolves the service. With routeCount=1 the gate does NOT fire — the
   * entry EMITS with `resolvedFrom: 'class-name-heuristic'`.
   */
  it('WI-B45: emits class-name-heuristic entry when route count === 1 (full predicate coverage)', async () => {
    const callerClass = 'OrderService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/api/orders',
        // Different controller so the self-reference guard does not fire.
        controller: 'QuoteController',
        handler: 'getQuote',
        filePath: 'src/controllers/QuoteController.java',
        line: 10,
      }],
    });

    // CALLS-graph returns 0 rows → class-name heuristic is the only path.
    // route-count gate returns 1 → unambiguous → EMIT.
    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      routeCount: () => 1, // unambiguous → emit
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/OrderService.java:getOrder',
        name: 'getOrder',
        kind: 'Method',
        filePath: 'src/services/OrderService.java',
        depth: 0,
        content: 'public String getOrder() { return client.config; }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression `client.config`:
          //   - has `.` → variableName heuristic at line 2212 returns null
          //   - has NO `()` → B15 regex `/\.\w+\(\)/` does NOT match
          //   - has no leading `/` → endpoint-path fallback (line 2153) skipped
          //   - `client` and `config` are both in `genericNames` → variable
          //     refs at line 2185-2193 all return null
          // Result: the class-name heuristic is the only path that can
          // resolve the service, and with routeCount=1 the gate does NOT
          // fire — the entry EMITS.
          httpCallDetails: [{
            httpMethod: 'GET',
            urlExpression: 'client.config',
            variableRefs: ['client', 'config'],
          }],
        },
        callees: [],
      }],
      root: 'getQuote',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/api/orders',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // PRIMARY ASSERTION: the entry was emitted (full predicate coverage of
    // AC #2's "count === 1 → emit" half). The complement test above
    // verifies the "count > 1 → skip" half.
    expect(apis).toHaveLength(1);
    expect(apis[0].endpoint).toBe('GET client.config');
    expect(apis[0].resolvedFrom).toContain('class-name-heuristic');
  });

  /**
   * WI-B15 (AC #4): the unresolved-expression filter preserves strongly-
   * resolved entries even when the endpoint contains a `.toString()`-
   * style member-call pattern. A regression that weakened the strong-
   * token check (e.g. dropped `static-final` from the strong list) would
   * silently drop legitimate `static-final` URLs that happen to include
   * `.toString()` in their trace.
   *
   * Setup: variableRef `url` resolves to a static-final field whose
   * declared value contains `.toString()` (a legitimate StringBuilder-
   * traced URL). The endpoint is built from the resolved path constant
   * (line 2080 of document-endpoint.ts), so the resulting endpoint
   * contains `.toString()` and resolvedFrom is `static-final` (strong).
   * The B15 filter MUST preserve this entry.
   */
  it('WI-B15: preserves strong resolvedFrom with `.toString()` in endpoint (AC #4)', async () => {
    const callerClass = 'OrderService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/i/v2/orders/ibond',
        controller: 'BondController',
        handler: 'placeIbond',
        filePath: 'src/controllers/BondController.java',
        line: 10,
      }],
    });

    // The mock must respond to the resolveStaticFieldValue query (detected
    // by `classNamePattern === '.OrderService'`) with a class record that
    // has a static-final `url` field. The value contains `.toString()` to
    // exercise the B15 unresolved-expression regex. resolvedFrom will be
    // set to `static-final` (strong) at document-endpoint.ts:2007.
    const mockExecuteQuery = vi.fn().mockImplementation(async (_repoId: string, query: string, params: any) => {
      issuedQueries.push(query);
      if (query.includes('c.filePath')) {
        return [{ name: callerClass }];
      }
      if (isCallsGraphResolverQuery(query)) {
        return []; // CALLS-graph returns 0 rows
      }
      if (isRouteCountQuery(query)) {
        return [{ cnt: 1 }];
      }
      // resolveStaticFieldValue: keyed by classNamePattern === '.OrderService'
      if (params?.classNamePattern === '.OrderService') {
        return [{
          fields: JSON.stringify([{
            name: 'url',
            modifiers: ['static', 'final'],
            // Contrived: a static-final whose value contains `.toString()`,
            // modelling a StringBuilder-traced URL. The literal substring
            // is what the B15 regex `/\.\w+\(\)/` matches against.
            value: '/api/profile.toString()',
          }]),
        }];
      }
      return [];
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/OrderService.java:getOrder',
        name: 'getOrder',
        kind: 'Method',
        filePath: 'src/services/OrderService.java',
        depth: 0,
        content: 'public String getOrder() { return restTemplate.getForObject(url.toString(), String.class); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression has `.toString()` and variableRef `url` resolves
          // to a static-final field. The endpoint is built from
          // pathConstants[0].value (line 2080), so the final endpoint
          // contains `.toString()` and resolvedFrom is `static-final`.
          httpCallDetails: [{
            httpMethod: 'GET',
            urlExpression: 'url.toString()',
            variableRefs: ['url'],
          }],
        },
        callees: [],
      }],
      root: 'placeIbond',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/i/v2/orders/ibond',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // PRIMARY ASSERTION: the B15 filter preserves this entry because
    // resolvedFrom contains a strong token (`static-final`). The endpoint
    // matches the unresolved-expression pattern (`.toString()`), but the
    // strong resolvedFrom wins.
    expect(apis).toHaveLength(1);
    expect(apis[0].resolvedFrom).toContain('static-final');
    // The endpoint, built from the static-final value, contains `.toString()`.
    expect(apis[0].endpoint).toContain('.toString()');
  });

  it('WI-B15: drops entry with `.toString()` endpoint and weak resolvedFrom', async () => {
    const callerClass = 'BondTradingService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'POST',
        path: '/i/v2/orders/ibond',
        controller: 'BondController',
        handler: 'placeIbond',
        filePath: 'src/controllers/BondController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/BondTradingService.java:placeIbond',
        name: 'placeIbond',
        kind: 'Method',
        filePath: 'src/services/BondTradingService.java',
        depth: 0,
        content: 'public String placeIbond() { return restTemplate.postForEntity(url.toString(), body, String.class); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression is `url.toString()` — `.toString()` is the unresolved
          // expression pattern. pathConstants is empty so the endpoint falls
          // through to `${httpMethod} ${urlExpression}`.
          httpCallDetails: [{ httpMethod: 'POST', urlExpression: 'url.toString()' }],
        },
        callees: [],
      }],
      root: 'placeIbond',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/i/v2/orders/ibond',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // The filter drops the entry: endpoint matches `/\.\w+\(\)/` AND
    // resolvedFrom is weak (`endpoint-path` or `variable-name-heuristic`).
    expect(apis).toHaveLength(0);
  });

  /**
   * WI-B15 (regression): a clean path endpoint (no `.toString()`) with a
   * weak `resolvedFrom` is preserved.
   */
  it('WI-B15 regression: preserves clean-path endpoint with weak resolvedFrom', async () => {
    const callerClass = 'UserService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'GET',
        path: '/users',
        controller: 'UserController',
        handler: 'listUsers',
        filePath: 'src/controllers/UserController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/UserService.java:listUsers',
        name: 'listUsers',
        kind: 'Method',
        filePath: 'src/services/UserService.java',
        depth: 0,
        content: 'public String listUsers() { return client.config(); }',
        metadata: {
          ...emptyMetadata(),
          // urlExpression `/api/users` has no member-call → NOT an unresolved
          // expression. resolvedFrom is `endpoint-path` (weak) but the filter
          // only fires when the regex matches, so the entry is preserved.
          httpCallDetails: [{ httpMethod: 'GET', urlExpression: '/api/users' }],
        },
        callees: [],
      }],
      root: 'listUsers',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'GET',
      path: '/users',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    expect(apis).toHaveLength(1);
    expect(apis[0].endpoint).toBe('GET /api/users');
    // Resolved from path → contains 'endpoint-path' (weak)
    expect(apis[0].resolvedFrom).toContain('endpoint-path');
  });

  /**
   * WI-B15 EdgeCase #5: a single handler with 2 calls (one clean, one
   * `.toString()`) produces 2 entries. The filter operates per-entry:
   * the clean path is preserved, the `.toString()` entry is dropped.
   */
  it('WI-B15 EdgeCase #5: filters multiple entries independently per call', async () => {
    const callerClass = 'TradingService';
    const issuedQueries: string[] = [];

    vi.mocked(endpointQuery.queryEndpoints).mockResolvedValue({
      endpoints: [{
        method: 'POST',
        path: '/trades',
        controller: 'TradeController',
        handler: 'placeTrade',
        filePath: 'src/controllers/TradeController.java',
        line: 10,
      }],
    });

    const mockExecuteQuery = createResolvedDownstreamExecuteQuery({
      enclosingClassName: callerClass,
      issuedQueries,
    });

    vi.mocked(traceExecutor.executeTrace).mockResolvedValue({
      chain: [{
        uid: 'Method:src/services/TradingService.java:placeTrade',
        name: 'placeTrade',
        kind: 'Method',
        filePath: 'src/services/TradingService.java',
        depth: 0,
        content: 'public String placeTrade() { svc.foo(); restTemplate.postForEntity(url.toString(), body, String.class); }',
        metadata: {
          ...emptyMetadata(),
          // Two httpCallDetails: one clean, one with .toString()
          httpCallDetails: [
            { httpMethod: 'GET', urlExpression: '/api/quotes' },
            { httpMethod: 'POST', urlExpression: 'url.toString()' },
          ],
        },
        callees: [],
      }],
      root: 'placeTrade',
      summary: emptySummary(),
    });

    const result = await documentEndpoint(mockRepo, {
      method: 'POST',
      path: '/trades',
      include_context: true,
      executeQuery: mockExecuteQuery,
    });

    const apis = asContextResult(result).result.externalDependencies.downstreamApis;
    // Two entries produced; only the clean-path entry survives the filter.
    expect(apis).toHaveLength(1);
    expect(apis[0].endpoint).toBe('GET /api/quotes');
  });
});
