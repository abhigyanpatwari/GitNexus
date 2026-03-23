# Route Mapping, Decorator Detection & Response Shape Tracking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Map `fetch('/api/...')` calls to Next.js/Express route handler files, detect framework decorators as graph nodes, and optionally extract response shapes for mismatch detection.

**Architecture:** Three phases building on GitNexus's existing pipeline. Phase 1 adds Next.js file-system route mapping (fetch URL → route.ts handler). Phase 2 adds AST decorator detection for `@Controller`, `@Get`, `@Query`, etc. Phase 3 adds response shape extraction from `NextResponse.json({...})` / `res.json({...})`. Each phase produces new graph nodes/edges using existing infrastructure (`ExtractedRoute`, `processRoutesFromExtracted`, tree-sitter queries).

**Tech Stack:** TypeScript, tree-sitter (existing), LadybugDB graph (existing), GitNexus ingestion pipeline

**Worktree:** `~/Coding-space/GitNexus/gitnexus-response-shapes/gitnexus/`
**Branch:** `feat/response-shape-tracking`
**Issue:** https://github.com/abhigyanpatwari/GitNexus/issues/471

**Note:** Phases 1-2 build the route-to-handler mapping infrastructure. Phase 3 implements the actual response shape tracking from issue #471. The route mapping is a prerequisite — you need to know which handler serves which endpoint before you can compare response shapes.

---

## Review Fixes (read before implementing)

The following corrections override the task details below:

### Fix 1: Template string capture (Task 3)
Do NOT capture `string_fragment` from template strings — tree-sitter splits them into fragments. Instead, capture the **entire** `template_string` node and use its `.text` property. In the parse worker, reconstruct the URL by replacing `${...}` with `[param]`. The tree-sitter query should be:
```
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string) @route.template_url])) @route.fetch
```
In parse worker: if `captureMap['route.template_url']`, use `captureMap['route.template_url'].text` and pass through `normalizeFetchURL()` which already handles `${...}` → `[param]` and backtick stripping.

### Fix 2: Separate fetch route processing from Laravel (Task 5)
The existing `processRoutesFromExtracted` skips entries with `controllerName: null` (line 1298). Do NOT push fetch URLs into `ExtractedRoute`. Instead:
- Store fetch URLs in a new `extractedFetchCalls` array (separate from `routes`)
- Create a new function `processNextjsFetchRoutes(graph, fetchCalls, routeRegistry)` in call-processor.ts
- Call it from pipeline.ts after route registry is built

### Fix 3: captureMap collision (Task 5)
`fetch()` calls produce TWO separate tree-sitter matches: one as `@call`/`@call.name` and one as `@route.fetch`/`@route.url`. Handle `route.fetch` in its own `if` block BEFORE the `call` block in the parse worker loop, with `continue` to avoid double-processing.

### Fix 4: Update validation sets (Task 1)
Also add to `local-backend.ts`:
- `'Route'` to `VALID_NODE_LABELS` set
- `'HANDLES_ROUTE'` and `'FETCHES'` to `VALID_RELATION_TYPES` set

### Fix 5: Test infrastructure
The worktree has NO test files — they live in the main repo at `gitnexus/test/`. Before Task 6, verify the test helpers exist. If not, run `npm install` in the worktree first. The test fixtures and helpers from the main repo should be available since it's a git worktree (shares history).

### Known limitations (document but don't fix)
- `fetch('/api/' + endpoint)` — string concatenation URLs can't be resolved
- `fetch(getApiUrl())` — wrapper function URLs can't be resolved
- Dynamic routes `/api/[userId]/posts` vs `/api/[orgId]/members` — ambiguous, both match
- Pages Router defaults to `['GET']` — handler actually handles all methods via `req.method`

---

## Existing Infrastructure

Key files to understand before starting:

| File | What it does | Relevant to |
|------|-------------|-------------|
| `src/core/ingestion/pipeline.ts` | Orchestrates all analysis phases | Where new processors get called |
| `src/core/ingestion/workers/parse-worker.ts` | Extracts symbols/calls/routes from AST | `ExtractedRoute` interface, Laravel route extraction |
| `src/core/ingestion/call-processor.ts` | Resolves calls to graph edges | `processRoutesFromExtracted` (Laravel only) |
| `src/core/ingestion/framework-detection.ts` | Detects framework from file paths | Already knows Next.js API routes |
| `src/core/ingestion/tree-sitter-queries.ts` | Tree-sitter queries per language | Where decorator/fetch queries go |
| `src/core/graph/types.ts` | Node labels + relationship types | Where new types are added |
| `src/mcp/tools.ts` | MCP tool definitions | Where `shape_check` tool goes |
| `src/mcp/local/local-backend.ts` | MCP tool implementations | Where `shape_check` logic goes |

**Existing route infrastructure:**
- `ExtractedRoute` interface already exists (filePath, httpMethod, routePath, controllerName, methodName)
- `processRoutesFromExtracted` already creates CALLS edges from route files to controllers
- `extractLaravelRoutes` in parse-worker.ts is the reference implementation
- `framework-detection.ts` already identifies Next.js API routes by path pattern

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/core/ingestion/route-extractors/nextjs.ts` | Extract Next.js file-system routes + fetch URL mapping |
| `src/core/ingestion/route-extractors/express.ts` | Extract Express/Hono route registrations |
| `src/core/ingestion/response-shape-extractor.ts` | Extract response object keys from `NextResponse.json({...})` |
| `test/fixtures/lang-resolution/nextjs-route-mapping/` | Test fixture: Next.js app with API routes + fetch consumers |
| `test/fixtures/lang-resolution/express-route-mapping/` | Test fixture: Express app with routes |
| `test/integration/resolvers/route-mapping.test.ts` | Integration tests for route mapping |

### Modified files
| File | What changes |
|------|-------------|
| `src/core/graph/types.ts` | Add `Route` node label, `HANDLES_ROUTE` relationship type |
| `src/core/ingestion/pipeline.ts` | Call route extraction after parsing phase |
| `src/core/ingestion/workers/parse-worker.ts` | Add Next.js fetch-to-route extraction |
| `src/core/ingestion/tree-sitter-queries.ts` | Add fetch() call capture with URL argument |
| `src/core/ingestion/call-processor.ts` | Extend `processRoutesFromExtracted` for Next.js |
| `src/mcp/tools.ts` | Add `route_map` tool definition |
| `src/mcp/local/local-backend.ts` | Add `route_map` tool implementation |

---

## Phase 1: Next.js Route Mapping (fetch URL → route handler)

### Task 1: Add Route node and HANDLES_ROUTE edge types

**Files:**
- Modify: `src/core/graph/types.ts`

- [ ] **Step 1: Add new types**

Add `Route` to `NodeLabel` union:
```typescript
| 'Route'       // API route endpoint (e.g., /api/grants)
```

Add `HANDLES_ROUTE` to `RelationshipType` union:
```typescript
| 'HANDLES_ROUTE'  // Function/File → Route (handler serves this endpoint)
| 'FETCHES'        // Function/File → Route (consumer calls this endpoint)
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: clean (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/core/graph/types.ts
git commit -m "feat: add Route node and HANDLES_ROUTE/FETCHES edge types"
```

---

### Task 2: Create Next.js route extractor

**Files:**
- Create: `src/core/ingestion/route-extractors/nextjs.ts`

- [ ] **Step 1: Write the route URL builder**

The extractor maps Next.js file-system paths to API route URLs:
- `app/api/grants/route.ts` → `/api/grants`
- `app/api/organizations/[slug]/grants/route.ts` → `/api/organizations/[slug]/grants`
- `pages/api/auth/login.ts` → `/api/auth/login`

```typescript
/**
 * Convert a Next.js file path to its API route URL.
 * Returns null if the file is not a route handler.
 */
export function nextjsFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // App Router: app/**/route.ts
  const appMatch = normalized.match(/app\/(.+?)\/route\.(ts|js|tsx|jsx)$/);
  if (appMatch) {
    return '/' + appMatch[1];
  }

  // Pages Router: pages/api/**/*.ts
  const pagesMatch = normalized.match(/pages\/(api\/.+?)\.(ts|js|tsx|jsx)$/);
  if (pagesMatch) {
    let route = '/' + pagesMatch[1];
    // Remove /index suffix
    route = route.replace(/\/index$/, '');
    return route;
  }

  return null;
}

/**
 * Extract HTTP methods exported from a Next.js App Router route file.
 * Looks for: export async function GET/POST/PUT/DELETE/PATCH
 */
export function extractNextjsHttpMethods(fileContent: string): string[] {
  const methods: string[] = [];
  const pattern = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/g;
  let match;
  while ((match = pattern.exec(fileContent)) !== null) {
    methods.push(match[1]);
  }
  return methods.length > 0 ? methods : ['GET']; // Default to GET for pages router
}
```

- [ ] **Step 2: Write the fetch URL normalizer**

```typescript
/**
 * Normalize a fetch URL to match against route patterns.
 * - Strips template literal expressions: `/api/orgs/${slug}` → `/api/orgs/[param]`
 * - Strips query strings: `/api/grants?page=1` → `/api/grants`
 * - Handles string concatenation: `'/api/' + path` → null (can't resolve)
 */
export function normalizeFetchURL(rawURL: string): string | null {
  // Must start with /api or be a relative path to /api
  if (!rawURL.includes('/api/') && !rawURL.startsWith('/api')) return null;

  // Extract path portion (before ?)
  let url = rawURL.split('?')[0];

  // Replace template literal expressions ${...} with [param]
  url = url.replace(/\$\{[^}]+\}/g, '[param]');

  // Replace backtick wrapper if present
  url = url.replace(/^`|`$/g, '');

  // Must be a clean path
  if (url.includes('+') || url.includes('(')) return null;

  return url;
}

/**
 * Check if a fetch URL matches a Next.js route pattern.
 * Handles dynamic segments: /api/orgs/[param] matches /api/orgs/[slug]
 */
export function routeMatches(fetchURL: string, routeURL: string): boolean {
  const fetchParts = fetchURL.split('/').filter(Boolean);
  const routeParts = routeURL.split('/').filter(Boolean);

  if (fetchParts.length !== routeParts.length) return false;

  return fetchParts.every((part, i) => {
    if (part.startsWith('[') || routeParts[i].startsWith('[')) return true;
    return part === routeParts[i];
  });
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/core/ingestion/route-extractors/nextjs.ts
git commit -m "feat: add Next.js route URL extractor and fetch URL normalizer"
```

---

### Task 3: Add fetch URL extraction to tree-sitter queries

**Files:**
- Modify: `src/core/ingestion/tree-sitter-queries.ts`

- [ ] **Step 1: Add fetch URL capture to TypeScript/JavaScript queries**

Add to both `TYPESCRIPT_QUERIES` and `JAVASCRIPT_QUERIES`:
```
; fetch('/api/...') calls — capture URL argument for route mapping
(call_expression
  function: (identifier) @_fetch_fn (#eq? @_fetch_fn "fetch")
  arguments: (arguments
    [(string (string_fragment) @route.url)
     (template_string (string_fragment) @route.url)])) @route.fetch
```

- [ ] **Step 2: Verify query compiles**

Run: `npm test -- test/integration/query-compilation.test.ts`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add src/core/ingestion/tree-sitter-queries.ts
git commit -m "feat: add fetch URL capture to TS/JS tree-sitter queries"
```

---

### Task 4: Create test fixtures

**Files:**
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/app/api/grants/route.ts`
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/app/api/organizations/[slug]/grants/route.ts`
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/components/GrantsList.tsx`
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/hooks/useGrants.ts`

- [ ] **Step 1: Create route handler fixtures**

`app/api/grants/route.ts`:
```typescript
import { NextResponse } from 'next/server';

export async function GET() {
  const grants = await fetchGrants();
  return NextResponse.json({ data: grants, pagination: { page: 1 } });
}
```

`app/api/organizations/[slug]/grants/route.ts`:
```typescript
import { NextResponse } from 'next/server';

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const grants = await fetchOrgGrants(params.slug);
  return NextResponse.json({ data: grants });
}
```

- [ ] **Step 2: Create consumer fixtures**

`hooks/useGrants.ts`:
```typescript
export function useGrants() {
  const data = fetch('/api/grants').then(r => r.json());
  return data;
}
```

`components/GrantsList.tsx`:
```typescript
export function GrantsList({ slug }: { slug: string }) {
  const data = fetch(`/api/organizations/${slug}/grants`).then(r => r.json());
  return data;
}
```

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/lang-resolution/nextjs-route-mapping/
git commit -m "test: add Next.js route mapping fixtures"
```

---

### Task 5: Wire route extraction into the pipeline

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`
- Modify: `src/core/ingestion/workers/parse-worker.ts`
- Modify: `src/core/ingestion/call-processor.ts`

- [ ] **Step 1: Extract fetch URLs in parse worker**

In `parse-worker.ts`, after the existing call extraction block (~line 1050), add:
```typescript
// Extract fetch-to-route mappings
if (captureMap['route.fetch'] && captureMap['route.url']) {
  const fetchURL = captureMap['route.url'].text;
  // Store as a special ExtractedRoute with the fetch URL
  result.routes.push({
    filePath: file.path,
    httpMethod: 'GET', // Default; could be overridden by options arg
    routePath: fetchURL,
    controllerName: null,
    methodName: null,
    middleware: [],
    prefix: null,
    lineNumber: captureMap['route.fetch'].startPosition.row,
  });
}
```

- [ ] **Step 2: Build route registry in pipeline**

In `pipeline.ts`, after the parsing phase, add a route registry step:
```typescript
// Build Next.js route registry: map file paths to route URLs
import { nextjsFileToRouteURL } from './route-extractors/nextjs.js';

const routeRegistry = new Map<string, string>(); // routeURL → handlerFilePath
for (const file of allFiles) {
  const routeURL = nextjsFileToRouteURL(file.path);
  if (routeURL) routeRegistry.set(routeURL, file.path);
}
```

- [ ] **Step 3: Create Route nodes and HANDLES_ROUTE edges**

```typescript
// Create Route nodes and HANDLES_ROUTE edges
for (const [routeURL, handlerPath] of routeRegistry) {
  const routeNodeId = generateId('Route', routeURL);
  graph.addNode({
    id: routeNodeId,
    label: 'Route',
    properties: { name: routeURL, filePath: handlerPath },
  });

  const handlerFileId = generateId('File', handlerPath);
  graph.addRelationship({
    id: generateId('HANDLES_ROUTE', `${handlerFileId}->${routeNodeId}`),
    sourceId: handlerFileId,
    targetId: routeNodeId,
    type: 'HANDLES_ROUTE',
    confidence: 1.0,
    reason: 'nextjs-filesystem-route',
  });
}
```

- [ ] **Step 4: Create FETCHES edges from fetch URLs to Route nodes**

In `processRoutesFromExtracted` or a new function, match extracted fetch URLs to route registry:
```typescript
import { normalizeFetchURL, routeMatches } from './route-extractors/nextjs.js';

// For each extracted fetch call, find matching route
for (const route of extractedRoutes) {
  if (!route.routePath) continue;
  const normalized = normalizeFetchURL(route.routePath);
  if (!normalized) continue;

  for (const [routeURL, handlerPath] of routeRegistry) {
    if (routeMatches(normalized, routeURL)) {
      const sourceId = generateId('File', route.filePath);
      const routeNodeId = generateId('Route', routeURL);
      graph.addRelationship({
        id: generateId('FETCHES', `${sourceId}->${routeNodeId}`),
        sourceId,
        targetId: routeNodeId,
        type: 'FETCHES',
        confidence: 0.9,
        reason: 'fetch-url-match',
      });
      break;
    }
  }
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/pipeline.ts src/core/ingestion/workers/parse-worker.ts src/core/ingestion/call-processor.ts
git commit -m "feat: wire Next.js route extraction into pipeline"
```

---

### Task 6: Write integration tests

**Files:**
- Create: `test/integration/resolvers/route-mapping.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, getNodesByLabel, runPipelineFromRepo, type PipelineResult } from './helpers.js';

describe('Next.js route mapping', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'nextjs-route-mapping'),
      () => {},
    );
  }, 60000);

  it('creates Route nodes for API endpoints', () => {
    const routes = getNodesByLabel(result, 'Route');
    expect(routes).toContain('/api/grants');
  });

  it('creates HANDLES_ROUTE edge from route file to Route node', () => {
    const edges = getRelationships(result, 'HANDLES_ROUTE');
    const grantsRoute = edges.find(e => e.target === '/api/grants');
    expect(grantsRoute).toBeDefined();
  });

  it('creates FETCHES edge from consumer to Route node', () => {
    const edges = getRelationships(result, 'FETCHES');
    const fetchEdge = edges.find(e =>
      e.sourceFilePath.includes('useGrants') && e.target === '/api/grants'
    );
    expect(fetchEdge).toBeDefined();
  });

  it('matches dynamic route segments', () => {
    const edges = getRelationships(result, 'FETCHES');
    const dynamicFetch = edges.find(e =>
      e.sourceFilePath.includes('GrantsList')
    );
    expect(dynamicFetch).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npm test -- test/integration/resolvers/route-mapping.test.ts`
Expected: all pass

- [ ] **Step 3: Commit**

```bash
git add test/integration/resolvers/route-mapping.test.ts
git commit -m "test: add Next.js route mapping integration tests"
```

---

### Task 7: Add `route_map` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add tool definition**

In `tools.ts`:
```typescript
{
  name: 'route_map',
  description: `Show API route mappings: which components/hooks fetch which API endpoints, and which handler files serve them.

WHEN TO USE: Understanding API consumption patterns, finding orphaned routes, impact analysis for API changes.
AFTER THIS: Use impact() on specific route handlers to see full blast radius.

Returns: route nodes with their handlers and consumers.`,
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'Filter by route path (e.g., "/api/grants"). Omit for all routes.' },
      repo: { type: 'string', description: 'Repository name or path.' },
    },
    required: [],
  },
},
```

- [ ] **Step 2: Add tool implementation**

In `local-backend.ts`, add `routeMap` method:
```typescript
private async routeMap(repo: RepoHandle, params: { route?: string }): Promise<any> {
  await this.ensureInitialized(repo.id);

  const routeFilter = params.route
    ? `WHERE r.name CONTAINS $route`
    : '';

  const results = await executeParameterized(repo.id, `
    MATCH (r) WHERE r.id STARTS WITH 'Route:'
    ${routeFilter}
    OPTIONAL MATCH (handler)-[h:CodeRelation {type: 'HANDLES_ROUTE'}]->(r)
    OPTIONAL MATCH (consumer)-[f:CodeRelation {type: 'FETCHES'}]->(r)
    RETURN r.name AS route,
           handler.filePath AS handler,
           collect(DISTINCT consumer.filePath) AS consumers
  `, params.route ? { route: params.route } : {});

  return {
    routes: results.map((r: any) => ({
      route: r.route || r[0],
      handler: r.handler || r[1],
      consumers: r.consumers || r[2],
    })),
    total: results.length,
  };
}
```

- [ ] **Step 3: Wire into callTool dispatcher**

Add to the switch/case in `callTool`:
```typescript
case 'route_map':
  return this.routeMap(repo, params as any);
```

- [ ] **Step 4: Verify TypeScript compiles and tool test passes**

Run: `npx tsc --noEmit && npm test -- test/unit/tools.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts src/mcp/local/local-backend.ts
git commit -m "feat: add route_map MCP tool"
```

---

## Phase 2: AST Decorator Detection (roadmap item)

### Task 8: Add decorator/annotation queries for TypeScript + Python + Java

**Files:**
- Modify: `src/core/ingestion/tree-sitter-queries.ts`

- [ ] **Step 1: Add TypeScript decorator queries**

```
; Decorators: @Controller, @Get, @Post, etc.
(decorator
  (call_expression
    function: (identifier) @decorator.name
    arguments: (arguments (string (string_fragment) @decorator.arg)?))) @decorator
```

- [ ] **Step 2: Add Python decorator queries**

```
; Python decorators: @app.route, @router.get, etc.
(decorator
  (call
    function: (attribute
      object: (identifier) @decorator.receiver
      attribute: (identifier) @decorator.name)
    arguments: (argument_list
      (string (string_content) @decorator.arg)?))) @decorator
```

- [ ] **Step 3: Verify queries compile**

Run: `npm test -- test/integration/query-compilation.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/core/ingestion/tree-sitter-queries.ts
git commit -m "feat: add decorator/annotation queries for TS, Python"
```

---

### Task 9: Process decorators into graph metadata

**Files:**
- Modify: `src/core/ingestion/parsing-processor.ts` or `workers/parse-worker.ts`

- [ ] **Step 1: Store decorator info on function/class nodes**

When a `@decorator` capture is found alongside a `@definition.function` or `@definition.class`:
```typescript
if (captureMap['decorator.name']) {
  const decoratorName = captureMap['decorator.name'].text;
  const decoratorArg = captureMap['decorator.arg']?.text;
  // Store as metadata on the nearest definition node
  // e.g., astFrameworkReason: '@Get("/api/users")'
}
```

- [ ] **Step 2: Create Route nodes from decorator paths**

If decorator is `@Get`, `@Post`, `@Route`, etc. with a path argument, create a Route node:
```typescript
if (['Get', 'Post', 'Put', 'Delete', 'Patch', 'Route', 'route'].includes(decoratorName) && decoratorArg) {
  // Create Route node from decorator path
}
```

- [ ] **Step 3: Test and commit**

Run: `npm test`

```bash
git commit -m "feat: extract decorator metadata and create Route nodes from @Get/@Post"
```

---

## Phase 3: Response Shape Extraction (bonus)

### Task 10: Extract response object keys

**Files:**
- Create: `src/core/ingestion/response-shape-extractor.ts`

- [ ] **Step 1: Write extractor for NextResponse.json({...}) / res.json({...})**

```typescript
/**
 * Extract top-level keys from response object literals.
 * Handles: NextResponse.json({ data, pagination }), res.json({ users, total })
 */
export function extractResponseKeys(node: SyntaxNode): string[] {
  // Find object literal argument in json() call
  // Extract property names from shorthand and key-value pairs
}
```

- [ ] **Step 2: Store as node property**

Add `responseKeys?: string[]` to `NodeProperties` in `types.ts`.
Store the keys on the Route or Function node that returns them.

- [ ] **Step 3: Test and commit**

---

### Task 11: Add `shape_check` MCP tool (optional)

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Implement shape comparison**

Compare `responseKeys` from route handler against property accesses in consuming files.
Report mismatches: keys accessed by consumer but not in response shape.

- [ ] **Step 2: Test on real project (a Next.js project)**

Run: `gitnexus analyze --force` on a Next.js project, then `route_map` + `shape_check`

- [ ] **Step 3: Commit**

---

## Run Order

| Task | Phase | Depends on | Estimated time |
|------|-------|-----------|----------------|
| 1 | 1 | — | 2 min |
| 2 | 1 | — | 5 min |
| 3 | 1 | — | 3 min |
| 4 | 1 | — | 3 min |
| 5 | 1 | 1, 2, 3 | 10 min |
| 6 | 1 | 4, 5 | 5 min |
| 7 | 1 | 5 | 5 min |
| 8 | 2 | — | 5 min |
| 9 | 2 | 8 | 10 min |
| 10 | 3 | 5 | 10 min |
| 11 | 3 | 7, 10 | 10 min |

**Tasks 1-4 can run in parallel.** Task 5 integrates them. Tasks 8-9 are independent of Phase 1. Tasks 10-11 are optional bonus.

## Verification

After all phases, test on real project:
```bash
cd /path/to/your-nextjs-project
gitnexus analyze --force
# Then via MCP:
# route_map() → should show all API routes with handlers and consumers
# impact({target: "GET", direction: "upstream"}) → should trace from route to all consumers
```
