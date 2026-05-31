/**
 * Shared test helpers for language resolution integration tests.
 */
import path from 'path';
import { it as vitestIt } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineOptions } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import type { GraphRelationship } from 'gitnexus-shared';

const LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES: Readonly<Record<string, ReadonlySet<string>>> = {
  c: new Set([
    // The legacy DAG path does not resolve the main → create_service call
    // because the function prototype in the .h file and the definition in
    // the .c file create a dedup ambiguity. The registry-primary path
    // resolves it via scope-based wildcard import binding.
    'emits CALLS edges for cross-file function calls',
    // The legacy DAG path does not resolve cross-file calls through
    // #include → prototype chains. The scope-based path resolves
    // caller.c → b.h → public_b via wildcard import binding +
    // isFileLocalDef filtering of static functions.
    'caller.c calls b:helper via include, NOT a:static helper',
  ]),
  csharp: new Set([
    'emits the using-import edge App/Program.cs -> Models/User.cs through the scope-resolution path',
    // Generic type-argument USES edges are emitted by the registry-primary
    // resolver only; the legacy DAG path does not synthesize these references.
    'emits USES edges for generic type arguments',
  ]),
  go: new Set([
    // The legacy DAG path does not resolve method calls when the method is
    // defined in a different file from the receiver type (go-split-method-owner
    // fixture). This requires scope-based cross-file package-sibling resolution
    // which is only available in the registry-primary path.
    'resolves user.Save() to the method whose receiver type is declared in another package file',
  ]),
  java: new Set([
    // Duplicate-FQN same-module path-affinity ordering is implemented in the
    // Java provider hook for the scope-resolution path. Legacy DAG parity runs
    // still use legacy owner/type resolution behavior and can bind cross-module.
    'resolves Module1App.run calls to module1 UserService, not module2',
    'resolves Module2App.run calls to module2 UserService, not module1',
  ]),
  php: new Set([
    // Arity-narrowing in `pickUniqueGlobalCallable` rejects free-call
    // candidates that are definitively below required-parameter-count. The
    // legacy DAG path does not narrow on arity, so it emits over-broad CALLS
    // edges for variadic functions invoked with too few args even though
    // the only candidate's required count is non-zero. Scope-resolver-only
    // correctness win (commit af9af4a9 U1); backporting to legacy is out
    // of scope.
    'does NOT emit CALLS edge for record() with zero args (below required=1)',
    'does NOT emit CALLS edge for pad() with zero args (below required=1)',
    // `$this->method()` precedence inside a class that composes a trait AND
    // extends a parent both defining the same method requires the augmented
    // trait-aware MRO (trait shadows parent). The legacy DAG has no
    // trait-aware MRO, so it fails to bind the call to the trait. Scope-
    // resolver-only correctness win (commit af9af4a9 U3).
    '$this->record() still resolves to Auditable::record (trait shadows parent)',
    // Fully-qualified type-hint resolution (`\App\Other\User $u` parameter)
    // routes through the scope-resolver's bindingAugmentations channel
    // populated by `populatePhpNamespaceSiblings` Step 3b. The legacy DAG
    // resolves receiver types via simple-name workspace lookup and has no
    // namespace-prefixed binding channel, so it cannot distinguish the FQN
    // target from a same-simple-name class reachable via `use`. Scope-
    // resolver-only correctness win (Codex PR #1497 review, finding 1).
    '\\App\\Other\\User parameter resolves $u->record() to app/Other/User.php (NOT app/Models/User.php)',
    // MRO arity-mismatch on class-name receivers (`Child::method(1)` where
    // Child::method takes 2 args and Parent::method takes 1): the legacy
    // DAG has no arity narrowing on Case 2 (class-name) MRO walk, so it
    // emits a false CALLS edge to Parent::method on fallthrough. Scope-
    // resolver-only correctness win (PR #1497 review Image 1 / U1).
    'arity-incompatible most-derived override does NOT fall through to ParentModel::method',
    // Class-name receiver with single-class arity mismatch (no parent in
    // the MRO chain): legacy resolves the method by name without arity
    // gating, so it emits a CALLS edge even when arity is definitively
    // incompatible. The scope-resolver's `narrowOverloadCandidates` check
    // in `receiver-bound-calls.ts` Case 2 rejects this post-fix. Scope-
    // resolver-only correctness win (PR #1497 / U1).
    'arity-incompatible class with no parent emits zero CALLS edges (regression check)',
    // `phpEmitUnresolvedReceiverEdges` exact-required-arity gate (PR
    // #1497 / U4): the legacy DAG has no equivalent unresolved-receiver
    // fallback hook, so it resolves these untyped-receiver sites via a
    // different code path that over-emits for default-parameter and
    // variadic-required-mismatch shapes. Scope-resolver-only correctness
    // wins; backporting to legacy is out of scope.
    'argCount > required (2>1) on candidate with default param emits NO edge post-fix',
    'variadic candidate, argCount < required (1<2) emits NO edge',
  ]),
  typescript: new Set([
    // Issue #1358 sub-cases: class-instance singleton (`export const foo = new Foo()`)
    // and factory-pattern singleton (`export const foo = makeFoo()`) cross-file
    // CALLS resolution. The scope-resolution path resolves these via
    // `@type-binding.constructor` capture (TS query) +
    // `propagateImportedReturnTypes` mirror + receiver-bound Case 4 simple
    // typeBinding lookup. The legacy DAG's typeEnv does not propagate
    // `new Foo()` constructor inference across module boundaries — verified
    // by `scope-parity / typescript parity` CI job failure. Node-existence
    // and HAS_METHOD edge assertions pass under legacy DAG (parser-level
    // emission is intact); only the cross-file CALLS edge resolution
    // requires the scope-resolution chain. Scope-resolver-only correctness
    // wins; backporting requires constructor-typeBinding cross-file
    // propagation in the legacy DAG.
    'resolves caller.fooService.getUser() to FooService.getUser via constructor-inferred typeBinding',
    'resolves caller.fooService.getUser() through the factory chain to FooService.getUser',
  ]),
  javascript: new Set([
    // Mirrors the TypeScript class-instance and factory-pattern singleton
    // resolution gates above. JavaScript fails on the same 2 CALLS-edge
    // resolution tests under `REGISTRY_PRIMARY_JAVASCRIPT=0` for the same
    // reason — no cross-file constructor-typeBinding propagation in the
    // legacy DAG path. Verified by `scope-parity / javascript parity` CI
    // job failure on the bare singleton tests before this exclusion landed.
    'resolves caller.fooService.getUser() to FooService.getUser via constructor-inferred typeBinding',
    'resolves caller.fooService.getUser() through the factory chain to FooService.getUser',
  ]),
  python: new Set([
    // Suffix-fallback lex tiebreak depends on the registry-primary
    // resolver's deterministic sort. The legacy resolver returns the
    // first match in `Set` iteration order, which is insertion-order
    // dependent and not aligned with this guarantee. Backporting the
    // sort to legacy is out of scope.
    'picks the lexicographically smaller path on equal-depth ties',
    'binds the call to alpha/services/sync.py, not omega',
    'lex tiebreak still picks alpha/services/sync.py with reversed file-write order',
  ]),
  kotlin: new Set<string>([
    // #1756 companion-vs-instance dispatch: the registry-primary path
    // suppresses `instance.companionMethod()` via `ScopeResolver.
    // isStaticOnly` (see `isKotlinStaticOnly` + the Case 4 filter in
    // `receiver-bound-calls.ts`). The legacy DAG has no equivalent
    // static-only gate — companion methods promoted onto the outer
    // class are also returned by `lookupMethodByOwner` when the
    // receiver is an instance, producing a false `CALLS` edge. Scope-
    // resolver-only correctness win; backporting to legacy is out of
    // scope per the migration policy (the bug stops mattering once
    // Kotlin enters `MIGRATED_LANGUAGES` and legacy stops running).
    'crossover() invoking logger.create() on an instance emits NO CALLS edge',
    // #1756 / U2 (remediation plan 2026-05-22-002) MRO shadow tests:
    // the registry-primary path filters static-only candidates INSIDE
    // the Case-4 MRO chain walk (`pickFirstNonStaticOnly` in
    // `receiver-bound-calls.ts`), so a derived class whose only
    // member is a companion-promoted static method falls through to
    // an ancestor's legitimate instance method; if no ancestor has
    // an instance method, no CALLS edge is emitted. The legacy DAG
    // returns the static-only companion method via
    // `lookupMethodByOwner` on the most-derived owner and emits a
    // false `CALLS` edge to it. Same scope-resolver-only correctness
    // class as the bare `crossover()` test above; backporting is out
    // of scope per the migration policy.
    'useChild() falls through static-only Child.foo to Base.foo',
    'useChild() does NOT emit an edge to the companion-promoted Child.foo',
    'useStandalone() emits no CALLS edge (entire chain is static-only)',
    // #1757 lambda scopes: the registry-primary path creates a Block
    // scope per `lambda_literal` and synthesizes scoped type-bindings
    // for the lambda parameter / implicit `it` (see
    // `synthesizeKotlinLambdaBindings` in `kotlin/captures.ts` plus
    // the `@type-binding.lambda-scoped` gate in
    // `kotlinBindingScopeFor`). This lets the body's call-resolution
    // chain see the chain-typebinding for the lambda's enclosing
    // call (`users.map { it.name }.forEach { name -> println(name) }`)
    // and emit the `chained -> println` edge correctly. The legacy DAG
    // has no lambda-body scope and no per-lambda type-binding
    // synthesis; calls inside lambdas resolve against the enclosing
    // function scope only, so the `name` parameter chain inside a
    // chained-receiver forEach lambda doesn't carry the right binding
    // and the call-extractor never emits the CALLS edge. Scope-
    // resolver-only correctness win; backporting requires re-modeling
    // lambda bodies as their own scopes in `call-processor.ts`, which
    // is out of scope per migration policy.
    'chained: println(name) inside forEach resolves to file-scope println',
    // #1756 / U4 (remediation plan 2026-05-22-002) named-companion
    // crossover: the registry-primary path stamps the static-only
    // marker on named-companion methods (via the new `@scope.companion`
    // marker capture and the updated `populateCompanionMembersOn
    // EnclosingClass` guard), so `instance.namedCompanionMethod()`
    // is filtered out at the `isStaticOnly` hook. The legacy DAG has
    // no static-only gate AND no named-companion-aware owner
    // promotion — it both leaves the named-companion method owned
    // by `Helper` AND emits a crossover edge when the call site uses
    // an instance receiver. Same scope-resolver-only correctness
    // class as the bare `crossover()` test; backporting is out of
    // scope per the migration policy.
    'useNamedCrossover: o.create() emits NO CALLS edge to create',
    // #1756 / U3 (remediation plan 2026-05-22-002) other-receiver
    // crossover: the registry-primary path applies the `isStaticOnly`
    // filter across Cases 0 (compound receiver), 3b (chain-typebinding),
    // and 5 (value-receiver bridge) of `receiver-bound-calls.ts`. For
    // the U3 fixture `kotlin-companion-other-cases/App.kt`, the
    // chain-typebinding crossover (`services.first().build()` on a
    // chain whose receiver type resolves through the legacy DAG's
    // unfiltered lookup) and the value-receiver crossover
    // (`l.create("nope")` where the legacy DAG binds `l` directly
    // via its receiver-resolution path) both emit false `CALLS`
    // edges to the companion-promoted static-only members. The
    // legacy DAG has no `isStaticOnly`-equivalent hook, so these
    // edges leak. Same scope-resolver-only correctness class as the
    // bare `crossover()` test and the U2 MRO-shadow tests above;
    // backporting is out of scope per the migration policy.
    'useChainTypeBindingCrossover: services.first().build() emits NO CALLS edge to build',
    'useValueReceiverCrossover: l.create("nope") emits NO CALLS edge to create',
  ]),
  ruby: new Set<string>([
    // Ruby scope-resolution currently achieves 89/127 parity.
    // Tests listed here are scope-resolver-only correctness wins
    // (pass under registry-primary, fail under legacy). Currently
    // empty — all 127 tests pass under legacy mode.
  ]),
  swift: new Set<string>([
    // Swift scope-resolution achieves 77/77 baseline parity. The tests
    // listed here are scope-resolver-only correctness wins from the U4
    // remediation (PR #1948): they PASS under registry-primary but FAIL
    // under the legacy DAG, which has no equivalent mechanism. Backporting
    // to legacy is out of scope per the migration policy. Each entry below
    // states the registry-primary mechanism and why legacy can't match.
    //
    // BUG1 read-edge: the legacy DAG emits a `read` ACCESSES edge only for
    // a field-access CHAIN that feeds a call (e.g. `user.address.save()`);
    // a STANDALONE field read (`let current = self.balance`) produces no
    // read ACCESSES under legacy. The scope-resolver emits it from the
    // reference-site `read` kind. (The write-edge and no-spurious-read
    // assertions DO pass both legs and are not skipped.)
    'still emits a read ACCESSES for a genuine standalone field read (not the write LHS)',
    // BUG2 class-func: the observable signal is the RESOLUTION PROVENANCE of
    // a `self.<property>` read inside a `class func` vs `static func` vs an
    // instance method. The legacy DAG cannot resolve these self-property
    // reads at all (it emits no ACCESSES for this fixture), so the
    // provenance-parity check is a scope-resolver-only correctness check.
    'a class func gets no instance self-binding (parity with static func; instance method differs)',
    // BUG3 second-binding: the second `if let` / `guard let` clause binding
    // (`b: makeB() -> B`) is inferred only by the scope-resolver's
    // per-clause `@type-binding.constructor` synthesis. The colliding
    // `B.shared` / `Decoy.shared` defeats a unique-name global fallback, so
    // legacy leaves `b.shared()` unresolved.
    'resolves b.shared() to B.shared via the SECOND if-let clause binding',
    'resolves b.shared() to B.shared via the SECOND guard-let clause binding',
    // BUG4 nested-extension self-call: `added` hoists onto Bar in both legs
    // (the HAS_METHOD assertion is NOT skipped), but resolving the
    // `self.base()` call to `Bar.base` (self == Bar, the trailing identifier
    // of `Foo.Bar`) depends on the scope-resolver's extension `self`
    // type-binding plus its cross-file self-dispatch; the legacy DAG leaves
    // the `self.base()` call unresolved for this fixture.
    'resolves self.base() inside added() to Bar.base (self == Bar), not Foo',
  ]),
  cpp: new Set<string>([
    // The legacy DAG path has no scope-aware filtering on the global
    // free-call fallback, so `#include`d headers still leak class
    // methods (`User::save`) and namespace members (`ns::foo`) as
    // resolution targets for unqualified calls. The scope-resolver
    // path filters via `populateCppNonGloballyVisible` +
    // `isFileLocalDef`. Scope-resolver-only correctness win
    // (PR #1520 review follow-up plan U1); backporting to legacy is
    // out of scope.
    'does NOT resolve unqualified save() to User::save via #include',
    'does NOT resolve unqualified foo() to ns::foo via #include',
    // The legacy DAG path lacks the OVERLOAD_AMBIGUOUS suppression
    // wired through `pickOverload` + `isOverloadAmbiguousAfterNormalization`,
    // so it arbitrarily picks the first overload when `f(int)` and
    // `f(long)` collide after C++ integer-width normalization. Scope-
    // resolver-only correctness win (PR #1520 review follow-up plan U2 /
    // Claude review Finding 5); backporting to legacy is out of scope.
    'emits zero CALLS edges when process(int)/process(long) collide after normalization',
    'records a structured suppression reason for normalization ambiguity',
    // The legacy DAG path resolves `using namespace a; using namespace b; foo()`
    // by walking the workspace registry by simple name and binding to
    // the first match — same shape as the integer-width collision, just
    // with namespace-resolution as the ambiguity source. Scope-resolver-
    // only correctness win (PR #1520 review follow-up plan U4 / Claude
    // review Finding 7); backporting to legacy is out of scope.
    'emits zero CALLS edges for ambiguous foo() bound via two using-namespace declarations',
    // The legacy DAG path lacks two-phase template lookup. Unqualified
    // calls inside a class template body bind to dependent-base members
    // there, producing CALLS edges the compiler would reject (ISO C++
    // two-phase name lookup). Scope-resolver-only correctness win
    // (PR #1520 review follow-up plan 2026-05-13-001 U3); backporting
    // is out of scope.
    'Derived<T>::g() -> f() does NOT bind to Base<T>::f (dependent base)',
    // The legacy DAG path does not apply merged ordinary+ADL narrowing
    // with ambiguity suppression.
    // When ADL surfaces multiple overloads that collide after C++
    // int/long normalization, legacy picks the first match arbitrarily.
    // The scope-resolver path suppresses in free-call-fallback after
    // merged-candidate overload narrowing. Scope-resolver-only
    // correctness win (PR #1520 review follow-up plan
    // 2026-05-13-001 U2); backporting is out of scope.
    'process(t, 42) emits zero CALLS edges when ADL surfaces process(Token,int)/process(Token,long) (collide after C++ int normalization)',
    // Legacy DAG path does not merge ordinary and ADL candidate sets for
    // non-empty ordinary lookup, so it misses ADL's better-match overload.
    'swap(a, b) prefers data::swap(Pair&, Pair&) over app::swap(int, int)',
    // The legacy DAG path has no qualified namespace-member resolver
    // and no inline-namespace awareness. For the versioned fixture
    // (`outer::v1::foo` inline, `outer::v0::foo` not), the registry-
    // primary path resolves `outer::foo()` to v1 via the inline
    // exemption; legacy can't see EITHER and emits zero edges. The
    // unqualified / nested fixtures coincidentally resolve in legacy
    // because their global free-call fallback picks the unique simple-
    // name match; the versioned fixture has two `foo`s and legacy can't
    // disambiguate. Scope-resolver-only correctness win (PR #1520
    // review follow-up plan 2026-05-13-001 U5); backporting is out of
    // scope.
    'outer::foo() resolves to outer::v1::foo (inline child), NOT outer::v0::foo',
    // Phase 5 cross-unit composition tests assert no false positives
    // for compositions where the legacy DAG over-resolves. The legacy
    // path has no template-arg-stripping qualified-receiver logic and
    // no two-phase dependent-base suppression, so it produces CALLS
    // edges where the registry-primary path correctly suppresses.
    // Scope-resolver-only correctness wins (PR #1520 review follow-up
    // plan 2026-05-13-001 Phase 5); backporting is out of scope.
    'emits EXTENDS edge: Derived → Base for template base Base<T>',
    'emits EXTENDS edges: Derived → A, Derived → B for template multi-base list',
    'Base<T>::method() resolves to Base::method inside template body',
    'unqualified f() inside Derived<T>::g() does NOT bind to outer::v1::Base<T>::f (dependent base across inline namespace)',
    'emits EXTENDS edge: Derived → Base for qualified template base outer::v1::Base<T>',
    'outer::v1::Base<T>::f() resolves to Base::f inside template body',
    'outer::v1::free_fn() resolves as a namespace free function, not a super-receiver method',
    // Template specialization owner identity currently relies on
    // class-template fingerprints in the registry-primary graph bridge.
    // Legacy DAG collapses specializations to the simple class name.
    'emits distinct Class nodes for List<User> and List<Order>',
    'callSave() in each specialization resolves to its own save()',
    'save specialization bodies route to their own sibling method',
    // PR #1590 follow-up: explicit `this->` resolution in template class
    // bodies and paired two-phase assertions are scope-resolver-only.
    // Legacy DAG lacks this receiver-bound template semantics and
    // dependent-base suppression parity for these shapes.
    'Derived<T>::g() -> this->f() resolves to f (1 edge)',
    'Derived<T>::k() -> this->base_method() resolves via EXTENDS chain (1 edge)',
    'Derived<T>::g_unqualified() -> f() does NOT bind to Base<T>::f',
    'Derived<T>::g_this() -> this->f() resolves to Base<T>::f (1 edge)',
    'Derived<T>::g() -> this->f() emits zero CALLS edges when only hidden derived overload is arity-incompatible',
    // Conversion-rank scoring (#1578 / #1606) disambiguates `f(int)` vs
    // `f(double)` by ranking exact match over standard conversion. The
    // legacy DAG has no conversion-rank scoring; it either picks
    // arbitrarily or leaves the call unresolved. Scope-resolver-only
    // correctness win.
    'f(2.5) resolves to f(double) — exact match beats standard conversion',
    'f(42) resolves to f(int) — exact match beats standard conversion',
    'g(42) emits zero CALLS edges — int/long normalize to same type, ambiguous',
    // char-literal promotion exercises the conversion ranker (step 4b).
    // Legacy DAG has no conversion-rank scoring. Scope-resolver-only.
    "p('a') resolves to p(int) — char promotion (rank 1) beats char→double conversion (rank 2)",
    // Multi-arg incomparable overloads: pairwise dominance check finds
    // neither h(int,int) nor h(double,double) dominates. Scope-resolver-only.
    'h(42, 2.5) emits zero CALLS edges — incomparable multi-arg overloads, ambiguous',
    'records a structured suppression reason for conversion-rank ties',
    // Pointer/nullptr/ellipsis conversion ranks (#1637) need C++ type-class
    // sidecars plus conversion-rank scoring. The legacy DAG has neither.
    'f(nullptr) and f(p) resolve to f(int*) while f(42) resolves to f(bool)',
    'g(1, 2) resolves to fixed-arity g(int, int), not g(int, ...)',
    "h(1, 'a') resolves to h(int, double), not h(int, ...)",
    'k(1, 2, 3) keeps the ellipsis overload viable when it is the only match',
    // Pack-expanded dependent bases (`struct Mix : B...`) are suppressed
    // at C++ scope-capture time in the registry-primary path. The legacy
    // DAG still sees same-file class-owned methods by simple name and
    // over-emits `Mix::run -> B::inherited`.
    'does not bind unqualified member lookup through a pack-expanded dependent base',
    // User-defined conversion ranking (#1631) builds on the C++
    // conversion-rank hook and the registry-primary C++ owner sidecars.
    // Legacy DAG has no user-defined-conversion sidecar or ranking path.
    'f(42) resolves to f(double) because standard conversion beats constructor UDC',
    'g(42) keeps a single constructor UDC viable when no standard conversion overload exists',
    'h(42) emits zero CALLS edges when two single-step constructor UDCs tie',
    'e(42) ignores the explicit-constructor overload and keeps the implicit UDC viable',
    'does not let beta::Token(int) tie the valid alpha::Other(int) conversion',
    // The legacy DAG path lacks the SFINAE / `requires`-clause aware
    // overload filter (issue #1579). The two `process<T>` overloads
    // guarded by mutually-exclusive `enable_if_t` predicates collapse
    // into false multi-candidate ambiguity → 0 CALLS edges. The
    // registry-primary path filters via `constraintCompatibility` and
    // emits exactly 2 edges (one per ISO-resolved overload). Scope-
    // resolver-only correctness win; backporting requires a constexpr
    // evaluation engine in the legacy DAG.
    'enable_if_t<is_integral_v<T>> overload binds only on integral call sites',
    'enable_if_t<is_floating_point_v<T>> overload binds only on floating call sites',
    'requires-clause overloads disambiguate same as enable_if_t (F4 AST shape)',
    'is_pointer_v and is_class_v disambiguate pointer vs class arguments',
    'is_reference_v keeps reference-shaped arguments distinct from values',
    'is_class_v rejects primitive arguments while keeping class arguments',
    'is_enum_v distinguishes known enum declarations from primitives',
    'is_const_v and is_volatile_v disambiguate cv-qualified locals',
    'is_void_v does not misclassify void pointers as void values',
    // The legacy DAG path has no inline-namespace same-name ambiguity
    // detection. When two inline children declare the same name, the
    // legacy path picks an arbitrary match. The scope-resolver returns
    // 'ambiguous' and suppresses edge emission. Scope-resolver-only
    // correctness win (#1564); backporting to legacy is out of scope.
    'outer::foo() emits zero CALLS edges when v1 and v2 both declare foo',
    'records a structured suppression reason for inline namespace ambiguity',
    // Distinct-signature inline-namespace ambiguity: `foo(int)` in v1 and
    // `foo(double)` in v2. PR #1810 threads call-site types through the
    // resolveQualifiedReceiverMember contract — resolved in both mode paths.
    // Legacy DAG emits an edge via the global callable fallback; the test
    // now expects 1 edge, so the old expected-failure entry is removed.
    // Normalized-signature ambiguity: `foo(int)` vs `foo(long)` both map to
    // `int` via normalizeCppParamType. Scope-resolver suppresses via
    // isOverloadAmbiguousAfterNormalization; legacy path picks arbitrarily.
    'outer::foo(42) emits zero CALLS edges when v1 declares foo(int) and v2 declares foo(long) — both normalize to int',
    // PR #1598: ADL free-function reference arg negative fixtures rely on
    // scope-resolver-only correctness. The legacy DAG falls back to
    // `pickUniqueGlobalCallable` which resolves the callee by simple-name
    // workspace lookup, ignoring argument analysis. These fixtures expect
    // zero CALLS edges (the registry-primary path correctly avoids a false-
    // positive), but the legacy path emits one edge via the global fallback.
    // Scope-resolver-only correctness wins; backporting is out of scope.
    'process(data::value) emits zero CALLS edges \u2014 data::value is a variable, not a function',
    'run_with(callback) emits zero CALLS edges when callback is a parameter, not a function reference',
    // PR #1633: strict function-type ADL no longer contributes the referenced
    // function's enclosing namespace. The legacy DAG still resolves these via
    // simple-name global fallback.
    'with_callback(utils::worker) emits zero CALLS edges when worker has no class parameter or return type',
    'with_callback(utils::worker) with overloaded utils::worker still emits zero CALLS edges',
    // PR #1599 adversarial review findings: nearest-scope ADL blocker
    // semantics and block-scope function declaration ADL suppression are
    // scope-resolver-only. The legacy DAG has no scope-aware ADL blocker
    // detection; it falls back to `pickUniqueGlobalCallable`. Scope-
    // resolver-only correctness wins; backporting is out of scope.
    'record(e) emits zero CALLS when a variable named record exists in scope',
    'records a structured suppression reason for ADL blocker lookup',
    'swap(a,b) resolves to data::swap when inner scope has callable swap and outer has variable',
    'record(e) emits zero CALLS when a block-scope function declaration exists',
    // PR #1634: sibling-namespace dependent-base suppression. The scope-resolver
    // correctly suppresses when detail::Inner and public_api::Inner share the
    // same simple name. The legacy DAG picks an arbitrary match.
    'Derived<T>::g() -> this->f_a() emits zero CALLS when detail::Inner and public_api::Inner are sibling namespaces (ambiguity suppressed)',
    // PR #1634: deep-nesting suppression. The scope-resolver enforces a
    // one-level cap on namespace walking. The legacy DAG picks arbitrarily.
    'Derived<T>::g() -> this->f() emits zero CALLS when Inner is two levels deep (ns.a.b) — one-level cap enforced',
    // Template partial ordering (#1635) relies on C++ parameter type-class
    // sidecars and scope-resolver overload narrowing. The legacy DAG does not
    // rank function-template shapes, so it leaves the call unresolved.
    'pick(T*) wins over pick(T) for pointer arguments',
  ]),
};

type ResolverParityEnv = Readonly<Record<string, string | undefined>>;
type VitestIt = typeof vitestIt;
type CallableIt = (name: string, ...args: unknown[]) => unknown;

export function resolverParityFlagName(languageSlug: string): string {
  return `REGISTRY_PRIMARY_${languageSlug.toUpperCase().replace(/-/g, '_')}`;
}

export function isLegacyResolverParityRun(
  languageSlug: string,
  env: ResolverParityEnv = process.env,
): boolean {
  const value = env[resolverParityFlagName(languageSlug)]?.trim().toLowerCase();
  return value === '0' || value === 'false' || value === 'no';
}

export function isLegacyResolverParityExpectedFailure(
  languageSlug: string,
  testName: string,
  env: ResolverParityEnv = process.env,
): boolean {
  if (!isLegacyResolverParityRun(languageSlug, env)) return false;
  return LEGACY_RESOLVER_PARITY_EXPECTED_FAILURES[languageSlug]?.has(testName) ?? false;
}

export function createResolverParityIt(languageSlug: string): VitestIt {
  const wrapped = ((name: string, ...args: unknown[]) => {
    const runner = isLegacyResolverParityExpectedFailure(languageSlug, name)
      ? vitestIt.skip
      : vitestIt;
    return (runner as unknown as CallableIt)(name, ...args);
  }) as VitestIt;

  Object.assign(wrapped, vitestIt);
  return wrapped;
}

export const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'lang-resolution');
export const CROSS_FILE_FIXTURES = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cross-file-binding',
);

export type RelEdge = {
  source: string;
  target: string;
  sourceLabel: string;
  targetLabel: string;
  sourceFilePath: string;
  targetFilePath: string;
  rel: GraphRelationship;
};

export function getRelationships(result: PipelineResult, type: string): RelEdge[] {
  const edges: RelEdge[] = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type === type) {
      const sourceNode = result.graph.getNode(rel.sourceId);
      const targetNode = result.graph.getNode(rel.targetId);
      edges.push({
        source: sourceNode?.properties.name ?? rel.sourceId,
        target: targetNode?.properties.name ?? rel.targetId,
        sourceLabel: sourceNode?.label ?? 'unknown',
        targetLabel: targetNode?.label ?? 'unknown',
        sourceFilePath: sourceNode?.properties.filePath ?? '',
        targetFilePath: targetNode?.properties.filePath ?? '',
        rel,
      });
    }
  }
  return edges;
}

export function getResolutionOutcomes(result: PipelineResult) {
  return result.resolutionOutcomes ?? [];
}

export function getNodesByLabel(result: PipelineResult, label: string): string[] {
  const names: string[] = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) names.push(n.properties.name);
  });
  return names.sort();
}

export function edgeSet(edges: Array<{ source: string; target: string }>): string[] {
  return edges.map((e) => `${e.source} → ${e.target}`).sort();
}

/** Get graph nodes by label with full properties (for parameterTypes assertions). */
export function getNodesByLabelFull(
  result: PipelineResult,
  label: string,
): Array<{ name: string; properties: Record<string, any> }> {
  const nodes: Array<{ name: string; properties: Record<string, any> }> = [];
  result.graph.forEachNode((n) => {
    if (n.label === label) nodes.push({ name: n.properties.name, properties: n.properties });
  });
  return nodes.sort((a, b) => a.name.localeCompare(b.name));
}

// Tests can pass { skipGraphPhases: true } as third arg for faster runs
// (skips MRO, community detection, and process extraction).
export { runPipelineFromRepo };
export type { PipelineOptions, PipelineResult };
