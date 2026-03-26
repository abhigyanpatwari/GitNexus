# Data-Shape Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add end-to-end data-flow shape tracking to GitNexus so it can detect mismatches where multiple consumers share a cache key, context, or state slot but expect different data shapes.

**Architecture:** New `StateSlot` node type with `PRODUCES`/`CONSUMES` edges carrying shape info on the edge. Detection via tree-sitter AST extraction in the parse worker, plus a new pipeline phase (3.7) that creates graph nodes. New `data_flow` MCP tool and extensions to existing `shape_check`/`api_impact`/`impact`/`context` tools.

**Tech Stack:** TypeScript, tree-sitter (AST), LadybugDB (graph DB), vitest (tests), MCP protocol

**Spec:** `docs/superpowers/specs/2026-03-26-data-shape-tracking-design.md`

**Worktree:** `/private/tmp/gitnexus-data-shape-tracking` (branch `feat/data-shape-tracking`)

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/core/ingestion/state-slot-detectors/types.ts` | `ExtractedStateSlot` interface and `SlotKind` type |
| `src/core/ingestion/state-slot-detectors/react-query.ts` | React Query / TanStack Query detector |
| `src/core/ingestion/state-slot-detectors/swr.ts` | SWR detector |
| `src/core/ingestion/state-slot-detectors/react-context.ts` | React Context detector (Phase 3) |
| `src/core/ingestion/state-slot-detectors/redux.ts` | Redux createSlice detector (Phase 3) |
| `src/core/ingestion/state-slot-detectors/zustand.ts` | Zustand store detector (Phase 3) |
| `src/core/ingestion/state-slot-detectors/index.ts` | Barrel export + `detectStateSlots()` orchestrator |
| `src/core/ingestion/state-slot-processor.ts` | Pipeline phase 3.7: create StateSlot nodes + PRODUCES/CONSUMES edges |
| `src/core/ingestion/shape-inference.ts` | AST-based shape inference (object literals, destructuring, property access) |
| `test/fixtures/state-slot-seed.ts` | Cypher seed data for data_flow E2E tests |
| `test/fixtures/state-slot-fixtures/` | Mini TS/JS files for pipeline-level state slot tests |
| `test/integration/data-flow-e2e.test.ts` | E2E test for data_flow MCP tool |
| `test/unit/state-slot-detectors.test.ts` | Unit tests for each detector |
| `test/unit/shape-inference.test.ts` | Unit tests for shape inference |

### Modified Files
| File | Changes |
|------|---------|
| `src/core/graph/types.ts` | Add `StateSlot` to `NodeLabel`, add `slotKind`/`cacheKey` to `NodeProperties`, add `PRODUCES`/`CONSUMES` to `RelationshipType` |
| `src/core/lbug/schema.ts` | Add `STATE_SLOT_SCHEMA`, update `NODE_TABLES`, `REL_TYPES`, `RELATION_SCHEMA`, `NODE_SCHEMA_QUERIES` |
| `src/core/lbug/csv-generator.ts` | Add `stateSlotWriter` and `case 'StateSlot'` |
| `src/core/ingestion/tree-sitter-queries.ts` | Add `datahook.*` capture queries to TS and JS query strings |
| `src/core/ingestion/workers/parse-worker.ts` | Add `ExtractedDataHook` interface, `datahook` dispatch, accumulate in `ParseWorkerResult` |
| `src/core/ingestion/pipeline.ts` | Add Phase 3.7 (state slot detection), accumulate `allDataHooks`, call `processStateSlots()` |
| `src/mcp/tools.ts` | Add `data_flow` tool definition |
| `src/mcp/local/local-backend.ts` | Add `dataFlow()` method, `case 'data_flow'` in `callTool()`, extend `shapeCheck()`/`apiImpact()`/`_impactImpl()`/`context()` |
| `src/mcp/server.ts` | Add next-step hint for `data_flow` |

---

## Phase 1: Foundation (React Query + SWR + Core Infrastructure)

### Task 1: Add StateSlot to Graph Types

**Files:**
- Modify: `gitnexus/src/core/graph/types.ts:1-121`

- [ ] **Step 1: Add StateSlot to NodeLabel union**

In `types.ts`, add `'StateSlot'` after `'Tool'` in the `NodeLabel` union (line 38):

```typescript
  | 'Tool'
  | 'StateSlot';   // Shared state: React Query cache, Context, Redux slice, etc.
```

- [ ] **Step 2: Add StateSlot-specific properties to NodeProperties**

After the Route-specific properties (around line 79), add:

```typescript
  // StateSlot-specific
  slotKind?: string;       // react-query | swr | react-context | redux | zustand | trpc | graphql | custom-hook
  cacheKey?: string;        // Literal or pattern of cache/state key
```

- [ ] **Step 3: Add PRODUCES and CONSUMES to RelationshipType**

After `'WRAPS'` in the `RelationshipType` union (line 101):

```typescript
  | 'WRAPS'           // Reserved, not yet emitted
  | 'PRODUCES'        // Function/Method -> StateSlot (writes data into shared state)
  | 'CONSUMES';       // Function/Method -> StateSlot (reads data from shared state)
```

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/core/graph/types.ts
git commit -m "feat(types): add StateSlot node label and PRODUCES/CONSUMES relationship types"
```

---

### Task 2: Add StateSlot to LadybugDB Schema

**Files:**
- Modify: `gitnexus/src/core/lbug/schema.ts:15-518`

- [ ] **Step 1: Add 'StateSlot' to NODE_TABLES array**

After `'Tool'` in `NODE_TABLES` (line 21):

```typescript
  'Route',
  'Tool',
  'StateSlot'
] as const;
```

- [ ] **Step 2: Add 'PRODUCES' and 'CONSUMES' to REL_TYPES**

After `'WRAPS'` in `REL_TYPES` (line 32):

```typescript
export const REL_TYPES = ['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'HAS_METHOD', 'HAS_PROPERTY', 'ACCESSES', 'OVERRIDES', 'MEMBER_OF', 'STEP_IN_PROCESS', 'HANDLES_ROUTE', 'FETCHES', 'HANDLES_TOOL', 'ENTRY_POINT_OF', 'WRAPS', 'PRODUCES', 'CONSUMES'] as const;
```

- [ ] **Step 3: Add STATE_SLOT_SCHEMA constant**

After `TOOL_SCHEMA` (line 218):

```typescript
// Shared state slots (React Query cache, Context, Redux slice, etc.)
export const STATE_SLOT_SCHEMA = `
CREATE NODE TABLE StateSlot (
  id STRING,
  name STRING,
  filePath STRING,
  slotKind STRING,
  cacheKey STRING,
  PRIMARY KEY (id)
)`;
```

- [ ] **Step 4: Add StateSlot FROM/TO entries to RELATION_SCHEMA**

After the Tool FROM/TO entries (line 338), add:

```typescript
  FROM Function TO StateSlot,
  FROM Method TO StateSlot,
  FROM File TO StateSlot,
  FROM StateSlot TO Process,
```

- [ ] **Step 5: Add STATE_SLOT_SCHEMA to NODE_SCHEMA_QUERIES**

After `TOOL_SCHEMA` in the array (line 513):

```typescript
  // MCP tools
  TOOL_SCHEMA,
  // Shared state slots
  STATE_SLOT_SCHEMA,
];
```

- [ ] **Step 6: Commit**

```bash
git add gitnexus/src/core/lbug/schema.ts
git commit -m "feat(schema): add StateSlot node table and PRODUCES/CONSUMES to LadybugDB schema"
```

---

### Task 3: Add StateSlot to CSV Generator

**Files:**
- Modify: `gitnexus/src/core/lbug/csv-generator.ts:245-443`

- [ ] **Step 1: Add stateSlotWriter creation**

After `toolWriter` creation (around line 247):

```typescript
const stateSlotWriter = new BufferedCSVWriter(path.join(csvDir, 'stateslot.csv'), 'id,name,filePath,slotKind,cacheKey');
```

- [ ] **Step 2: Add case 'StateSlot' in the switch block**

After the `case 'Tool':` block (around line 376):

```typescript
case 'StateSlot':
  await stateSlotWriter.addRow([
    escapeCSVField(node.id),
    escapeCSVField(node.properties.name || ''),
    escapeCSVField(node.properties.filePath || ''),
    escapeCSVField((node.properties as any).slotKind || ''),
    escapeCSVField((node.properties as any).cacheKey || ''),
  ].join(','));
  break;
```

- [ ] **Step 3: Add stateSlotWriter to allWriters and tableMap**

Add to `allWriters` array (around line 414):

```typescript
stateSlotWriter,
```

Add to `tableMap` result entries (around line 442):

```typescript
['StateSlot' as NodeTableName, stateSlotWriter],
```

- [ ] **Step 4: Commit**

```bash
git add gitnexus/src/core/lbug/csv-generator.ts
git commit -m "feat(csv): add StateSlot CSV generation for LadybugDB bulk import"
```

---

### Task 4: Create Detector Types

**Files:**
- Create: `gitnexus/src/core/ingestion/state-slot-detectors/types.ts`

- [ ] **Step 1: Write the ExtractedStateSlot interface**

```typescript
/**
 * Shared types for state slot detection across frameworks.
 */

export type SlotKind = 'react-query' | 'swr' | 'react-context' | 'redux' | 'zustand' | 'trpc' | 'graphql' | 'custom-hook';

export type ShapeConfidence = 'type-checked' | 'ast-literal' | 'heuristic';

export interface ExtractedStateSlotProducer {
  /** Function/method name that produces data into this slot */
  functionName: string;
  /** File where the producer lives */
  filePath: string;
  /** Line number of the producing call */
  lineNumber: number;
  /** Top-level keys this producer writes */
  keys: string[];
  /** Confidence tier */
  confidence: ShapeConfidence;
  /** Raw TS type annotation if available (e.g. 'VendorPattern[]') */
  sourceType?: string;
}

export interface ExtractedStateSlotConsumer {
  /** Function/method name that consumes data from this slot */
  functionName: string;
  /** File where the consumer lives */
  filePath: string;
  /** Line number of the consuming call */
  lineNumber: number;
  /** Properties this consumer accesses */
  accessedKeys: string[];
  /** Confidence tier */
  confidence: ShapeConfidence;
}

export interface ExtractedStateSlot {
  /** Human-readable identifier (e.g. "['vendor-patterns', slug]") */
  name: string;
  /** Framework that manages this state */
  slotKind: SlotKind;
  /** Literal or pattern of the cache/state key */
  cacheKey: string;
  /** File where the slot is first defined/configured */
  filePath: string;
  /** Line number of the slot definition */
  lineNumber: number;
  /** Functions that write data into this slot */
  producers: ExtractedStateSlotProducer[];
  /** Functions that read data from this slot */
  consumers: ExtractedStateSlotConsumer[];
}
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/src/core/ingestion/state-slot-detectors/types.ts
git commit -m "feat(types): add ExtractedStateSlot interface for state slot detection"
```

---

### Task 5: Write Shape Inference Module

**Files:**
- Create: `gitnexus/src/core/ingestion/shape-inference.ts`
- Create: `gitnexus/test/unit/shape-inference.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import {
  extractObjectLiteralKeys,
  extractDestructuredKeys,
  extractPropertyAccessKeys,
  cacheKeyPrefix,
  cacheKeysOverlap,
} from '../../src/core/ingestion/shape-inference.js';

describe('shape-inference', () => {
  describe('extractObjectLiteralKeys', () => {
    it('extracts top-level keys from JSON return', () => {
      const code = `return Response.json({ patterns, total, page })`;
      expect(extractObjectLiteralKeys(code)).toEqual(['patterns', 'total', 'page']);
    });

    it('extracts keys from NextResponse.json', () => {
      const code = `return NextResponse.json({ data: items, pagination: { page, limit } })`;
      expect(extractObjectLiteralKeys(code)).toEqual(['data', 'pagination']);
    });

    it('returns empty for no object literal', () => {
      expect(extractObjectLiteralKeys(`return data`)).toEqual([]);
    });
  });

  describe('extractDestructuredKeys', () => {
    it('extracts destructured keys from data variable', () => {
      const code = `const { patterns, total } = data;`;
      expect(extractDestructuredKeys(code)).toEqual(['patterns', 'total']);
    });

    it('extracts from response.json() destructuring', () => {
      const code = `const { items, count } = await res.json();`;
      expect(extractDestructuredKeys(code)).toEqual(['items', 'count']);
    });

    it('extracts from nested destructuring (top level only)', () => {
      const code = `const { data: { items }, total } = response;`;
      expect(extractDestructuredKeys(code)).toContain('total');
    });
  });

  describe('extractPropertyAccessKeys', () => {
    it('extracts dot-access keys on data variable', () => {
      const code = `console.log(data.patterns);\nconst x = data.total;`;
      expect(extractPropertyAccessKeys(code)).toEqual(expect.arrayContaining(['patterns', 'total']));
    });

    it('extracts optional chaining keys', () => {
      const code = `data?.items?.length`;
      expect(extractPropertyAccessKeys(code)).toContain('items');
    });

    it('filters out method-like accesses', () => {
      const keys = extractPropertyAccessKeys(`data.toString(); data.length; data.items`);
      expect(keys).not.toContain('toString');
      expect(keys).not.toContain('length');
      expect(keys).toContain('items');
    });
  });

  describe('cacheKeyPrefix', () => {
    it('extracts static prefix from array key', () => {
      expect(cacheKeyPrefix(`['vendor-patterns', slug]`)).toBe('vendor-patterns');
    });

    it('extracts prefix from single-string key', () => {
      expect(cacheKeyPrefix(`'vendor-patterns'`)).toBe('vendor-patterns');
    });

    it('extracts prefix from template literal', () => {
      expect(cacheKeyPrefix('`/api/vendors/${id}`')).toBe('/api/vendors/');
    });
  });

  describe('cacheKeysOverlap', () => {
    it('detects exact match', () => {
      expect(cacheKeysOverlap(`['vendor-patterns', slug]`, `['vendor-patterns', slug]`)).toBe(true);
    });

    it('detects prefix match with different dynamic parts', () => {
      expect(cacheKeysOverlap(`['vendor-patterns', slug]`, `['vendor-patterns', id]`)).toBe(true);
    });

    it('rejects different prefixes', () => {
      expect(cacheKeysOverlap(`['vendor-patterns']`, `['grants']`)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/shape-inference.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
/**
 * AST-based shape inference utilities.
 *
 * Extracts data shape information from source code using regex patterns
 * (not tree-sitter — these run on raw text for flexibility across contexts).
 */

/** Keys that are method-like and should be filtered from property access results */
const ACCESS_BLOCKLIST = new Set([
  'length', 'toString', 'valueOf', 'hasOwnProperty', 'constructor',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'map', 'filter',
  'reduce', 'forEach', 'find', 'findIndex', 'includes', 'indexOf',
  'keys', 'values', 'entries', 'then', 'catch', 'finally',
  'json', 'text', 'blob', 'arrayBuffer', 'formData', 'clone', 'ok', 'status',
]);

/**
 * Extract top-level keys from object literals in .json() or return statements.
 * Uses brace-depth counting (same approach as response-shapes.ts).
 */
export function extractObjectLiteralKeys(code: string): string[] {
  const keys: string[] = [];
  // Find .json({ ... }) or return { ... }
  const jsonPattern = /\.json\s*\(\s*\{|return\s+\{/g;
  let match: RegExpExecArray | null;

  while ((match = jsonPattern.exec(code)) !== null) {
    const braceStart = code.indexOf('{', match.index);
    if (braceStart === -1) continue;

    let depth = 0;
    let keyStart = -1;
    for (let i = braceStart; i < code.length; i++) {
      const ch = code[i];
      if (ch === '{') {
        depth++;
        if (depth === 1) keyStart = i + 1;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1 && ch === ':') {
        // Extract key before the colon
        const beforeColon = code.slice(keyStart, i).trim();
        // Handle quoted keys and identifier keys
        const keyMatch = beforeColon.match(/(?:['"]([^'"]+)['"]|(\w+))\s*$/);
        if (keyMatch) {
          keys.push(keyMatch[1] || keyMatch[2]);
        }
      } else if (depth === 1 && (ch === ',' || ch === '}')) {
        // Shorthand property: { patterns, total }
        const segment = code.slice(keyStart, i).trim();
        if (segment && /^\w+$/.test(segment)) {
          keys.push(segment);
        }
        keyStart = i + 1;
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract destructured keys from variable declarations.
 * Matches: const { key1, key2 } = data/response/result/res.json()
 */
export function extractDestructuredKeys(code: string): string[] {
  const keys: string[] = [];
  const pattern = /const\s+\{\s*([^}]+)\}\s*=\s*/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const inner = match[1];
    // Split by commas, extract the key name (before any colon for renaming)
    for (const part of inner.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle: key, key: alias, key: { nested }, ...rest
      const keyMatch = trimmed.match(/^(\w+)/);
      if (keyMatch && keyMatch[1] !== 'rest') {
        keys.push(keyMatch[1]);
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract property access keys from dot-access and optional chaining patterns.
 * Matches: data.key, response?.key, result.key
 */
export function extractPropertyAccessKeys(code: string): string[] {
  const keys: string[] = [];
  const dataVarNames = /(?:data|response|result|res|json|payload|body|state|value)/;
  const pattern = new RegExp(
    `(?:${dataVarNames.source})\\??\\.([a-zA-Z_]\\w*)`,
    'g',
  );
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(code)) !== null) {
    const key = match[1];
    if (!ACCESS_BLOCKLIST.has(key)) {
      keys.push(key);
    }
  }

  return [...new Set(keys)];
}

/**
 * Extract static prefix from a cache key expression.
 * Examples:
 *   "['vendor-patterns', slug]" → "vendor-patterns"
 *   "'vendor-patterns'" → "vendor-patterns"
 *   "`/api/vendors/${id}`" → "/api/vendors/"
 */
export function cacheKeyPrefix(cacheKey: string): string {
  // Array format: ['prefix', ...]
  const arrayMatch = cacheKey.match(/\[\s*['"]([^'"]+)['"]/);
  if (arrayMatch) return arrayMatch[1];

  // Single string: 'prefix'
  const stringMatch = cacheKey.match(/^['"]([^'"]+)['"]/);
  if (stringMatch) return stringMatch[1];

  // Template literal: `/api/path/${var}`
  const templateMatch = cacheKey.match(/^`([^$`]+)/);
  if (templateMatch) return templateMatch[1];

  return cacheKey;
}

/**
 * Check if two cache keys potentially overlap (could point to same slot).
 * Uses prefix matching — if static prefixes match, keys might collide.
 */
export function cacheKeysOverlap(key1: string, key2: string): boolean {
  const prefix1 = cacheKeyPrefix(key1);
  const prefix2 = cacheKeyPrefix(key2);
  return prefix1 === prefix2 && prefix1.length > 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/shape-inference.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/ingestion/shape-inference.ts gitnexus/test/unit/shape-inference.test.ts
git commit -m "feat: add shape inference utilities for object literals, destructuring, and cache key matching"
```

---

### Task 6: Write React Query Detector

**Files:**
- Create: `gitnexus/src/core/ingestion/state-slot-detectors/react-query.ts`
- Create: `gitnexus/test/unit/state-slot-detectors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { detectReactQuerySlots } from '../../src/core/ingestion/state-slot-detectors/react-query.js';

describe('detectReactQuerySlots', () => {
  it('detects useQuery with array queryKey', () => {
    const code = `
      export function useVendorPatterns(slug) {
        return useQuery({
          queryKey: ['vendor-patterns', slug],
          queryFn: () => fetch('/api/vendors').then(r => r.json()),
        });
      }
    `;
    const slots = detectReactQuerySlots(code, 'hooks/useVendorPatterns.ts');
    expect(slots).toHaveLength(1);
    expect(slots[0].slotKind).toBe('react-query');
    expect(slots[0].cacheKey).toContain('vendor-patterns');
    expect(slots[0].producers).toHaveLength(1);
    expect(slots[0].producers[0].filePath).toBe('hooks/useVendorPatterns.ts');
  });

  it('detects multiple useQuery calls in same file', () => {
    const code = `
      export function usePatterns(slug) {
        return useQuery({ queryKey: ['vendor-patterns', slug], queryFn: fetchPatterns });
      }
      export function usePatternCount(slug) {
        return useQuery({ queryKey: ['vendor-patterns', slug], queryFn: fetchCount });
      }
    `;
    const slots = detectReactQuerySlots(code, 'hooks/vendors.ts');
    expect(slots).toHaveLength(2);
    // Both share same cache key prefix
    expect(slots[0].cacheKey).toContain('vendor-patterns');
    expect(slots[1].cacheKey).toContain('vendor-patterns');
  });

  it('detects useMutation', () => {
    const code = `
      const mutation = useMutation({
        mutationKey: ['update-vendor'],
        mutationFn: (data) => fetch('/api/vendors', { method: 'POST', body: JSON.stringify(data) }),
      });
    `;
    const slots = detectReactQuerySlots(code, 'hooks/useUpdateVendor.ts');
    expect(slots).toHaveLength(1);
    expect(slots[0].cacheKey).toContain('update-vendor');
  });

  it('detects useInfiniteQuery', () => {
    const code = `
      useInfiniteQuery({
        queryKey: ['vendors-list'],
        queryFn: ({ pageParam }) => fetchVendors(pageParam),
      });
    `;
    const slots = detectReactQuerySlots(code, 'hooks/useVendors.ts');
    expect(slots).toHaveLength(1);
  });

  it('detects useSuspenseQuery', () => {
    const code = `
      useSuspenseQuery({
        queryKey: ['vendor-detail', id],
        queryFn: () => fetchVendor(id),
      });
    `;
    const slots = detectReactQuerySlots(code, 'hooks/useVendor.ts');
    expect(slots).toHaveLength(1);
  });

  it('returns empty for files without React Query hooks', () => {
    const code = `export function add(a, b) { return a + b; }`;
    expect(detectReactQuerySlots(code, 'utils/math.ts')).toEqual([]);
  });

  it('extracts consumer accessed keys from destructuring', () => {
    const code = `
      export function useVendors() {
        const { data } = useQuery({
          queryKey: ['vendors'],
          queryFn: fetchVendors,
        });
        const items = data?.patterns;
        const count = data?.total;
        return { items, count };
      }
    `;
    const slots = detectReactQuerySlots(code, 'hooks/useVendors.ts');
    expect(slots).toHaveLength(1);
    expect(slots[0].consumers).toHaveLength(1);
    expect(slots[0].consumers[0].accessedKeys).toEqual(
      expect.arrayContaining(['patterns', 'total']),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/state-slot-detectors.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
/**
 * React Query / TanStack Query state slot detector.
 *
 * Detects useQuery, useMutation, useInfiniteQuery, useSuspenseQuery calls
 * and extracts cache keys, producer shapes, and consumer access patterns.
 */

import type { ExtractedStateSlot, ExtractedStateSlotProducer, ExtractedStateSlotConsumer } from './types.js';
import { extractDestructuredKeys, extractPropertyAccessKeys } from '../shape-inference.js';

const REACT_QUERY_HOOKS = /\b(useQuery|useMutation|useInfiniteQuery|useSuspenseQuery)\s*\(\s*\{/g;
const QUERY_KEY_PATTERN = /queryKey\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/;
const MUTATION_KEY_PATTERN = /mutationKey\s*:\s*(\[[^\]]*\]|['"][^'"]+['"])/;

/**
 * Extract the options object for a React Query hook call starting at the opening brace.
 * Uses brace-depth counting to find the matching closing brace.
 */
function extractOptionsBlock(code: string, braceStart: number): string {
  let depth = 0;
  for (let i = braceStart; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return code.slice(braceStart, i + 1);
    }
  }
  return code.slice(braceStart);
}

/**
 * Find the enclosing function name for a position in code.
 * Looks backwards for `function NAME` or `const NAME =` patterns.
 */
function findEnclosingFunctionName(code: string, position: number): string {
  const before = code.slice(0, position);
  // Try: export function NAME, function NAME, const NAME =
  const funcMatch = before.match(/(?:export\s+)?(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:\([^)]*\)\s*=>|\w+\s*=>|function)|\s*\()/g);
  if (funcMatch) {
    const last = funcMatch[funcMatch.length - 1];
    const nameMatch = last.match(/(?:function|const|let|var)\s+(\w+)/);
    if (nameMatch) return nameMatch[1];
  }
  return '<anonymous>';
}

/**
 * Detect React Query / TanStack Query state slots in source code.
 */
export function detectReactQuerySlots(code: string, filePath: string): ExtractedStateSlot[] {
  const slots: ExtractedStateSlot[] = [];

  let match: RegExpExecArray | null;
  REACT_QUERY_HOOKS.lastIndex = 0;

  while ((match = REACT_QUERY_HOOKS.exec(code)) !== null) {
    const hookName = match[1];
    const isMutation = hookName === 'useMutation';
    const braceStart = code.indexOf('{', match.index + hookName.length);
    if (braceStart === -1) continue;

    const optionsBlock = extractOptionsBlock(code, braceStart);
    const keyPattern = isMutation ? MUTATION_KEY_PATTERN : QUERY_KEY_PATTERN;
    const keyMatch = optionsBlock.match(keyPattern);
    if (!keyMatch) continue;

    const cacheKey = keyMatch[1];
    const lineNumber = code.slice(0, match.index).split('\n').length;
    const functionName = findEnclosingFunctionName(code, match.index);

    // The hook call is both a producer (writes queryFn result to cache) and defines the slot
    const producer: ExtractedStateSlotProducer = {
      functionName,
      filePath,
      lineNumber,
      keys: [], // Will be enriched by shape inference in the pipeline
      confidence: 'heuristic',
    };

    // Look for consumer access patterns in the surrounding function context
    // Find the function body that contains this hook call
    const consumers: ExtractedStateSlotConsumer[] = [];
    const funcEnd = findFunctionEnd(code, match.index);
    const funcBody = code.slice(match.index, funcEnd);

    const destructuredKeys = extractDestructuredKeys(funcBody);
    const accessKeys = extractPropertyAccessKeys(funcBody);
    const allKeys = [...new Set([...destructuredKeys, ...accessKeys])];

    if (allKeys.length > 0) {
      consumers.push({
        functionName,
        filePath,
        lineNumber,
        accessedKeys: allKeys,
        confidence: 'heuristic',
      });
    }

    slots.push({
      name: `${hookName}(${cacheKey})`,
      slotKind: 'react-query',
      cacheKey,
      filePath,
      lineNumber,
      producers: [producer],
      consumers,
    });
  }

  return slots;
}

/**
 * Find the end of the function containing a given position.
 * Simple heuristic: find the next function/export boundary or end of file.
 */
function findFunctionEnd(code: string, position: number): number {
  // Look for the next top-level function/export declaration after the current position
  const afterPos = code.slice(position + 1);
  const nextFunc = afterPos.search(/\n(?:export\s+)?(?:function|const|let|var)\s+\w+/);
  if (nextFunc !== -1) return position + 1 + nextFunc;
  return code.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/state-slot-detectors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/ingestion/state-slot-detectors/react-query.ts gitnexus/test/unit/state-slot-detectors.test.ts
git commit -m "feat: add React Query state slot detector with cache key extraction"
```

---

### Task 7: Write SWR Detector

**Files:**
- Create: `gitnexus/src/core/ingestion/state-slot-detectors/swr.ts`
- Modify: `gitnexus/test/unit/state-slot-detectors.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `state-slot-detectors.test.ts`:

```typescript
import { detectSWRSlots } from '../../src/core/ingestion/state-slot-detectors/swr.js';

describe('detectSWRSlots', () => {
  it('detects useSWR with string key', () => {
    const code = `
      export function useVendor(id) {
        const { data, error } = useSWR('/api/vendors/' + id, fetcher);
        return { data, error };
      }
    `;
    const slots = detectSWRSlots(code, 'hooks/useVendor.ts');
    expect(slots).toHaveLength(1);
    expect(slots[0].slotKind).toBe('swr');
    expect(slots[0].cacheKey).toContain('/api/vendors/');
  });

  it('detects useSWR with array key', () => {
    const code = `
      const { data } = useSWR(['vendors', id], fetchVendor);
    `;
    const slots = detectSWRSlots(code, 'hooks/useVendor.ts');
    expect(slots).toHaveLength(1);
    expect(slots[0].cacheKey).toContain('vendors');
  });

  it('detects useSWRMutation', () => {
    const code = `
      const { trigger } = useSWRMutation('/api/vendors', updateVendor);
    `;
    const slots = detectSWRSlots(code, 'hooks/useUpdateVendor.ts');
    expect(slots).toHaveLength(1);
  });

  it('returns empty for files without SWR', () => {
    expect(detectSWRSlots(`const x = 1;`, 'utils.ts')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/state-slot-detectors.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
/**
 * SWR state slot detector.
 *
 * Detects useSWR and useSWRMutation calls and extracts cache keys.
 */

import type { ExtractedStateSlot, ExtractedStateSlotProducer, ExtractedStateSlotConsumer } from './types.js';
import { extractDestructuredKeys, extractPropertyAccessKeys } from '../shape-inference.js';

const SWR_HOOKS = /\b(useSWR|useSWRMutation)\s*\(\s*/g;

/**
 * Extract the first argument (cache key) from a SWR hook call.
 * SWR key is the first argument: useSWR(key, fetcher, options?)
 */
function extractSWRKey(code: string, callStart: number): string | null {
  const afterParen = code.indexOf('(', callStart);
  if (afterParen === -1) return null;

  let pos = afterParen + 1;
  // Skip whitespace
  while (pos < code.length && /\s/.test(code[pos])) pos++;

  // Array key: ['key', var]
  if (code[pos] === '[') {
    const end = code.indexOf(']', pos);
    if (end !== -1) return code.slice(pos, end + 1);
  }

  // String key: '/api/path' or "/api/path"
  if (code[pos] === "'" || code[pos] === '"') {
    const quote = code[pos];
    const end = code.indexOf(quote, pos + 1);
    if (end !== -1) return code.slice(pos, end + 1);
  }

  // Template literal: `/api/path/${id}`
  if (code[pos] === '`') {
    const end = code.indexOf('`', pos + 1);
    if (end !== -1) return code.slice(pos, end + 1);
  }

  // Expression with string concat: '/api/vendors/' + id
  // Capture up to the comma separator
  const exprEnd = code.indexOf(',', pos);
  if (exprEnd !== -1) {
    const expr = code.slice(pos, exprEnd).trim();
    // Only keep if it starts with a string literal
    if (/^['"`]/.test(expr)) return expr;
  }

  return null;
}

function findEnclosingFunctionName(code: string, position: number): string {
  const before = code.slice(0, position);
  const funcMatch = before.match(/(?:export\s+)?(?:function|const|let|var)\s+(\w+)\s*(?:=\s*(?:\([^)]*\)\s*=>|\w+\s*=>|function)|\s*\()/g);
  if (funcMatch) {
    const last = funcMatch[funcMatch.length - 1];
    const nameMatch = last.match(/(?:function|const|let|var)\s+(\w+)/);
    if (nameMatch) return nameMatch[1];
  }
  return '<anonymous>';
}

/**
 * Detect SWR state slots in source code.
 */
export function detectSWRSlots(code: string, filePath: string): ExtractedStateSlot[] {
  const slots: ExtractedStateSlot[] = [];

  let match: RegExpExecArray | null;
  SWR_HOOKS.lastIndex = 0;

  while ((match = SWR_HOOKS.exec(code)) !== null) {
    const hookName = match[1];
    const cacheKey = extractSWRKey(code, match.index);
    if (!cacheKey) continue;

    const lineNumber = code.slice(0, match.index).split('\n').length;
    const functionName = findEnclosingFunctionName(code, match.index);

    const producer: ExtractedStateSlotProducer = {
      functionName,
      filePath,
      lineNumber,
      keys: [],
      confidence: 'heuristic',
    };

    // Look for consumer access patterns after the hook call
    const consumers: ExtractedStateSlotConsumer[] = [];
    const contextEnd = Math.min(match.index + 500, code.length);
    const contextCode = code.slice(match.index, contextEnd);

    const destructuredKeys = extractDestructuredKeys(contextCode);
    const accessKeys = extractPropertyAccessKeys(contextCode);
    const allKeys = [...new Set([...destructuredKeys, ...accessKeys])];

    if (allKeys.length > 0) {
      consumers.push({
        functionName,
        filePath,
        lineNumber,
        accessedKeys: allKeys,
        confidence: 'heuristic',
      });
    }

    slots.push({
      name: `${hookName}(${cacheKey})`,
      slotKind: 'swr',
      cacheKey,
      filePath,
      lineNumber,
      producers: [producer],
      consumers,
    });
  }

  return slots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/unit/state-slot-detectors.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/core/ingestion/state-slot-detectors/swr.ts gitnexus/test/unit/state-slot-detectors.test.ts
git commit -m "feat: add SWR state slot detector"
```

---

### Task 8: Create Detector Index and Barrel Export

**Files:**
- Create: `gitnexus/src/core/ingestion/state-slot-detectors/index.ts`

- [ ] **Step 1: Write the barrel export and orchestrator**

```typescript
/**
 * State slot detection orchestrator.
 *
 * Runs all registered detectors against file content and returns
 * merged ExtractedStateSlot results.
 */

import type { ExtractedStateSlot } from './types.js';
import { detectReactQuerySlots } from './react-query.js';
import { detectSWRSlots } from './swr.js';

export type { ExtractedStateSlot, SlotKind, ShapeConfidence, ExtractedStateSlotProducer, ExtractedStateSlotConsumer } from './types.js';

type Detector = (code: string, filePath: string) => ExtractedStateSlot[];

const DETECTORS: Detector[] = [
  detectReactQuerySlots,
  detectSWRSlots,
  // Phase 3: detectReactContextSlots, detectReduxSlots, detectZustandSlots
  // Phase 4: detectTRPCSlots, detectGraphQLSlots
];

/**
 * Run all state slot detectors on a file and return merged results.
 */
export function detectStateSlots(code: string, filePath: string): ExtractedStateSlot[] {
  const results: ExtractedStateSlot[] = [];
  for (const detector of DETECTORS) {
    results.push(...detector(code, filePath));
  }
  return results;
}
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/src/core/ingestion/state-slot-detectors/index.ts
git commit -m "feat: add state slot detector orchestrator with barrel exports"
```

---

### Task 9: Create State Slot Processor (Pipeline Phase 3.7)

**Files:**
- Create: `gitnexus/src/core/ingestion/state-slot-processor.ts`

- [ ] **Step 1: Write the processor**

```typescript
/**
 * Pipeline Phase 3.7: State Slot Processing.
 *
 * Creates StateSlot nodes and PRODUCES/CONSUMES edges from ExtractedStateSlot data.
 * Runs after route detection (3.5) and tool detection (3.6).
 */

import type { KnowledgeGraph } from '../graph/graph.js';
import type { ExtractedStateSlot } from './state-slot-detectors/index.js';
import { cacheKeysOverlap } from './shape-inference.js';

// Re-use the existing generateId from the pipeline (consistent ID format)
function generateId(prefix: string, key: string): string {
  return `${prefix}:${key}`;
}

export interface StateSlotProcessorResult {
  slotsCreated: number;
  producesEdges: number;
  consumesEdges: number;
  overlapWarnings: number;
}

/**
 * Process extracted state slots into the knowledge graph.
 *
 * Creates StateSlot nodes and PRODUCES/CONSUMES edges. Also detects
 * potential cache key overlaps (same prefix, different producers).
 */
export function processStateSlots(
  graph: KnowledgeGraph,
  allSlots: ExtractedStateSlot[],
): StateSlotProcessorResult {
  const stats: StateSlotProcessorResult = {
    slotsCreated: 0,
    producesEdges: 0,
    consumesEdges: 0,
    overlapWarnings: 0,
  };

  // Deduplicate slots by cacheKey — merge producers/consumers for same key
  const slotsByKey = new Map<string, ExtractedStateSlot>();

  for (const slot of allSlots) {
    const existing = slotsByKey.get(slot.cacheKey);
    if (existing) {
      existing.producers.push(...slot.producers);
      existing.consumers.push(...slot.consumers);
    } else {
      slotsByKey.set(slot.cacheKey, { ...slot, producers: [...slot.producers], consumers: [...slot.consumers] });
    }
  }

  // Create StateSlot nodes and edges
  for (const [cacheKey, slot] of slotsByKey) {
    const slotNodeId = generateId('StateSlot', `${slot.slotKind}:${cacheKey}`);

    graph.addNode({
      id: slotNodeId,
      label: 'StateSlot',
      properties: {
        name: slot.name,
        filePath: slot.filePath,
        slotKind: slot.slotKind,
        cacheKey: slot.cacheKey,
      },
    });
    stats.slotsCreated++;

    // PRODUCES edges
    for (const producer of slot.producers) {
      const producerNodeId = findSymbolId(graph, producer.functionName, producer.filePath)
        || generateId('File', producer.filePath);

      const edgeReason = buildProducesReason(producer);
      graph.addRelationship({
        id: generateId('PRODUCES', `${producerNodeId}->${slotNodeId}`),
        sourceId: producerNodeId,
        targetId: slotNodeId,
        type: 'PRODUCES',
        confidence: confidenceToNumber(producer.confidence),
        reason: edgeReason,
      });
      stats.producesEdges++;
    }

    // CONSUMES edges
    for (const consumer of slot.consumers) {
      const consumerNodeId = findSymbolId(graph, consumer.functionName, consumer.filePath)
        || generateId('File', consumer.filePath);

      const edgeReason = buildConsumesReason(consumer);
      graph.addRelationship({
        id: generateId('CONSUMES', `${consumerNodeId}->${slotNodeId}`),
        sourceId: consumerNodeId,
        targetId: slotNodeId,
        type: 'CONSUMES',
        confidence: confidenceToNumber(consumer.confidence),
        reason: edgeReason,
      });
      stats.consumesEdges++;
    }
  }

  // Detect cache key prefix overlaps across different slots
  const keys = [...slotsByKey.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (keys[i] !== keys[j] && cacheKeysOverlap(keys[i], keys[j])) {
        stats.overlapWarnings++;
      }
    }
  }

  return stats;
}

/**
 * Find a Function/Method node ID by name and filePath in the graph.
 */
function findSymbolId(graph: KnowledgeGraph, name: string, filePath: string): string | undefined {
  // Try common ID patterns used by the pipeline
  for (const prefix of ['Function', 'Method']) {
    const candidateId = generateId(prefix, `${filePath}:${name}`);
    if (graph.getNode(candidateId)) return candidateId;
  }
  // Fallback: search nodes by name and filePath
  for (const node of graph.nodes) {
    if (node.properties.name === name && node.properties.filePath === filePath) {
      return node.id;
    }
  }
  return undefined;
}

function confidenceToNumber(confidence: string): number {
  switch (confidence) {
    case 'type-checked': return 1.0;
    case 'ast-literal': return 0.8;
    case 'heuristic': return 0.6;
    default: return 0.5;
  }
}

function buildProducesReason(producer: { keys: string[]; confidence: string; sourceType?: string }): string {
  const parts = [`shape-${producer.confidence}`];
  if (producer.keys.length > 0) parts.push(`keys:${producer.keys.join(',')}`);
  if (producer.sourceType) parts.push(`type:${producer.sourceType}`);
  return parts.join('|');
}

function buildConsumesReason(consumer: { accessedKeys: string[]; confidence: string }): string {
  const parts = [`shape-${consumer.confidence}`];
  if (consumer.accessedKeys.length > 0) parts.push(`keys:${consumer.accessedKeys.join(',')}`);
  return parts.join('|');
}
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/src/core/ingestion/state-slot-processor.ts
git commit -m "feat: add state slot processor for pipeline phase 3.7"
```

---

### Task 10: Integrate State Slot Detection into Pipeline

**Files:**
- Modify: `gitnexus/src/core/ingestion/pipeline.ts`

- [ ] **Step 1: Add imports at top of pipeline.ts**

Add after existing imports:

```typescript
import { detectStateSlots } from './state-slot-detectors/index.js';
import type { ExtractedStateSlot } from './state-slot-detectors/index.js';
import { processStateSlots } from './state-slot-processor.js';
```

- [ ] **Step 2: Add accumulator in runChunkedParseAndResolve**

After `const allToolDefs: ExtractedToolDef[] = [];` (line 630), add:

```typescript
  // Accumulate state slot detections for Phase 3.7
  const allStateSlots: ExtractedStateSlot[] = [];
```

- [ ] **Step 3: Add state slot detection inside the chunk loop**

After `allToolDefs.push(...chunkWorkerData.toolDefs);` (line 757), add:

```typescript
        // Detect state slots (React Query, SWR, etc.) from file contents
        for (const [filePath, content] of chunkContents) {
          const slots = detectStateSlots(content, filePath);
          if (slots.length > 0) allStateSlots.push(...slots);
        }
```

Note: `chunkContents` is already available in scope (line 637). We run detection on raw source text (not AST), which is fast.

- [ ] **Step 4: Add allStateSlots to the return value**

Update the return type of `runChunkedParseAndResolve` (line 505) to include:

```typescript
  allStateSlots: ExtractedStateSlot[];
```

And add to the return statement (around line 860):

```typescript
  return { exportedTypeMap, allFetchCalls, allExtractedRoutes, allDecoratorRoutes, allToolDefs, allStateSlots };
```

- [ ] **Step 5: Add Phase 3.7 in the pipeline orchestrator**

After Phase 3.6 (tool detection, around line 1244), add:

```typescript
  // ── Phase 3.7: State Slot Detection ────────────────────────────────────────
  if (allStateSlots.length > 0) {
    onProgress({
      phase: 'state-slots',
      percent: 89,
      message: `Processing ${allStateSlots.length} state slot(s)...`,
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    const slotResult = processStateSlots(graph, allStateSlots);

    if (isDev) {
      console.log(`🗄️ State slots: ${slotResult.slotsCreated} created, ${slotResult.producesEdges} PRODUCES, ${slotResult.consumesEdges} CONSUMES, ${slotResult.overlapWarnings} overlap warnings`);
    }
  }
```

- [ ] **Step 6: Update destructuring of runChunkedParseAndResolve result**

Update the line that destructures the result (around line 1074) to include `allStateSlots`:

```typescript
  const { exportedTypeMap, allFetchCalls, allExtractedRoutes, allDecoratorRoutes, allToolDefs, allStateSlots } = await runChunkedParseAndResolve(
```

- [ ] **Step 7: Commit**

```bash
git add gitnexus/src/core/ingestion/pipeline.ts
git commit -m "feat: integrate state slot detection as pipeline phase 3.7"
```

---

### Task 11: Create Seed Data for E2E Tests

**Files:**
- Create: `gitnexus/test/fixtures/state-slot-seed.ts`

- [ ] **Step 1: Write seed data**

```typescript
import type { FTSIndexDef } from '../helpers/test-indexed-db.js';

/**
 * Seed data for data_flow E2E tests.
 *
 * Simulates a Next.js project with:
 * - Two React Query hooks sharing cache key ['vendor-patterns', slug]
 *   with DIFFERENT produced shapes (the original bug)
 * - One SWR hook with a different key (no conflict)
 * - Consumer components with different access patterns
 */
export const STATE_SLOT_SEED_DATA = [
  // ─── Files ─────────────────────────────────────────────────────────
  `CREATE (f:File {id: 'file:hooks/useVendorPatterns.ts', name: 'useVendorPatterns.ts', filePath: 'hooks/useVendorPatterns.ts', content: 'useQuery vendor-patterns'})`,
  `CREATE (f:File {id: 'file:hooks/useVendorCount.ts', name: 'useVendorCount.ts', filePath: 'hooks/useVendorCount.ts', content: 'useQuery vendor-patterns count'})`,
  `CREATE (f:File {id: 'file:hooks/useGrants.ts', name: 'useGrants.ts', filePath: 'hooks/useGrants.ts', content: 'useSWR grants'})`,
  `CREATE (f:File {id: 'file:components/VendorList.tsx', name: 'VendorList.tsx', filePath: 'components/VendorList.tsx', content: 'displays vendor patterns'})`,
  `CREATE (f:File {id: 'file:components/VendorStats.tsx', name: 'VendorStats.tsx', filePath: 'components/VendorStats.tsx', content: 'displays vendor count'})`,

  // ─── StateSlot nodes ───────────────────────────────────────────────
  // Two hooks share this cache key with different shapes
  `CREATE (s:StateSlot {id: 'StateSlot:react-query:[vendor-patterns, slug]', name: 'useQuery([vendor-patterns, slug])', filePath: 'hooks/useVendorPatterns.ts', slotKind: 'react-query', cacheKey: '[vendor-patterns, slug]'})`,
  // SWR slot with no conflicts
  `CREATE (s:StateSlot {id: 'StateSlot:swr:/api/grants', name: 'useSWR(/api/grants)', filePath: 'hooks/useGrants.ts', slotKind: 'swr', cacheKey: '/api/grants'})`,

  // ─── Functions ─────────────────────────────────────────────────────
  `CREATE (fn:Function {id: 'func:useVendorPatterns', name: 'useVendorPatterns', filePath: 'hooks/useVendorPatterns.ts', startLine: 1, endLine: 10, isExported: true, content: 'export function useVendorPatterns()', description: 'Hook returning vendor patterns list'})`,
  `CREATE (fn:Function {id: 'func:useVendorCount', name: 'useVendorCount', filePath: 'hooks/useVendorCount.ts', startLine: 1, endLine: 8, isExported: true, content: 'export function useVendorCount()', description: 'Hook returning vendor count'})`,
  `CREATE (fn:Function {id: 'func:useGrants', name: 'useGrants', filePath: 'hooks/useGrants.ts', startLine: 1, endLine: 6, isExported: true, content: 'export function useGrants()', description: 'Hook returning grants'})`,
  `CREATE (fn:Function {id: 'func:VendorList', name: 'VendorList', filePath: 'components/VendorList.tsx', startLine: 1, endLine: 15, isExported: true, content: 'export function VendorList()', description: 'Vendor list component'})`,
  `CREATE (fn:Function {id: 'func:VendorStats', name: 'VendorStats', filePath: 'components/VendorStats.tsx', startLine: 1, endLine: 10, isExported: true, content: 'export function VendorStats()', description: 'Vendor stats component'})`,

  // ─── PRODUCES edges (hooks → StateSlot) ─────────────────────────────
  // useVendorPatterns produces {patterns, total, page} into the shared slot
  `MATCH (fn:Function), (s:StateSlot) WHERE fn.id = 'func:useVendorPatterns' AND s.id = 'StateSlot:react-query:[vendor-patterns, slug]'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 0.8, reason: 'shape-ast-literal|keys:patterns,total,page', step: 0}]->(s)`,
  // useVendorCount produces {total} into the SAME slot (CONFLICT!)
  `MATCH (fn:Function), (s:StateSlot) WHERE fn.id = 'func:useVendorCount' AND s.id = 'StateSlot:react-query:[vendor-patterns, slug]'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 0.8, reason: 'shape-ast-literal|keys:total', step: 0}]->(s)`,
  // useGrants produces {grants, pagination} into a different slot (no conflict)
  `MATCH (fn:Function), (s:StateSlot) WHERE fn.id = 'func:useGrants' AND s.id = 'StateSlot:swr:/api/grants'
   CREATE (fn)-[:CodeRelation {type: 'PRODUCES', confidence: 0.6, reason: 'shape-heuristic|keys:grants,pagination', step: 0}]->(s)`,

  // ─── CONSUMES edges (components → StateSlot) ───────────────────────
  // VendorList accesses patterns and page from the shared slot
  `MATCH (fn:Function), (s:StateSlot) WHERE fn.id = 'func:VendorList' AND s.id = 'StateSlot:react-query:[vendor-patterns, slug]'
   CREATE (fn)-[:CodeRelation {type: 'CONSUMES', confidence: 0.6, reason: 'shape-heuristic|keys:patterns,page', step: 0}]->(s)`,
  // VendorStats accesses total from the shared slot
  `MATCH (fn:Function), (s:StateSlot) WHERE fn.id = 'func:VendorStats' AND s.id = 'StateSlot:react-query:[vendor-patterns, slug]'
   CREATE (fn)-[:CodeRelation {type: 'CONSUMES', confidence: 0.6, reason: 'shape-heuristic|keys:total', step: 0}]->(s)`,
];

export const STATE_SLOT_FTS_INDEXES: FTSIndexDef[] = [
  { table: 'Function', indexName: 'function_fts', columns: ['name', 'content', 'description'] },
  { table: 'File', indexName: 'file_fts', columns: ['name', 'content'] },
];
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/test/fixtures/state-slot-seed.ts
git commit -m "test: add seed data for data_flow E2E tests with cache key conflict scenario"
```

---

### Task 12: Add data_flow MCP Tool Definition

**Files:**
- Modify: `gitnexus/src/mcp/tools.ts`

- [ ] **Step 1: Add data_flow to GITNEXUS_TOOLS array**

After the `api_impact` tool definition (or at the end of the array):

```typescript
  {
    name: 'data_flow',
    description: `Show data flow through shared state slots (React Query cache keys, SWR keys, React Context, Redux slices, Zustand stores).

WHEN TO USE: When you need to understand how data flows through shared state, detect cache key collisions, or find shape mismatches where two hooks/components share a state slot but expect different data shapes.

Returns: state slots with their producers (who writes data), consumers (who reads data), shape comparison, and mismatch verdict (ok/suspicious/conflict).

AFTER THIS: If mismatches are found, use \`context\` on the producer/consumer functions to understand the full call chain.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter by cache key, context name, or slice name (substring match)' },
        slotKind: { type: 'string', description: 'Filter by state slot kind', enum: ['react-query', 'swr', 'react-context', 'redux', 'zustand', 'trpc', 'graphql', 'custom-hook'] },
        mismatchesOnly: { type: 'string', description: 'Set to "true" to only show slots with shape conflicts' },
        repo: { type: 'string', description: 'Repository name or path. Omit if only one repo is indexed.' },
      },
      required: [],
    },
  },
```

- [ ] **Step 2: Commit**

```bash
git add gitnexus/src/mcp/tools.ts
git commit -m "feat(mcp): add data_flow tool definition"
```

---

### Task 13: Implement data_flow Tool in Local Backend

**Files:**
- Modify: `gitnexus/src/mcp/local/local-backend.ts`

- [ ] **Step 1: Add 'data_flow' case to callTool() dispatch**

In the `callTool()` switch (around line 417), add before `default:`:

```typescript
    case 'data_flow':   return this.dataFlow(repo, params);
```

- [ ] **Step 2: Implement dataFlow() method**

Add after `apiImpact()` method (around line 1900):

```typescript
  /**
   * data_flow tool: Show data flow through shared state slots with mismatch detection.
   */
  private async dataFlow(
    repo: RepoHandle,
    params: { query?: string; slotKind?: string; mismatchesOnly?: string },
  ): Promise<any> {
    await this.ensureInitialized(repo.id);

    // Build filter clauses
    const conditions: string[] = [];
    const queryParams: Record<string, any> = {};

    if (params.query) {
      conditions.push(`(s.name CONTAINS $query OR s.cacheKey CONTAINS $query)`);
      queryParams.query = params.query;
    }
    if (params.slotKind) {
      conditions.push(`s.slotKind = $slotKind`);
      queryParams.slotKind = params.slotKind;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Query StateSlot nodes with their PRODUCES and CONSUMES edges
    const slotsQuery = `
      MATCH (s:StateSlot)
      ${whereClause}
      RETURN s.id AS id, s.name AS name, s.filePath AS filePath,
             s.slotKind AS slotKind, s.cacheKey AS cacheKey
      ORDER BY s.slotKind, s.name
    `;

    const slotRows = await executeParameterized(repo.id, slotsQuery, queryParams);

    if (!slotRows || slotRows.length === 0) {
      return { slots: [], total: 0, message: 'No state slots found.' };
    }

    const results = [];

    for (const slot of slotRows) {
      // Get producers
      const producersQuery = `
        MATCH (fn)-[r:CodeRelation]->(s:StateSlot)
        WHERE s.id = $slotId AND r.type = 'PRODUCES'
        RETURN fn.name AS name, fn.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
      `;
      const producerRows = await executeParameterized(repo.id, producersQuery, { slotId: slot.id });

      // Get consumers
      const consumersQuery = `
        MATCH (fn)-[r:CodeRelation]->(s:StateSlot)
        WHERE s.id = $slotId AND r.type = 'CONSUMES'
        RETURN fn.name AS name, fn.filePath AS filePath, r.reason AS reason, r.confidence AS confidence
      `;
      const consumerRows = await executeParameterized(repo.id, consumersQuery, { slotId: slot.id });

      const producers = (producerRows || []).map((p: any) => ({
        name: p.name,
        file: p.filePath,
        ...parseShapeReason(p.reason),
        confidence: p.confidence,
      }));

      const consumers = (consumerRows || []).map((c: any) => ({
        name: c.name,
        file: c.filePath,
        ...parseShapeReason(c.reason),
        confidence: c.confidence,
      }));

      // Determine mismatch verdict
      const verdict = computeShapeVerdict(producers, consumers);

      if (params.mismatchesOnly === 'true' && verdict.status === 'ok') continue;

      results.push({
        name: slot.name,
        slotKind: slot.slotKind,
        cacheKey: slot.cacheKey,
        file: slot.filePath,
        producers,
        consumers,
        verdict,
      });
    }

    return {
      slots: results,
      total: results.length,
      conflicts: results.filter(r => r.verdict.status === 'conflict').length,
      suspicious: results.filter(r => r.verdict.status === 'suspicious').length,
    };
  }
```

- [ ] **Step 3: Add helper functions**

Add near the top of the file (with other helpers) or at the bottom:

```typescript
/**
 * Parse shape metadata from PRODUCES/CONSUMES edge reason field.
 * Format: "shape-{confidence}|keys:k1,k2|type:TypeName"
 */
function parseShapeReason(reason: string): { keys: string[]; sourceType?: string } {
  const keys: string[] = [];
  let sourceType: string | undefined;

  if (!reason) return { keys };

  const parts = reason.split('|');
  for (const part of parts) {
    if (part.startsWith('keys:')) {
      keys.push(...part.slice(5).split(',').filter(Boolean));
    } else if (part.startsWith('type:')) {
      sourceType = part.slice(5);
    }
  }

  return { keys, ...(sourceType ? { sourceType } : {}) };
}

/**
 * Compare producer and consumer shapes to determine mismatch verdict.
 */
function computeShapeVerdict(
  producers: { name: string; keys: string[] }[],
  consumers: { name: string; keys: string[] }[],
): { status: 'ok' | 'suspicious' | 'conflict'; reason: string } {
  // Check for producer shape conflicts (different producers write different shapes)
  if (producers.length >= 2) {
    const shapes = producers.map(p => p.keys.sort().join(','));
    const uniqueShapes = new Set(shapes);
    if (uniqueShapes.size > 1) {
      const diffs = producers.map(p => `${p.name} writes {${p.keys.join(', ')}}`).join('; ');
      return {
        status: 'conflict',
        reason: `Multiple producers write different shapes to same slot: ${diffs}`,
      };
    }
  }

  // Check for consumer accessing keys not in any producer
  if (producers.length > 0 && consumers.length > 0) {
    const allProducedKeys = new Set(producers.flatMap(p => p.keys));
    if (allProducedKeys.size > 0) {
      for (const consumer of consumers) {
        const unknownKeys = consumer.keys.filter(k => !allProducedKeys.has(k));
        if (unknownKeys.length > 0) {
          return {
            status: 'suspicious',
            reason: `${consumer.name} accesses keys not in any producer: {${unknownKeys.join(', ')}}`,
          };
        }
      }
    }
  }

  return { status: 'ok', reason: 'No shape mismatches detected' };
}
```

- [ ] **Step 4: Add next-step hint in server.ts**

In `getNextStepHint()` in `server.ts`, add a case:

```typescript
case 'data_flow':
  return '\n\n💡 Next: Use `context` on any producer/consumer to see its full call chain, or `api_impact` to check the upstream API route.';
```

- [ ] **Step 5: Commit**

```bash
git add gitnexus/src/mcp/local/local-backend.ts gitnexus/src/mcp/server.ts
git commit -m "feat(mcp): implement data_flow tool with shape mismatch detection"
```

---

### Task 14: Write E2E Test for data_flow Tool

**Files:**
- Create: `gitnexus/test/integration/data-flow-e2e.test.ts`

- [ ] **Step 1: Write the E2E test**

```typescript
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { STATE_SLOT_SEED_DATA, STATE_SLOT_FTS_INDEXES } from '../fixtures/state-slot-seed.js';

vi.mock('../../src/storage/repo-manager.js', () => ({
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
}));

withTestLbugDB('data-flow-e2e', (handle) => {
  let backend: LocalBackend;

  beforeAll(async () => {
    const ext = handle as typeof handle & { _backend?: LocalBackend };
    backend = ext._backend!;
  });

  describe('data_flow tool', () => {
    it('returns all state slots when no filter', async () => {
      const result = await backend.callTool('data_flow', {});
      expect(result).not.toHaveProperty('error');
      expect(result.total).toBe(2); // react-query + swr
      expect(result.slots).toHaveLength(2);
    });

    it('filters by slotKind', async () => {
      const result = await backend.callTool('data_flow', { slotKind: 'react-query' });
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0].slotKind).toBe('react-query');
    });

    it('filters by query substring', async () => {
      const result = await backend.callTool('data_flow', { query: 'vendor-patterns' });
      expect(result.slots).toHaveLength(1);
      expect(result.slots[0].cacheKey).toContain('vendor-patterns');
    });

    it('detects shape conflict in shared cache key', async () => {
      const result = await backend.callTool('data_flow', { query: 'vendor-patterns' });
      const slot = result.slots[0];
      expect(slot.verdict.status).toBe('conflict');
      expect(slot.verdict.reason).toContain('different shapes');
      expect(slot.producers).toHaveLength(2);
    });

    it('shows ok verdict for non-conflicting slot', async () => {
      const result = await backend.callTool('data_flow', { query: 'grants' });
      const slot = result.slots[0];
      expect(slot.verdict.status).toBe('ok');
    });

    it('mismatchesOnly filters to conflicts only', async () => {
      const result = await backend.callTool('data_flow', { mismatchesOnly: 'true' });
      expect(result.slots.length).toBeLessThan(2);
      for (const slot of result.slots) {
        expect(slot.verdict.status).not.toBe('ok');
      }
    });

    it('returns producer and consumer details', async () => {
      const result = await backend.callTool('data_flow', { query: 'vendor-patterns' });
      const slot = result.slots[0];

      // Producers
      expect(slot.producers.some((p: any) => p.name === 'useVendorPatterns')).toBe(true);
      expect(slot.producers.some((p: any) => p.name === 'useVendorCount')).toBe(true);

      // Consumers
      expect(slot.consumers.some((c: any) => c.name === 'VendorList')).toBe(true);
      expect(slot.consumers.some((c: any) => c.name === 'VendorStats')).toBe(true);

      // Shape keys
      const patternsProducer = slot.producers.find((p: any) => p.name === 'useVendorPatterns');
      expect(patternsProducer.keys).toEqual(expect.arrayContaining(['patterns', 'total', 'page']));

      const countProducer = slot.producers.find((p: any) => p.name === 'useVendorCount');
      expect(countProducer.keys).toEqual(['total']);
    });
  });
}, {
  seed: STATE_SLOT_SEED_DATA,
  ftsIndexes: STATE_SLOT_FTS_INDEXES,
  poolAdapter: true,
  afterSetup: async (handle) => {
    vi.mocked(listRegisteredRepos).mockResolvedValue([{
      name: 'test-state-repo',
      path: '/test/state-repo',
      storagePath: handle.tmpHandle.dbPath,
      indexedAt: new Date().toISOString(),
      lastCommit: 'abc123',
      stats: { files: 5, nodes: 10, communities: 0, processes: 0 },
    }]);
    const backend = new LocalBackend();
    await backend.init();
    (handle as any)._backend = backend;
  },
});
```

- [ ] **Step 2: Run tests**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run test/integration/data-flow-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Break a fixture to verify test catches failures**

Temporarily change the seed to remove one producer (delete the `useVendorCount PRODUCES` edge). Re-run the test — it should fail on the "detects shape conflict" assertion. Then revert the change.

- [ ] **Step 4: Commit**

```bash
git add gitnexus/test/integration/data-flow-e2e.test.ts
git commit -m "test: add E2E tests for data_flow tool with shape conflict detection"
```

---

### Task 15: Run Full Test Suite and Fix Breakages

- [ ] **Step 1: Run the full test suite**

Run: `cd /private/tmp/gitnexus-data-shape-tracking/gitnexus && npx vitest run`
Expected: All existing tests pass + new tests pass. Watch for:
- Schema tests that assert on node/edge type counts
- Tests that iterate all NodeLabel or RelationshipType values

- [ ] **Step 2: Fix any count-based assertions**

Per memory (`auto_project_gitnexus-schema-count-test-assertions.md`), count-based test assertions break when adding node types. Find and update any tests asserting exact counts of node tables or relationship types.

- [ ] **Step 3: Commit fixes**

```bash
git add -A
git commit -m "fix: update count-based test assertions for new StateSlot/PRODUCES/CONSUMES types"
```

---

## Phase 2: TypeScript Type Pass + Route Chaining (Outline)

### Task 16: TypeScript Type Extractor
**Files:** Create `src/core/ingestion/ts-type-extractor.ts`
- Use TypeScript compiler API (`ts.createProgram`) to extract generic type arguments from `useQuery<T>` calls
- Resolve type aliases one level (e.g., `type VendorResponse = { patterns: VendorPattern[], total: number }` → keys `["patterns", "total"]`)
- Extract `as` assertions: `data as VendorPattern[]`
- Opt-in per repository via pipeline options (skip for non-TS repos)
- This produces `type-checked` confidence shapes

### Task 17: Route-to-Cache Chaining
**Files:** Modify `src/core/ingestion/state-slot-processor.ts`
- After creating StateSlot nodes, check if any producer's function has a FETCHES edge to a Route node
- If so, copy the Route's `responseKeys` as the StateSlot's produced keys
- Upgrades shape confidence from `heuristic` to `ast-literal` for those producers

### Task 18: Wrapper Hook Resolution (Phase 3.7.1)
**Files:** Modify `src/core/ingestion/state-slot-processor.ts`
- After state slots are created, trace CALLS edges backwards
- If function A calls function B, and B has a PRODUCES edge to a StateSlot, create an indirect PRODUCES edge from A to the same StateSlot
- Max depth: 2 levels
- This connects `useVendorPatterns()` wrapper to the underlying `useQuery` StateSlot

### Task 19: queryClient.setQueryData Detection
**Files:** Create `src/core/ingestion/state-slot-detectors/query-client.ts`
- Detect `queryClient.setQueryData(['key'], data)` and `queryClient.setQueriesData` patterns
- Extract the cache key from the first argument
- Create a PRODUCES edge (this is a programmatic cache mutation)

### Task 20: Extend shape_check with State Layer
**Files:** Modify `src/mcp/local/local-backend.ts`
- In `shapeCheck()`, after checking Route responseKeys vs FETCHES accessedKeys, also query StateSlot nodes
- For each StateSlot, compare PRODUCES keys vs CONSUMES accessedKeys
- Include state-layer mismatches in the output

### Task 21: Extend api_impact with State Layer
**Files:** Modify `src/mcp/local/local-backend.ts`
- In `apiImpact()`, add a "State Layer" section
- For each route's consumers, if the consumer function also has a PRODUCES edge to a StateSlot, show the StateSlot and downstream mismatches
- Include in risk assessment

### Task 22: Real-Repo Validation (fluentiagrant-app)
- Run the full pipeline on fluentiagrant-app
- Verify the original vendor-patterns cache key collision is detected
- Verify no false positives on unrelated hooks

---

## Phase 3: React Context + Redux/Zustand (Outline)

### Task 23: React Context Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/react-context.ts`
- Detect `createContext(defaultValue)` — extract shape from default value
- Detect `<Provider value={...}>` — extract shape from value prop
- Detect `useContext(SomeContext)` — track property accesses on the returned value
- SlotKind: `react-context`

### Task 24: Redux createSlice Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/redux.ts`
- Detect `createSlice({ name: '...', initialState: {...} })` — extract shape from initialState
- Detect `useSelector((state) => state.slice.field)` — extract accessed keys
- SlotKind: `redux`

### Task 25: Zustand Store Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/zustand.ts`
- Detect `create((set, get) => ({...}))` — extract shape from factory return
- Detect `useStore((state) => state.field)` — extract accessed keys
- SlotKind: `zustand`

### Task 26: Extend impact and context Tools
**Files:** Modify `src/mcp/local/local-backend.ts`
- In `_impactImpl()`: when BFS hits a function with a PRODUCES edge, follow through to CONSUMES consumers
- In `context()`: include PRODUCES/CONSUMES edges in the 360-degree view

### Task 27: Real-Repo Validation (Context/Redux/Zustand projects)
- Run on projects that use these patterns
- Verify detection and zero false positives on unrelated code

---

## Phase 4: Custom Hooks + GraphQL + tRPC (Outline)

### Task 28: Custom Hook Chain Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/custom-hook.ts`
- Detect hooks that wrap other hooks and reshape the return value
- Compare return shapes across CALLS edges
- SlotKind: `custom-hook`

### Task 29: GraphQL Query/Fragment Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/graphql.ts`
- Parse tagged template literals (`gql\`...\``) for field selections
- Parse `.graphql`/`.gql` files
- Match query names to consumer access patterns
- SlotKind: `graphql`

### Task 30: tRPC Procedure Detector
**Files:** Create `src/core/ingestion/state-slot-detectors/trpc.ts`
- Detect `trpc.router({ ... })` procedure definitions with input/output schemas
- Detect client-side `trpc.procedure.useQuery()` calls
- Cross-framework detection: tRPC → React Query cache
- SlotKind: `trpc`

### Task 31: Final Integration Testing
- Run on 6+ real projects
- Verify cross-framework detection (tRPC → React Query)
- Performance benchmarking on large repos

---

## Post-Implementation Process (After Each Phase)

1. Run `/simplify` on the branch
2. Real-repo validation (fluentiagrant-app, collector, etc.)
3. Squash duplicate commits
4. Audit PR body for private project references
5. Push to fork and create PRs
