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
    // PR #1598: ADL free-function reference arg negative fixtures rely on
    // scope-resolver-only correctness. The legacy DAG falls back to
    // `pickUniqueGlobalCallable` which resolves the callee by simple-name
    // workspace lookup, ignoring argument analysis. These fixtures expect
    // zero CALLS edges (the registry-primary path correctly avoids a false-
    // positive), but the legacy path emits one edge via the global fallback.
    // Scope-resolver-only correctness wins; backporting is out of scope.
    'process(data::value) emits zero CALLS edges \u2014 data::value is a variable, not a function',
    'run_with(callback) emits zero CALLS edges when callback is a parameter, not a function reference',
    // PR #1599 adversarial review findings: nearest-scope ADL blocker
    // semantics and block-scope function declaration ADL suppression are
    // scope-resolver-only. The legacy DAG has no scope-aware ADL blocker
    // detection; it falls back to `pickUniqueGlobalCallable`. Scope-
    // resolver-only correctness wins; backporting is out of scope.
    'swap(a,b) resolves to data::swap when inner scope has callable swap and outer has variable',
    'record(e) emits zero CALLS when a block-scope function declaration exists',
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
