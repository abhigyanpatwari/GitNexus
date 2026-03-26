# Data-Shape Tracking for GitNexus

**Date:** 2026-03-26
**Status:** Approved
**Approach:** Layered Hybrid (AST base + optional TS type pass)

## Problem

GitNexus tracks symbol call graphs but has no visibility into runtime data shapes. Two hooks sharing a React Query cache key like `['vendor-patterns', slug]` appear as independent functions in the graph — GitNexus cannot detect that one stores `{total: 42}` while the other expects `VendorPattern[]` from the same cache slot. This class of bug is runtime-only, produces no type errors, and is extremely hard to find manually.

## Scope

Full end-to-end data-flow shape tracking: API response → cache/store → consumer component, detecting mismatches at any boundary.

### Framework Coverage (all phases)

| # | Framework/Pattern | Phase |
|---|-------------------|-------|
| 1 | React Query / TanStack Query | 1 |
| 2 | SWR | 1 |
| 3 | API route responses (existing, extended) | 2 |
| 4 | Fetch/axios consumers (existing, chained) | 2 |
| 5 | React Context | 3 |
| 6 | Redux / Zustand | 3 |
| 7 | Custom hook chains | 4 |
| 8 | GraphQL query/fragment shapes | 4 |
| 9 | tRPC procedure input/output | 4 |

## Graph Model

### New Node: `StateSlot`

Represents any shared intermediate state that has producers and consumers.

| Property | Type | Description |
|----------|------|-------------|
| `name` | string | Human-readable identifier (e.g., `['vendor-patterns', slug]`, `VendorContext`, `store.auth`) |
| `slotKind` | enum | `react-query` \| `swr` \| `react-context` \| `redux` \| `zustand` \| `trpc` \| `graphql` \| `custom-hook` |
| `cacheKey` | string? | Literal or pattern of the cache/state key |
| `filePath` | string | File where the slot is first defined/configured |

### New Edge: `PRODUCES` (Function/Method → StateSlot)

| Property | Type | Description |
|----------|------|-------------|
| `keys` | string[] | Top-level keys this producer writes |
| `confidence` | enum | `type-checked` \| `ast-literal` \| `heuristic` |
| `sourceType` | string? | Raw TS type annotation if available |

### New Edge: `CONSUMES` (Function/Method → StateSlot)

| Property | Type | Description |
|----------|------|-------------|
| `accessedKeys` | string[] | Properties this consumer reads |
| `confidence` | enum | `type-checked` \| `ast-literal` \| `heuristic` |

### Mismatch Detection

A mismatch exists when a StateSlot has PRODUCES edges with different `keys`, or when a CONSUMES edge's `accessedKeys` references keys not present in any PRODUCES edge. Queryable in one Cypher hop — no extra joins needed.

## Detection Pipeline

### Phase 3.7: State Slot Detection (new)

Runs per-file after route detection (3.5) and tool detection (3.6). Each detector is a standalone exported function returning `ExtractedStateSlot[]`.

| Detector | What it finds | How |
|----------|--------------|-----|
| `react-query` | `useQuery`, `useMutation`, `useInfiniteQuery`, `useSuspenseQuery` | AST: match call expression, extract `queryKey` array literal, extract `queryFn` reference |
| `swr` | `useSWR`, `useSWRMutation` | AST: first argument is cache key (string or array) |
| `react-context` | `createContext()` → `useContext()` | AST: track default value shape, Provider value prop shape, useContext access patterns |
| `queryClient-mutations` | `queryClient.setQueryData`, `setQueriesData`, `invalidateQueries` | AST: member call on queryClient, extract first arg as cache key |
| `redux` | `createSlice` → `useSelector` | AST: slice initialState shape → selector return access patterns |
| `zustand` | `create()` store → `useStore(selector)` | AST: store factory shape → selector access patterns |
| `custom-hook-chain` | Hook A returns shape, Hook B wraps A and reshapes | Depends on Phase 3.7.1 wrapper resolution; compare return shapes across CALLS edges |
| `trpc` | `trpc.router` → `trpc.procedure.useQuery` | AST: router input/output schemas → client-side access |
| `graphql` | Query/fragment field selections | AST: parse tagged template literals or .gql files for field names |

### Phase 3.7.1: Wrapper Hook Resolution (new)

After state slots are extracted, trace through wrapper hooks:
- If `useVendorPatterns(slug)` has a CALLS edge to a function containing `useQuery({queryKey: ...})`, propagate the cache key up to the wrapper
- Max depth: 2 levels (wrapper → wrapper → actual query call)
- Connects consumers of wrapper hooks to the underlying StateSlot

### Phase 3.8: Shape Inference (new)

Two layers with tiered confidence:

**AST layer (all languages):**
- Object literal keys in return statements / queryFn bodies
- Destructuring patterns at consumer sites
- Property access chains (`.data.patterns`, `.total`)
- Prefix-match cache keys — flag shared prefixes even if full keys differ

**TS type layer (opt-in, TypeScript only):**
- Generic type arguments: `useQuery<VendorPattern[]>` → shape is `VendorPattern[]`
- Type alias resolution (one level): `type VendorResponse = { patterns: VendorPattern[], total: number }` → keys `["patterns", "total"]`
- `as` assertions: `data as VendorPattern[]`

Confidence tiers: `type-checked` > `ast-literal` > `heuristic`

### Phase 3.8.1: Route-to-Cache Chaining (new)

If a queryFn contains a fetch() that already has a FETCHES edge to a Route node, the Route's `responseKeys` become the StateSlot's produced shape. Reuses existing infrastructure — just wiring data through new StateSlot nodes.

### Detection Boosters

These techniques maximize catch rate beyond basic detection:

1. **Prefix-match cache keys** — two hooks with `['vendor-patterns', slug]` and `['vendor-patterns', id]` share static prefix `'vendor-patterns'`. Flag as potential collision even if variable portions differ.
2. **Wrapper hook tracing** — follow CALLS edges through custom hooks to find underlying cache keys (2 levels max).
3. **queryClient.setQueryData tracking** — detect programmatic cache mutations as PRODUCES edges.
4. **Route-to-cache chaining** — reuse existing Route responseKeys as produced shapes when queryFn fetches a known route.
5. **Suspicious flagging** — same cache key prefix + different access patterns = `suspicious` verdict even at heuristic confidence. Don't require proof of mismatch.
6. **Context default + Provider tracking** — both createContext default value and Provider value prop are AST-visible shape sources.

### Estimated Detection Rate

| Codebase type | Estimate |
|--------------|----------|
| Well-typed TypeScript | ~80-85% |
| Loosely-typed JavaScript | ~50-55% |

### Known Limitations

- **Dynamic cache keys built programmatically** (e.g., `getQueryKey('vendor', slug)`) — cannot resolve function return to literal
- **Shapes hidden behind deep call chains** (3+ levels) — AST sees function reference, not eventual shape
- **Runtime-conditional shapes** — static analysis cannot model server-side branching
- **Unbound generics** (`useQuery<T>` where T is a type parameter) — cannot resolve without call-site context
- **queryClient mutations across distant files** — requires cross-file queryClient instance tracking (v2 target)

### Integration with Existing Pipeline Phases

| Existing phase | Change |
|---|---|
| Phase 3 (parse worker) | Add tree-sitter queries for useQuery, useSWR, createContext, queryClient.*, createSlice, create() store patterns |
| Phase 3.5 (route registry) | No change — Route nodes stay as-is |
| Phase 6 (processes) | StateSlot nodes connected to execution flows via producer/consumer functions |

## MCP Tool Layer

### New Tool: `data_flow`

Full picture of data flow through state slots with mismatch detection.

**Input:**
| Param | Type | Description |
|-------|------|-------------|
| `slug` | string | Repository slug |
| `query` | string? | Filter by cache key, context name, or slice name |
| `slotKind` | string? | Filter by kind (react-query, redux, etc.) |
| `mismatchesOnly` | bool? | Only show slots with shape conflicts (default: false) |

**Output per StateSlot:**
- Cache key / state identifier
- Producers: function name, file, shape keys, confidence
- Consumers: function name, file, accessed keys, confidence
- Mismatch verdict: `ok` | `suspicious` | `conflict` with explanation
- Linked execution flows (via producer/consumer STEP_IN_PROCESS edges)

### Extensions to Existing Tools

| Tool | Change |
|------|--------|
| `shape_check` | Add StateSlot PRODUCES vs CONSUMES comparison. If a Route feeds into a queryFn → StateSlot, trace the full chain. |
| `api_impact` | Add "State Layer" section: for each route's consumers, if consumer is a queryFn, show the StateSlot and downstream mismatches. Include in risk assessment. |
| `impact` | When BFS hits a function with PRODUCES edge, follow through to all CONSUMES consumers as additional impact targets. |
| `context` | Include PRODUCES/CONSUMES edges to StateSlots in 360-degree view alongside CALLS/IMPORTS. |

### Example Output

```
data_flow --slug fluentiagrant-app --mismatchesOnly true

StateSlot: react-query ['vendor-patterns', slug]
  Producers:
    useVendorPatterns()     → keys: [patterns, total, page]  (ast-literal)
    useVendorPatternCount() → keys: [total]                  (ast-literal)
  Consumers:
    VendorList component    → accesses: [patterns, page]     (heuristic)
    VendorStats component   → accesses: [total]              (heuristic)

  ⚠ CONFLICT: Two producers write different shapes to same cache key.
    useVendorPatterns returns {patterns, total, page}
    useVendorPatternCount returns {total}
    Risk: Consumer expecting array gets object, or vice versa.
```

## Implementation Phases

### Phase 1 — Foundation
- StateSlot node type: graph types, LadybugDB schema, CSV generator
- PRODUCES and CONSUMES relationship types
- React Query + SWR detectors (items 1-2)
- Prefix-match cache key comparison
- AST shape inference (object literals, destructuring, property access)
- Basic `data_flow` MCP tool
- Seed-based test fixtures for cache key collision scenarios

### Phase 2 — TypeScript Type Pass + Route Chaining
- Optional TS compiler API integration for generic type extraction
- Route-to-cache chaining (connect existing FETCHES → StateSlot)
- Wrapper hook resolution (trace through 2 levels)
- queryClient.setQueryData detection
- Extend `shape_check` and `api_impact` with state layer
- Real-repo validation: fluentiagrant-app

### Phase 3 — React Context + Redux/Zustand (items 5-6)
- createContext → Provider → useContext detection
- Redux createSlice → useSelector detection
- Zustand store → selector detection
- Extend `impact` and `context` tools
- Real-repo validation on projects using these patterns

### Phase 4 — Custom Hooks + GraphQL + tRPC (items 7-9)
- Custom hook chain shape tracking
- GraphQL query/fragment field extraction
- tRPC procedure input/output tracking
- Cross-framework detection (e.g., tRPC response → React Query cache)

## Testing Strategy

### Seed-Based Tests (per detector)
- Fixture files with known cache key collisions → assert StateSlot created, edges exist, mismatch detected
- Fixture files with NO collision → assert no false positive
- Break a fixture to confirm test catches the change

### Pipeline-Level Tests
- Full pipeline on synthetic mini-project with React Query, Context, Redux patterns
- Assert node/edge counts and mismatch verdicts

### Real-Repo Validation
- fluentiagrant-app (React Query — original bug)
- collector (PHP — no state slots expected, verify zero false positives)
- kurz-spj-sk (Next.js — likely React Query patterns)
- At least 6 projects total

### MCP Tool Smoke Tests
- After each tool change, invoke via MCP and verify output format

## Post-Implementation Process (every phase)

1. Run /simplify on the branch
2. Real-repo validation (fluentiagrant-app, collector, etc.)
3. Squash duplicate commits
4. Audit PR body for private project references
5. Push to fork and create PRs
