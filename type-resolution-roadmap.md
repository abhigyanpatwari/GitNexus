# Type Resolution Roadmap

This roadmap describes the evolution of GitNexus's type-resolution layer from a receiver-disambiguation aid into a production-grade static-analysis foundation.

---

## Principles

- **stay conservative** — prefer missing a binding over introducing a misleading one
- **prefer explainable inference over clever but brittle inference**
- **limit performance overhead during ingestion**
- **keep per-language extractors explicit rather than over-generic**
- **separate "better receiver resolution" from "compiler-grade typing"**

The goal is not to build a compiler. The goal is to support high-value static analysis for call graphs, impact analysis, context gathering, and downstream graph features.

---

## Delivered Phases

### Phase 7: Cross-Scope and Return-Aware Propagation ✅

**Shipped in** `feat/phase7-type-resolution`.

- `ReturnTypeLookup` interface threading return-type knowledge into TypeEnv
- Iterable call-expression support across 7 languages (Go, TS, Python, Rust, Java, Kotlin, C#)
- PHP class-level `@var` property typing for `$this->property` foreach (Strategy C)
- `pendingCallResults` infrastructure (Tier 2b loop + `PendingAssignment` union) — activated by Phase 9

### Phase 8: Field and Property Type Resolution ✅

**Shipped in** `feat/phase8-field-property-type-resolution`.

- SymbolTable `fieldByOwner` index — O(1) field lookup by `ownerNodeId\0fieldName`
- `HAS_PROPERTY` edge type + `declaredType` on Property symbols
- Deep chain resolution up to 3 levels (`user.address.city.getName()`) across 10 languages
- Mixed field+method chains via unified `MixedChainStep[]` (`svc.getUser().address.save()`)
- Type-preserving stdlib passthroughs (`unwrap`, `clone`, `expect`, etc.)
- `ACCESSES` edge type — read/write field access tracking across 12 languages
- C++ `field_declaration` capture, `field_expression` receiver support
- Rust unit struct instantiation, Ruby YARD `@return` for `attr_accessor`

### Phase 9 + 9C: Return-Type-Aware Variable Binding ✅

**Shipped in** `feat/phase9-call-result-binding` (PR #379).

- Simple call-result binding: `const user = getUser(); user.save()` across 11 languages
- Unified fixpoint loop replacing sequential Tier 2b/2a — handles 4 binding kinds (`callResult`, `copy`, `fieldAccess`, `methodCallResult`) at arbitrary depth
- Field access binding: `const addr = user.address` resolves via `lookupFieldByOwner` + `declaredType`
- Method-call-result binding: `const city = addr.getCity()` resolves via `lookupFuzzyCallable` filtered by `ownerId`
- Fixpoint iterates until stable (max 10 iterations), enabling chains like `getUser() → .address → .getCity() → city.save()`
- Reverse-order copy chains now resolve (`const b = a; const a: User = x` → both resolve)

### Milestone D — Completeness ✅

**Shipped in** `feat/type-resolution-milestone-d` (PR #387). Consolidated original Phases 10–13 into 3 balanced phases.

#### Phase A: Fixpoint Completeness ✅

- Post-fixpoint for-loop replay (ex-9B): `pendingForLoops` collection + replay after fixpoint resolves iterable types
- Object destructuring via `fieldAccess` items (TS/JS `object_pattern`, Rust `struct_pattern`) — no new `destructure` PendingAssignment variant needed
- Extracted `resolveFixpointBindings()` helper with exhaustive switch + `classDefCache` memoization

#### Phase B: Inheritance & Receivers ✅

- `BuildTypeEnvOptions` interface replacing positional params for `buildTypeEnv`
- Heritage pre-pass constructing `parentMap` from tree-sitter query matches (not graph edges — heritage-processor runs in parallel)
- MRO-aware `walkParentChain()` (depth 5, cycle-safe BFS) for `resolveFieldType` and `resolveMethodReturnType`
- `this`/`self`/`$this`/`Me` receiver substitution via `substituteThisReceiver` hook
- Go `inc_statement`/`dec_statement` write-access queries

#### Phase C: Branch-Sensitive Narrowing ✅

- Null-check narrowing (`!= null`, `!== undefined`, `is not null`) via position-indexed `patternOverrides`
- Supported for TS, Kotlin, C# — renamed `PATTERN_BRANCH_TYPES` → `NARROWING_BRANCH_TYPES`
- Bug fix: Kotlin narrowing required 3 fixes in `jvm.ts` (AST node type `equality_expression`, anonymous `null` node, `nullable_type` parameter fallback)

#### Deferred from Milestone D

- **Type predicates (13A):** Cross-function analysis for niche TS `x is User` feature — deferred
- **Swift parity (11D):** tree-sitter-swift Node 22 issues — all Swift work consolidated to Phase S
- **Positional destructuring (12C):** Python/Kotlin/C#/C++ tuple-position-to-field mapping — deferred
- **Discriminated union narrowing (13C):** Needs tagged union metadata not in SymbolTable — deferred

#### Integration Test Coverage

17 fixture directories, 23 describe blocks, 705 lines of test code covering all 11 languages:
- Grandparent MRO (depth-2 C→B→A): TS, JS, Kotlin, C#, C++, Java, PHP, Python, Ruby
- Object destructuring: TS, JS
- Struct destructuring: Rust
- Post-fixpoint for-loop replay: TS, JS
- Go inc/dec write access
- Null-check narrowing: TS, C#, Kotlin

---

## Open Phases

### Phase P: Polymorphism & Overloading

**Plan:** `docs/plans/2026-03-19-feat-polymorphism-overloading-type-resolution-plan.md`

Four incremental phases:
1. **Parameter type metadata** — extend `SymbolDefinition` with `parameterTypes: string[]` extracted during parsing — **DELIVERED**
2. **Overload disambiguation** — filter overloaded methods by argument literal types at call sites — **DELIVERED** (Java, Kotlin, C#, C++, TypeScript)
3. **Constructor-visible virtual dispatch** — `Base b = new Derived(); b.method()` resolves to `Derived#method` when constructor type is a known subclass — **DELIVERED** (Java, C#, TS, C++, Kotlin via `detectConstructorType` hook, C++ smart pointers via `make_shared`/`make_unique`)
4. **Optional parameter arity resolution** — calls with omitted optional/default args now resolve via `requiredParameterCount` range check — **DELIVERED** (TS, Python, Kotlin, C#, C++, PHP, Ruby)
5. **Covariant return type awareness** — prefer child's return type over inherited definition

Languages benefiting: Java, Kotlin, C#, C++, TypeScript (overloading). All OOP languages (virtual dispatch).

**Impact: High | Effort: High** (P.1–P.4 delivered; P.5 covariant return types remains open)

---

### Phase S: Swift Parity

**Blocked on** tree-sitter-swift Node 22 compatibility.

- For-loop element binding (from Phase 10)
- Assignment chains: copy, callResult, fieldAccess, methodCallResult (from Phase 11D)
- `guard let` narrowing (from Phase 13B) — uses scopeEnv path, not `patternOverrides`

**Impact: Medium | Effort: Medium**

---

### Phase 14: Cross-File Binding Propagation ✅

**Shipped in** `feat/phase14-cross-file-binding-propagation`.

Three enrichment mechanisms:
- **E1:** `seedCrossFileReceiverTypes` — pre-seeds `receiverTypeName` for single-hop imported receivers (zero re-parse)
- **E2:** `ExportedTypeMap` seeded into `importedBindings` for re-resolution pass
- **E3:** `buildImportedReturnTypes` — cross-file return types for imported callables (local-first, SymbolTable takes precedence)

Architecture:
- Topological import ordering via Kahn's BFS (`topologicalLevelSort`, returns `{ levels, cycleCount }`)
- Cycle-safe: files in cycles grouped in final level, no cross-cycle propagation
- `runCrossFileBindingPropagation()` extracted as standalone pipeline phase
- `synthesizeWildcardImportBindings()` expands whole-module imports (Go/Ruby/C/C++/Swift) into per-symbol namedImportMap entries from graph-exported symbols — runs before Phase 14
- Worker path: `buildExportedTypeMapFromGraph` collects Tier 0 (annotated) exports only
- Sequential path: `collectExportedBindings` captures full fixpoint-inferred exports

**Per-language Phase 14 coverage:**
| Language | namedImportMap | ExportedTypeMap (E1/E2) | E3 (importedReturnTypes) | Benefit |
|----------|:-:|:-:|:-:|---|
| TypeScript | Full (named imports) | File-scope vars | Full | **High** |
| JavaScript | Full (named imports) | File-scope vars | Full | **High** |
| Python | from-imports | File-scope vars | Full | **High** |
| Kotlin | Top-level fns | Top-level props | Full | **High** |
| Rust | use clauses | Limited | Full | **High** |
| Go | Synthesized¹ | Exported symbols | Full | **Medium** |
| Ruby | Synthesized¹ | Exported symbols | Full | **Medium** |
| C/C++ | Synthesized¹ | Exported symbols | Full | **Medium** |
| Swift | Synthesized¹ | Exported symbols | Full | **Low** (Phase S blocked) |
| PHP | use classes | Inert (class-scope) | Inert (no fn imports) | **Marginal** |
| Java | Classes + static methods | Inert (no file-scope) | Via SymbolTable | **Medium** |
| C# | Alias + `using static` | Inert (no file-scope) | Via SymbolTable | **Medium** |

¹ Whole-module import languages: namedImportMap entries synthesized from graph-exported symbols via `synthesizeWildcardImportBindings()` (capped at 1000 per file)

**Named binding extraction details:**
- Java: `import static X.Y.method` now captured (static modifier detection). Ambiguous static imports (same method from multiple classes) fall through to Tier 2a for arity narrowing.
- C#: `using static NS.Type;` now captured (last segment as class binding). Non-alias `using NS;` remains unsupported (namespace import requires type inference).

**Resolved limitations (this PR):**
- ~~Worker path vs sequential path quality split~~ — workers now return file-scope TypeEnv bindings; main thread merges fixpoint-inferred exports into ExportedTypeMap (filtered by graph `isExported`)
- ~~`lookupRawReturnType` no cross-file fallback~~ — separate `importedRawReturnTypes` map stores raw declared types (e.g., `User[]`) for for-loop element extraction via `extractElementTypeFromString`
- ~~C++ header method declarations~~ — tree-sitter query fix: `field_identifier` added to declaration pattern alongside `identifier`, plus pointer/reference return type variants

**Impact: High | Effort: High** — delivered

---

## Dependency Graph

```
Milestone D (Phases A, B, C) ✅ ──┐
                                   ├──→ Phase 14 (cross-file) ✅
Phase P (polymorphism) ───────────┤
                                   │
Phase S (Swift parity) ───────────┘

Phase P.1–P.4 are delivered. P.5 (covariant return types) remains open.
Phase P and Phase S are independent of each other and Phase 14.
Phase 14 is delivered. Remaining open: Phase P.5, Phase S.
```

---

## Language-Specific Gaps (remaining)

### Swift
- For-loop element binding → Phase S
- Assignment chains (copy, callResult, fieldAccess, methodCallResult) → Phase S
- `guard let` narrowing → Phase S

### Kotlin
- ~~Virtual dispatch: `Dog()` uses `call_expression` (no `new` keyword)~~ — **RESOLVED** via `detectConstructorType` hook

### All languages
- ~~Cross-file binding propagation → Phase 14~~ — **DELIVERED** for all 13 languages via two mechanisms: (1) named import extraction (TS/JS/Python/Kotlin/Rust/PHP/Java/C#), (2) wildcard import synthesis from graph-exported symbols (Go/Ruby/C/C++/Swift). Remaining gap: C# non-alias `using NS;` (namespace import, requires type inference).

---

## Milestones

### Milestone A — Inference Expansion ✅ (Phase 7)

Loop inference, `ReturnTypeLookup`, PHP Strategy C.

### Milestone B — Structural Member Typing ✅ (Phase 8)

Field/property maps, deep chains, mixed chains, stdlib passthroughs.

### Milestone C — Static-Analysis Foundation ✅ (Phase 9 + 9C)

Unified fixpoint loop, call-result binding, field access binding, method-call-result binding, arbitrary-depth chain propagation.

### Milestone D — Completeness ✅ (Phases A, B, C)

Consolidated Phases 10–13 into 3 balanced phases. Loop-fixpoint bridge, MRO-aware inheritance walking, `this`/`self` resolution, object/struct destructuring, null-check narrowing. Kotlin null-check bug fix. Full 11-language integration test coverage.

### Milestone E — Cross-Boundary ✅ (Phase 14)

Export-type index, cross-file binding propagation. Full coverage for TS/JS/Python/Kotlin. Marginal for PHP. Inert for Java/C#/Go/Ruby/C/C++ (relies on Phase 9 SymbolTable).

### Milestone P — Polymorphism & Overloading (Phase P)

Parameter type metadata, overload disambiguation, constructor-visible virtual dispatch (including Kotlin `detectConstructorType` and C++ smart pointer factories), optional parameter arity resolution, covariant return types (open).

### Milestone S — Swift Parity (Phase S)

For-loop binding, assignment chains, `guard let` narrowing. Blocked on tree-sitter-swift Node 22.

---

## Open Design Questions

| # | Question | Status |
|---|----------|--------|
| 1 | Where should field-type metadata live? | ✅ Resolved: `fieldByOwner` index in SymbolTable |
| 2 | How should ambiguity be represented? | ✅ Resolved: keep `undefined`. Conservative approach proven through 9 phases. |
| 3 | How much receiver context for return types? | ✅ Resolved: Phase 9C `resolveMethodReturnType` filters by `ownerId`. |
| 4 | How much branch sensitivity? | ✅ Resolved: type predicates + null checks only. No control-flow graph. (Phase 13) |
| 5 | Field typing and chain typing — one phase or two? | ✅ Resolved: incremental delivery within phases (Phase 8/8A precedent). |
| 6 | Phase 9B vs Phase 10? | ✅ Resolved: Phase 10 supersedes 9B via post-fixpoint replay. |

---

## What "Production-Grade" Means Here

For GitNexus, production-grade does **not** mean replacing a language compiler. The target:

- Strong receiver-constrained call resolution across common language idioms
- Reliable handling of typed loops, constructors, and common patterns
- Return-type propagation for service/repository code
- Field/property knowledge for chained-member analysis
- Inheritance-aware lookups
- Conservative behavior under ambiguity
- Predictable performance during indexing

That supports: better call graphs, more accurate impact analysis, stronger AI context assembly, more trustworthy graph traversal.

---

## Summary

**Complete:** Phases 7, 8, 9, 9C, Milestone D (A, B, C) — explicit types, constructor inference, loop inference, field/property resolution, deep chains, mixed chains, stdlib passthroughs, comment-based types, unified fixpoint with 4 binding kinds, arbitrary-depth chain propagation, MRO-aware inheritance walking, this/self resolution, object/struct destructuring, null-check narrowing — across 11 languages with full integration test coverage.

**Next:** Phase 14 (cross-file binding propagation) — the architectural capstone. Phase S (Swift parity) is independent and unblocked once tree-sitter-swift Node 22 is resolved.
