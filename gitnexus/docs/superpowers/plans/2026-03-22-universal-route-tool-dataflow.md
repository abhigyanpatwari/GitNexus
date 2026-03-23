# Universal Route, Tool & Data Flow Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend GitNexus route mapping to detect routes from PHP/Laravel/Express/decorator-based frameworks, detect MCP/RPC tool definitions, and link both to execution flows — making `route_map` and a new `tool_map` useful across all tech stacks.

**Architecture:** Three phases building on the existing Route node infrastructure. Phase A expands Route detection to PHP file-based routes, Laravel `Route::get()`, and decorator-based routes (`@Get`, `@app.route`). Phase B adds a new `Tool` node type for MCP/RPC tool definitions with `tool_map` MCP tool. Phase C connects Route and Tool nodes to existing Process (execution flow) nodes, creating a unified entry-point → flow → handler picture.

**Tech Stack:** TypeScript, tree-sitter (existing), LadybugDB graph (existing), GitNexus ingestion pipeline

**Worktree:** `~/Coding-space/GitNexus/gitnexus-response-shapes/gitnexus/`
**Branch:** `feat/response-shape-tracking` (continuing)

---

## Existing Infrastructure

| File | What it does | Relevant to |
|------|-------------|-------------|
| `src/core/ingestion/route-extractors/nextjs.ts` | Next.js file→route URL mapping | Pattern for new extractors |
| `src/core/ingestion/workers/parse-worker.ts` | Captures `@decorator` metadata + `route.fetch` URLs | Already stores decorator name+arg |
| `src/core/ingestion/call-processor.ts` | `processNextjsFetchRoutes`, `extractFetchCallsFromFiles` | Where new route/tool processors go |
| `src/core/ingestion/pipeline.ts` | Route registry + Route node creation | Where new detection phases plug in |
| `src/core/lbug/schema.ts` | Route table, NODE_TABLES, REL_TYPES, RELATION_SCHEMA | Must update for Tool node |
| `src/core/lbug/csv-generator.ts` | Route CSV writer | Must add Tool CSV writer |
| `src/core/lbug/lbug-adapter.ts` | `getCopyQuery` for Route | Must add Tool COPY query |
| `src/core/ingestion/workers/parse-worker.ts:724` | `extractLaravelRoutes` — already extracts route paths | Needs to create Route nodes |
| `src/core/ingestion/entry-point-scoring.ts` | Scores functions as entry points | Route/Tool handlers boost score |
| `src/core/ingestion/process-processor.ts` | Detects execution flows from call chains | Phase C connects Route/Tool → Process |

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/core/ingestion/route-extractors/php.ts` | PHP file-based route detection (`api/*.php`) |
| `src/core/ingestion/tool-extractors/mcp.ts` | MCP tool definition detection (Python `@mcp.tool()` + TypeScript tool arrays) |

### Modified files
| File | What changes |
|------|-------------|
| `src/core/graph/types.ts` | Add `Tool` node label, `HANDLES_TOOL` relationship type |
| `src/core/lbug/schema.ts` | Add Tool table schema, NODE_TABLES, REL_TYPES, RELATION_SCHEMA entries |
| `src/core/lbug/csv-generator.ts` | Add Tool CSV writer case |
| `src/core/lbug/lbug-adapter.ts` | Add Tool COPY query |
| `src/core/ingestion/pipeline.ts` | Add PHP route registry, decorator route creation, Tool detection, Process linkage |
| `src/core/ingestion/workers/parse-worker.ts` | Store decorator routes in `fetchCalls` or new array for Route node creation |
| `src/core/ingestion/call-processor.ts` | New `processDecoratorRoutes`, `processToolDefinitions` |
| `src/core/ingestion/tree-sitter-queries.ts` | Add MCP tool decorator query for Python, tool definition pattern for TS |
| `src/mcp/tools.ts` | Add `tool_map` tool definition |
| `src/mcp/local/local-backend.ts` | Add `tool_map` implementation, update `VALID_NODE_LABELS` / `VALID_RELATION_TYPES` |
| `test/fixtures/lang-resolution/nextjs-route-mapping/` | Extend fixtures |
| `test/integration/resolvers/route-mapping.test.ts` | Add PHP, decorator, tool tests |

---

## Phase A: Expand Route Detection (PHP, Laravel, Decorators)

### Task 1: Add PHP file-based route extractor

**Files:**
- Create: `src/core/ingestion/route-extractors/php.ts`
- Modify: `src/core/ingestion/pipeline.ts`

PHP projects use direct file-to-URL mapping: `api/upload.php` serves `/api/upload`. No framework router — the file IS the endpoint.

- [ ] **Step 1: Create PHP route extractor**

```typescript
// src/core/ingestion/route-extractors/php.ts

/**
 * Convert a PHP file path to its route URL.
 * Handles direct file-based routing (no framework).
 * api/upload.php → /api/upload
 * api/next_sign.php → /api/next_sign
 * index.php → /
 */
export function phpFileToRouteURL(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');

  // Only match files in api/ directory or root index.php
  const apiMatch = normalized.match(/^(api\/.+?)\.php$/);
  if (apiMatch) {
    return '/' + apiMatch[1];
  }

  // Root index.php
  if (normalized === 'index.php' || normalized.endsWith('/index.php')) {
    return '/';
  }

  return null;
}
```

- [ ] **Step 2: Wire into pipeline route registry**

In `pipeline.ts`, after the Next.js route registry loop, add PHP detection:

```typescript
import { phpFileToRouteURL } from './route-extractors/php.js';

// PHP file-based routes (api/*.php)
for (const p of allPaths) {
  if (!p.endsWith('.php')) continue;
  const routeURL = phpFileToRouteURL(p);
  if (routeURL && !routeRegistry.has(routeURL)) {
    routeRegistry.set(routeURL, p);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/core/ingestion/route-extractors/php.ts src/core/ingestion/pipeline.ts
git commit -m "feat: add PHP file-based route detection"
```

---

### Task 2: Create Route nodes from Laravel extracted routes

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`
- Modify: `src/core/ingestion/workers/parse-worker.ts` (read `ExtractedRoute` interface)

The existing `extractLaravelRoutes` already extracts route paths into `ExtractedRoute` objects with `routePath`, `httpMethod`, `controllerName`, and `methodName`. Currently `processRoutesFromExtracted` only creates CALLS edges (controller→method). We need to also create Route nodes.

- [ ] **Step 1: Create Route nodes from extracted Laravel routes**

In `pipeline.ts`, after the route registry building, add:

```typescript
// Laravel routes — create Route nodes from extracted route data
// (extractLaravelRoutes already runs during parsing; routes are in worker results)
// Accumulate routes from worker data (similar to fetchCalls pattern)
```

We need to accumulate `routes` from worker results. They're already accumulated in `chunkWorkerData.routes`. But we need them after the chunk loop. Add an accumulator:

Before the chunk loop (near `allFetchCalls`):
```typescript
const allExtractedRoutes: ExtractedRoute[] = [];
```

Inside the worker path (near fetchCalls accumulation):
```typescript
if (chunkWorkerData.routes?.length) {
  allExtractedRoutes.push(...chunkWorkerData.routes);
}
```

After route registry building:
```typescript
// Create Route nodes from framework-extracted routes (Laravel, etc.)
for (const route of allExtractedRoutes) {
  if (!route.routePath) continue;
  const routeURL = route.routePath.startsWith('/') ? route.routePath : '/' + route.routePath;
  if (routeRegistry.has(routeURL)) continue; // already registered by file-based detection
  routeRegistry.set(routeURL, route.filePath);
}
```

The Route node creation loop already handles all entries in `routeRegistry`, so Laravel routes will get Route nodes automatically.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/core/ingestion/pipeline.ts
git commit -m "feat: create Route nodes from Laravel extracted routes"
```

---

### Task 3: Create Route nodes from decorator metadata

**Files:**
- Modify: `src/core/ingestion/workers/parse-worker.ts`
- Modify: `src/core/ingestion/pipeline.ts`

The parse worker already captures decorators (`@Get("/users")`, `@app.route("/api/items")`) and stores them in `fileDecorators` map. Currently they only set `astFrameworkReason` on definition nodes. We need to also emit route data for Route node creation.

- [ ] **Step 1: Add ExtractedDecoratorRoute to parse worker**

In `parse-worker.ts`, add a new interface after `ExtractedFetchCall`:

```typescript
export interface ExtractedDecoratorRoute {
  filePath: string;
  routePath: string;
  httpMethod: string;
  decoratorName: string;
  lineNumber: number;
}
```

Add to `ParseWorkerResult`:
```typescript
  decoratorRoutes: ExtractedDecoratorRoute[];
```

Add to `accumulated`, `mergeResult`, and all initialization sites (follow the `fetchCalls` pattern).

- [ ] **Step 2: Emit decorator routes in the match loop**

In the decorator handler block (around line 981), after storing in `fileDecorators`, add:

```typescript
const ROUTE_DECORATORS = new Set([
  'Get', 'Post', 'Put', 'Delete', 'Patch', 'Route',
  'get', 'post', 'put', 'delete', 'patch', 'route',
  'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping',
]);
if (ROUTE_DECORATORS.has(decoratorName) && decoratorArg) {
  const method = decoratorName.replace('Mapping', '').toUpperCase();
  const httpMethod = ['GET','POST','PUT','DELETE','PATCH'].includes(method) ? method : 'GET';
  result.decoratorRoutes.push({
    filePath: file.path,
    routePath: decoratorArg,
    httpMethod,
    decoratorName,
    lineNumber: decoratorNode.startPosition.row,
  });
}
```

- [ ] **Step 3: Accumulate and process in pipeline**

In `pipeline.ts`:
- Add accumulator: `const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];`
- Accumulate in chunk loop: `if (chunkWorkerData.decoratorRoutes?.length) { allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes); }`
- After route registry:
```typescript
for (const dr of allDecoratorRoutes) {
  const routeURL = dr.routePath.startsWith('/') ? dr.routePath : '/' + dr.routePath;
  if (!routeRegistry.has(routeURL)) {
    routeRegistry.set(routeURL, dr.filePath);
  }
}
```

- [ ] **Step 4: Update parsing-processor.ts**

Add `decoratorRoutes` to `WorkerExtractedData` interface and all return/accumulation points (follow `fetchCalls` pattern).

- [ ] **Step 5: Verify TypeScript compiles + tests pass**

Run: `npx tsc --noEmit && npx vitest run test/integration/resolvers/route-mapping.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/workers/parse-worker.ts src/core/ingestion/pipeline.ts src/core/ingestion/parsing-processor.ts
git commit -m "feat: create Route nodes from decorator-based routes (@Get, @app.route)"
```

---

### Task 4: Add test fixtures and tests for PHP + decorator routes

**Files:**
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/api/upload.php`
- Create: `test/fixtures/lang-resolution/nextjs-route-mapping/api/status.php`
- Modify: `test/integration/resolvers/route-mapping.test.ts`

- [ ] **Step 1: Create PHP fixtures**

`api/upload.php`:
```php
<?php
header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') { http_response_code(405); exit; }
echo json_encode(['status' => 'ok', 'id' => 1]);
```

`api/status.php`:
```php
<?php
header('Content-Type: application/json');
echo json_encode(['status' => 'running', 'uptime' => 3600]);
```

- [ ] **Step 2: Add tests**

```typescript
it('creates Route nodes for PHP API endpoints', () => {
  const routes = getNodesByLabel(result, 'Route');
  expect(routes).toContain('/api/upload');
  expect(routes).toContain('/api/status');
});
```

- [ ] **Step 3: Run tests, fix if needed, commit**

```bash
git add test/
git commit -m "test: add PHP route detection fixtures and tests"
```

---

## Phase B: Tool/RPC Dispatch Detection

### Task 5: Add Tool node type and schema

**Files:**
- Modify: `src/core/graph/types.ts`
- Modify: `src/core/lbug/schema.ts`
- Modify: `src/core/lbug/csv-generator.ts`
- Modify: `src/core/lbug/lbug-adapter.ts`
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add types**

In `types.ts`:
- Add `'Tool'` to `NodeLabel`
- Add `'HANDLES_TOOL'` to `RelationshipType`

In `local-backend.ts`:
- Add `'Tool'` to `VALID_NODE_LABELS`
- Add `'HANDLES_TOOL'` to `VALID_RELATION_TYPES`

- [ ] **Step 2: Add LadybugDB schema**

In `schema.ts`:
- Add `'Tool'` to `NODE_TABLES`
- Add `'HANDLES_TOOL'` to `REL_TYPES`
- Add schema:
```typescript
export const TOOL_SCHEMA = `
CREATE NODE TABLE Tool (
  id STRING,
  name STRING,
  filePath STRING,
  description STRING,
  PRIMARY KEY (id)
)`;
```
- Add to `NODE_SCHEMA_QUERIES`
- Add to `RELATION_SCHEMA`: `FROM File TO Tool`, `FROM Function TO Tool`, `FROM Method TO Tool`

- [ ] **Step 3: Add CSV generator case**

In `csv-generator.ts`:
```typescript
const toolWriter = new BufferedCSVWriter(path.join(csvDir, 'tool.csv'), 'id,name,filePath,description');
// ... in switch:
case 'Tool':
  await toolWriter.addRow([
    escapeCSVField(node.id),
    escapeCSVField(node.properties.name || ''),
    escapeCSVField(node.properties.filePath || ''),
    escapeCSVField((node.properties as any).description || ''),
  ].join(','));
  break;
```
Add to `allWriters` and `tableMap`.

- [ ] **Step 4: Add COPY query**

In `lbug-adapter.ts`:
```typescript
if (table === 'Tool') {
  return `COPY ${t}(id, name, filePath, description) FROM "${filePath}" ${COPY_CSV_OPTS}`;
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/core/graph/types.ts src/core/lbug/schema.ts src/core/lbug/csv-generator.ts src/core/lbug/lbug-adapter.ts src/mcp/local/local-backend.ts
git commit -m "feat: add Tool node type with full LadybugDB schema support"
```

---

### Task 6: Detect MCP tool definitions in Python

**Files:**
- Modify: `src/core/ingestion/tree-sitter-queries.ts`
- Modify: `src/core/ingestion/workers/parse-worker.ts`

Python MCP tools use `@mcp.tool()` decorator on functions. The existing Python decorator query captures `@receiver.name(arg)` patterns, which already matches `@mcp.tool()` where receiver=`mcp`, name=`tool`.

- [ ] **Step 1: Add ExtractedToolDef to parse worker**

```typescript
export interface ExtractedToolDef {
  filePath: string;
  toolName: string;
  description: string;
  lineNumber: number;
}
```

Add `toolDefs: ExtractedToolDef[]` to `ParseWorkerResult` and all init/merge sites.

- [ ] **Step 2: Detect @mcp.tool() in decorator handler**

In the decorator handler block, add detection for tool decorators:

```typescript
// MCP tool detection: @mcp.tool(), @app.tool(), @server.tool()
const TOOL_DECORATOR_NAMES = new Set(['tool']);
if (TOOL_DECORATOR_NAMES.has(decoratorName)) {
  // The tool name is the decorated function's name — we store the decorator
  // position and resolve to function name in the definition handler below
  fileDecorators.set(decoratorNode.endPosition.row, {
    name: decoratorName,
    arg: decoratorArg,
    isTool: true,
  });
  continue; // already stored, skip the route check
}
```

In the definition handler (where `frameworkHint` is applied from `fileDecorators`), also emit tool definitions:

```typescript
if (dec && (dec as any).isTool) {
  result.toolDefs.push({
    filePath: file.path,
    toolName: nodeName,
    description: dec.arg || '',
    lineNumber: definitionNode.startPosition.row,
  });
}
```

Note: The `fileDecorators` map value type needs to be extended to include `isTool?: boolean`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/core/ingestion/workers/parse-worker.ts
git commit -m "feat: detect MCP tool definitions from Python @mcp.tool() decorators"
```

---

### Task 7: Detect MCP tool definitions in TypeScript

**Files:**
- Modify: `src/core/ingestion/workers/parse-worker.ts` or `src/core/ingestion/pipeline.ts`

TypeScript MCP tools are defined as arrays of objects with `name` and `description` properties (like GitNexus's own `src/mcp/tools.ts`). This is harder to detect via tree-sitter queries. Use a regex-based approach on file content in the pipeline.

- [ ] **Step 1: Add TypeScript tool detection in pipeline**

After route registry building in pipeline.ts, add tool detection:

```typescript
// Detect MCP tool definitions in TypeScript (array of {name, description, inputSchema})
const toolDefs: { name: string; filePath: string; description: string }[] = [];

// From worker-extracted decorator tools (Python @mcp.tool())
for (const td of allToolDefs) {
  toolDefs.push({ name: td.toolName, filePath: td.filePath, description: td.description });
}

// From TypeScript tool definition arrays (pattern: name: 'tool_name', description: `...`)
for (const p of allPaths) {
  if (!p.endsWith('.ts') && !p.endsWith('.js')) continue;
  if (!p.includes('tool')) continue; // Quick filter: only check files with 'tool' in path
  const content = (await readFileContents(repoPath, [p])).get(p);
  if (!content) continue;
  // Match: name: 'tool_name' or name: "tool_name"
  const toolPattern = /name:\s*['"](\w+)['"]\s*,\s*\n?\s*description:\s*[`'"]([\s\S]*?)['"`]/g;
  let match;
  while ((match = toolPattern.exec(content)) !== null) {
    toolDefs.push({ name: match[1], filePath: p, description: match[2].slice(0, 200) });
  }
}
```

- [ ] **Step 2: Create Tool nodes and HANDLES_TOOL edges**

```typescript
if (toolDefs.length > 0) {
  for (const td of toolDefs) {
    const toolNodeId = generateId('Tool', td.name);
    graph.addNode({
      id: toolNodeId,
      label: 'Tool',
      properties: { name: td.name, filePath: td.filePath, description: td.description },
    });

    const handlerFileId = generateId('File', td.filePath);
    graph.addRelationship({
      id: generateId('HANDLES_TOOL', `${handlerFileId}->${toolNodeId}`),
      sourceId: handlerFileId,
      targetId: toolNodeId,
      type: 'HANDLES_TOOL',
      confidence: 1.0,
      reason: 'tool-definition',
    });
  }

  if (isDev) {
    console.log(`🔧 Tool registry: ${toolDefs.length} tools detected`);
  }
}
```

- [ ] **Step 3: Accumulate toolDefs from workers**

Add `allToolDefs: ExtractedToolDef[]` accumulator (same pattern as fetchCalls/decoratorRoutes).

- [ ] **Step 4: Update parsing-processor.ts**

Add `toolDefs` to `WorkerExtractedData`.

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/core/ingestion/pipeline.ts src/core/ingestion/parsing-processor.ts
git commit -m "feat: detect MCP tool definitions in TypeScript and create Tool nodes"
```

---

### Task 8: Add `tool_map` MCP tool

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add tool definition**

```typescript
{
  name: 'tool_map',
  description: `Show MCP/RPC tool definitions: which tools are defined, where they're handled, and their descriptions.

WHEN TO USE: Understanding tool APIs, finding tool implementations, impact analysis for tool changes.

Returns: tool nodes with their handler files and descriptions.`,
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Filter by tool name. Omit for all tools.' },
      repo: { type: 'string', description: 'Repository name or path.' },
    },
    required: [],
  },
},
```

- [ ] **Step 2: Add implementation**

Reuse the `fetchRoutesWithConsumers` pattern but for Tool nodes:

```typescript
case 'tool_map':
  return this.toolMap(repo, params);

// ...

private async toolMap(repo: RepoHandle, params: { tool?: string }): Promise<any> {
  await this.ensureInitialized(repo.id);

  const toolFilter = params.tool ? `AND n.name CONTAINS $tool` : '';
  const queryParams = params.tool ? { tool: params.tool } : {};

  const rows = await executeParameterized(repo.id, `
    MATCH (n:Tool)
    WHERE n.id STARTS WITH 'Tool:' ${toolFilter}
    RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.description AS description
  `, queryParams);

  if (rows.length === 0) {
    return { tools: [], total: 0, message: params.tool ? `No tools matching "${params.tool}"` : 'No tool definitions found.' };
  }

  return {
    tools: rows.map((r: any) => ({
      name: r.name ?? r[0],
      filePath: r.filePath ?? r[1],
      description: (r.description ?? r[2] ?? '').slice(0, 200),
    })),
    total: rows.length,
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools.ts src/mcp/local/local-backend.ts
git commit -m "feat: add tool_map MCP tool"
```

---

## Phase C: Data Flow Linkage (Route/Tool → Process)

### Task 9: Link Route nodes to Process nodes

**Files:**
- Modify: `src/core/ingestion/pipeline.ts`

Process nodes represent execution flows (call chains). Route handler files are often the entry points of these flows. After process detection completes, link Route nodes to any Process whose entry point is in the route handler file.

- [ ] **Step 1: Add ENTRY_POINT_OF relationship type**

In `types.ts`, add:
```typescript
| 'ENTRY_POINT_OF'  // Route/Tool → Process (this endpoint starts this execution flow)
```

Update `VALID_RELATION_TYPES` in `local-backend.ts`.
Update `REL_TYPES` in `schema.ts`.
Add `FROM Route TO Process` and `FROM Tool TO Process` to `RELATION_SCHEMA`.

- [ ] **Step 2: Link Route/Tool nodes to Processes**

In `pipeline.ts`, after process detection (which runs after the community phase), add:

```typescript
// Link Route and Tool nodes to Processes they participate in
// A Route/Tool's handler file is the entry point — find Processes that start there
if (routeRegistry.size > 0 || toolDefs.length > 0) {
  let linked = 0;
  graph.forEachNode(processNode => {
    if (processNode.label !== 'Process') return;
    const entryPointId = processNode.properties.entryPointId;
    if (!entryPointId) return;

    // Find the entry point's file
    const entryNode = graph.getNode(entryPointId);
    if (!entryNode) return;
    const entryFile = entryNode.properties.filePath;

    // Check if this file is a route handler
    for (const [routeURL, handlerPath] of routeRegistry) {
      if (handlerPath === entryFile || entryFile === handlerPath) {
        const routeNodeId = generateId('Route', routeURL);
        graph.addRelationship({
          id: generateId('ENTRY_POINT_OF', `${routeNodeId}->${processNode.id}`),
          sourceId: routeNodeId,
          targetId: processNode.id,
          type: 'ENTRY_POINT_OF',
          confidence: 0.85,
          reason: 'route-handler-entry-point',
        });
        linked++;
        break;
      }
    }
  });

  if (isDev && linked > 0) {
    console.log(`🔗 Linked ${linked} Route/Tool nodes to execution flows`);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/core/graph/types.ts src/core/lbug/schema.ts src/mcp/local/local-backend.ts src/core/ingestion/pipeline.ts
git commit -m "feat: link Route and Tool nodes to Process execution flows"
```

---

### Task 10: Extend route_map to show linked execution flows

**Files:**
- Modify: `src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add flow data to fetchRoutesWithConsumers**

Extend the Cypher query to also fetch linked Process nodes:

```typescript
OPTIONAL MATCH (n)-[ep:CodeRelation]->(proc)
WHERE ep.type = 'ENTRY_POINT_OF'
```

Add `flows: string[]` to the return type.

- [ ] **Step 2: Update routeMap to include flows**

```typescript
routes: routes.map(r => ({
  route: r.name,
  handler: r.filePath,
  consumers: r.consumers,
  flows: r.flows,  // execution flows this route participates in
})),
```

- [ ] **Step 3: Verify and commit**

Run: `npx tsc --noEmit`

```bash
git add src/mcp/local/local-backend.ts
git commit -m "feat: show linked execution flows in route_map output"
```

---

### Task 11: Run integration tests + test on real projects

- [ ] **Step 1: Run all tests**

```bash
npx vitest run test/integration/resolvers/route-mapping.test.ts test/integration/query-compilation.test.ts
```

- [ ] **Step 2: Build and test on all 6 projects**

```bash
npm run build
for project in project-a project-b project-c; do
  echo "=== $project ==="
  cd /path/to/$project
  npx gitnexus analyze --force
done
```

Then test `route_map` and `tool_map` on each.

- [ ] **Step 3: Commit any fixes**

---

## Run Order

| Task | Phase | Depends on | What |
|------|-------|-----------|------|
| 1 | A | — | PHP file-based route detection |
| 2 | A | — | Laravel Route nodes from extracted routes |
| 3 | A | — | Decorator Route nodes (@Get, @app.route) |
| 4 | A | 1, 2, 3 | Tests for PHP + decorator routes |
| 5 | B | — | Tool node type + LadybugDB schema |
| 6 | B | 5 | Python @mcp.tool() detection |
| 7 | B | 5, 6 | TypeScript tool definition detection + Tool nodes |
| 8 | B | 5 | tool_map MCP tool |
| 9 | C | all A + B | Route/Tool → Process linkage |
| 10 | C | 9 | Show flows in route_map/tool_map |
| 11 | C | all | Integration testing on real projects |

**Tasks 1-3 can run sequentially (they all modify pipeline.ts).** Task 5 is independent of A. Tasks 6-8 depend on 5. Task 9 depends on all prior. Task 11 is final verification.

## Expected Results After Implementation

| Project | Routes | Tools | Flows Linked |
|---------|--------|-------|-------------|
| Next.js app | ~400+ (API routes) | 0 | Many |
| collector | ~9 (PHP api/*.php) | 0 | Some |
| Python ML toolkit | 0 | ~8 (MCP tools) | Some |

| Swift iOS app | 0 | 0 | 0 |
| GitNexus | 0 | ~10 (MCP tools) | Some |
