# Type Resolution System

GitNexus's type resolution system maps variables to likely declared types across the supported languages so the ingestion pipeline can perform **receiver-constrained call resolution**.

When the code contains a call such as `user.save()`, the resolver tries to determine that `user` is a `User`, allowing call resolution to prefer `User#save` over unrelated methods such as `Repo#save`.

This system is designed to be:

- **Conservative** — it prefers missing a binding over introducing a misleading one
- **Walk + fixpoint** — bindings are collected during a single AST walk, then a unified fixpoint loop iterates over pending assignments (copy, callResult, fieldAccess, methodCallResult) until no new bindings are produced
- **Scope-aware** — function-local bindings are isolated from file-level bindings
- **Per-file with cross-file seeding** — the environment is built for one file at a time, but Phase 14 seeds upstream bindings (imported types, return types) into the file scope before the fixpoint for all 13 languages

It is **not** a full compiler type checker. Its job is to recover enough type information to improve call-edge accuracy during ingestion.

---

## Purpose in the Pipeline

Type resolution sits between parsing and call resolution.

```text
parse-worker.ts
     │
     ▼
buildTypeEnv(tree, language, symbolTable?)
     │
     ├──► TypeEnvironment.lookup(varName, callNode)
     │         │
     │         ▼
     │    call-processor.ts
     │    - resolves receiver type for method calls
     │    - filters candidates by receiver match
     │    - verifies deferred constructor / initializer bindings
     │
     └──► discarded after file processing
```

The `TypeEnvironment` is built once per file. `call-processor.ts` then uses `lookup()` to determine receiver types and narrow candidate symbols from the `SymbolTable`.

> **Note (RFC #909 Ring 3):** `call-processor.ts` is the legacy call-resolution path. Languages in `MIGRATED_LANGUAGES` (see `gitnexus/src/core/ingestion/registry-primary-flag.ts`) route through the scope-resolution pipeline instead — see `ARCHITECTURE.md § Scope-Resolution Pipeline`. TypeEnv is still built for migrated languages in the parse worker, but receiver typing flows through `ParsedTypeBinding` + `ScopeResolutionIndexes` rather than `call-processor.ts`.

---

## Architecture

```text
                                 ┌──────────────────────┐
                                 │     type-env.ts      │
                                 │                      │
                                 │  buildTypeEnv()      │
                                 │  - Single AST walk   │
                                 │  - Scope tracking    │
                                 │  - Tier orchestration│
                                 └──────────┬───────────┘
                                            │ dispatches to
                    ┌───────────────────────┬┴┬────────────────────────┐
                    │                       │ │                        │
          ┌─────────▼──────────┐  ┌─────────▼─▼─────────┐  ┌──────────▼─────────┐
          │   shared.ts        │  │  <language>.ts      │  │    types.ts        │
          │                    │  │                      │  │                    │
          │  Container table   │  │  Per-language        │  │  Extractor         │
          │  Type helpers      │  │  extractors          │  │  interface defs    │
          │  Generic helpers   │  │  (shared + per-lang) │  │                    │
          └────────────────────┘  └──────────────────────┘  └────────────────────┘
```

### Main files

| File | Purpose |
|------|---------|
| `type-env.ts` | Core engine. Walks the AST once, tracks scopes, collects bindings, and exposes `buildTypeEnv()` plus the `TypeEnvironment` interface. |
| `types.ts` | TypeScript interfaces for extractor hooks such as `TypeBindingExtractor`, `ForLoopExtractor`, and `PatternBindingExtractor`. |
| `shared.ts` | Language-agnostic helpers such as `extractSimpleTypeName`, `extractElementTypeFromString`, `resolveIterableElementType`, `CONTAINER_DESCRIPTORS`, and `TYPED_PARAMETER_TYPES`. |
| `index.ts` | Dispatch map from `SupportedLanguages` to `LanguageTypeConfig`. |
| `typescript.ts` | TypeScript and JavaScript extractors, including JSDoc support. |
| `jvm.ts` | Java and Kotlin extractors. |
| `csharp.ts` | C# extractors. |
| `go.ts` | Go extractors, including range semantics. |
| `rust.ts` | Rust extractors, including `if let`, match-related handling, and `Self` resolution. |
| `python.ts` | Python extractors, including `match` / `case` handling. |
| `php.ts` | PHP extractors, including PHPDoc support. |
| `ruby.ts` | Ruby extractors, including YARD support. |
| `swift.ts` | Swift extractors. Currently the most minimal configuration. |
| `c-cpp.ts` | Shared C / C++ extractors. |

---

## Supported Languages

The current type-resolution layer supports **13 languages**:

- TypeScript
- JavaScript
- Python
- Java
- Kotlin
- C#
- Go
- Rust
- PHP
- Ruby
- Swift
- C
- C++

Not all languages have the same level of coverage. Swift remains the most minimal. C and some C++ cases naturally benefit less from receiver typing than object-oriented languages.

---

## Design Constraints

The type resolution layer is intentionally narrower than a compiler-grade type system.

It does:

- resolve variable types from declarations, parameters, initializers, loops, and selected pattern constructs
- normalize common wrappers such as nullable types and generic containers
- improve receiver matching during call resolution
- verify some ambiguous initializer bindings against the `SymbolTable`

It does not:

- perform full semantic type checking
- guarantee resolution for every ambiguous construct

It now does (Phase 14):

- run a unified fixpoint loop per file for copy/callResult/fieldAccess/methodCallResult chains
- propagate inferred bindings across files for all 13 supported languages:
  - **Named import extraction** (TS/JS/Python/Kotlin/Rust/PHP/Java/C#): per-symbol bindings extracted from import AST nodes
  - **Wildcard import synthesis** (Go/Ruby/C/C++/Swift): namedImportMap entries synthesized from graph-exported symbols via `synthesizeWildcardImportBindings()`, enabling cross-file propagation for whole-module-import languages
- seed imported bindings into file scope after walk, before fixpoint (local declarations always win)

---

## TypeEnvironment Model

`buildTypeEnv()` returns a `TypeEnvironment` that contains:

- scoped bindings collected from the current file
- deferred constructor / initializer binding candidates
- lookup helpers used by call resolution
- pattern override data for branch-local narrowing where supported

### Scope model

The environment is scope-aware so identical variable names in different functions do not collide.

```text
File scope ('')
├── config → Config
├── users → Map
│
├── processUsers@100
│   ├── user → User
│   └── alias → User
│
└── processRepos@200
    └── repo → Repo
```

### Scope keys

- `''` for file scope
- `functionName@startIndex` for function-local scope

These scope keys are also used later when verifying deferred bindings in call processing, so any future change to scope-key format must stay consistent across both layers.

---

## Lookup Semantics

`TypeEnvironment.lookup()` resolves types in this effective order:

1. special receivers
   - `this`, `self`, `$this` → enclosing class
   - `super`, `base`, `parent` → parent class
2. position-indexed pattern overrides
3. function-local scope
4. file-level scope

Special receivers are handled as a dedicated fast path rather than ordinary lexical bindings.

---

## Resolution Tiers

Bindings are collected during the same AST walk. Higher-confidence sources win over weaker inference.

### Tier 0: Explicit Type Annotations

Direct extraction from AST type nodes.

```typescript
// TypeScript
const user: User = getUser()

// Java
User user = getUser()

// Go
var user User

// Rust
let user: User = get_user()

// Python
user: User = get_user()
```

`extractDeclaration()` reads the declaration type node and normalizes it through `extractSimpleTypeName()`.

Parameters are handled separately by `extractParameter()` using the same normalization logic. The shared `TYPED_PARAMETER_TYPES` set controls which AST node types are treated as typed parameters.

### Tier 0b: For-Loop Element Type Resolution

Also referred to as **Tier 1c** in Phase 6 PR and test naming.

For-each style loops often introduce a variable with no explicit type. In those cases, the resolver derives the loop variable type from the iterable's container type.

```csharp
foreach (var user in users) { user.Save(); }

// TypeScript
for (const user of users) { user.save(); }

// Rust
for user in users { user.save(); }
```

This is handled by `resolveIterableElementType()` through a three-step cascade:

1. **Declaration type nodes**  
   Uses raw type annotation nodes when available, including cases such as `User[]` or `List[User]`.

2. **Scope environment string**  
   Uses `extractElementTypeFromString()` to parse a stored type string.

3. **AST walk fallback**  
   Walks upward to enclosing declarations or parameters when needed.

### Tier 0c: Pattern Binding

Pattern-matching constructs may introduce a new variable or temporarily narrow an existing one.

```csharp
if (obj is User user) { user.Save(); }

// Java
if (obj instanceof User user) { user.save(); }

// Rust
if let Some(user) = opt { user.save(); }

// Python
match obj:
    case User() as user:
        user.save()
```

Binding behavior depends on the language:

- **first-writer-wins** is used by default
- **position-indexed branch overrides** are used where branch-local narrowing must not leak between branches, most notably Kotlin

### Tier 1: Initializer / Constructor Inference

When there is no explicit annotation, the resolver can infer a type from the initializer.

```typescript
const user = new User()

// C#
var user = new User()

// Kotlin
val user = User()

// Go
user := User{}
ptr := &User{}
user2 := new(User)

// Ruby
user = User.new
```

Some languages can identify constructor-like syntax directly. Others need validation through the `SymbolTable`, because syntax alone cannot always distinguish `User()` from `getUser()`.

In those cases the system records an unverified binding candidate and later validates it against known class / struct symbols.

### Tier 2: Assignment Chain Propagation

Bindings can propagate through simple identifier assignments.

```typescript
const user: User = getUser()
const alias = user
const other = alias
```

This is handled after the main walk through a unified fixpoint loop over all pending assignments (copy, callResult, fieldAccess, methodCallResult). The loop iterates until no new bindings are produced (max 10 iterations), enabling arbitrary-depth mixed chains and reverse-order resolution:

```typescript
const b = a              // iteration 2: b → User (a now resolved)
const a: User = getUser()  // iteration 1: a → User
```

Both `a` and `b` resolve correctly. The fixpoint also handles chains mixing field access and method calls:

```typescript
const user = getUser()       // callResult → User
const addr = user.address    // fieldAccess → Address
const city = addr.getCity()  // methodCallResult → City
```

---

## Container Type Descriptors

`CONTAINER_DESCRIPTORS` defines the type-parameter semantics for common containers.

That allows the resolver to distinguish key-yielding methods from value-yielding methods instead of always assuming the last generic argument.

```typescript
for (const key of map.keys()) { ... }    // key → string
for (const val of map.values()) { ... }  // val → User
```

Unknown containers fall back to heuristics, keeping the system conservative rather than fully semantic.

### Examples of descriptor-driven behavior

- `Map<K, V>` / `Dictionary<K, V>` / similar key-value containers
- `List<T>` / `Array<T>` / `Vec<T>` / `Set<T>` / similar single-element containers
- method-aware yield selection such as `.keys()`, `.values()`, `.keySet()`, `.Values`

---

## Comment-Based Types

For less strictly typed ecosystems, the resolver can fall back to documentation-based type information.

Supported comment systems:

- **JSDoc** for JavaScript / TypeScript
- **PHPDoc** for PHP
- **YARD** for Ruby

These are used conservatively and only when AST-level type information is missing or insufficient.

---

## SymbolTable Interaction

Although the environment is built per file, it may consult the global `SymbolTable` in specific validation paths.

This is important for languages where constructor-like syntax is ambiguous. A binding candidate such as `val user = User()` may need confirmation that `User` is a class-like symbol rather than an ordinary function.

This means the system is still **per-file in binding construction**, but not completely isolated from project-wide symbol knowledge.

---

## Deferred Binding Verification in Call Processing

A key detail is that some initializer bindings are not fully resolved inside `TypeEnv` itself.

`call-processor.ts` later verifies deferred bindings and may infer receiver types from:

- validated class / struct constructor candidates
- uniquely resolved function or method calls that expose a usable return type

So return-type-aware receiver inference already exists in a constrained downstream form today. Phase 7.3 extended this by threading `ReturnTypeLookup` into `TypeEnv` via `ForLoopExtractorContext`, enabling for-loop call-expression iterables (e.g., `for (const u of getUsers())`) to resolve element types in 7 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP). Phase 9 activated simple call-result binding (`var x = f()`) across all 11 supported languages (Swift excluded). Phase 9C replaced the sequential Tier 2b/2a with a unified fixpoint loop that handles four binding kinds — `callResult`, `copy`, `fieldAccess`, and `methodCallResult` — iterating until no new bindings are produced. This enables arbitrary-depth mixed chains like `const user = getUser(); const addr = user.address; const city = addr.getCity(); city.save()`.

---

## Language Feature Matrix

| Feature | TS | JS | Java | Kotlin | C# | Go | Rust | Python | PHP | Ruby | Swift | C++ | C | Dart |
|---------|:--:|:--:|:----:|:------:|:--:|:--:|:----:|:------:|:---:|:----:|:-----:|:---:|:-:|:----:|
| Declarations | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Parameters | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Initializer / constructor inference | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Constructor binding scan | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| For-loop element types | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes††† | Yes | Yes | Yes |
| Pattern binding | Yes | Yes | Yes | Yes | No | Yes | Yes | No | No | No | Partial‡‡‡ | No | No | No |
| Assignment chains | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes | Yes | Yes | Yes |
| Field/property type resolution | Yes | No† | Yes | Yes | Yes | Yes | Yes | Yes* | Yes | YARD | No | Yes | No‡ | No |
| Comment-based types | JSDoc | JSDoc | No | No | No | No | No | No | PHPDoc | YARD | No | No | No | No |
| Return type extraction | JSDoc | JSDoc | No | No | No | No | No | No | PHPDoc | YARD | No | No | No | No |
| Call-result variable binding | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes¶ | Yes††† | Yes | No | Yes |
| Field access binding | Yes | No† | Yes | Yes | Yes | Yes | Yes | No‖ | Yes | N/A | Yes††† | Yes | No | Yes |
| Method-call-result binding | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes¶ | Yes††† | Yes | No | Yes |
| Write access (ACCESSES write) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes§ | Yes | Yes | Yes | No | Yes |
| Parameter types extracted | Yes** | No | Yes | Yes | Yes | Yes | Yes | Partial†† | No | No | No | Yes | No | No |
| Method overload disambiguation | Yes** | No | Yes | Yes | Yes | No | No | No | No | No | No | Yes | No | No |
| Constructor-visible virtual dispatch | Yes | No | Yes | Yes‡‡ | Yes | No | No | No | No | No | No | Yes§§ | No | Yes |
| Optional parameter arity resolution | Yes | No | No | Yes | Yes | No | No | Yes | Yes | Yes | No | Yes | No | No |
| Cross-file binding propagation | Yes | Yes | Yes‖‖ | Yes | Yes¶¶ | Yes*** | Yes | Yes | Partial | Yes*** | Yes*** | Yes*** | Yes*** | Yes*** |

\* Python class-level annotated attributes (`address: Address`) now resolve `declaredType` correctly. The `self.x` instance attribute pattern is not yet supported.

† JS field topology is captured (`field_definition` → `HAS_PROPERTY` edges) but `declaredType` is never set — JS has no AST type annotations. Disambiguation via `lookupFieldByOwner` requires `declaredType`. JSDoc `@type` support is a Phase 9 candidate.

‡ C has no `@definition.property` query pattern. Struct member fields are not captured. C++ captures class/struct member fields via `field_declaration`.

¶ Ruby call-result and method-call-result binding work via `call`/`method_call` nodes. Ruby uses method calls for both field access and method calls — there is no separate field access node type.

‖ Python class-level annotated attributes (`address: Address`) have `declaredType`, but `self.x` instance attributes do not. Field access binding only works for class-level annotated fields.

**Note on `this`/`self`/`$this` receivers:** Field access and method-call-result binding with `this`/`self`/`$this` as the receiver do not resolve in the fixpoint loop because these keywords are not stored in `scopeEnv`. They are resolved on-demand at call sites via `findEnclosingClassName()` AST walk. This is consistent across all languages and not a regression.

§ PHP write access covers instance property writes (`$obj->field = value`) and static property writes (`ClassName::$field = value`). Nullsafe writes (`$obj?->field = value`) are not tracked because this is invalid PHP syntax — null-safe member access on the left-hand side of assignment is a parse error.

\*\* TS: `parameterTypes` populated with `inferLiteralType` for overload disambiguation. TS overloads share one implementation body (generateId collision), but disambiguation selects the correct candidate.

†† Python: parameter types extracted only with PEP 3107 type annotations (`def f(x: int)`).

‡‡ Kotlin virtual dispatch supported via `detectConstructorType` hook — detects `Dog()` constructor calls (no `new` keyword) by verifying callee against `ClassNameLookup`.

§§ C++ smart pointer virtual dispatch supported for `make_shared<T>()`/`make_unique<T>()` factory patterns. Raw pointer `new` also supported.

‖‖ Java: `import static X.Y.method` now captured. Ambiguous static imports (same name from multiple classes) fall through to Tier 2a for arity narrowing. Non-static lowercase imports still skipped (package imports).

¶¶ C#: `using static NS.Type;` now captured (last segment as class binding). Non-alias `using NS;` still unsupported — namespace imports can't be reduced to per-symbol bindings without type inference.

††† Swift: `extractPendingAssignment` handles `callResult`, `methodCallResult`, `fieldAccess`, and `copy` bindings. `if let` / `guard let` optional bindings supported via `extractIfGuardBinding`. `await` / `try` expression wrappers are unwrapped before RHS analysis. For-loop element type extraction supports `[User]` array sugar and `Array<User>` generics. See `swift-ingestion-gaps.md` for remaining limitations.

‡‡‡ Swift: `if let` / `guard let` optional bindings supported. `while let`, `switch` / `case` pattern matching, and tuple destructuring not yet implemented.

\*\*\* Whole-module-import languages (Go, Ruby, C/C++, Swift): namedImportMap entries synthesized from graph-exported symbols via `synthesizeWildcardImportBindings()`. Not from import AST node extraction.

---

## Current Strengths

The current system provides strong value for call resolution because it combines:

- explicit annotation extraction across 13 languages
- generic-aware loop element typing (including call-expression iterables)
- initializer-based inference with SymbolTable validation
- selected pattern-based narrowing
- scope-aware lookups
- comment-based fallbacks for dynamic ecosystems (JSDoc, PHPDoc, YARD)
- constrained return-type-aware receiver inference in call processing
- deep field/property chains up to 3 levels across 9 languages
- ACCESSES edge emission for field read access (via chain walking) and field write access (via assignment capture) across 12 languages
- mixed field+method chain resolution (e.g. `svc.getUser().address.save()`)
- type-preserving stdlib passthrough for `unwrap()`, `clone()`, `expect()`, etc.
- method overload disambiguation via argument literal types (Java, Kotlin, C#, C++)
- constructor-visible virtual dispatch for same-file subclasses (Java, C#, TypeScript, C++, Kotlin)
- optional/default parameter arity resolution — calls with omitted optional args still resolve (TS, Python, Kotlin, C#, C++, PHP, Ruby)
- cross-file binding propagation across all 13 languages — named import extraction for languages with per-symbol imports, wildcard import synthesis for whole-module-import languages (Go, Ruby, C/C++, Swift)

This is enough to materially improve call-edge precision even without implementing a full static type system.

---

## Current Limitations

Important gaps still remain:

- no general cross-file propagation of inferred bindings
- `this`/`self`/`$this` receivers are not resolved in the fixpoint loop (resolved on-demand at call sites via AST walk instead)
- limited branch-sensitive narrowing outside selected pattern constructs
- limited Swift support compared with other languages (see `swift-ingestion-gaps.md`)
- no complete destructuring-based field typing
- no MRO/inheritance walking for field lookups (`lookupFieldByOwner` is direct-only)
- for-loop variables bound at walk time cannot see fixpoint-resolved types (Phase 9B gap)
- overloaded same-file methods share a graph node ID (generateId collision) — CALLS edges deduplicate to one per callee name

---

## Contributor Notes

When modifying this system, treat the following as load-bearing invariants:

1. **Conservatism matters more than recall**  
   A missed binding is usually safer than a misleading receiver type.

2. **Scope-key format is shared behavior**  
   If scope keys change, constructor-binding verification and any downstream lookup using those keys must change in sync.

3. **Tier naming may differ across code and PR discussions**  
   For-loop element inference may appear as "Tier 0b" in documentation and "Tier 1c" in Phase 6 PR / test naming.

4. **Comment-based types are fallback signals, not primary truth**  
   They should remain lower-trust than explicit AST-derived types.

5. **Return-type-aware inference already exists in constrained form**  
   Future roadmap work should extend and generalize it rather than reintroduce it from scratch.
