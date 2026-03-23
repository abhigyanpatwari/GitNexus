# Deep Flow Detection: Property Access, Middleware Chains, Error Flows, API Impact

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make route/tool detection truly useful for LLM-assisted coding by tracking what fields consumers read from API responses, detecting middleware chains, capturing error response shapes, and providing a pre-change API impact report.

**Architecture:** Four features building on the existing Route/Tool/FETCHES infrastructure. Feature 1 adds property access tracking on response objects (consumer reads `response.data.items`). Feature 2 detects middleware wrapper chains (`withAuth(withRateLimit(handler))`). Feature 3 captures error response shapes from catch blocks. Feature 4 creates an `api_impact` MCP tool that combines route_map + impact + shape data into a pre-change report.

**Tech Stack:** TypeScript, tree-sitter (existing), LadybugDB graph (existing), GitNexus ingestion pipeline

**Worktree:** `~/Coding-space/GitNexus/gitnexus-response-shapes/gitnexus/`
**Branch:** `feat/response-shape-tracking` (continuing)

---

## Feature 1: Property Access Tracking on Response Objects

Track what fields consumer files read from fetch/API response objects. When a file does `const { data, pagination } = await res.json()` or `response.data.items.map(...)`, capture the accessed property chains.

### Task 1: Add consumer property access extraction in pipeline

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`
- Modify: `src/core/graph/types.ts` (add `accessedKeys` to NodeProperties)

The approach: After FETCHES edges are created, read consumer file content and extract property access patterns following `.json()` / `await fetch()` calls. Use regex on the consumer source to find patterns like:
- `response.data` / `result.data.items`
- `const { data, pagination } = await res.json()`
- Destructuring: `const { data: items } = response`

- [ ] **Step 1: Add accessedKeys to Route node properties**

In `types.ts`, the Route node already has `responseKeys`. We don't need a new property — instead, store consumer access data on the FETCHES relationship as metadata. But relationships don't have custom properties beyond `reason` in the current schema.

Alternative: Store consumer access info as a property on the FETCHES edge reason field, or create a new data structure returned by `shape_check`.

Simplest approach: Extract consumer property accesses at query time (in the `shape_check` tool), not during indexing. This avoids schema changes and works by reading consumer file content on demand.

- [ ] **Step 2: Implement consumer property access extraction in shape_check**

In `src/mcp/local/local-backend.ts`, enhance `shapeCheck` to:
1. For each route with responseKeys and consumers, read the consumer file content
2. Find the `fetch('/route')` or equivalent call in the consumer
3. Extract property accesses on the response variable in the surrounding scope
4. Compare against responseKeys and report mismatches

```typescript
// In shapeCheck, after getting routes with consumers:
// For each consumer, read file and extract accessed properties
const consumerPaths = results.flatMap(r => r.consumers.map(c => c.filePath));
// Can't read files from MCP tool — need to store during indexing

// Alternative: extract during pipeline Phase 3.5 and store on graph
```

Actually, the MCP tool runs at query time and doesn't have filesystem access (only graph queries). So we need to extract consumer accesses during indexing.

- [ ] **Step 3: Extract response property accesses during parsing**

In `parse-worker.ts`, after a `fetch()` call is detected, scan the surrounding code for property accesses on the response. This requires tracking what variable the fetch result is assigned to, then finding property accesses on that variable.

Pattern 1: `const response = await fetch('/api/grants'); response.data.items`
Pattern 2: `const { data, pagination } = await fetch('/api/grants').then(r => r.json())`
Pattern 3: `fetch('/api/grants').then(res => { res.json().then(data => { data.items }) })`

This is complex AST analysis. Simplest reliable approach: for each file that has a `fetch()` call to a known route, extract ALL `identifier.property` chains in that file that could plausibly be response accesses.

Pragmatic approach: Since we know which files consume which routes (FETCHES edges), do a regex scan of consumer files for common destructuring/property access patterns:

```typescript
// Patterns to extract from consumer files:
// 1. Destructuring: const { key1, key2 } = await response.json()
// 2. Property access: response.key1.key2
// 3. Optional chaining: data?.key1?.key2
```

- [ ] **Step 4: Store extracted accesses as ExtractedConsumerAccess**

```typescript
export interface ExtractedConsumerAccess {
  filePath: string;       // consumer file
  fetchURL: string;       // the route URL being consumed
  accessedKeys: string[]; // top-level keys accessed (e.g., ['data', 'pagination', 'error'])
}
```

Add to `ParseWorkerResult` and accumulate in pipeline like other extracted data.

- [ ] **Step 5: Create consumer access nodes/properties on FETCHES edges**

Store `accessedKeys` on the FETCHES relationship reason field (since we can't add custom properties to edges in current schema). Or better: store as a property on the consumer File node for this route.

Simplest: During `processNextjsFetchRoutes`, when creating FETCHES edges, also store the consumer's accessed keys in the `reason` field as a structured string:

```typescript
reason: `fetch-url-match|keys:data,pagination,error`
```

Then `shape_check` can parse this reason field to extract consumer-accessed keys.

- [ ] **Step 6: Enhance shape_check to compare and report mismatches**

```typescript
// For each route:
// - responseKeys (from handler): ['data', 'pagination']
// - consumerAccessedKeys (from FETCHES reason): ['data', 'pagination', 'error']
// - missing = consumerAccessedKeys - responseKeys = ['error']
// Report: Consumer accesses 'error' but handler doesn't return it
```

- [ ] **Step 7: Test and commit**

---

### Task 2: Add tree-sitter query for response destructuring

**Files:**
- Modify: `src/core/ingestion/tree-sitter-queries.ts`
- Modify: `src/core/ingestion/workers/parse-worker.ts`

Add a query to capture destructuring patterns after fetch/API calls:

```
; Response destructuring: const { data, error } = await res.json()
(variable_declarator
  name: (object_pattern) @response_destructure.pattern
  value: (await_expression
    (call_expression
      function: (member_expression
        property: (property_identifier) @_json_method (#eq? @_json_method "json"))))) @response_destructure
```

Extract the destructured property names from the `object_pattern` capture.

- [ ] **Step 1: Add query to TS and JS**
- [ ] **Step 2: Handle captures in parse-worker — extract property names from object_pattern**
- [ ] **Step 3: Store as ExtractedConsumerAccess with the property names**
- [ ] **Step 4: Test and commit**

---

## Feature 2: Middleware Chain Detection

Detect `withAuth(withRateLimit(handler))` wrapper patterns and model them as ordered middleware steps.

### Task 3: Detect middleware wrapper patterns

**Files:**
- Modify: `src/core/ingestion/workers/parse-worker.ts`
- Modify: `src/core/graph/types.ts` (add `WRAPS` relationship type)
- Modify: `src/core/ingestion/pipeline.ts`

Pattern: In Next.js App Router, middleware is applied via wrapper functions:
```typescript
export const POST = withRateLimit(withCSRF(withAuth(async (req) => { ... })));
```

The tree-sitter AST for this is nested `call_expression` nodes:
```
call_expression(withRateLimit, call_expression(withCSRF, call_expression(withAuth, arrow_function)))
```

- [ ] **Step 1: Add WRAPS relationship type**

In `types.ts`: `| 'WRAPS'  // Function wraps another (middleware chain)`
In `schema.ts`: Add to REL_TYPES, add `FROM Function TO Function` for WRAPS (already exists for CALLS).
In `local-backend.ts`: Add to VALID_RELATION_TYPES.

- [ ] **Step 2: Detect wrapper chains in parse-worker**

When we see an export assignment where the value is nested call expressions:
```typescript
export const POST = withRateLimit(withCSRF(withAuth(handler)))
```

Walk the nested calls and emit WRAPS edges:
- `withRateLimit` WRAPS `withCSRF`
- `withCSRF` WRAPS `withAuth`
- `withAuth` WRAPS `handler`

Store as new extracted data:
```typescript
interface ExtractedMiddlewareChain {
  filePath: string;
  exportName: string;  // 'POST', 'GET', etc.
  chain: string[];     // ['withRateLimit', 'withCSRF', 'withAuth']
}
```

- [ ] **Step 3: Create WRAPS edges in pipeline**

After route detection, for each middleware chain in a route handler file, create WRAPS edges between the wrapper functions.

- [ ] **Step 4: Add middleware info to route_map output**

```typescript
// route_map response:
{
  route: '/api/grants',
  handler: 'app/api/grants/route.ts',
  middleware: ['withRateLimit', 'withCSRF', 'withAuth'],
  consumers: [...],
  flows: [...]
}
```

- [ ] **Step 5: Test and commit**

---

## Feature 3: Error Response Shape Detection

Capture error response shapes from catch blocks and status code responses.

### Task 4: Detect error responses in route handlers

**Files:**
- Modify: `src/core/ingestion/pipeline.ts` (extend response shape extraction)

The existing brace-depth parser finds `.json({...})` calls. Extend it to also capture:
1. The HTTP status code if present: `NextResponse.json({...}, { status: 400 })`
2. Multiple `.json()` calls per handler (success + error paths)

- [ ] **Step 1: Extract all .json() calls with status codes**

Modify the response shape extraction in pipeline.ts to return an array of shapes:
```typescript
interface ResponseShape {
  keys: string[];
  status?: number;  // 200, 400, 401, 500, etc.
}
```

Detect status codes from:
- `NextResponse.json({...}, { status: 400 })` — second arg
- `new Response(JSON.stringify({...}), { status: 500 })` — second arg
- `res.status(400).json({...})` — chained status call

- [ ] **Step 2: Store multiple shapes on Route node**

Change `responseKeys?: string[]` to `responseShapes?: string` (JSON-serialized array of shapes):
```json
[{"keys":["data","pagination"],"status":200},{"keys":["error","details"],"status":400}]
```

Or simpler: Store `errorKeys?: string[]` alongside `responseKeys`.

- [ ] **Step 3: Show error shapes in shape_check**

```typescript
{
  route: '/api/grants',
  successKeys: ['data', 'pagination'],
  errorKeys: ['error', 'message'],
  consumers: [...]
}
```

- [ ] **Step 4: Test and commit**

---

## Feature 4: Pre-Change API Impact Report (`api_impact` tool)

The killer feature: before modifying a route handler, show exactly what will break.

### Task 5: Create `api_impact` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add tool definition**

```typescript
{
  name: 'api_impact',
  description: `Pre-change impact report for an API route handler.

WHEN TO USE: BEFORE modifying any API route handler. Shows what consumers depend on, what response fields they access, what middleware protects the route, and what execution flows it triggers.

Returns: comprehensive impact report combining route_map, shape_check, and impact data.`,
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'Route path (e.g., "/api/grants")' },
      file: { type: 'string', description: 'Handler file path (alternative to route)' },
      repo: { type: 'string', description: 'Repository name or path.' },
    },
    required: [],
  },
},
```

- [ ] **Step 2: Implement api_impact**

Combines data from multiple sources into one report:

```typescript
private async apiImpact(repo: RepoHandle, params: { route?: string; file?: string }): Promise<any> {
  // 1. Find the Route node
  // 2. Get consumers (FETCHES edges)
  // 3. Get response shape (responseKeys)
  // 4. Get middleware chain (if detected)
  // 5. Get execution flows (ENTRY_POINT_OF)
  // 6. Run impact analysis on the handler function
  // 7. Combine into report

  return {
    route: '/api/grants',
    handler: 'app/api/grants/route.ts',
    httpMethods: ['GET', 'POST'],

    responseShape: {
      success: ['data', 'pagination'],
      error: ['error', 'message'],
    },

    middleware: ['withRateLimit', 'withCSRF', 'withAuth'],

    consumers: [
      { file: 'GrantsList.tsx', accesses: ['data', 'pagination.page'] },
      { file: 'ExportBtn.tsx', accesses: ['data', 'meta'] },  // MISMATCH: 'meta' not in response
    ],

    mismatches: [
      { consumer: 'ExportBtn.tsx', field: 'meta', reason: 'accessed but not in response shape' }
    ],

    executionFlows: ['HandleGET → BuildCSP', 'HandlePOST → ValidateInput → SaveGrant'],

    impactSummary: {
      directConsumers: 5,
      affectedFlows: 3,
      riskLevel: 'MEDIUM',
      warning: 'Changing response shape will affect 5 components'
    }
  };
}
```

- [ ] **Step 3: Wire into callTool dispatcher**
- [ ] **Step 4: Test on a Next.js project**
- [ ] **Step 5: Commit**

---

## Run Order

| Task | Feature | Depends on | What |
|------|---------|-----------|------|
| 1-2 | Property Access | — | Extract consumer property accesses, store on FETCHES edges |
| 3 | Middleware | — | Detect wrapper chains, WRAPS edges |
| 4 | Error Flows | — | Multiple response shapes with status codes |
| 5 | API Impact | 1-4 | Combine all data into pre-change report |

Tasks 1-2, 3, and 4 can run in parallel. Task 5 integrates them all.

## Expected Output

After implementation, running `api_impact({ route: "/api/grants" })` on a Next.js project should return:
```
Route: /api/grants (GET)
Handler: app/api/grants/route.ts
Middleware: withRateLimit, withAuth
Response: { data, pagination } (200), { error } (400/500)
Consumers: 5 files
  - GrantsList.tsx reads: data, pagination.page, pagination.total
  - ExportBtn.tsx reads: data  ← OK
Flows: HandleGET → FetchGrants → PrismaQuery
Risk: MEDIUM — 5 consumers depend on response shape
```
