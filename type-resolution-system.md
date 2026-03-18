# Type Resolution System

GitNexus's type resolution system maps variables to likely declared types across the supported languages so the ingestion pipeline can perform **receiver-constrained call resolution**.

When the code contains a call such as `user.save()`, the resolver tries to determine that `user` is a `User`, allowing call resolution to prefer `User#save` over unrelated methods such as `Repo#save`.

This system is designed to be:

- **Conservative** — it prefers missing a binding over introducing a misleading one
- **Single-pass** — bindings are collected during a single AST walk, with a limited post-pass for assignment propagation
- **Scope-aware** — function-local bindings are isolated from file-level bindings
- **Per-file** — the environment is built for one file at a time, though it may consult the global `SymbolTable` for validation in specific cases

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
- run fixpoint inference
- propagate inferred bindings across files as ordinary environment entries
- model deep field/property chains such as `user.address.city`
- guarantee resolution for every ambiguous construct

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

This is handled after the main walk through a single pass over pending assignments.

This supports simple forward propagation, but there is no iterative fixpoint step. For example:

```typescript
const b = a
const a: User = getUser()
```

will not resolve `b`.

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

So return-type-aware receiver inference already exists in a constrained downstream form today. Phase 7.3 extended this by threading `ReturnTypeLookup` into `TypeEnv` via `ForLoopExtractorContext`, enabling for-loop call-expression iterables (e.g., `for (const u of getUsers())`) to resolve element types in 7 languages (TS/JS, Java, Kotlin, C#, Go, Rust, Python, PHP). General assignment propagation (`var x = f()` binding the return type of `f` into the scope env) remains pending — the `pendingCallResults` infrastructure exists but is dormant until Phase 9.

---

## Language Feature Matrix

| Feature | TS/JS | Java | Kotlin | C# | Go | Rust | Python | PHP | Ruby | Swift | C/C++ |
|---------|:-----:|:----:|:------:|:--:|:--:|:----:|:------:|:---:|:----:|:-----:|:-----:|
| Declarations | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Parameters | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Initializer / constructor inference | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Constructor binding scan | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| For-loop element types | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Pattern binding | Yes | Yes | Yes | Yes | No | Yes | Yes | No | No | No | No |
| Assignment chains | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No | Yes |
| Comment-based types | JSDoc | No | No | No | No | No | No | PHPDoc | YARD | No | No |
| Return type extraction | JSDoc | No | No | No | No | No | No | PHPDoc | YARD | No | No |

---

## Current Strengths

The current system already provides strong value for call resolution because it combines:

- explicit annotation extraction
- generic-aware loop element typing
- initializer-based inference
- selected pattern-based narrowing
- scope-aware lookups
- comment-based fallbacks for dynamic ecosystems
- constrained return-type-aware receiver inference in call processing

This is enough to materially improve call-edge precision even without implementing a full static type system.

---

## Current Limitations

Important gaps still remain:

- no field / property type map for deep chains such as `user.address.city`
- no general cross-file propagation of inferred bindings
- no fixpoint inference
- limited branch-sensitive narrowing outside selected pattern constructs
- limited Swift support compared with other languages
- no complete destructuring-based field typing
- no broad expression-level return-type propagation inside `TypeEnv` (for-loop call-expression iterables are resolved in 7 languages via `ReturnTypeLookup`, but general `var x = f()` assignment propagation is pending)

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
