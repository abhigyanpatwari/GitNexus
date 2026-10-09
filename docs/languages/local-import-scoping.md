# Local import scoping

GitNexus resolves statically known local imports through their lexical owner and
actual declaration identity. A nearer name that is unresolved, unavailable, or
noncallable blocks an unrelated outer or workspace fallback. An absent name can
continue through the existing lookup rules. This is static analysis: it does not
execute loaders or infer arbitrary runtime initialization order.

## Shared contract

Language rules stay in providers. The shared
[name-claim lookup](../../gitnexus-shared/src/scope-resolution/name-claims.ts)
distinguishes `absent`, `blocked`, and `resolved` before filtering by target kind.
Its [regressions](../../gitnexus/test/unit/scope-resolution/lexical-name-claims.test.ts)
cover noncallable barriers, unresolved imports, type/value lookup, declaration
positions, and inferred aliases that retain their initializer's lookup position.
Calls, constructors, receiver/type inference, inheritance, namespace lookup, and
fallback consumers use these ownership facts rather than independently choosing a
same-named symbol.

The [shared records](../../gitnexus-shared/src/scope-resolution/types.ts) carry
ownership, activation positions, directive destinations, and lookup purpose as
serializable data. They retain declaration identity and ambiguity; they contain
no AST nodes or callbacks. `declaredAtScope` describes ownership, while
`runsOnlyWhenCalled` describes deferred execution. A function-local Rust `use` or
C `#include` is not deferred merely because of its position; Python and Ruby
loading can be. The
[function-local import chain tests](../../gitnexus/test/unit/scope-resolution/function-local-import-chain.test.ts)
pin that distinction.

## Providers with expanded lexical support

These seven entries are part of the
[18-provider registry](../../gitnexus/src/core/ingestion/languages/index.ts).
The evidence links cover exact targets and negative cases, not just edge counts.

| Provider | Supported behavior | Source and regression evidence |
| --- | --- | --- |
| Python | Function-local named, aliased, and namespace imports; compiler-local ownership; ordered class lookup; `global`/`nonlocal` destinations. | [Lexical facts](../../gitnexus/src/core/ingestion/languages/python/lexical-bindings.ts), [local imports](../../gitnexus/test/unit/scope-resolution/python/python-local-imports.test.ts), [namespace semantics](../../gitnexus/test/integration/resolvers/python-namespace-semantics.test.ts) |
| TypeScript | Literal genuine `require`, immediately awaited `import`, and import-equals; namespace, named, and renamed bindings; type/value separation. | [Loader collector](../../gitnexus/src/core/ingestion/languages/typescript/local-loaders.ts), [loader tests](../../gitnexus/test/unit/scope-resolution/typescript/local-loader-imports.test.ts), [type ownership](../../gitnexus/test/unit/scope-resolution/typescript/lexical-type-ownership.test.ts) |
| JavaScript | The same supported runtime loaders and lexical barriers, using JavaScript captures for JS/JSX. | [Captures](../../gitnexus/src/core/ingestion/languages/javascript/captures.ts), [JS/JSX loader cases](../../gitnexus/test/unit/scope-resolution/typescript/local-loader-imports.test.ts) |
| Vue | Local loader facts in extracted scripts, with original declaration graph positions preserved. Explicit JS/JSX uses its own semantic grammar inside the worker; TS reuses the cached tree. | [Script delegation](../../gitnexus/src/core/ingestion/languages/vue/captures.ts), [direct/pre-extracted parity](../../gitnexus/test/unit/scope-resolution/typescript/local-loader-imports.test.ts), [real workers](../../gitnexus/test/integration/local-import-worker-parity.test.ts) |
| Rust | Lexical `use`, producer identity for imported factories/types, and Cargo-aware crate/module identity. Unresolved explicit imports block unrelated fallback. | [Lexical facts](../../gitnexus/src/core/ingestion/languages/rust/lexical-bindings.ts), [import targets](../../gitnexus/src/core/ingestion/languages/rust/import-target.ts), [local scope](../../gitnexus/test/integration/resolvers/rust-import-scope.test.ts), [Cargo boundaries](../../gitnexus/test/integration/resolvers/rust-cargo-target-fallback.test.ts) |
| C++ | Position-sensitive local `using` declarations/directives, separate from includes; propagated header claims retain unresolved named `using` barriers. | [Captures](../../gitnexus/src/core/ingestion/languages/cpp/captures.ts), [local using](../../gitnexus/test/integration/resolvers/cpp-local-using.test.ts), [header using](../../gitnexus/test/integration/resolvers/cpp-local-using-headers.test.ts) |
| Zig | Literal `@import` namespace/member bindings, block activation, container hoisting, stable deep aliases, and inline `@import` receivers. | [Captures](../../gitnexus/src/core/ingestion/languages/zig/captures.ts), [local imports](../../gitnexus/test/integration/resolvers/zig-local-imports.test.ts), [static gating](../../gitnexus/test/integration/resolvers/zig-static-gating.test.ts) |

### Python boundaries

Compiler-local binders include parameters, assignment patterns, loop/with/except
targets, match captures, augmented assignment, deletion, and comprehension/walrus
bindings. Comprehension targets do not leak, and the first iterable is evaluated
outside the comprehension environment. Class bodies use ordered locals; methods
skip class locals for bare-name lookup while explicit instance receivers remain
available. Annotation-only declarations distinguish compiler ownership from a
runtime store. These cases are characterized in the
[Python local-import tests](../../gitnexus/test/unit/scope-resolution/python/python-local-imports.test.ts).

Mixed import/value rebinding and conflicting import identities conservatively
abstain throughout the environment, including simple sequential rebinding; this
is not a control-flow evaluator. A definite `def`/`class` declaration can still
supply its own target after activation. The
[provider policy](../../gitnexus/src/core/ingestion/languages/python/lexical-bindings.ts)
and [rebinding regressions](../../gitnexus/test/integration/resolvers/python-namespace-semantics.test.ts)
define this boundary. There is no full annotation evaluator, `exec` evaluation,
or general closure scheduling model. A deferred `global`/`nonlocal` installer is
not assumed to have executed for unrelated callers.

Default expressions look up names in the enclosing environment. FastAPI's
synthetic dependency graph caller is recorded separately as `callerScope`; it
does not move lexical lookup into the handler body. Both
[direct extraction](../../gitnexus/test/unit/scope-resolution/python/python-local-imports.test.ts)
and [worker transport](../../gitnexus/test/integration/local-import-worker-parity.test.ts)
check this distinction.

### JavaScript-family boundaries

Loader recognition checks AST shape and binding identity, including parameters,
catch/destructuring bindings, temporal-dead-zone ownership, and writes to the
loader or imported handle. CommonJS forwarding uses that same identity check.
Unawaited dynamic imports remain Promise/file-dependency facts rather than module
namespace aliases. Computed specifiers, indirect loader/Promise chains, and
unsupported destructuring remain unresolved; see the
[loader regressions](../../gitnexus/test/unit/scope-resolution/typescript/local-loader-imports.test.ts).

Vue's explicit JS/JSX script requires an additional bounded semantic parse because
the worker's structural tree uses TypeScript. That parse runs inside the real
worker. The [parity test](../../gitnexus/test/integration/local-import-worker-parity.test.ts)
witnesses returned worker facts; a main-thread fallback does not satisfy it.

### Rust, C++, and Zig boundaries

Rust uses Cargo editions, target roots, and module identities, including files
with multiple valid identities. Reusable per-analysis indexes bound repeated
lookup work; this is not a claim of a global indexing speedup. See
[Cargo metadata](../../gitnexus/src/core/ingestion/languages/rust/cargo-targets.ts)
and its [tests](../../gitnexus/test/unit/scope-resolution/rust-cargo-targets.test.ts).
Exact same-name inline `pub use` forwarding is supported. A forwarding alias that
changes symbol spelling through a file-only target conservatively remains
unresolved; ambiguous same-file homonyms and re-export cycles cannot select an
unrelated declaration. These limits are explicit in the
[Cargo fallback regressions](../../gitnexus/test/integration/resolvers/rust-cargo-target-fallback.test.ts).
Inferred receiver types retain their receiving declaration range. When same-block
shadowing replaces a retained type fact, earlier uses cannot consume the later
declaration's type and may remain unresolved; this is not full SSA inference. See
the [factory ownership regressions](../../gitnexus/test/unit/scope-resolution/rust/rust-range-binding-order.test.ts).

C++ includes keep their compilation-unit behavior alongside lexical `using`.
The header tests cover literal includes, declaration positions, unresolved named
using claims, and overload identity. They do not establish a full preprocessor,
namespace-alias evaluator, or arbitrary transitive `using namespace` chain support.
Zig nonliteral imports remain unresolved; its block-local names do not escape or
activate before their declarations.

## Retained provider behavior

The other eleven providers retain their existing import/loading models. This
work does not reinterpret every dependency construct as a local value import.

| Provider | Retained model and boundary | Evidence |
| --- | --- | --- |
| Ruby | Wildcard loading; method-local loading is deferred. The extractor recognizes string arguments to `require`, `require_relative`, and `load`. The linked behavioral tests establish `require`/`require_relative` and deferral, not arbitrary `load` execution. | [Extractor](../../gitnexus/src/core/ingestion/languages/ruby/captures.ts), [loading](../../gitnexus/test/integration/resolvers/ruby-scope.test.ts), [deferral](../../gitnexus/test/unit/scope-resolution/function-local-import-chain.test.ts) |
| PHP | Namespace `use` imports are distinct from closure capture and trait `use`. The scope provider does not propagate names through `include`/`require`. | [Query](../../gitnexus/src/core/ingestion/languages/php/query.ts), [ownership](../../gitnexus/src/core/ingestion/languages/php/simple-hooks.ts), [resolver coverage](../../gitnexus/test/integration/resolvers/php.test.ts) |
| C | Header includes remain preprocessor/compilation-unit dependencies, including includes written inside functions; no full preprocessing is added. | [Include interpretation](../../gitnexus/src/core/ingestion/languages/c/interpret.ts), [include tests](../../gitnexus/test/unit/scope-resolution/c/c-imports.test.ts), [deferral boundary](../../gitnexus/test/unit/scope-resolution/function-local-import-chain.test.ts) |
| Objective-C | Headers, modules, and compilation-unit siblings retain the dedicated provider rules. | [Provider guide](objective-c-provider.md), [resolver](../../gitnexus/src/core/ingestion/languages/objective-c/scope-resolver.ts), [workspace tests](../../gitnexus/test/unit/scope-resolution/objective-c/objc-workspace.test.ts) |
| COBOL | `COPY` stays on the dedicated copybook path with module ownership. | [Interpretation](../../gitnexus/src/core/ingestion/languages/cobol/interpret.ts), [COPY target parity](../../gitnexus/test/unit/scope-resolution/cobol-import-target-parity.test.ts) |
| Go | File imports and package sibling visibility retain separate provider rules. | [Import ownership](../../gitnexus/src/core/ingestion/languages/go/simple-hooks.ts), [imports](../../gitnexus/test/unit/scope-resolution/go/go-imports.test.ts), [package siblings](../../gitnexus/test/unit/scope-resolution/go/go-package-siblings.test.ts) |
| Java | Imports belong to the compilation unit. | [Ownership](../../gitnexus/src/core/ingestion/languages/java/simple-hooks.ts), [named/wildcard import resolution](../../gitnexus/test/integration/resolvers/java.test.ts) |
| Kotlin | File import headers retain their existing alias/package resolution. | [Header decomposition](../../gitnexus/src/core/ingestion/languages/kotlin/import-decomposer.ts), [resolver tests](../../gitnexus/test/integration/resolvers/kotlin.test.ts) |
| C# | Namespace/file `using` directives remain imports; resource `using` statements are not import directives. | [Directive query](../../gitnexus/src/core/ingestion/languages/csharp/query.ts), [import tests](../../gitnexus/test/unit/scope-resolution/csharp/csharp-imports.test.ts) |
| Swift | Imports and target/module visibility retain provider ownership. | [Ownership](../../gitnexus/src/core/ingestion/languages/swift/simple-hooks.ts), [import decomposition](../../gitnexus/test/unit/scope-resolution/swift/import-decomposer.test.ts), [target siblings](../../gitnexus/test/unit/scope-resolution/swift/target-siblings.test.ts) |
| Dart | Library imports retain existing package identity and visibility rules. | [Ownership](../../gitnexus/src/core/ingestion/languages/dart/simple-hooks.ts), [library/package regressions](../../gitnexus/test/integration/resolvers/dart.test.ts) |

## Taint provenance

Taint source, sink, and sanitizer matching uses the same lexical provenance.
A genuine external import may match its raw module name even when that package
has no indexed source. A sibling import, local shadow, or type-only import cannot
authorize that match. General copied-handle tracking is outside this support.
The [taint regressions](../../gitnexus/test/unit/taint/lexical-imports.test.ts)
cover extraction, emission, and function summaries, including abstention when
exact call-site positions are missing.

## Cache migration and verification evidence

[Parse-cache schema 134](../../gitnexus/src/storage/parse-cache.ts) replaces 133
for these facts. The same version gate applies to the
[durable ParsedFile store](../../gitnexus/src/storage/parsedfile-store.ts).
Incompatible records are rejected and rebuilt on the next analysis; unchanged
records can then be reused. The
[schema regression](../../gitnexus/test/unit/incremental-parse-cache.test.ts)
explicitly rejects valid schema-133 records in both stores.

The [real-worker parity suite](../../gitnexus/test/integration/local-import-worker-parity.test.ts)
witnesses worker boot, dispatch, and returned ParsedFiles, then compares complete
provider facts with direct extraction, including `callerScope` and C++ side-channel
data. Optional grammar availability is explicit in the test gate.

The [persistence suite](../../gitnexus/test/integration/resolvers/local-import-persistence.test.ts)
loads both stores afresh from disk. Its parse-cache chunks contain no embedded
ParsedFiles, so warm equality requires durable-store reuse. It checks identical
`CALLS`/`IMPORTS` identities with zero extraction and zero worker dispatch on an
unchanged warm run. Editing a local import target or shadowing `require` removes
the stale target, and a second warm run preserves the edited graph.

Both suites are in the [cross-platform manifest](../../gitnexus/scripts/cross-platform-tests.ts);
the [shard regression](../../gitnexus/test/unit/cross-platform-shard.test.ts)
ensures each is selected exactly once across the four Windows/macOS shards.
[CI](../../.github/workflows/ci-tests.yml) owns native execution on those systems;
Ubuntu's full suite discovers the tests normally. These are focused evidence
boundaries, not a statement that the final full suite or every platform has passed.

## Relationship to main and issue #3499

The integrated main baseline `50aa4be3` already includes #3502's nested Python
declaration ownership fix for the original #3499 case and #3504's aliased package
re-export fix. Their [Python integration coverage](../../gitnexus/test/integration/resolvers/python.test.ts)
and [module namespace coverage](../../gitnexus/test/unit/scope-resolution/python/python-module-namespace-construction.test.ts)
remain relevant. This branch extends that base with the lexical claims, provider
semantics, and persistence evidence described above. Issue coverage is **Related
#3499**; this document does not assert that all dynamic Python behavior is solved
or make an issue-status claim.
