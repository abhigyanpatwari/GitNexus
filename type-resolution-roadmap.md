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

## Phase 8: Field and Property Type Resolution

### Goal

Model class / struct fields so chained member access can be resolved more accurately.

### Problems this phase addresses

#### 8A. Deep property chains

```typescript
user.address.city
```

Today the system may resolve `user -> User`, but it cannot generally resolve:

- `address -> Address`
- `city -> City` or scalar type

#### 8B. Chained method targets through field access

```typescript
user.address.save()
```

Without field typing, the resolver cannot reliably identify the receiver type of `address`.

#### 8C. Pattern destructuring that depends on field knowledge

This is especially relevant for:

- Rust struct-pattern destructuring
- PHP chained property access
- richer TypeScript or Python object-based destructuring in future work

### Engineering direction

- parse field / property declarations per class or struct
- build a field-type map keyed by owning type
- teach lookup and chain-resolution logic to walk member segments
- keep this separate from the base variable-binding layer where possible

### Expected impact

This is the biggest unlock for richer static analysis because it allows the graph to model more than just top-level receivers.

It would materially improve:

- chained property resolution
- member-based call disambiguation
- deeper context extraction for downstream tooling

### Risk level

**High**

This is the first phase that pushes the system from variable typing into structural object modelling. It will likely require:

- schema expansion or new internal maps
- careful handling of inheritance / embedding / language-specific member semantics
- broader test coverage than earlier phases

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

- field / property type resolution
- generalised return-type-aware binding in `TypeEnv`

**Priority:** Very High  
**Reason:** These are the biggest remaining blockers to deeper static analysis.

---

## Recommended Delivery Order

### 1. Generalise existing return and loop inference

This is the best cost-to-value step.

Deliverables:

- iterable call-expression support
- wider access to return-type maps
- file-scope binding visibility where needed

### 2. Add field / property type maps

This unlocks the next class of analysis depth.

Deliverables:

- per-type field metadata
- chained property resolution
- better destructuring support

### 3. Promote return types into first-class `TypeEnv` inputs

This converts existing downstream validation into a broader inference capability.

Deliverables:

- call-result variable binding
- loop inference from call results
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

### Milestone A — Inference Expansion

Success looks like:

- loop inference works for identifier iterables and common call-expression iterables
- simple call-result assignments benefit from return types more broadly
- no major regression in ambiguity handling

### Milestone B — Structural Member Typing

Success looks like:

- field/property maps exist for class-like types
- chained access can resolve at least one segment beyond the base receiver
- field-aware member-call resolution works in the most important languages

### Milestone C — Static-Analysis Foundation

Success looks like:

- return-type-aware variable binding is a first-class part of environment construction
- chains, loops, and assignments share a coherent propagation model
- downstream graph features can rely on more than local receiver heuristics

---

## Open Questions for Future Design

These should be resolved before or during implementation of the later phases.

1. **Where should field-type metadata live?**  
   In `TypeEnv`, in `SymbolTable`, or in a dedicated side structure?

2. **How should ambiguity be represented?**  
   Is `undefined` sufficient, or do later phases need a richer "known ambiguous" state?

3. **How much receiver context should return-type inference require?**  
   Some methods only become meaningful once the receiver type is already partially known.

4. **How much branch sensitivity is worth the complexity?**  
   Some narrowing gives clear value; full control-flow typing likely does not.

5. **Should field typing and chain typing be one phase or two?**  
   Keeping them separate may reduce risk and make regressions easier to isolate.

---

## Summary

The next stage of the type system should focus on **generalising what already works** before attempting compiler-like sophistication.

The most important path is:

1. extend return-type and iterable inference
2. add field/property type knowledge
3. promote return-type-aware inference into `TypeEnv`

That path preserves the current strengths of the system while moving GitNexus materially closer to a robust, production-grade static-analysis foundation.
