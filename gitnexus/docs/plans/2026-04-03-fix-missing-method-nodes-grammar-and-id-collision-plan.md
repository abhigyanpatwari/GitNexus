---
title: "fix: Missing method nodes — Rust grammar gap + systemic ID collision"
type: fix
status: active
date: 2026-04-03
deepened: 2026-04-03
---

# fix: Missing method nodes — Rust grammar gap + systemic ID collision

## Enhancement Summary

**Deepened on:** 2026-04-03
**Sections enhanced:** 6
**Research agents used:** CALLS resolution explorer, worker path explorer, architecture strategist, performance oracle

### Key Improvements
1. Identified the ONLY breaking code path: `extractFuncNameFromSourceId()` in `call-processor.ts:1245` uses `lastIndexOf(':')` — must be updated
2. Confirmed symbol table name keys must stay bare (not qualified) — resolution depends on this
3. Architecture review recommends returning `{ classId, className }` from `findEnclosingClassId` instead of parsing the ID string
4. Performance review confirms zero measurable overhead

### New Considerations Discovered
- Constructor nodes also collide (e.g., multiple `init` constructors in Swift same-file classes)
- `pipeline.ts` hardcodes ID construction (`Function:${filePath}:${name}`) — must be updated too
- Nested classes: only the immediate enclosing class is used (acceptable)

---

## Overview

Two distinct bugs cause method nodes to be silently absent from the knowledge graph:

1. **Rust grammar gap**: Abstract trait methods (`function_signature_item`) have no tree-sitter query capture, so they never become graph nodes.
2. **Systemic ID collision**: When two methods share the same name and file (e.g., `Animal.speak()` and `Dog.speak()` in `animal.dart`), `generateId('Method', 'filepath:name')` produces identical IDs. `addNode` silently drops the second one.

Both bugs were hidden by `if (prop !== undefined)` test guards that silently passed when nodes were missing.

## Problem Statement

### Rust: `function_signature_item` not captured

Rust traits define abstract methods as `function_signature_item` nodes:
```rust
trait Animal {
    fn speak(&self) -> String;  // function_signature_item — NOT captured
    fn breathe(&self) -> bool { true }  // function_item — captured
}
```

The tree-sitter queries only have `(function_item name: (identifier) @name) @definition.function`. No query exists for `function_signature_item`. The method extractor config already handles it (`methodNodeTypes: ['function_item', 'function_signature_item']`), but enrichment can't run because no graph node exists.

### All languages: node ID collision for same-name methods

```typescript
// src/lib/utils.ts
export const generateId = (label: string, name: string): string => `${label}:${name}`;

// parsing-processor.ts line 372
const nodeId = generateId(nodeLabel, `${file.path}:${nodeName}`);
```

This produces `Method:animal.dart:speak` for BOTH `Animal.speak()` and `Dog.speak()` in the same file. The graph's `addNode` silently drops the second:
```typescript
if (!nodeMap.has(node.id)) { nodeMap.set(node.id, node); }
```

**Impact**: Any file with same-name methods in different classes loses all but the first. This affects inheritance hierarchies, interface implementations, and overrides across ALL languages.

### Research Insights

**Confirmed safe components (no changes needed):**
- `symbol-table.ts` — keyed by bare name, returns complete nodeId. No parsing of IDs.
- `resolution-context.ts` — lookups use bare names, returns `SymbolDefinition` with full nodeId.
- `call-processor.ts` CALLS resolution — matches by name + ownerId, targets `resolved.nodeId`. Unaffected.
- `graph.ts` — stores nodeId as opaque strings. No parsing.
- Heritage processing — resolves class/interface IDs, not method IDs.

**Confirmed breaking code:**
- `call-processor.ts:1245-1249` — `extractFuncNameFromSourceId()` uses `lastIndexOf(':')` to extract function name. With `Method:file:Class.name`, it returns `Class.name` instead of `name`. Used at 5 call sites (lines 1519, 1554, 1668, 1773, and one more).
- `pipeline.ts` — hardcodes `Function:${filePath}:${name}` for route/endpoint nodes. Must use qualified format when inside a class.

## Proposed Solution

### Phase 1: Rust grammar fix (low risk, isolated)

Add the missing `function_signature_item` query to `RUST_QUERIES`:

```
; Abstract trait method signatures (no body)
(function_signature_item name: (identifier) @name) @definition.function
```

**File**: `src/core/ingestion/tree-sitter-queries.ts`, Rust section (~line 636)

**Note**: After Phase 2, Rust trait abstract methods and their concrete implementations in the same file (e.g., `fn speak` in both `trait Animal` and `impl Animal for Dog`) will get distinct IDs. Before Phase 2, the second one will be silently dropped by `addNode` (same collision bug). Phase 1 is still valuable as groundwork.

### Phase 2: ID collision fix (higher impact, requires careful rollout)

Incorporate the enclosing class name into node IDs for Method/Function/Constructor nodes that have an enclosing class.

**Current**: `Method:animal.dart:speak`
**Proposed**: `Method:animal.dart:Animal.speak` and `Method:animal.dart:Dog.speak`

#### Step 2a: Modify `findEnclosingClassId` to return richer result

Instead of parsing the class name from the returned ID string, modify `findEnclosingClassId` to return both:

```typescript
// ast-helpers.ts
interface EnclosingClassInfo {
  classId: string;    // "Class:animal.dart:Animal"
  className: string;  // "Animal"
}

export const findEnclosingClassId = (
  node: SyntaxNode,
  filePath: string,
): EnclosingClassInfo | null => {
  // ... existing parent walk logic ...
  // Return both the ID and the name when found
  return { classId: generateId(label, `${filePath}:${nameNode.text}`), className: nameNode.text };
};
```

**Backward compat**: Callers that only need `classId` destructure it. The name is available without string parsing.

#### Step 2b: Reorder and qualify IDs in both parsing paths

**Sequential path** (`parsing-processor.ts`):
```typescript
// Compute enclosing class FIRST (moved up)
const enclosingInfo = needsOwner
  ? cachedFindEnclosingClassId(nameNode || definitionNodeForRange, file.path)
  : null;

// Generate qualified node ID
const qualifiedName = enclosingInfo
  ? `${enclosingInfo.className}.${nodeName}`
  : nodeName;
const nodeId = generateId(nodeLabel, `${file.path}:${qualifiedName}`);

// Use enclosingInfo.classId for HAS_METHOD edges and ownerId
const enclosingClassId = enclosingInfo?.classId ?? null;
```

**Worker path** (`parse-worker.ts`): Same change at line 1722.

#### Step 2c: Fix `extractFuncNameFromSourceId`

```typescript
// call-processor.ts — BEFORE (BREAKS with Class.method format)
const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  return lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
};

// AFTER — extract bare method name, stripping any Class. prefix
const extractFuncNameFromSourceId = (sourceId: string): string => {
  const lastColon = sourceId.lastIndexOf(':');
  const segment = lastColon >= 0 ? sourceId.slice(lastColon + 1) : '';
  const dotIdx = segment.lastIndexOf('.');
  return dotIdx >= 0 ? segment.slice(dotIdx + 1) : segment;
};
```

#### Step 2d: Update symbol table `name` key

**CRITICAL: The symbol table `name` key MUST remain the bare identifier.** Resolution callers pass bare call-site names (e.g., `speak` from `dog.speak()`). If the key becomes `Dog.speak`, resolution breaks.

```typescript
// CORRECT — bare name as key, qualified nodeId as value
symbolTable.add(file.path, nodeName, nodeId, nodeLabel, { ... });
//                          ^^^^^^^^ bare   ^^^^^^ qualified
```

**Files to modify**:
- `src/core/ingestion/utils/ast-helpers.ts` — return `EnclosingClassInfo` from `findEnclosingClassId`
- `src/core/ingestion/parsing-processor.ts` — reorder + qualify ID
- `src/core/ingestion/workers/parse-worker.ts` — same reorder + qualify
- `src/core/ingestion/call-processor.ts:1245` — fix `extractFuncNameFromSourceId`
- `src/core/ingestion/pipeline.ts` — fix hardcoded `Function:${filePath}:${name}` patterns

**No changes needed**:
- `src/lib/utils.ts` (`generateId`) — stays as-is
- `src/core/ingestion/symbol-table.ts` — keys stay bare
- `src/core/ingestion/resolution-context.ts` — uses bare names
- `src/core/graph/graph.ts` — ID-agnostic
- Heritage/IMPLEMENTS/EXTENDS — resolves class IDs, not method IDs

### Phase 2 risk mitigation

1. **Only qualify Method/Function/Constructor/Property nodes that have an enclosing class.** Top-level functions keep their current format (`Function:main.rs:main`).
2. **Return `{ classId, className }` from `findEnclosingClassId`** — avoids fragile string parsing.
3. **Run the full 5000+ test suite** after each sub-step to catch regressions immediately.
4. **Share ID qualification logic** via a helper used by both parsing paths:
```typescript
function qualifyNodeId(label: string, filePath: string, name: string, enclosingClassName?: string): string {
  const qualified = enclosingClassName ? `${enclosingClassName}.${name}` : name;
  return generateId(label, `${filePath}:${qualified}`);
}
```

## Technical Considerations

- **Performance**: Zero concern. `findEnclosingClassId` is already cached per-file per-node. Moving it earlier adds no extra cost. Additional `split('.')` operations are negligible even at 500k+ nodes.
- **Worker path parity**: Both `parsing-processor.ts` and `parse-worker.ts` must use the shared `qualifyNodeId` helper. The worker already computes `enclosingClassId` — just needs reordering.
- **Backward compatibility**: Indexed repositories will have stale IDs. Re-indexing is cheap and expected.
- **Graph consumers**: MCP tools and wiki generator query by label + name properties, not by raw ID. Unaffected.
- **Constructor collision**: Multiple `init` constructors in different Swift classes in the same file also collide today. The qualification fix resolves this too: `Constructor:file.swift:Animal.init` vs `Constructor:file.swift:Dog.init`.

### Research Insights — Architecture

**The blast radius is smaller than initially estimated.** Deep analysis of all ID construction, parsing, and matching sites shows only 2 code paths that break:

1. `extractFuncNameFromSourceId()` — uses `lastIndexOf(':')`, trivial to fix
2. `pipeline.ts` hardcoded ID construction — needs qualification when inside classes

All other components (symbol table, resolution, graph storage, edge construction, label extraction) treat node IDs as opaque strings and are unaffected.

**No simpler alternative exists.** Line-number-based IDs (e.g., `Method:file:speak:42`) are fragile across edits. The class-qualified approach is the standard solution and matches how `findEnclosingClassId` already works for owner IDs.

### Research Insights — Performance

Confirmed by performance analysis: zero measurable overhead on any repository size. The string operations are trivial compared to tree-sitter parsing, AST query matching, and method extraction.

## System-Wide Impact

### Interaction Graph
- `generateId` is called in both parsing paths + `findEnclosingClassId` + symbol table + CALLS resolution
- HAS_METHOD edges use `enclosingClassId` as source — these IDs are for CLASS nodes, not method nodes, so they are unaffected by the method ID format change
- CALLS edges use `resolved.nodeId` as target — automatically gets the new qualified format from symbol table

### Error Propagation
- Silent: `addNode` drops duplicates without warning. Consider adding a debug-level log for dropped nodes.

### State Lifecycle Risks
- Re-indexing required after ID format change. Stale graph caches won't match new IDs.

### API Surface Parity
- Both `parse-worker.ts` and `parsing-processor.ts` must produce identical IDs for the same input.
- Use the shared `qualifyNodeId` helper to guarantee this.

### Integration Test Scenarios
- Same-name methods in different classes in the same file (Dart, Swift, Rust)
- Trait method + impl method in the same file (Rust — depends on Phase 1 first)
- Protocol method + class method in the same file (Swift)
- Abstract class method + concrete subclass override in the same file (Dart, Python, Java)
- Top-level functions (no enclosing class) — ID format must NOT change
- Constructor disambiguation — multiple `init` methods in different classes
- Nested classes — only immediate enclosing class used (e.g., `Inner.method`, not `Outer.Inner.method`)

## Acceptance Criteria

### Phase 1 (Rust grammar)
- [ ] `function_signature_item` query added to `RUST_QUERIES` in `tree-sitter-queries.ts`
- [ ] Abstract trait methods appear as `Function` nodes in the graph with `isAbstract: true`
- [ ] Integration test: Rust `rust-method-enrichment` fixture verifies abstract trait method nodes exist
- [ ] Integration test: HAS_METHOD edges from Trait → abstract methods are present
- [ ] All 5000+ existing tests pass

### Phase 2 (ID collision)
- [ ] `findEnclosingClassId` returns `{ classId, className }` instead of bare string
- [ ] `qualifyNodeId` shared helper created and used by both parsing paths
- [ ] Method/Function/Constructor nodes inside classes use qualified IDs (`Method:file:Class.method`)
- [ ] Top-level functions keep unqualified IDs (`Function:file:name`)
- [ ] Same-name methods in different classes in the same file both appear as distinct graph nodes
- [ ] `extractFuncNameFromSourceId` updated to handle `Class.method` format
- [ ] `pipeline.ts` hardcoded ID patterns updated
- [ ] Symbol table name keys remain bare identifiers (NOT qualified)
- [ ] HAS_METHOD edge source IDs unchanged (they use class IDs, not method IDs)
- [ ] CALLS resolution still works (bare-name lookup → qualified nodeId in results)
- [ ] Both parsing paths (sequential + worker) produce identical IDs via shared helper
- [ ] Dart: `Dog.speak()` and `Animal.speak()` both exist as distinct Method nodes
- [ ] Swift: Protocol methods and class methods both exist
- [ ] Constructor disambiguation works (e.g., `Animal.init` vs `Dog.init`)
- [ ] All 5000+ existing tests pass (test ID assertion updates expected)

## Dependencies & Risks

| Risk | Severity | Mitigation | Research Status |
|------|----------|------------|-----------------|
| `extractFuncNameFromSourceId` breaks | 🔴 High | Add `.lastIndexOf('.')` strip after `:` extraction | **Confirmed — only breaking code path** |
| `pipeline.ts` hardcoded IDs break | 🟡 Medium | Update to use `qualifyNodeId` helper | **Confirmed — needs update** |
| CALLS resolution breaks | 🟢 Low | Symbol table keyed by bare name; resolution unaffected | **Confirmed safe** |
| HAS_METHOD edges break | 🟢 Low | Edge sourceId is class ID, targetId is method nodeId — both computed consistently | **Confirmed safe** |
| Large test diff | 🟡 Medium | Most tests use `getNodesByLabel` (queries by name property, not ID) | **Confirmed — limited impact** |
| Worker/sequential ID divergence | 🔴 High | Shared `qualifyNodeId` helper eliminates divergence | Mitigated by design |

## Sources & References

### Internal References
- ID generation: `src/lib/utils.ts:generateId`
- Sequential path: `src/core/ingestion/parsing-processor.ts:372` (nodeId), `:480` (enclosingClassId)
- Worker path: `src/core/ingestion/workers/parse-worker.ts:1722` (nodeId), `:1942` (enclosingClassId)
- **Breaking code**: `src/core/ingestion/call-processor.ts:1245-1249` (`extractFuncNameFromSourceId`)
- **Breaking code**: `src/core/ingestion/pipeline.ts` (hardcoded `Function:${filePath}:${name}`)
- Graph addNode: `src/core/graph/graph.ts:9`
- Rust queries: `src/core/ingestion/tree-sitter-queries.ts:636`
- Rust method extractor: `src/core/ingestion/method-extractors/configs/rust.ts:154`
- Label extraction (safe): `src/server/api.ts:571`, `src/core/lbug/lbug-adapter.ts:212`, `src/core/embeddings/embedding-pipeline.ts:361`, `src/mcp/local/local-backend.ts:829`

### Prior art
- TypeScript abstract class fix: commit `6c8a162` (added `abstract_class_declaration` query)
- Rust impl-for-Struct owner resolution: commit `1ba65e3`
