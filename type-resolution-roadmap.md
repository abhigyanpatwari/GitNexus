# Type Resolution Roadmap

This roadmap describes the next major capabilities needed to evolve GitNexus's type-resolution layer from a strong receiver-disambiguation aid into a broader static-analysis foundation.

The roadmap assumes the current system already provides:

- explicit type extraction from declarations and parameters
- initializer / constructor inference
- loop element inference for many languages
- selected pattern binding and narrowing
- comment-based fallbacks in JS/TS, PHP, and Ruby
- constrained return-type-aware receiver inference during call processing

The remaining work is about **generalisation**, **deeper structure modelling**, and **better propagation**.

---

## Principles for Future Work

The type system should continue to preserve the qualities that make it practical today:

- **stay conservative**
- **prefer explainable inference over clever but brittle inference**
- **limit performance overhead during ingestion**
- **keep per-language extractors explicit rather than over-generic**
- **separate "better receiver resolution" from "compiler-grade typing"**

The goal is not to build a compiler. The goal is to support high-value static analysis for call graphs, impact analysis, context gathering, and downstream graph features.

---

## Near-Term Priority: Generalise Existing Inference

The next biggest gain is not inventing a new type system layer. It is expanding the inference the system already performs so more constructs can benefit from it.

### Why this is the right next step

Today, return-type-aware inference already exists in constrained form inside `call-processor.ts`, and loop element inference already handles many identifier-based iterables.

The most valuable next move is to let those signals participate in more places, especially:

- iterable expressions rather than only iterable identifiers
- assignment propagation from call results
- doc-comment-derived file-scope bindings where local scope is insufficient

---

## Phase 7: Cross-Scope and Return-Aware Propagation

> **Status: COMPLETE** — shipped in `feat/phase7-type-resolution` (commits `ed767e3`, `ca4c6c1`, `d79237e`).

### Goal

Allow loop inference and assignment inference to see more than the current function-local environment.

### Problems this phase addresses

#### 7A. Iterable expressions in Go and similar cases (shipped as Phase 7.3)

```go
for _, user := range getUsers() {
    user.Save()
}
```

The iterable is a call expression, not an identifier with a local binding.

Resolved: `ReturnTypeLookup` introduced in Phase 7.1 exposes `lookupRawReturnType`. All seven typed-iteration languages (Go, TypeScript, Python, Rust, Java, Kotlin, C#) now unwrap the raw container type string to extract the element type when the iterable is a direct function call.

#### 7B. File-scope or class-scope iterable typing in PHP (shipped as Phase 7.4)

```php
foreach ($this->users as $user) {
    $user->save();
}
```

If `$this->users` is typed through a class property annotation or file/class-scope doc-comment information, the current local-scope-only path may not be enough.

Resolved: Strategy C in the PHP `extractForLoopBinding` walks up the AST to the enclosing `class_declaration`, scans the `declaration_list` for a matching `property_declaration`, and extracts the element type from the `@var` PHPDoc comment (or PHP 7.4+ native type field). The `@param` workaround previously required in the fixture is gone.

#### 7C. Broader use of already-known return types (shipped as Phase 7.1 + 7.2)

The system can already infer receiver types from uniquely resolved call results in `call-processor.ts`. That needs to be generalised so `TypeEnv` can benefit from it too.

Resolved: `ReturnTypeLookup` (Phase 7.1) encapsulates `lookupReturnType` / `lookupRawReturnType` and is threaded through `ForLoopExtractorContext` (Phase 7.2) to all for-loop extractors. Phase 7.2 also added the `pendingCallResults` infrastructure (the `PendingAssignment` discriminated union in `types.ts` and the Tier 2b processing loop in `type-env.ts`), but no extractor populates it yet — `var x = f()` propagation is Phase 9 work.

### Engineering direction (as implemented)

- introduced `ReturnTypeLookup` interface and `buildReturnTypeLookup` factory in `type-env.ts`
- replaced per-extractor `(node, env)` signature with `ForLoopExtractorContext` context object for extensibility
- added `extractElementTypeFromString` to `shared.ts` as the canonical raw-string container unwrapper
- added PHP Strategy C helper (`findClassPropertyElementType`) scoped to the PHP extractor
- kept all changes backwards-compatible — explicit-type paths are untouched

### Delivered impact

- loop inference now works for direct function call iterables in all 7 typed-iteration languages
- PHP `$this->property` foreach is resolved from class-level `@var` without requiring `@param` workarounds
- `pendingCallResults` infrastructure is in place (Tier 2b loop + `PendingAssignment` union) — dormant until an extractor emits `{ kind: 'callResult' }` (Phase 9)

### Risk level

**Medium** (as predicted)

The interface change touched all extractors but remained additive — no existing paths were changed.

---

## Phase 8: Field and Property Type Resolution *(delivered)*

### Goal

Model class / struct fields so chained member access can be resolved more accurately.

### Status

**Delivered.** One-level, deep, and mixed field+method chain resolution is implemented across 9 languages. Pattern destructuring (8C) remains open.

#### What shipped

- **SymbolTable `fieldByOwner` index** — O(1) lookup via `ownerNodeId\0fieldName` key. Properties excluded from `globalIndex` to prevent namespace pollution. *(Q1 resolved)*
- **`HAS_PROPERTY` edge type** — split from `HAS_METHOD` to distinguish property linkage
- **`declaredType` field** on Property symbols — semantic split from `returnType` (methods)
- **`resolveFieldAccessType`** in call-processor — resolves field access chains at call sites
- **`extractPropertyDeclaredType`** in shared utils — 5-strategy cross-language type extraction
- **Per-language `@definition.property` captures** — see coverage table below
- **`extractMixedChain`** in utils — unified recursive AST walker that handles both `call_expression` and `field_expression` nodes interchangeably, building `MixedChainStep[]` capped at `MAX_CHAIN_DEPTH` (3). Replaces the earlier separate `extractFieldChain` / `extractCallChain` functions.
- **`receiverMixedChain`** on `ExtractedCall` — unified chain representation replacing the old `receiverCallChain` + `receiverFieldAccess` split
- **Unified chain resolution** in call-processor — a single loop in both `processCalls` (sequential) and `processCallsFromExtracted` (worker) walks `MixedChainStep[]`, dispatching `kind: 'field'` to `resolveFieldAccessType` and `kind: 'call'` to `resolveCallTarget` + return type extraction
- **Type-preserving stdlib passthrough** — `unwrap()`, `expect()`, `clone()`, `as_ref()`, and similar stdlib methods that don't change the receiver type are recognized as identity operations in the chain loop, allowing chains like `user.unwrap().save()` to resolve correctly when TypeEnv has already stripped the nullable wrapper
- **C++ `field_declaration`** property capture via `field_identifier` declarator
- **C++ `field_expression` support** — tree-sitter-cpp uses `argument` (not `object`) for the receiver of `field_expression`; `extractMixedChain` handles this
- **C++ inline method double-indexing guard** — prevents `@definition.function` from creating duplicate symbol entries for methods already captured by `@definition.method` inside class/struct bodies (applied in both `parsing-processor.ts` and `parse-worker.ts`)
- **Rust unit struct instantiation** — `let svc = UserService;` (bare identifier assignment) now recognized by type-env when the RHS matches a known class/struct name
- **Ruby YARD `@return [Type]`** extraction for `attr_accessor` properties, enabling field-type resolution in dynamically typed Ruby

#### Language coverage

| Language | Property capture | `declaredType` extraction | Deep chain | Notes |
|----------|-----------------|--------------------------|:----------:|-------|
| TypeScript | ✅ `public_field_definition`, `private_property_identifier`, `required_parameter` | ✅ Strategy 2 (type_annotation) | ✅ | Parameter properties added |
| JavaScript | ✅ `field_definition` | ⚠️ No type annotations in JS | — | Capture added; declaredType requires JSDoc |
| Java | ✅ `field_declaration` | ✅ Strategy 3 (parent type) | ✅ | |
| C# | ✅ `property_declaration` | ✅ Strategy 1 (type field) | ✅ | |
| Go | ✅ `field_declaration` | ✅ Strategy 1 (type field) | ✅ | |
| Kotlin | ✅ `property_declaration` | ✅ Strategy 4 (variable_declaration) | ✅ | New strategy added |
| PHP | ✅ `property_declaration` | ✅ Strategy 1 + PHPDoc @var fallback | ✅ | Strategy 5 for pre-7.4 |
| Rust | ✅ `field_declaration` | ✅ Strategy 1 (type field) | ✅ | `extractMemberAccessParts` handles `field_expression` via `value`/`field` |
| Python | ✅ `assignment` with `type` | ✅ Class-level annotations | ✅ | `self.x` instance pattern not yet supported |
| Ruby | ✅ `attr_*` via call routing | ✅ YARD `@return [Type]` | — | YARD fallback for dynamically typed properties |
| C++ | ✅ `field_declaration` via `field_identifier` | ✅ Strategy 1 (type field) | ✅ | |
| Swift | ✅ `property_declaration` | ⚠️ Untested | — | |

#### What remains open

- **8C. Pattern destructuring** dependent on field knowledge
- Python `self.x` instance attribute pattern

### Problems this phase addresses

#### 8A. Deep property chains *(delivered)*

```typescript
user.address.city.getName()
```

✅ `extractFieldChain` recursively walks nested member_expression nodes at parse time, building a `fieldChain: string[]`. At resolution time, the chain is walked step-by-step: `user → User`, `address → Address`, `city → City`, `getName() → City#getName`. Supported across TS, Java, C#, Go, Kotlin, PHP, C++.

#### 8B. Mixed field+method chain resolution *(delivered)*

```typescript
svc.getUser().address.save()   // call → field → call
user.getAddress().city.getName() // call → field → call
user.address.getCity().save()   // field → call → call
user.unwrap().save()            // stdlib passthrough → call
```

✅ `extractMixedChain` walks both call-expression and field-expression nodes in a single unified pass, producing `MixedChainStep[]`. The resolver walks steps left-to-right: `kind: 'field'` resolves via `resolveFieldAccessType`, `kind: 'call'` resolves via `resolveCallTarget` + return type extraction. Stdlib passthroughs (`unwrap`, `clone`, `expect`, etc.) are recognized as type-preserving identity operations.

#### 8C. Pattern destructuring that depends on field knowledge

This is especially relevant for:

- Rust struct-pattern destructuring
- PHP chained property access
- richer TypeScript or Python object-based destructuring in future work

### Engineering direction (as implemented)

- ~~parse field / property declarations per class or struct~~ ✅
- ~~build a field-type map keyed by owning type~~ ✅ (`fieldByOwner` index)
- ~~teach lookup and chain-resolution logic to walk member segments (deep chains)~~ ✅ (`extractMixedChain` + unified chain-walking loop)
- ~~unify field chains and call chains into a single representation~~ ✅ (`MixedChainStep[]` replaces separate `receiverCallChain` / `receiverFieldAccess`)
- ~~C++ struct member field capture~~ ✅ (`field_declaration` via `field_identifier`)
- ~~C++ `field_expression` receiver extraction~~ ✅ (`argument` field support in `extractMixedChain`)
- ~~Rust unit struct instantiation~~ ✅ (`let svc = TypeName;` recognized by type-env)
- ~~Ruby YARD `@return` for `attr_accessor`~~ ✅ (comment-walking in `call-routing.ts`)
- ~~stdlib passthrough methods~~ ✅ (`TYPE_PRESERVING_METHODS` set in call-processor)
- keep this separate from the base variable-binding layer where possible

### Delivered impact

This is the biggest unlock for richer static analysis because it allows the graph to model more than just top-level receivers.

It materially improved:

- chained property resolution (up to 3 levels deep)
- mixed field+method chain resolution (e.g. `svc.getUser().address.save()`)
- member-based call disambiguation across 9 languages
- deeper context extraction for downstream tooling
- C++ struct/class field visibility in the knowledge graph
- C++ chained method call resolution (previously blocked by missing `argument` field support)
- Rust nullable receiver chains (`user.unwrap().save()`)
- Ruby field-type resolution via YARD documentation

### Risk level

**High** (delivered — risk was managed through incremental delivery across 8, 8A, 8B)

This phase pushed the system from variable typing into structural object modelling. Remaining work:

- careful handling of inheritance / embedding / language-specific member semantics
- pattern destructuring dependent on field knowledge (8C)

---

## Phase 9: Full Return-Type-Aware Variable Binding

### Goal

Make return-type-driven inference a first-class input to `TypeEnv`, not just a downstream verification path.

### Problems this phase addresses

#### 9A. Binding variables from call results

```typescript
const users = repo.getUsers()
```

Desired binding:

- `users -> List<User>`

#### 9B. Looping directly over call results

```typescript
for (const user of getUsers()) {
    user.save()
}
```

Desired binding:

- `user -> User`

#### 9C. Broader method-chain inference

```typescript
repo.getUsers().first()
```

If return types can propagate more systematically, later chain stages become much more resolvable.

### Engineering direction

- expose return types as reusable inference inputs inside `TypeEnv`
- distinguish raw textual return types from normalized receiver-usable types
- make method-call return inference receiver-aware where necessary
- avoid over-eager propagation when multiple call targets remain ambiguous

### Expected impact

This phase would make the type system feel much closer to a static-analysis substrate rather than a set of local heuristics.

It will especially improve codebases that rely heavily on:

- service-returned collections
- builder APIs
- repository methods
- chain-heavy fluent interfaces

### Risk level

**Medium to High**

The conceptual basis already exists, but generalising it without introducing false bindings requires careful ambiguity rules.

---

## Language-Specific Gaps

### Swift

Current support remains relatively minimal.

Missing or weak areas include:

- for-loop element binding
- pattern binding
- assignment-chain propagation
- broader expression-based inference

**Priority:** Medium  
**Reason:** It matters for parity, but the biggest global analysis gains are elsewhere.

### Go

Key remaining gap:

- ~~iterable call expressions in range loops~~ ✓ shipped in Phase 7.3

**Priority:** Medium (chained property access remains for Phase 8)

### PHP

Key remaining gaps:

- ~~file/class-scope iterable propagation~~ ✓ shipped in Phase 7.4 (Strategy C)
- chained property access

**Priority:** High
**Reason:** PHP heavily benefits from doc-comment-aware field and property modelling.

### Rust

Key remaining gap:

- struct-pattern field destructuring

**Priority:** Medium  
**Reason:** Important for completeness, but field-type infrastructure is the real prerequisite.

### All languages

Shared missing capabilities:

- ~~field / property type resolution~~ ✓ shipped in Phase 8 + 8A (10 languages)
- ~~mixed field+method chain resolution~~ ✓ shipped in Phase 8B (unified `MixedChainStep[]`)
- generalised return-type-aware binding in `TypeEnv` (Phase 9)

**Priority:** High
**Reason:** Return-type propagation is the biggest remaining blocker to deeper static analysis.

---

## Recommended Delivery Order

### ~~1. Generalise existing return and loop inference~~ ✅ Phase 7

Delivered. Iterable call-expression support, `ReturnTypeLookup`, file-scope binding, PHP Strategy C.

### ~~2. Add field / property type maps~~ ✅ Phase 8 + 8A + 8B

Delivered. Per-type field metadata, deep chain resolution (up to 3 levels), mixed field+method chains, type-preserving stdlib passthrough, C++ and Rust fixes.

### 3. Promote return types into first-class `TypeEnv` inputs ← **next**

This converts existing downstream validation into a broader inference capability.

Deliverables:

- call-result variable binding (`var x = f()` propagation)
- loop inference from call results (already done for direct iterables, pending for assigned results)
- broader chain propagation

### 4. Broaden branch-sensitive narrowing where low-risk

After the structural work lands, selective branch refinement becomes more valuable and easier to reason about.

---

## What “Production-Grade Static Analysis” Means Here

For GitNexus, production-grade does **not** mean replacing a language compiler.

A realistic target is:

- strong receiver-constrained call resolution across common language idioms
- reliable handling of typed loops, constructor-like initializers, and common patterns
- useful return-type propagation for service/repository style code
- enough field/property knowledge to support chained-member analysis
- conservative behavior under ambiguity
- predictable performance during indexing

That would be sufficient for:

- better call graphs
- more accurate impact analysis
- stronger context assembly for AI workflows
- more trustworthy graph traversal features

---

## Suggested Milestone Definitions

### Milestone A — Inference Expansion ✅

Delivered in Phase 7.

- loop inference works for identifier iterables and common call-expression iterables across 7 languages
- `ReturnTypeLookup` threads return-type knowledge into TypeEnv
- PHP class-level `@var` property typing for `$this->property` foreach

### Milestone B — Structural Member Typing ✅

Delivered in Phase 8 + 8A + 8B.

- field/property maps exist for class-like types across 9 languages
- deep chains resolve up to 3 levels (`user.address.city.getName()`)
- mixed field+method chains resolve interleaved patterns (`svc.getUser().address.save()`)
- stdlib passthroughs (`unwrap`, `clone`, etc.) are type-preserving in chains
- C++ and Rust chain call resolution fixed (field_expression argument, unit struct)

### Milestone C — Static-Analysis Foundation ← **next**

Success looks like:

- return-type-aware variable binding is a first-class part of environment construction
- chains, loops, and assignments share a coherent propagation model
- downstream graph features can rely on more than local receiver heuristics

---

## Open Questions for Future Design

These should be resolved before or during implementation of the later phases.

1. **Where should field-type metadata live?**
   ✅ Resolved: in `SymbolTable` via the `fieldByOwner` index, keyed by `ownerNodeId\0fieldName`. Properties live alongside other symbols but are excluded from `globalIndex` to prevent namespace pollution.

2. **How should ambiguity be represented?**  
   Is `undefined` sufficient, or do later phases need a richer "known ambiguous" state?

3. **How much receiver context should return-type inference require?**  
   Some methods only become meaningful once the receiver type is already partially known.

4. **How much branch sensitivity is worth the complexity?**  
   Some narrowing gives clear value; full control-flow typing likely does not.

5. **Should field typing and chain typing be one phase or two?**
   ✅ Resolved: delivered as Phase 8 (single-level) + Phase 8A (deep chains) in the same branch, with separate test suites per language. Incremental delivery within one phase worked well.

---

## Summary

Phases 7 and 8 (including 8A and 8B) are **complete**. The type system now handles:

- ✅ explicit type annotations and parameters across 13 languages
- ✅ initializer/constructor inference with SymbolTable validation
- ✅ loop element inference including call-expression iterables (7 languages)
- ✅ field/property type resolution with deep chains (up to 3 levels, 10 languages)
- ✅ mixed field+method chains (`svc.getUser().address.save()`)
- ✅ type-preserving stdlib passthroughs (`unwrap`, `clone`, `expect`, etc.)
- ✅ comment-based types (JSDoc, PHPDoc, YARD)

**The next step is Phase 9**: promote return-type-aware inference into `TypeEnv` as a first-class input, enabling `var x = f()` variable binding and broader chain propagation. The `pendingCallResults` infrastructure is already in place (Tier 2b loop + `PendingAssignment` union) — it just needs extractors to emit `{ kind: 'callResult' }` entries.

That path preserves the current strengths of the system while moving GitNexus the final step toward a robust, production-grade static-analysis foundation.
