---
title: "feat: Close type resolution gaps across all 12 languages"
type: feat
status: active
date: 2026-03-14
---

# Close Type Resolution Gaps Across All 12 Languages

## Overview

The type resolution system (TypeEnv + call-processor) has been hardened through 6 rounds of review on `feat/type-resolution-constructor-inference`. This plan closes the remaining gaps identified by the comprehensive 4-agent gap analysis covering all 12 supported languages.

Every task MUST include per-language integration tests following the established pattern:
- Fixture directory: `test/fixtures/lang-resolution/<lang>-<pattern>/`
- Integration test: `test/integration/resolvers/<lang>.test.ts`
- Unit tests: `test/unit/type-env.test.ts` where applicable

## Problem Statement

The current TypeEnv extracts types from explicit annotations (Tier 0) and constructor calls (Tier 1). Many common patterns across all languages produce no type binding, causing receiver-type resolution to fail silently. The gap analysis identified 14 categories of missing patterns affecting call resolution accuracy.

## Implementation Phases

### Phase 1: Quick Wins (Independent — can run in parallel)

Each task is self-contained. No dependencies between them.

#### Task 1.1: Python walrus operator `:=`
- **File**: `src/core/ingestion/type-extractors/python.ts`
- **Change**: Add `named_expression` to `DECLARATION_NODE_TYPES`
- **Why**: `if (user := get_user()):` is common Python 3.8+ pattern; `user` gets no type binding
- **Pattern**: `named_expression` has `name` (identifier) and `value` (call) children
- **Tests**:
  - Unit: `type-env.test.ts` — walrus with call, walrus with annotated type
  - Integration fixture: `test/fixtures/lang-resolution/python-walrus-operator/`
  - Integration test: `python.test.ts` — `user := User(); user.save()` resolves

#### Task 1.2: PHP typed class properties
- **File**: `src/core/ingestion/type-extractors/php.ts`
- **Change**: Add `property_declaration` to `DECLARATION_NODE_TYPES`, implement `extractDeclaration` for it
- **Why**: `private User $repo;` is the primary PHP 7.4+ property declaration pattern
- **Pattern**: `property_declaration` has `type` (named_type) and child `property_element` with `name` (variable_name)
- **Tests**:
  - Unit: `type-env.test.ts` — typed property extraction
  - Integration fixture: `test/fixtures/lang-resolution/php-typed-properties/`
  - Integration test: `php.test.ts` — `private UserRepo $repo; $repo->save()` resolves

#### Task 1.3: Nullable receiver unwrapping
- **File**: `src/core/ingestion/utils.ts` — `extractReceiverName` function (~line 800)
- **Change**: Before returning `undefined` for non-simple receivers, check if the receiver node wraps a simple identifier with an optional chain operator
- **Patterns to handle**:
  - TS/JS: `optional_chain_expression` wrapping `member_expression`
  - Kotlin: `safe_navigation_expression`
  - C#: `conditional_access_expression`
  - Swift: `optional_chaining_expression`
- **Approach**: Add the wrapped expression types to `SIMPLE_RECEIVER_TYPES` or unwrap one level before checking
- **Tests**:
  - Integration fixtures per language: `ts-nullable-receiver/`, `kotlin-nullable-receiver/`, etc.
  - Integration tests: `user?.save()` resolves same as `user.save()`

#### Task 1.4: Go `make()` builtin
- **File**: `src/core/ingestion/type-extractors/go.ts`
- **Change**: In `extractGoShortVarDeclaration`, add a `call_expression` branch for `make` (similar to existing `new` branch)
- **Pattern**: `make([]User, 0)` — first arg is `slice_type`/`map_type` with element type
- **Approach**: Extract element type from the first argument's type node
- **Tests**:
  - Unit: `type-env.test.ts` — `make([]User, 0)`, `make(map[string]User)`
  - Integration fixture: `test/fixtures/lang-resolution/go-make-builtin/`
  - Integration test: `go.test.ts`

#### Task 1.5: Go type assertions
- **File**: `src/core/ingestion/type-extractors/go.ts`
- **Change**: Handle `type_assertion_expression` in short var declarations
- **Pattern**: `user, ok := iface.(User)` — `type_assertion_expression` has a `type` field
- **Tests**:
  - Unit: `type-env.test.ts` — type assertion single and comma-ok forms
  - Integration fixture: `test/fixtures/lang-resolution/go-type-assertion/`
  - Integration test: `go.test.ts`

---

### Phase 2: Medium Effort (Some dependencies noted)

#### Task 2.1: C++ range-for loop variables
- **File**: `src/core/ingestion/type-extractors/c-cpp.ts`
- **Change**: Add `for_range_loop` to `DECLARATION_NODE_TYPES`, extract the type from the declaration part
- **Pattern**: `for (auto& user : users)` — the `for_range_loop` has a `type` and `declarator` child
- **Note**: When type is `auto`, would need collection element type inference (deferred to Phase 3). For explicit types `for (User& u : users)` this works now.
- **Tests**:
  - Unit: explicit type in range-for
  - Integration fixture: `test/fixtures/lang-resolution/cpp-range-for/`
  - Integration test: `cpp.test.ts`

#### Task 2.2: Rust `if let` / `while let` bindings
- **File**: `src/core/ingestion/type-extractors/rust.ts`
- **Change**: Add `if_let_expression` and `while_let_expression` to `DECLARATION_NODE_TYPES` or handle in `extractDeclaration`
- **Pattern**: `if let Some(user) = opt { user.save() }` — pattern binding inside conditional
- **Approach**: Extract the pattern variable and the matched type from the source expression
- **Note**: Full generic unwrapping (Some<User> → User) is Phase 3. Initial version extracts the binding variable with no type — still useful for scope tracking.
- **Tests**:
  - Unit: if-let with annotated type, while-let
  - Integration fixture: `test/fixtures/lang-resolution/rust-if-let/`
  - Integration test: `rust.test.ts`

#### Task 2.3: Swift `guard let` / `if let` bindings
- **File**: `src/core/ingestion/type-extractors/swift.ts`
- **Change**: Add `guard_statement` and `if_statement` with `optional_binding_condition` to declaration handling
- **Pattern**: `guard let user = fetchUser() else { return }` — `optional_binding_condition` has `pattern` and `value`
- **Note**: Swift parser availability varies (Node 22 issue). Tests must use `describe.skipIf(!swiftAvailable)`.
- **Tests**:
  - Integration fixture: `test/fixtures/lang-resolution/swift-guard-let/`
  - Integration test: `swift.test.ts` with skipIf guard

#### Task 2.4: C# pattern matching `is Type variable`
- **File**: `src/core/ingestion/type-extractors/csharp.ts`
- **Change**: Handle `is_pattern_expression` or `declaration_pattern` in the type extractor
- **Pattern**: `if (obj is User user) { user.Save(); }` — `declaration_pattern` has `type` and `name`
- **Tests**:
  - Unit: `type-env.test.ts` — is-pattern with type
  - Integration fixture: `test/fixtures/lang-resolution/csharp-pattern-matching/`
  - Integration test: `csharp.test.ts`

#### Task 2.5: Python class-level type annotations
- **File**: `src/core/ingestion/type-extractors/python.ts`
- **Change**: Ensure `assignment` declarationNodeTypes also captures class body assignments with type annotations
- **Pattern**: `class User: name: str = "default"` — tree-sitter may use `expression_statement` > `assignment` inside class body
- **Note**: Check if this already works via existing `assignment` handling — may just need scope key fix
- **Tests**:
  - Unit: class-level annotation
  - Integration fixture: `test/fixtures/lang-resolution/python-class-annotations/`

---

### Phase 3: Architecture Changes (Sequential — requires design decisions)

#### Task 3.1: Return type inference
- **Files**: `src/core/ingestion/type-env.ts`, `src/core/ingestion/call-processor.ts`
- **Change**: When processing calls, look up the callee's return type from SymbolTable and bind the assignment target
- **Approach**:
  1. `extractMethodSignature` already stores `returnType` in symbol metadata
  2. In `buildTypeEnv` or as a post-processing step, for assignments like `let x = foo()`, look up `foo` in SymbolTable
  3. If `foo.returnType` exists, add binding `x → returnType`
  4. Must strip nullable wrappers and generic containers to get base type
- **Risk**: Circular dependencies if two functions return each other's types. Mitigate with depth limit.
- **Tests**: Per-language integration tests for return-type-inferred receiver resolution

#### Task 3.2: Chained property access resolution
- **Files**: `src/core/ingestion/utils.ts` (`extractReceiverName`), `src/core/ingestion/call-processor.ts`
- **Change**: When receiver is `this.repo`, resolve `this` → class type, then look up `repo` property type on that class
- **Approach**:
  1. Extend `extractReceiverName` to return structured data: `{ chain: ['this', 'repo'] }` for multi-level access
  2. In call-processor, resolve chain iteratively: lookup first element, find property type, continue
  3. Requires property-type tracking: store class property types in TypeEnv or SymbolTable
- **Risk**: Performance impact from recursive lookups. Limit chain depth to 3.
- **Tests**: Per-language `this.repo.save()` / `self.db.query()` patterns

#### Task 3.3: For-loop variable typing
- **Files**: Per-language type extractors + `src/core/ingestion/type-env.ts`
- **Change**: Extract loop variable type from explicit annotations or inferred from collection type
- **Patterns per language**:
  - TS/JS: `for (const x of collection)` — `for_in_statement` with `left` and `right`
  - Java/C#: `for (Type x : collection)` — explicit type already works
  - Go: `for _, v := range slice` — `range_clause` with identifier
  - Python: `for x in collection` — `for_statement` with `left`
  - Rust: `for x in iter` — `for_expression` with `pattern`
- **Depends on**: Task 3.1 (return type inference) for inferring collection element types
- **Tests**: Per-language integration tests

#### Task 3.4: Generic type parameter extraction
- **File**: `src/core/ingestion/type-extractors/shared.ts` — `extractSimpleTypeName`
- **Change**: Add optional `extractGenericArgs` mode that returns type parameters alongside base type
- **Current**: `List<User>` → `List` (base only)
- **New**: `List<User>` → `{ base: 'List', args: ['User'] }` when requested
- **Use case**: For-loop element type inference, collection method resolution
- **Tests**: Unit tests for each language's generic syntax

#### Task 3.5: Block-level type narrowing
- **File**: `src/core/ingestion/type-env.ts` — scope handling
- **Change**: Add sub-function scope support for if/match/guard blocks
- **Current**: Scope keys are `funcName@startIndex` or `''` (file)
- **New**: Add block scope keys like `funcName@startIndex#if@lineN`
- **Risk**: Scope lookup complexity increases. Need to walk up scope chain on miss.
- **Tests**: Per-language pattern matching, instanceof, type guards

#### Task 3.6: Ruby dedicated type extractor
- **File**: New `src/core/ingestion/type-extractors/ruby.ts`
- **Change**: Replace the stub in `index.ts` with a real type extractor
- **Features**:
  - YARD annotation parsing (`@param name [Type]`, `@return [Type]`)
  - Instance variable type inference from constructor assignments
  - Block parameter typing heuristics
- **Tests**: Integration fixture: `test/fixtures/lang-resolution/ruby-typed-methods/`

---

## Acceptance Criteria

### Functional Requirements
- [ ] Each Phase 1 task has unit tests AND per-language integration tests with fixtures
- [ ] Each Phase 2 task has per-language integration tests with fixtures
- [ ] Each Phase 3 task has cross-language integration tests
- [ ] All existing 101 unit tests continue to pass
- [ ] All existing integration tests continue to pass
- [ ] No regressions in existing call resolution

### Quality Gates
- [ ] `npx vitest run test/unit/type-env.test.ts` — all pass
- [ ] `npx vitest run test/integration/resolvers/ --no-file-parallelism` — all pass
- [ ] No new TypeScript compilation errors

### Testing Pattern (MANDATORY for every task)
```
1. Create fixture: test/fixtures/lang-resolution/<lang>-<pattern>/
   - Source file with the pattern (e.g., main.py, models.py)
   - Class/struct definitions with methods to resolve against
2. Add describe block: test/integration/resolvers/<lang>.test.ts
   - beforeAll: runPipelineFromRepo(fixture_path)
   - Tests: verify CALLS edges resolve to correct file/method
3. Add unit tests: test/unit/type-env.test.ts (where applicable)
   - Parse code snippet, verify TypeEnv bindings
```

## Task Dependency Graph

```
Phase 1 (all parallel, no dependencies):
  1.1 Python walrus  ─┐
  1.2 PHP properties  ├─ All independent
  1.3 Nullable unwrap ├─ Can run as parallel swarm agents
  1.4 Go make()       │
  1.5 Go type assert  ─┘

Phase 2 (mostly parallel):
  2.1 C++ range-for   ─┐
  2.2 Rust if-let      ├─ Independent of each other
  2.3 Swift guard-let  ├─ Can run as parallel swarm agents
  2.4 C# pattern match │
  2.5 Python class ann ─┘

Phase 3 (sequential dependencies):
  3.1 Return type inference ──→ 3.3 For-loop typing
                                     ↑
  3.4 Generic extraction ────────────┘

  3.2 Chained property access (independent)
  3.5 Block-level scoping (independent)
  3.6 Ruby type extractor (independent)
```

## Sources & References

- PR #274: `feat/type-resolution-constructor-inference` — 6 rounds of review fixes
- Existing patterns: `test/fixtures/lang-resolution/` (150 fixture dirs)
- Integration tests: `test/integration/resolvers/*.test.ts` (12 languages)
- Type extractors: `src/core/ingestion/type-extractors/*.ts` (9 files + index)
- TypeEnv: `src/core/ingestion/type-env.ts`
- Call processor: `src/core/ingestion/call-processor.ts`
- Receiver extraction: `src/core/ingestion/utils.ts:extractReceiverName`
