/**
 * Scope-chain lookup primitives shared across language providers.
 *
 * Five functions:
 *   - `findReceiverTypeBinding` — walk scope.typeBindings up the chain
 *     for a receiver name.
 *   - `lookupBindingsAt` — read finalized + augmented binding refs at
 *     one scope, deduped by `def.nodeId`. The dual-source-aware
 *     primitive every other binding lookup composes with.
 *   - `findClassBindingInScope` — walk scope.bindings + the indexes via
 *     `lookupBindingsAt` for a class-kind binding.
 *   - `findOwnedMember` — find a method/field owned by a class def
 *     across all parsed files by (ownerId, simpleName).
 *   - `findExportedDef` — find a file-level exported def (top-of-module
 *     class / function) by simpleName.
 *
 * Next-consumer contract: every OO or module-capable language hits the
 * same pre-finalize / post-finalize binding split and the same
 * "resolve member on owner with MRO" pattern. All four are reusable
 * as-is for TypeScript, Java, Kotlin, Ruby, etc.
 */

import type {
  BindingRef,
  ParsedFile,
  Scope,
  ScopeId,
  SymbolDefinition,
  TypeParameter,
  TypeRef,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { WorkspaceResolutionIndex } from '../workspace-index-types.js';
import {
  normalizeQualifiedName,
  splitQualifiedName,
  stripTrailingTypeArguments,
} from '../../utils/qualified-name.js';
import {
  extractTemplateArguments,
  stripTemplateArguments,
} from '../../utils/template-arguments.js';
import { definitionIdPosition } from '../utils/definition-id.js';

const EMPTY_BINDINGS: readonly BindingRef[] = Object.freeze([]);

/**
 * Look up binding refs at `scopeId` for `name`, consulting both the
 * finalize-owned `bindings` channel and the post-finalize
 * `bindingAugmentations` channel (see invariant I8 in
 * `contract/scope-resolver.ts`). Finalized refs come first; augmented
 * refs append, deduped by `def.nodeId` so a sibling that's also
 * explicitly imported doesn't double-emit.
 *
 * Returns a shared frozen empty array when neither channel has the
 * name — callers can compare against `=== EMPTY_BINDINGS` if they
 * want a fast-path miss check. The bucket arrays are returned by
 * reference when only one channel populates them; the merged path
 * allocates a fresh array.
 *
 * Walker primitives (`findClassBindingInScope`,
 * `findCallableBindingInScope`, `findExportedDefByName`) and
 * post-finalize passes that read finalized bindings (e.g.
 * `propagateImportedReturnTypes`, `namespace-targets`) MUST go
 * through this helper instead of `scopes.bindings.get(...)` directly,
 * so the augmentation channel is always visible.
 */
export function lookupBindingsAt(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] {
  const finalized = scopes.bindings.get(scopeId)?.get(name);
  const augmented = scopes.bindingAugmentations.get(scopeId)?.get(name);
  const workspace = scopes.workspaceFqnBindings?.get(name);
  // Per-namespace channel (#1871 named-namespace generalization). Gated by
  // accessibility: only a *module* scope carries an `accessibleNamespacesByScope`
  // entry, so this collects nothing at child scopes and at module scopes only for
  // the namespaces that file can see. Empty (no entry) for every non-C# bundle,
  // so the behavior of the three pre-existing channels is unchanged.
  const namespaceRefs = collectNamespaceFqnBindings(scopeId, name, scopes);
  const fLen = finalized?.length ?? 0;
  const aLen = augmented?.length ?? 0;
  const wLen = workspace?.length ?? 0;
  const nLen = namespaceRefs?.length ?? 0;
  if (fLen === 0 && aLen === 0 && wLen === 0 && nLen === 0) return EMPTY_BINDINGS;
  if (aLen === 0 && wLen === 0 && nLen === 0) return finalized!;
  if (fLen === 0 && wLen === 0 && nLen === 0) return augmented!;
  if (fLen === 0 && aLen === 0 && nLen === 0) return workspace!;
  if (fLen === 0 && aLen === 0 && wLen === 0) return namespaceRefs!;
  // Merge in precedence order, deduped by `def.nodeId` so the strongest source
  // wins duplicate metadata. Named-namespace refs come BEFORE the flat global
  // `workspace` channel: pre-#1871 these lived in `bindingAugmentations` (which
  // `lookupBindingsAt` already ranks above `workspaceFqnBindings`), so a name in
  // both an accessible named namespace and the global namespace must still
  // resolve named-first. Order: finalized > augmented > namespace > workspace.
  const seen = new Set<string>();
  const out: BindingRef[] = [];
  for (const src of [finalized, augmented, namespaceRefs, workspace]) {
    if (src === undefined) continue;
    for (const r of src) {
      if (seen.has(r.def.nodeId)) continue;
      seen.add(r.def.nodeId);
      out.push(r);
    }
  }
  return out;
}

/**
 * Collect `BindingRef`s for `name` from the per-namespace channel
 * (`namespaceFqnBindings`) across every namespace accessible from `scopeId`.
 * Accessibility comes from `accessibleNamespacesByScope`, which is keyed by
 * *module* scope id — so this returns `undefined` at non-module scopes and at
 * every scope in a bundle that didn't populate the channel (all non-C# today).
 * Language-neutral: keyed only by namespace strings and the index.
 */
function collectNamespaceFqnBindings(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly BindingRef[] | undefined {
  const namespaces = scopes.accessibleNamespacesByScope?.get(scopeId);
  if (namespaces === undefined || namespaces.length === 0) return undefined;
  let collected: BindingRef[] | undefined;
  for (const ns of namespaces) {
    const bucket = scopes.namespaceFqnBindings?.get(ns)?.get(name);
    if (bucket !== undefined && bucket.length > 0) {
      if (collected === undefined) collected = [];
      for (const r of bucket) collected.push(r);
    }
  }
  return collected;
}

const EMPTY_NAMES: Iterable<string> = Object.freeze([]) as readonly string[];

/**
 * Return the union of bound names at `scopeId` across both the
 * finalized and augmented channels. Companion to `lookupBindingsAt`
 * for callers that need to iterate every name at a scope (e.g.
 * `propagateImportedReturnTypes`). Order is not guaranteed; callers
 * that need stable iteration should sort externally.
 *
 * Fast paths (zero allocation) when at most one channel is populated:
 * returns the underlying `Map.keys()` iterator directly. Only when both
 * channels carry names do we materialize a `Set` for deduplication.
 *
 * Scope: enumerates only the per-scope `bindings` and `bindingAugmentations`
 * channels. It deliberately EXCLUDES the scope-independent
 * `workspaceFqnBindings` channel (PHP FQN keys, C# global-namespace simple
 * names). `lookupBindingsAt` consults that third channel when resolving a
 * specific name, but name *enumeration* here does not — those names apply at
 * every scope and would flood per-scope callers. Callers that need
 * workspace-level names must read `workspaceFqnBindings` directly.
 */
export function namesAtScope(scopeId: ScopeId, scopes: ScopeResolutionIndexes): Iterable<string> {
  const finalized = scopes.bindings.get(scopeId);
  const augmented = scopes.bindingAugmentations.get(scopeId);
  const fSize = finalized?.size ?? 0;
  const aSize = augmented?.size ?? 0;
  if (fSize === 0 && aSize === 0) return EMPTY_NAMES;
  if (aSize === 0) return finalized!.keys();
  if (fSize === 0) return augmented!.keys();
  const out = new Set<string>(finalized!.keys());
  for (const name of augmented!.keys()) out.add(name);
  return out;
}

/**
 * True when a def's `type` names a class-like declaration — every kind
 * that collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Semantics widened historically from `'Class' | 'Interface'` to cover
 * C#-shape languages (struct, record, enum, trait) and Zig tagged unions
 * (`union(enum)` containers own methods like structs do). Languages that
 * emit only `'Class'` are unaffected — the extra kinds never appear in
 * their parsed output.
 */
export function isClassLike(t: string): boolean {
  return (
    t === 'Class' ||
    t === 'Interface' ||
    t === 'Struct' ||
    t === 'Record' ||
    t === 'Enum' ||
    t === 'Trait' ||
    t === 'Union'
  );
}

/**
 * Does this label declare MEMBERS addressable by name?
 *
 * `isClassLike` answers two questions that only coincide for classes:
 *   1. does this declare members I can look up?  — a SHAPE (structural)
 *   2. does this participate in inheritance / MRO? — a NOMINAL TYPE
 *
 * A TypeScript object-type alias answers YES to (1) and emphatically NO to
 * (2): it declares the same `property_signature` members as the interface
 * beside it, but has no supertypes and no place in a linearization. Answering
 * (2) "yes" merely to buy (1) is what widening `isClassLike` would do, and it
 * would enrol every language's aliases (Rust `type_item`, Kotlin/Swift/Dart
 * typealias, C `typedef`) into MRO and heritage.
 *
 * So the two questions get two predicates. Use THIS one where the question is
 * "find the shape so I can look up a member"; keep `isClassLike` where the
 * question is inheritance. The call sites announce which they are:
 * `resolveInheritanceBaseInScope` and `resolveQualifiedInheritanceBase` are
 * (2); receiver typing is (1).
 *
 * `Union` IS included, via `isClassLike`: Zig wires `union(enum)` as a member
 * container (methods dispatched on a union receiver — see the `main → isEnergy`
 * case in `test/integration/resolvers/zig.test.ts`), so it is a shape as well
 * as an inheritance-capable owner. C/C++ unions still do not emit `Union`
 * defs on the scope side, so nothing changes for them.
 *
 * NOT YET INCLUDED, deliberately: `Typedef`. It belongs here conceptually but
 * is not wired as a member container today, so adding it would widen a
 * predicate nothing exercises. It joins when its container does, with
 * fixtures.
 */
export function isShapeLike(t: string): boolean {
  return isClassLike(t) || t === 'TypeAlias';
}

/**
 * Walk the scope chain from `startScope` looking for a typeBinding
 * named `receiverName`. Returns the TypeRef or undefined if no binding
 * exists in the chain.
 *
 * A scope that declares `ownsReceivers.has(receiverName)` terminates the
 * walk with `undefined` (#2701): it binds that receiver itself, so an
 * enclosing scope's binding is not visible through it. The check runs
 * AFTER this scope's own `typeBindings`, so a scope that both owns and
 * binds the receiver — a class method, which is where `this` is bound TO
 * the class — still resolves normally. The namespace/global fallbacks
 * below are also skipped: they answer "which type is named X", which is a
 * different question from "what is this scope's receiver", and reaching
 * them for an owned-but-unbound receiver is how a static method or a
 * detached callback acquires a fabricated one.
 */
/**
 * True when `receiverName` is DEFINITIVELY unresolvable at `startScope`:
 * a scope on the chain declares it owns that receiver (`Scope.ownsReceivers`)
 * and carries no type binding for it (#2701).
 *
 * This is a stronger statement than `findReceiverTypeBinding` returning
 * `undefined`, which only means "no type found" — an ordinary miss that later
 * passes are free to resolve by other means. Here the language has said the
 * receiver is REBOUND at this scope, so no enclosing type can be its type:
 * `this.m()` inside a nested JS/TS `function` is a call on whatever the
 * function is invoked with, which the graph does not model. A member call
 * whose receiver is unresolvable in this sense must be suppressed rather
 * than left to the receiver-blind lexical fallback in `lookupCore`, which
 * would find the enclosing class's member by name alone.
 *
 * Returns false for every language that leaves `ownsReceivers` unset.
 */
export function isReceiverOwnedButUnbound(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): boolean {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return false;
    if (scope.typeBindings.has(receiverName)) return false;
    if (scope.ownsReceivers?.has(receiverName) === true) return true;
    currentId = scope.parent;
  }
  return false;
}

/**
 * True when a declaration between the call site and its module scope shadows a
 * file-level namespace import of the same name. Namespace targets are collected
 * per FILE, so every consumer of that map must apply this lexical guard before
 * trusting it at an inner scope — otherwise `def f(pkg): pkg.db.query()`
 * resolves through the import that the parameter shadows, producing a wrong
 * edge rather than a missing one.
 *
 * A namespace key may itself be a dotted import path (`pkg.db`, #2826), but the
 * name a declaration can shadow is always the ROOT identifier — `pkg = Decoy()`
 * shadows `pkg.db` too. Testing the whole dotted string would never match a
 * binding, so the guard would silently stop guarding for exactly the keys it
 * was extended to cover. Single-segment names are unaffected: their root is
 * themselves.
 *
 * Fails closed (returns `true`) on a missing scope or a parent cycle: for every
 * caller, suppressing a resolution costs a missing edge, while trusting a
 * corrupt scope chain costs a wrong one.
 *
 * Reads `scope.bindings` DIRECTLY rather than through `lookupBindingsAt`, and
 * that is deliberate — the opposite of the fix #2745 applied to Rust's
 * `headBoundLocally`. There the question was "is this name bound at all?", so
 * missing the finalized/augmented import channels lost real bindings. Here the
 * question is "does something LOCAL shadow the import?", and the import's own
 * finalized binding is the one thing that must NOT count: routing this through
 * `lookupBindingsAt` would find the namespace import shadowing itself and
 * suppress every namespace receiver in the workspace. Locals, parameters and
 * lexical names all live in the scope's own tables, which is exactly the set
 * this walk wants.
 */
export function isNamespaceNameShadowed(
  namespaceName: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): boolean {
  const firstDot = namespaceName.indexOf('.');
  const rootName = firstDot === -1 ? namespaceName : namespaceName.slice(0, firstDot);
  let currentId: ScopeId | null = inScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return true;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return true;
    // Stop AT the module scope without inspecting it. In languages where a
    // namespace import IS a variable declaration — CommonJS
    // `const svc = require('./svc')` — the import puts its own name into the
    // module scope's tables, so inspecting them reads the import as its own
    // shadow and suppresses every receiver it was meant to enable (#2723).
    // The contract is "a declaration BETWEEN the call site and its module
    // scope", and the module scope is the floor, not a rung.
    if (scope.kind === 'Module') return false;
    if (
      scope.kind !== 'Object' &&
      (scope.bindings.has(rootName) ||
        scope.typeBindings.has(rootName) ||
        scope.lexicalNames?.has(rootName) === true ||
        scope.ownedDefs.some((def) => {
          const qualifiedName = def.qualifiedName;
          if (qualifiedName === undefined) return false;
          const dot = qualifiedName.lastIndexOf('.');
          return (dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1)) === rootName;
        }))
    ) {
      return true;
    }
    currentId = scope.parent;
  }
  return true;
}

export function findReceiverTypeBinding(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  let moduleScopeId: ScopeId | null = null;
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    const typeRef = scope.typeBindings.get(receiverName);
    if (typeRef !== undefined) return typeRef;
    if (scope.ownsReceivers?.has(receiverName) === true) return undefined;
    if (scope.kind === 'Module') moduleScopeId = currentId;
    currentId = scope.parent;
  }
  // Fallback 1 — named namespaces accessible from this file (own + `using`d),
  // gated by `accessibleNamespacesByScope`. Consulted BEFORE the global channel
  // so a more-specific named binding wins, matching the pre-#1871 order where
  // these lived in the file's own `Scope.typeBindings` (the chain, above the
  // global fallback). Shared-channel routing avoids the O(files × names) blow-up.
  const named = namespaceTypeBindingFor(moduleScopeId, receiverName, scopes);
  if (named !== undefined) return named;
  // Fallback 2 — global/default namespace: C# global types are visible from
  // every file (see `workspaceTypeBindings` doc), so this flat channel is the
  // final, unconditional fallback (#1871).
  return scopes.workspaceTypeBindings?.get(receiverName);
}

/**
 * Resolve a typeBinding for `name` from the per-namespace channel
 * (`namespaceTypeBindings`) across the namespaces accessible from `moduleScopeId`.
 * First accessible-namespace hit wins. Returns `undefined` when the module has no
 * accessibility entry (non-module scope id, or a bundle that didn't populate the
 * channel — all non-C# today). Shared by the two typeBindings chain-walkers so
 * the named-namespace fallback stays identical between them.
 */
export function namespaceTypeBindingFor(
  moduleScopeId: ScopeId | null,
  name: string,
  scopes: ScopeResolutionIndexes,
): TypeRef | undefined {
  if (moduleScopeId === null) return undefined;
  const namespaces = scopes.accessibleNamespacesByScope?.get(moduleScopeId);
  if (namespaces === undefined) return undefined;
  for (const ns of namespaces) {
    const hit = scopes.namespaceTypeBindings?.get(ns)?.get(name);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Walk the scope chain from `startScope` to its enclosing Module scope id, or
 * `null` if none is found. Used by chain-followers that need the module scope to
 * consult the accessibility-gated per-namespace channels.
 */
export function moduleScopeIdOf(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): ScopeId | null {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return null;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return null;
    if (scope.kind === 'Module') return currentId;
    currentId = scope.parent;
  }
  return null;
}

/**
 * Look up a class-like binding by name in the given scope's chain.
 *
 * "Class-like" covers `Class | Interface | Struct | Record | Enum |
 * Trait` via the shared `isClassLike` predicate — every kind that
 * collapses to `@scope.class` in the scope-extractor query contract.
 *
 * Walks the scope chain upward and consults TWO sources at each step:
 *   1. `scope.bindings` — populated during scope-extraction Pass 2 with
 *      local declarations (`origin: 'local'`).
 *   2. The cross-file finalized + augmented bindings, via
 *      `lookupBindingsAt` (per I8: finalized = canonical immutable
 *      output; augmented = post-finalize hooks like
 *      `populateNamespaceSiblings`).
 *
 * Without (2) we'd miss every cross-file class-receiver call.
 */
/**
 * Every class-like definition visible for `name`, from the scope chain AND the
 * qualified-name index, deduped by `nodeId`.
 *
 * Exists because `walkScopeChain` returns the FIRST match and cannot report a
 * collision, so a caller that widens what a name can match (the decoration
 * normalizer below) has no way to tell "one answer" from "picked the nearest of
 * several". Mirrors `findAllCallableBindingsInScope`, which solved the same
 * problem for callables.
 */
export function findAllClassBindingsInScope(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  return classBindingsVisibleFrom(
    lexicalClassBindingsInScope(startScope, name, scopes),
    name,
    scopes,
  );
}

/**
 * {@link findAllClassBindingsInScope} for a caller that already holds the
 * scope-chain half (see {@link lexicalClassBindingsInScope}), so the chain is
 * walked once rather than once per question asked about the same name.
 *
 * The chain wins outright when it binds the name: an inner binding shadows
 * anything the qualified-name index would contribute.
 */
function classBindingsVisibleFrom(
  lexical: readonly SymbolDefinition[],
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  if (lexical.length > 0) return lexical;
  const byNodeId = new Map<string, SymbolDefinition>();
  for (const def of classDefsByQualifiedName(name, scopes)) byNodeId.set(def.nodeId, def);
  return [...byNodeId.values()];
}

/**
 * Strip one layer of type-preserving decoration off a declared type name, or
 * `undefined` when there is nothing left to strip. Supplied per language through
 * the `ScopeResolver` contract; the core never names a language (AGENTS.md R6).
 *
 * TYPE-PRESERVING only — pointer, reference, `const`, nullable, borrow,
 * deref-transparent smart pointer, sigil. A CONTAINER (array, slice, map,
 * `Option`) changes the member set, so stripping one here would type
 * `repos: Repo[]` as `Repo` and let `repos.find(x)` fold to `Repo.find`. Those
 * are unwrapped only by an index step that consumed a subscript.
 */
export type DecorationStripper = (typeName: string) => string | undefined;

/** Bounded so a pathological stripper cannot spin. Real decoration nests
 *  shallowly (`*[]T`, `const T&`); three layers is generous. */
const MAX_DECORATION_LAYERS = 3;

/** Memo for {@link typeParameterNamesInScope}, keyed by index bundle then
 *  scope. One bundle per model, so the outer WeakMap releases with it. */
const typeParameterNamesByBundle = new WeakMap<
  ScopeResolutionIndexes,
  Map<ScopeId, ReadonlySet<string>>
>();

const NO_TYPE_PARAMETERS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Did `def` OPEN `scope` — i.e. is this scope the declaration's own body?
 *
 * The gate on reading a declaration's `typeParameters` as a lexical binding.
 * `ownedDefs` answers "which scope was this declaration written in", which is a
 * DIFFERENT question: a declaration that opens no scope of its own is owned by
 * whatever encloses it, and reading its parameters there binds them across that
 * entire enclosing region.
 *
 * Measured (#2899): a TypeScript `type Maybe<Result> = Result | null` opens no
 * scope — only the `object_type` alias form does — so its parameter list landed
 * in the MODULE's `ownedDefs`. Since each scope's answer is built from its
 * parent's, `Result` was then bound as a type parameter in every scope in the
 * file, and the `USES` guard downstream deleted every genuine edge to the
 * `interface Result` beside it, imported ones included. One un-anchored
 * parameter list silently emptied an entire file of the edge class that answers
 * "what breaks if I remove this field?".
 *
 * Compares the def's declaration position with the scope's start — the same
 * alignment test `pickCallerCallableDef` uses to tell a closure from a nested
 * function, and sound for the same reason: when a declaration is itself the
 * scope node, both sides are built from one `Range`. Every language that
 * populates `typeParameters` today anchors them on a declaration that IS a scope
 * node (TS class/interface/function, Java/C#/Kotlin/Rust type declarations, the
 * C++ `class_specifier` inside a `template_declaration`), so the alignment holds
 * wherever the parameters were meant to bind.
 *
 * A `Module` scope is excluded outright rather than left to the position test:
 * a module is opened by the file, never by a declaration, and a declaration
 * written on the file's first line shares its start coordinates.
 */
function declarationOpenedScope(def: SymbolDefinition, scope: Scope): boolean {
  if (scope.kind === 'Module') return false;
  const position = definitionIdPosition(def.nodeId, def.filePath);
  if (position === undefined) return false;
  return position.line === scope.range.startLine && position.column === scope.range.startCol;
}

/**
 * Every name the scope chain above `scopeId` (inclusive) binds as a declared
 * TYPE PARAMETER.
 *
 * Memoized per scope, and each scope's answer is built from its PARENT's, so a
 * chain is walked once and every scope on it is O(own defs) rather than
 * O(depth × defs). That matters because the caller runs on every class-binding
 * lookup, and a module scope's `ownedDefs` is the whole file.
 *
 * That parent-inheriting fold is also why {@link declarationOpenedScope} gates
 * every read: a parameter list picked up one scope too high does not merely
 * over-reach by one scope, it reaches every scope below it as well.
 */
function typeParameterNamesInScope(
  scopeId: ScopeId,
  scopes: ScopeResolutionIndexes,
): ReadonlySet<string> {
  let byScope = typeParameterNamesByBundle.get(scopes);
  if (byScope === undefined) {
    byScope = new Map<ScopeId, ReadonlySet<string>>();
    typeParameterNamesByBundle.set(scopes, byScope);
  }
  const memo = byScope.get(scopeId);
  if (memo !== undefined) return memo;

  // Collect the chain first, then fold from the top down, so the recursion is
  // an explicit loop (a deep scope chain must not risk the call stack) and
  // every scope passed through is memoized on the way back.
  const chain: ScopeId[] = [];
  const seen = new Set<ScopeId>();
  let cursor: ScopeId | null = scopeId;
  let inherited: ReadonlySet<string> = NO_TYPE_PARAMETERS;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const cached = byScope.get(cursor);
    if (cached !== undefined) {
      inherited = cached;
      break;
    }
    chain.push(cursor);
    cursor = scopes.scopeTree.getScope(cursor)?.parent ?? null;
  }

  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const id = chain[i]!;
    const scope = scopes.scopeTree.getScope(id);
    let own: Set<string> | undefined;
    for (const def of scope?.ownedDefs ?? []) {
      if (def.typeParameters === undefined) continue;
      if (scope === undefined || !declarationOpenedScope(def, scope)) continue;
      for (const parameter of def.typeParameters) {
        if (parameter.name.length === 0) continue;
        own ??= new Set<string>(inherited);
        own.add(parameter.name);
      }
    }
    inherited = own ?? inherited;
    byScope.set(id, inherited);
  }
  return inherited;
}

/**
 * Does the scope chain at `scopeId` bind `name` as a declared TYPE PARAMETER?
 *
 * The question a class-binding lookup has to ask before it answers, because a
 * type parameter and a class are spelled identically and only the declaration
 * says which one a name is. `class Box<T> { t: T }` beside a workspace
 * `export class T` resolved `t` to the CLASS and emitted a confident wrong edge
 * from every member call on `t` — the exact failure mode this subsystem treats
 * as worse than a missing edge.
 *
 * WHY LEXICAL GROUNDING CANNOT SUBSTITUTE. The erasure grounds in
 * `resolveErasedBaseName` all ask "can the file SEE a declaration by this
 * name", and here it plainly can: `export class T` is imported, bound, and
 * lexically visible. Visibility is not the defect — the name means something
 * else at this site regardless of what else is visible, and only the enclosing
 * declaration's parameter list records that. Measured: with the grounding rule
 * in place the false edge still emitted.
 *
 * ABSENCE IS NOT EVIDENCE. `typeParameters` is populated only by the languages
 * whose captures were extended for it, and is absent both for a non-generic
 * declaration and for every declaration in a language that does not populate it
 * yet. So only a POSITIVE match declines; an absent list changes nothing, which
 * is what keeps every unconverted language behaving exactly as it does today.
 */
export function bindsTypeParameter(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): boolean {
  if (name.length === 0) return false;
  return typeParameterNamesInScope(scopeId, scopes).has(name);
}

/**
 * The declared parameter `name` refers to at `scopeId`, nearest declaration
 * first, or `undefined` when `name` is not a type parameter here.
 *
 * Separate from {@link bindsTypeParameter} because the guard only needs to know
 * THAT a name is a parameter, while resolving through a bound needs the
 * parameter itself — and the memoized name set deliberately keeps no payload so
 * that the guard, which runs on every lookup, stays a single hash probe.
 */
function typeParameterAt(
  scopeId: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): TypeParameter | undefined {
  let cursor: ScopeId | null = scopeId;
  const seen = new Set<ScopeId>();
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const scope = scopes.scopeTree.getScope(cursor);
    for (const def of scope?.ownedDefs ?? []) {
      const hit = def.typeParameters?.find((parameter) => parameter.name === name);
      if (hit !== undefined) return hit;
    }
    cursor = scope?.parent ?? null;
  }
  return undefined;
}

/**
 * The single class-like name a declared bound names, or `undefined` when the
 * bound names none or names more than one.
 *
 * DECLINING ON AN INTERSECTION is the point. `T extends Repo & Closeable` and
 * `T: Repo + Clone` make a member reachable through EITHER bound, so picking one
 * — the first, as erasure would — mints a confidently-attributed edge to a
 * declaration that may not own the member at all. Two candidates and no way to
 * choose is exactly the case this file already answers with `undefined` in
 * `findClassBindingInScope`'s decoration fallback: a missing edge is
 * recoverable, a wrong one is not.
 *
 * Type ARGUMENTS on the bound are erased (`T extends Repo<User>` → `Repo`),
 * which is sound here for the same reason the erased base-name route exists: the
 * members are declared once, on the declaration written against its parameters.
 */
function soleBoundBaseName(bound: string): string | undefined {
  // `&` (Java, TypeScript) and `+` (Rust, Kotlin) both compose bounds. Split on
  // whichever appears OUTSIDE brackets, so `Repo<A & B>` stays one bound.
  let depth = 0;
  for (let i = 0; i < bound.length; i += 1) {
    const ch = bound[i];
    if (ch === '<' || ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === '>' || ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (depth === 0 && (ch === '&' || ch === '+')) return undefined;
  }
  const base = stripTemplateArguments(bound).trim();
  return base.length === 0 ? undefined : base;
}

export function findClassBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
  /**
   * OPT-IN. When supplied, a name that binds nothing is retried with decoration
   * stripped one layer at a time, and each retry must resolve to exactly ONE
   * class-like definition or it declines.
   *
   * Opt-in rather than global because roughly two dozen call sites use the shape
   * `findClassBindingInScope(...) ?? otherResolver(...)`: turning a former
   * `undefined` into a hit SUPPRESSES the fallback that used to answer, which
   * would retarget inheritance edges and bypass generic-specialization
   * selection. Only receiver-chain base and step resolution passes this.
   */
  stripDecoration?: DecorationStripper,
): SymbolDefinition | undefined {
  // A TYPE PARAMETER is not a class, and it is checked before every route below
  // rather than inside one of them because each route would otherwise reach a
  // same-named class by its own channel: the scope chain when the class is
  // imported, the qualified-name index when it is not, and the decoration
  // fallback after stripping. The declaration that introduced the parameter is
  // the only thing that knows, and it knows for all three.
  if (bindsTypeParameter(startScope, receiverName, scopes)) {
    return resolveThroughTypeParameterBound(startScope, receiverName, scopes, stripDecoration);
  }

  const local = walkScopeChain(startScope, receiverName, scopes, (def) => isClassLike(def.type));
  if (local !== undefined) return local;

  // Fallback for languages (Go) where namespace-style imports don't
  // create scope bindings: resolve via QualifiedNameIndex. Only fires
  // when the scope-chain walk found nothing; single-match wins.
  const qnames = scopes.qualifiedNames.get(receiverName);
  if (qnames.length === 1) {
    const def = scopes.defs.get(qnames[0]!);
    if (def !== undefined && isClassLike(def.type)) return def;
  }
  // Second fallback: dotted names like "models.User" — try the simple
  // name (tail after last dot) for languages where defs are indexed by
  // simple name (Go). Only when the dotted lookup fails.
  if (receiverName.includes('.')) {
    const simple = receiverName.slice(receiverName.lastIndexOf('.') + 1);
    if (simple.length > 0 && simple !== receiverName) {
      const simpleIds = scopes.qualifiedNames.get(simple);
      if (simpleIds.length === 1) {
        const def = scopes.defs.get(simpleIds[0]!);
        if (def !== undefined && isClassLike(def.type)) return def;
      }
    }
  }

  // Decoration fallback (opt-in). Every branch above works on the name exactly
  // as written; only when none of them bound anything do we consider that the
  // name may be a decorated spelling of one that would.
  if (stripDecoration !== undefined) {
    let current = receiverName;
    for (let layer = 0; layer < MAX_DECORATION_LAYERS; layer++) {
      const stripped = stripDecoration(current);
      if (stripped === undefined || stripped === current || stripped.length === 0) break;
      current = stripped;
      const candidates = findAllClassBindingsInScope(startScope, current, scopes);
      // Exactly one, or decline. Two same-named classes reachable from here mean
      // the decoration was carrying the only disambiguating information, and
      // picking the nearest would mint a confident wrong edge — the failure this
      // whole line of work exists to avoid. A missing edge is recoverable.
      if (candidates.length === 1) return candidates[0];
      if (candidates.length > 1) return undefined;
    }
  }
  return undefined;
}

/**
 * What a TYPE PARAMETER used in type position resolves to — its declared BOUND
 * when it states exactly one, and nothing when it is unbounded.
 *
 * `class Box<T extends Repo> { t: T; run() { this.t.save(); } }` has one sound
 * answer for `this.t.save()`: the member set a `T` is GUARANTEED to have is its
 * bound's, so `Repo.save` is the target the declaration itself licenses. An
 * unbounded `class Box2<T>` licenses nothing — `T` has no members — and gets
 * `undefined`, which is the whole of the Gap-C fix.
 *
 * ONE HOP ONLY. The retry is guarded against a bound that is itself a parameter
 * (`class Box<T extends U, U extends Repo>`), so the recursion cannot chain or
 * cycle. Following such a chain is sound in principle but has no measured case
 * behind it, and an unbounded step in the middle would have to decline anyway.
 */
function resolveThroughTypeParameterBound(
  startScope: ScopeId,
  parameterName: string,
  scopes: ScopeResolutionIndexes,
  stripDecoration?: DecorationStripper,
): SymbolDefinition | undefined {
  const bound = typeParameterAt(startScope, parameterName, scopes)?.bound;
  if (bound === undefined) return undefined;
  const baseName = soleBoundBaseName(bound);
  if (baseName === undefined || baseName === parameterName) return undefined;
  // A bound naming another parameter terminates here rather than recursing.
  if (bindsTypeParameter(startScope, baseName, scopes)) return undefined;
  return findClassBindingInScope(startScope, baseName, scopes, stripDecoration);
}

function normalizeTemplateArgToken(value: string): string {
  return value.replace(/\s+/g, '');
}

/**
 * A definition that pins its OWN concrete type arguments (`templateArguments`
 * is set) — the shape a scope extractor records for a declaration written
 * against particular arguments rather than against its parameters, e.g. C++
 * `template <> struct Vec<bool>` (`['bool']`) or `template <class T> struct
 * Vec<T*>` (`['T*']`).
 *
 * The distinction that matters to the lookup below: such a definition serves
 * exactly ONE family of instantiations, so the only sound way to select it is
 * the exact-argument match. A declaration written against its parameters —
 * `template <class T> struct Vec`, `class Repo<T>` in TypeScript, C# and every
 * other language measured — carries NOTHING here (the extractor reads arguments
 * off the declared name, and the name is bare), which is precisely why it can
 * never win that match and must be reachable by the base-name route instead.
 */
function carriesOwnTemplateArguments(def: SymbolDefinition): boolean {
  return def.templateArguments !== undefined && def.templateArguments.length > 0;
}

/** Class-like defs registered in the workspace-wide qualified-name index under
 *  `name`. Workspace-WIDE: no scope filtering, so a caller must treat this as
 *  the weaker source and prefer lexically visible candidates. */
function classDefsByQualifiedName(
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  const out: SymbolDefinition[] = [];
  for (const id of scopes.qualifiedNames.get(name)) {
    const def = scopes.defs.get(id);
    if (def !== undefined && isClassLike(def.type)) out.push(def);
  }
  return out;
}

/** Defs from `candidates` whose own template arguments equal `wantedArgs`
 *  token-for-token (whitespace already squeezed on both sides). */
function matchingTemplateArguments(
  candidates: readonly SymbolDefinition[],
  wantedArgs: readonly string[],
): readonly SymbolDefinition[] {
  return candidates.filter((def) => {
    const defArgs = def.templateArguments?.map(normalizeTemplateArgToken);
    return (
      defArgs !== undefined &&
      defArgs.length === wantedArgs.length &&
      defArgs.every((value, i) => value === wantedArgs[i])
    );
  });
}

/**
 * Class-like defs the SCOPE CHAIN binds for `name` — locals, imports, wildcards,
 * namespace siblings; everything `findAllBindingsInScope` reaches. No
 * workspace-index fallback, which is the entire point: this is the set that
 * answers "can the file see a declaration by this name", and
 * `findAllClassBindingsInScope` deliberately cannot answer it because it falls
 * through to the scope-free index when the chain is silent.
 */
function lexicalClassBindingsInScope(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  return findAllBindingsInScope(startScope, name, scopes, (def) => isClassLike(def.type));
}

/**
 * The one declaration among `candidates` written against its PARAMETERS rather
 * than against particular arguments — or `undefined` when there is not exactly
 * one.
 *
 * ORDER-INDEPENDENT by construction, and that is why it exists separately from
 * "take the first": an unordered candidate set (the workspace index, whose order
 * is insertion order) must never let source order decide a call target. The
 * scope-chain route keeps its nearest-first answer; only the index routes use
 * this.
 */
function theInstantiationAgnosticDeclaration(
  candidates: readonly SymbolDefinition[],
): SymbolDefinition | undefined {
  const parameterized = candidates.filter((def) => !carriesOwnTemplateArguments(def));
  return parameterized.length === 1 ? parameterized[0] : undefined;
}

/** Memo for {@link bindsAnyCrossFileClass}, keyed by index bundle then module
 *  scope. One bundle per model, so the outer WeakMap releases with it. */
const crossFileClassChannelByBundle = new WeakMap<ScopeResolutionIndexes, Map<ScopeId, boolean>>();

/**
 * Does the FILE containing `scopeId` bind, at its module scope, any class-like
 * definition declared in a DIFFERENT file?
 *
 * This is the question "is a name's absence from this file's scope chain
 * evidence of anything", and it has to be asked of the data because the answer
 * differs per language while the scope model records no fact that says which.
 * Both halves were MEASURED on this pipeline, not assumed:
 *
 *   - A C++ `#include` materializes NO binding. Two files declaring `Repo`, one
 *     of them `#include`d by the referencing file, resolves to NEITHER — the
 *     include contributed nothing and the ambiguity was decided by the
 *     workspace-wide index alone. So a C++ file's chain binds nothing
 *     cross-file, and the index is the only channel it has.
 *   - A TypeScript `import` does bind, and so does a C# `using` (through the
 *     accessible-namespace channel).
 *
 * So "the chain does not bind `Map`" is real evidence in a TypeScript file and
 * no evidence at all in a C++ one. Asking the data which kind of file this is
 * keeps the rule out of the business of naming languages (AGENTS.md R6).
 *
 * FAILS TOWARD PERMISSIVE. `false` — no module scope, no file path, nothing
 * cross-file bound — restores exactly the import-blind behaviour that predates
 * this check, so every way it can be wrong costs a wrong edge that already
 * existed rather than a working edge that did not.
 */
function bindsAnyCrossFileClass(scopeId: ScopeId, scopes: ScopeResolutionIndexes): boolean {
  const moduleScopeId = moduleScopeIdOf(scopeId, scopes);
  if (moduleScopeId === null) return false;
  let byScope = crossFileClassChannelByBundle.get(scopes);
  if (byScope === undefined) {
    byScope = new Map<ScopeId, boolean>();
    crossFileClassChannelByBundle.set(scopes, byScope);
  }
  const memo = byScope.get(moduleScopeId);
  if (memo !== undefined) return memo;

  const answer = scanForCrossFileClass(moduleScopeId, scopes);
  byScope.set(moduleScopeId, answer);
  return answer;
}

/**
 * The uncached scan behind {@link bindsAnyCrossFileClass}. Answers on the FIRST
 * hit, so a file with a wide `export *` surface stops at its first imported
 * class rather than walking the surface; a file with none is walked in full, but
 * its module scope then holds only its own declarations.
 *
 * Reads the binding CHANNELS rather than asking `lookupBindingsAt` once per
 * name, because the question is existential and the per-name route answers a
 * question it does not need: a module scope activates the accessibility-gated
 * namespace channel, so every one of N bound names re-probed all K accessible
 * namespaces (75.6 ms for one C#-shaped file at N=5,000, K=1,000) and paid
 * `lookupBindingsAt`'s merge allocation each time. The population considered is
 * identical — the two per-scope channels' own buckets, plus the namespace and
 * workspace channels under exactly the names those two bind.
 */
function scanForCrossFileClass(moduleScopeId: ScopeId, scopes: ScopeResolutionIndexes): boolean {
  const filePath = scopes.scopeTree.getScope(moduleScopeId)?.filePath;
  if (filePath === undefined) return false;
  const bindsCrossFileClass = (refs: readonly BindingRef[] | undefined): boolean =>
    refs !== undefined &&
    refs.some((ref) => isClassLike(ref.def.type) && ref.def.filePath !== filePath);

  // The two per-scope channels, read as whole buckets. An ordinary import lands
  // here, so this is where the early exit usually fires.
  const finalized = scopes.bindings.get(moduleScopeId);
  const augmented = scopes.bindingAugmentations.get(moduleScopeId);
  for (const channel of [finalized, augmented]) {
    for (const refs of channel?.values() ?? []) {
      if (bindsCrossFileClass(refs)) return true;
    }
  }

  const boundNameCount = (finalized?.size ?? 0) + (augmented?.size ?? 0);
  if (boundNameCount === 0) return false;
  const bindsName = (name: string): boolean =>
    finalized?.has(name) === true || augmented?.has(name) === true;
  // Materialized once, not per channel — `namesAtScope` allocates when both
  // per-scope channels are populated.
  let boundNames: readonly string[] | undefined;
  const namesBoundHere = (): readonly string[] =>
    (boundNames ??= [...namesAtScope(moduleScopeId, scopes)]);

  // The accessibility-gated namespace channel: ONE lookup per accessible
  // namespace, then whichever of the two sides is smaller is the one iterated —
  // so neither a namespace with a large type table nor a file with many bound
  // names can reintroduce the product.
  for (const ns of scopes.accessibleNamespacesByScope?.get(moduleScopeId) ?? []) {
    const inNamespace = scopes.namespaceFqnBindings?.get(ns);
    if (inNamespace === undefined || inNamespace.size === 0) continue;
    if (inNamespace.size <= boundNameCount) {
      for (const [name, refs] of inNamespace) {
        if (bindsName(name) && bindsCrossFileClass(refs)) return true;
      }
    } else {
      for (const name of namesBoundHere()) {
        if (bindsCrossFileClass(inNamespace.get(name))) return true;
      }
    }
  }

  // The scope-independent workspace channel is keyed by name alone and has no
  // per-scope bucket to walk, so it stays a probe per bound name.
  const workspace = scopes.workspaceFqnBindings;
  if (workspace !== undefined && workspace.size > 0) {
    for (const name of namesBoundHere()) {
      if (bindsCrossFileClass(workspace.get(name))) return true;
    }
  }
  return false;
}

/**
 * Resolve a class-like binding for a declared type name, tolerating a spelling
 * that carries TYPE ARGUMENTS (`Repo<User>`, `Vec<int>`) where the declaration
 * itself is registered under the bare base name.
 *
 * Two normalizations, and they are not the same thing:
 *
 *   1. DECORATION stripping (`stripDecoration`, opt-in — see the parameter).
 *      Peels type-PRESERVING wrappers (`*T`, `const T&`) off the name.
 *   2. Type-argument ERASURE (unconditional, and the wider of the two).
 *      `Repo<User>` → `Repo`. This is what actually widens what binds, because
 *      it makes one declaration answer for EVERY instantiation of it — right
 *      for a language where a generic class has a single declaration, and a
 *      hazard where it does not, which is why the exact-argument match runs
 *      first and why the base-name route below refuses to return a
 *      declaration that pinned its own arguments.
 *
 * Order: exact spelling → exact type-argument match (lexically visible
 * candidates first, workspace-wide index second) → base name.
 */
export function resolveClassBindingForName(
  scopeId: string,
  rawClassName: string,
  scopes: ScopeResolutionIndexes,
  /**
   * OPT-IN, and it governs (1) only — argument erasure happens either way.
   * `findClassBindingInScope`'s own docstring explains the opt-in: a name that
   * previously bound nothing starts binding, which SUPPRESSES the
   * `?? otherResolver(...)` fallbacks several callers rely on.
   *
   * THE RULE, not a roll-call of who currently passes it (that list has been
   * appended to once per round of this work and is stale the moment it is
   * written): pass it from a receiver-TYPING site, and only where the site
   * already forwarded the same `stripTypePreservingDecoration` to the bare
   * lookup — so a Go pointer receiver keeps resolving exactly as it did. A site
   * that has never stripped must keep calling without it, because starting to
   * strip is what suppresses its fallback.
   */
  stripDecoration?: DecorationStripper,
): SymbolDefinition | undefined {
  const direct = findClassBindingInScope(scopeId, rawClassName, scopes, stripDecoration);
  if (direct !== undefined) return direct;

  // NO object-type-ALIAS fallback here, and that is a decision rather than an
  // omission. This function carried one before #2833 moved it out of
  // `passes/receiver-bound-calls.ts`; the move dropped it, and re-applying it at
  // merge time turned out to be wrong twice over. It is unexercised — deleting
  // it fails no test, because alias MEMBERS resolve through the precise path
  // instead (`type_alias_declaration value: (object_type)` emits `@scope.class`,
  // so a typed receiver reaches the shape's own scope). And re-adding it
  // unconditionally walked straight past the type-parameter refusal #2833 had
  // just introduced, re-opening through an alias the exact false edge that
  // change closed — their `neg-type-parameter` fixture caught it.
  //
  // If a future case genuinely needs it, it must be gated on
  // `bindsTypeParameter` and land with a test that fails without it.
  if (!rawClassName.includes('<')) return undefined;
  const baseName = stripTemplateArguments(rawClassName).replace(/\s+/g, '');
  if (baseName.length === 0) return undefined;

  // The class-like defs the SCOPE CHAIN binds for the base name. Computed once
  // and used twice — it is the lexical half of "what can the base name see from
  // here" AND ground (1) of the erasure rule below, and the two asked for it
  // separately, bottoming out in the same walk for a third of the cost of every
  // lookup whose declared type carries type arguments.
  const lexical = lexicalClassBindingsInScope(scopeId, baseName, scopes);

  const wantedArgs = extractTemplateArguments(rawClassName)?.map(normalizeTemplateArgToken);
  if (wantedArgs !== undefined && wantedArgs.length > 0) {
    // LEXICAL FIRST. The workspace-wide index is not scoped, so matching against
    // it up front let a field inside `namespace N` be answered by the GLOBAL
    // `Box<bool>` — or, when both namespaces declare one, by neither: two
    // matches, a decline, and a fall through to whatever base-name declaration
    // the walk reached first. Candidates the scope chain actually offers are
    // ranked ahead of it, exactly as every other lookup in this file does.
    const lexicalMatches = matchingTemplateArguments(
      classBindingsVisibleFrom(lexical, baseName, scopes),
      wantedArgs,
    );
    if (lexicalMatches.length === 1) return lexicalMatches[0];
    if (lexicalMatches.length === 0) {
      // Workspace-wide fallback — consulted ONLY when the scope chain offered no
      // exact match, which is how a declaration specialized in a different file
      // than the one instantiating it still binds.
      const indexMatches = matchingTemplateArguments(
        classDefsByQualifiedName(baseName, scopes),
        wantedArgs,
      );
      if (indexMatches.length === 1) return indexMatches[0];
    }
  }

  // ── Base-name route ────────────────────────────────────────────────────────
  // Nothing matched the arguments as written, so what is left to find is the
  // declaration written against its PARAMETERS — the one instantiation-agnostic
  // declaration the erasure is entitled to reach.
  return resolveErasedBaseName(scopeId, baseName, scopes, lexical);
}

/**
 * The declaration an ERASED base name is entitled to reach — the counterpart of
 * `findClassBindingInScope` for a name that lost its type arguments, and the one
 * place the grounding rule for that erasure lives.
 *
 * GROUNDING is the whole difference between a fix and a fabrication. Erasure
 * makes ONE declaration answer for EVERY instantiation of a name, so reaching it
 * by NAME ALONE is the widest step in this file: it is why `Map<string, User>`
 * bound a workspace `class Map` the file cannot see, and why a third-party
 * `Mapped[User]` bound an unrelated workspace `class Mapped` — a family of
 * confident wrong edges the language interpreters have been holding back with
 * deny-lists over an open universe of names. The name is not evidence. One of
 * four grounds must connect the site to the declaration, strongest first.
 */
function resolveErasedBaseName(
  scopeId: string,
  baseName: string,
  scopes: ScopeResolutionIndexes,
  /**
   * Ground (1) below, already computed: {@link lexicalClassBindingsInScope} for
   * `baseName` at `scopeId`. A parameter rather than a call because the only
   * caller needs the same list for its exact-argument match, and computing it
   * twice walked the scope chain twice.
   */
  lexical: readonly SymbolDefinition[],
): SymbolDefinition | undefined {
  // (1) THE SCOPE CHAIN binds the base name — a local, an import, a wildcard, a
  // namespace sibling. The file demonstrably sees a declaration by that name, so
  // erasing to it is what the source meant.
  if (lexical.length > 0) {
    const nearest = lexical[0]!;
    // The walk landed on a declaration that pinned its own arguments — arguments
    // the branch above just proved are NOT the ones written. It won on nothing
    // but being reached first: `Vec<int> vi` bound the `Vec<bool>`
    // specialization when the specialization happened to be declared above the
    // primary template, and the primary when it did not. Source order deciding a
    // call target is a wrong edge, not a missing one. Re-decide over the same
    // visible candidates with those declarations removed.
    return carriesOwnTemplateArguments(nearest)
      ? theInstantiationAgnosticDeclaration(lexical)
      : nearest;
  }

  // Nothing lexical. Both remaining grounds read the workspace-wide qualified-
  // name index, which consults no scope, no import and no module — so each one
  // has to supply the connection the index itself cannot.
  const indexed = classDefsByQualifiedName(baseName, scopes);

  // (2) THE DECLARATION IS IN THIS VERY FILE. A same-file declaration is visible
  // to the site in every language — no import, no `using`, no `#include` — which
  // is exactly what makes this ground language-neutral rather than a guess. It
  // is also load-bearing rather than theoretical: a member typed `ns::Repo<User>`
  // resolves through here, because the qualifier is dropped at capture and a
  // sibling NAMESPACE is not on the file's scope chain.
  const siteFile = scopes.scopeTree.getScope(scopeId)?.filePath;
  const sameFile = siteFile === undefined ? [] : indexed.filter((def) => def.filePath === siteFile);
  if (sameFile.length > 0) return theInstantiationAgnosticDeclaration(sameFile);

  // (3) THE INDEX PROVES THE NAME IS A TEMPLATE FAMILY — some declaration under
  // it pins its own arguments. That is the same evidence the exact-argument
  // index match above already acts on, and acting on it in only one direction
  // was incoherent: in one measured fixture `Vec<bool>` bound the cross-file
  // SPECIALIZATION through the index while `Vec<int>` bound nothing, though both
  // are equally import-blind and the primary template is the only declaration
  // that can answer `int`.
  //
  // (4) …or THE FILE HAS NO CROSS-FILE CHANNEL to be absent from, in which case
  // the index is not a shortcut around the scope chain — it is the only channel
  // that file has, and refusing it deletes every cross-file generic in the
  // languages whose visibility is not lexical. Measured, both directions: a C++
  // `#include` binds nothing, so `Repo<User>` in a `.cpp` reaches its header
  // declaration ONLY here; a TypeScript `import` binds, so a file that imports
  // anything and still cannot see `Map` genuinely cannot see it.
  //
  // Between them these two grounds are what separates the fix from the
  // fabrication: `Map`, `Queue`, `Deque` in a file with a working import channel
  // offer nothing but a spelling, and now get nothing.
  if (indexed.some(carriesOwnTemplateArguments) || !bindsAnyCrossFileClass(scopeId, scopes)) {
    return theInstantiationAgnosticDeclaration(indexed);
  }
  return undefined;
}

/**
 * Resolve a class-like inheritance target using the shared inheritance
 * resolution chain. Keeps pre-emitted heritage edges and language-specific
 * consumers of `inherits` sites aligned.
 */
export function resolveInheritanceBaseInScope(
  startScope: ScopeId,
  baseName: string,
  scopes: ScopeResolutionIndexes,
  rawQualifiedName?: string,
  enclosingClassDef?: SymbolDefinition,
): SymbolDefinition | undefined {
  // #1982: when the source wrote a qualified base (`Other::Inner`), resolve it
  // against the full-path QualifiedNameIndex FIRST, so a same-tail nested base
  // binds to the matching sibling instead of the first-inserted one that the
  // simple-tail scope walk picks. Falls through to the existing walk when the
  // base is unqualified, unknown, or the qualified lookup can't pick a unique
  // winner — so unqualified bases and the cross-file single-candidate case are
  // unchanged. `enclosingClassDef` (the deriving class) is threaded from the
  // caller to skip a redundant enclosing-class walk (#1982 perf).
  if (rawQualifiedName !== undefined) {
    const qualified = resolveQualifiedInheritanceBase(
      startScope,
      rawQualifiedName,
      scopes,
      enclosingClassDef,
    );
    if (qualified !== undefined) return qualified;
  }
  return (
    findClassBindingInScope(startScope, baseName, scopes) ??
    resolveAmbiguousInheritanceBaseViaImports(startScope, baseName, scopes)
  );
}

/**
 * Resolve a qualified inheritance base (`Other::Inner`, `ns::Base`) against the
 * full-path `QualifiedNameIndex` (keyed by `def.qualifiedName`, which carries
 * the promoted dotted path post-`populateOwners`). Tries the referencing site's
 * enclosing-scope segments as progressive prefixes (longest first) before the
 * root-anchored qualifier, so a *relative* base like `Outer::Inner` written
 * inside `namespace NS` resolves to the root-anchored key `NS.Outer.Inner`.
 * Returns a unique class-like def, or `undefined` when the base is unqualified,
 * unknown, or genuinely ambiguous at a key (refuse-on-tie — never guess; a
 * wrong EXTENDS edge silently corrupts impact analysis).
 */
function resolveQualifiedInheritanceBase(
  startScope: ScopeId,
  rawQualifiedName: string,
  scopes: ScopeResolutionIndexes,
  enclosingClassDef?: SymbolDefinition,
): SymbolDefinition | undefined {
  const normalized = stripTrailingTypeArguments(normalizeQualifiedName(rawQualifiedName));
  // No qualifier after normalization → nothing the simple-tail walk doesn't do.
  if (normalized.length === 0 || !normalized.includes('.')) return undefined;

  // #1982: a root-anchored base (`::Net::X`) names the GLOBAL scope, so it must
  // NOT be prefixed with the referencing site's enclosing segments — try only
  // the root-anchored key. normalizeQualifiedName strips the leading `::`, so
  // detect the anchor on the raw text (after leading whitespace).
  const isRootAnchored = /^\s*::/.test(rawQualifiedName);
  const enclosing = isRootAnchored
    ? []
    : enclosingScopeSegments(startScope, scopes, enclosingClassDef);
  // Candidate keys: longest enclosing prefix first for *relative* qualified
  // bases (`Outer.Inner` inside `NS.Outer.Derived` → `NS.Outer.Inner`). When the
  // qualifier names a *different* namespace than the enclosing scope (`new B.Foo()`
  // inside `namespace A` → `B.Foo`, not `A.Foo`), try the raw normalized key
  // FIRST so same-tail local bindings don't win (#2046 / #1991).
  const normParts = splitQualifiedName(normalized);
  const isRelativeToEnclosing =
    enclosing.length > 0 &&
    normParts.length > 0 &&
    normParts[0] === enclosing[enclosing.length - 1];
  const keys: string[] = [];
  if (!isRelativeToEnclosing) {
    keys.push(normalized);
  }
  for (let i = enclosing.length; i >= 1; i--) {
    keys.push([...enclosing.slice(0, i), normalized].join('.'));
  }
  if (!keys.includes(normalized)) {
    keys.push(normalized);
  }

  for (const key of keys) {
    const ids = scopes.qualifiedNames.get(key);
    if (ids.length === 0) continue;
    let unique: SymbolDefinition | undefined;
    let count = 0;
    for (const id of ids) {
      const def = scopes.defs.get(id);
      if (def !== undefined && isClassLike(def.type)) {
        unique = def;
        count++;
      }
    }
    if (count === 1) return unique;
    if (count > 1) {
      // #1993: same-tail bases collide at this namespace-omitted key (`NS1::A::Inner`
      // and `NS2::A::Inner` both key `A.Inner`). Break the tie with the bridge's
      // `namespacePrefix` sidecar — prefer the candidate in the SAME enclosing
      // namespace as the deriving class. Bridge-held: `def.qualifiedName` and the
      // index keys are untouched; still refuse when the sidecar can't pick a unique.
      const childPrefix = enclosingClassDef?.namespacePrefix;
      if (childPrefix !== undefined && childPrefix.length > 0) {
        let nsUnique: SymbolDefinition | undefined;
        let nsCount = 0;
        for (const id of ids) {
          const def = scopes.defs.get(id);
          if (def !== undefined && isClassLike(def.type) && def.namespacePrefix === childPrefix) {
            nsUnique = def;
            nsCount++;
          }
        }
        if (nsCount === 1) return nsUnique;
      }
      return undefined; // genuine tie → refuse, don't guess
    }
  }

  // Qualifier-vs-sidecar fallback (#2046). Languages whose class `qualifiedName`
  // is the SIMPLE name (C#) never populate a qualified key in the index, so the
  // keyed loop above can't see `B.Foo`. Resolve the simple TAIL and break the
  // same-tail collision by matching the explicit qualifier (`B`) against each
  // candidate's `namespacePrefix` sidecar. Commit only on a unique match — a
  // still-ambiguous qualifier refuses (never guesses a wrong EXTENDS/CALLS edge).
  const tail = normParts[normParts.length - 1];
  const qualifier = normParts.slice(0, -1).join('.');
  if (tail !== undefined && qualifier.length > 0) {
    const tailIds = scopes.qualifiedNames.get(tail);
    let qUnique: SymbolDefinition | undefined;
    let qCount = 0;
    for (const id of tailIds) {
      const def = scopes.defs.get(id);
      if (def === undefined || !isClassLike(def.type)) continue;
      const np = def.namespacePrefix;
      if (np === undefined || np.length === 0) continue;
      if (np === qualifier || np.endsWith(`.${qualifier}`)) {
        qUnique = def;
        qCount++;
      }
    }
    if (qCount === 1) return qUnique;
  }
  return undefined;
}

/**
 * Enclosing scope segments of an inheritance site, derived from the deriving
 * (child) class def's `qualifiedName` minus its own tail. For child
 * `NS.Other.Derived` this is `['NS', 'Other']`; empty for a file-scope child.
 * Used to build progressive-prefix lookup keys for relative qualified bases.
 */
function enclosingScopeSegments(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  enclosingClassDef?: SymbolDefinition,
): string[] {
  // Reuse the caller-provided deriving class when available (#1982 perf); only
  // walk the scope chain when it wasn't threaded in.
  const child = enclosingClassDef ?? findEnclosingClassDef(startScope, scopes);
  const q = child?.qualifiedName;
  if (q === undefined || q.length === 0) return [];
  const segs = q.split('.').filter(Boolean);
  return segs.slice(0, -1);
}

/**
 * Import/include-aware disambiguation for an *ambiguous* class-like base
 * name. Engages ONLY as a fallback after `findClassBindingInScope` has
 * already returned `undefined` — i.e. the scope-chain walk and the
 * single-match `qualifiedNames` fast paths could not pick a winner because
 * several same-named class-like defs exist (e.g. two `class Handler`s in
 * different headers/namespaces).
 *
 * Disambiguates by the referencing file's import graph: the enclosing
 * module scope's finalized `ImportEdge[]` (C++ `#include`, C# `using`, etc.)
 * each carry the exporting file in `targetFile`. A candidate whose defining
 * file is brought in by one of those edges is preferred. Resolution is
 * tiered, strictest first, and only commits when EXACTLY ONE candidate
 * survives a tier — so a still-ambiguous name keeps the historical
 * "return undefined" refusal:
 *
 *   1. Exact file match — candidate.filePath === an import's `targetFile`
 *      (covers C++ `#include "handler_a.h"` → that header's class).
 *   2. Same-directory match — candidate.filePath sits in the same directory
 *      as some import target file (covers C# `using MyApp.Models;`, where the
 *      namespace import resolves to ONE representative file in the namespace's
 *      directory, not necessarily the file declaring the referenced type).
 *
 * Language-neutral: keyed only on the finalized import edges and the
 * candidate defs' `filePath`. Returns `undefined` (preserving refusal) when
 * the name is single-match-resolvable already (never reached — caller gates
 * on `findClassBindingInScope` miss), when no import disambiguates, or when
 * a tier leaves more than one survivor.
 */
export function resolveAmbiguousInheritanceBaseViaImports(
  startScope: ScopeId,
  baseName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  // Gather the class-like candidates that share this simple name. Defs are
  // indexed by their `qualifiedName` in `qualifiedNames`; for languages whose
  // class qualifiedName IS the simple name (C++, C#, etc.) this is the full
  // candidate set. A single candidate is not "ambiguous" — leave it to the
  // existing single-match fast path (this fallback shouldn't have been called).
  const candidateIds = scopes.qualifiedNames.get(baseName);
  if (candidateIds.length < 2) return undefined;
  const candidates: SymbolDefinition[] = [];
  for (const id of candidateIds) {
    const def = scopes.defs.get(id);
    if (def !== undefined && isClassLike(def.type)) candidates.push(def);
  }
  if (candidates.length < 2) return undefined;

  // Collect the exporting files imported by the referencing file's enclosing
  // module scope (the chain may carry function-local imports too, but the
  // module scope is where `#include` / `using` land).
  const moduleScopeId = moduleScopeIdOf(startScope, scopes);
  if (moduleScopeId === null) return undefined;
  const importEdges = scopes.imports.get(moduleScopeId);
  if (importEdges === undefined || importEdges.length === 0) return undefined;
  const importedFiles = new Set<string>();
  const importedDirs = new Set<string>();
  for (const edge of importEdges) {
    if (edge.targetFile === null) continue;
    importedFiles.add(edge.targetFile);
    importedDirs.add(dirnameOf(edge.targetFile));
  }
  if (importedFiles.size === 0) return undefined;

  // Tier 1 — exact file match (C++ `#include "handler_a.h"`).
  const exact = candidates.filter((c) => importedFiles.has(c.filePath));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined; // still ambiguous → refuse

  // Tier 2 — same-directory match (C# namespace `using`, where the namespace
  // import resolves to one representative file in the namespace's directory).
  const sameDir = candidates.filter((c) => importedDirs.has(dirnameOf(c.filePath)));
  if (sameDir.length === 1) return sameDir[0];

  return undefined;
}

/**
 * Directory portion of a forward-slash workspace-relative path. Returns `''`
 * for a bare filename (no directory). Workspace paths are always normalized to
 * `/` separators upstream, so a simple `lastIndexOf('/')` is sufficient and
 * keeps this dependency-free.
 */
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/**
 * Predicate for value-receiver bridge: the labels for which
 * `reconcileOwnership` registers methods/fields under the def's
 * `nodeId` as the `ownerId`. Explicit allowlist so future NodeLabel
 * additions (Module, Namespace, TypeAlias, EnumMember, etc.) do NOT
 * silently widen the bridge — adding a new ownerable label requires
 * touching both this predicate and `reconcileOwnership`.
 *
 * See: `scope-resolution/pipeline/reconcile-ownership.ts` Property /
 * Variable / Const / Static registration block.
 */
export function isOwnableValueLabel(t: string): boolean {
  return t === 'Const' || t === 'Variable' || t === 'Property' || t === 'Static';
}

/**
 * Look up a value-binding (Const/Variable/Property/Static) by name in
 * the given scope's chain. Used by the value-receiver-owner bridge
 * for object-literal services such as:
 *
 *   export const fooService = { getUser(id) {...} };
 *
 * where `fooService` is a `Const`/`Variable` whose `nodeId` is the
 * `ownerId` of the member method. Neither `findClassBindingInScope`
 * (rejects non-class-like) nor `findReceiverTypeBinding` (no typeBinding
 * for an unannotated literal) finds it.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted def-type
 * predicate differs.
 */
export function findValueBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return walkScopeChain(startScope, receiverName, scopes, (def) => isOwnableValueLabel(def.type));
}

/**
 * Look up a SHAPE binding (class-like, or an object-type alias) by name.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted def-type
 * predicate differs — the same relationship `findValueBindingInScope` has to
 * it. Exists so a receiver typed as an object-type alias can reach that
 * alias's members WITHOUT the alias becoming eligible as an inheritance base:
 * `findClassBindingInScope` is what `resolveInheritanceBaseInScope` calls, so
 * widening that one would answer a question about hierarchies with a shape.
 */
export function findShapeBindingInScope(
  startScope: ScopeId,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return walkScopeChain(startScope, receiverName, scopes, (def) => isShapeLike(def.type));
}

/**
 * Generic scope-chain walker. Walks from `startScope` toward the root,
 * consulting both the local `scope.bindings` channel and the dual-source
 * `lookupBindingsAt` view (finalized + augmented). At each scope, local
 * bindings are exhausted BEFORE imported/augmented bindings — preserves
 * JavaScript-style lexical scoping where a local `const x` shadows an
 * imported `x` of the same name.
 *
 * Returns the first binding `def` matching `predicate`. Cycles in the
 * scope graph terminate the walk (defensive — should not occur in
 * well-formed inputs).
 */
function walkScopeChain(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
  predicate: (def: SymbolDefinition) => boolean,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;

    // `Object` scopes (object/record literal bodies) are a hoist
    // boundary only -- their members are reachable via property access,
    // never bare identifiers, so they contribute nothing to lookup
    // (#2545/#2551). Still traverse past to the parent.
    if (scope.kind !== 'Object') {
      // Local first: a `const x` in this scope shadows any imported `x`.
      const localBindings = scope.bindings.get(name);
      if (localBindings !== undefined) {
        for (const b of localBindings) {
          if (predicate(b.def)) return b.def;
        }
      }

      // Then imported/augmented bindings — only consulted when no local match.
      const importedBindings = lookupBindingsAt(currentId, name, scopes);
      for (const b of importedBindings) {
        if (predicate(b.def)) return b.def;
      }
    }

    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Look up a callable (Function/Method/Constructor) by name in the
 * given scope's chain. Uses the dual-source pattern (scope.bindings +
 * `lookupBindingsAt` for finalized + augmented) so cross-file
 * imports are visible — without it free calls to imported functions
 * never resolve via the post-pass.
 *
 * Mirrors `findClassBindingInScope` exactly; only the accepted
 * def-type predicate differs.
 */
export function findCallableBindingInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  return findAllCallableBindingsInScope(startScope, callableName, scopes)[0];
}

export interface CallableBindingCandidate {
  readonly def: SymbolDefinition;
  /** Every visibility path for this definition, in binding precedence order. */
  readonly bindings: readonly BindingRef[];
}

function collectCallableBindingCandidates(
  sources: readonly (readonly BindingRef[] | undefined)[],
): readonly CallableBindingCandidate[] {
  const byNodeId = new Map<string, { def: SymbolDefinition; bindings: BindingRef[] }>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const binding of source) {
      const def = binding.def;
      if (def.type !== 'Function' && def.type !== 'Method' && def.type !== 'Constructor') continue;
      const existing = byNodeId.get(def.nodeId);
      if (existing === undefined) {
        byNodeId.set(def.nodeId, { def, bindings: [binding] });
      } else {
        existing.bindings.push(binding);
      }
    }
  }
  return [...byNodeId.values()];
}

/**
 * Binding-aware callable lookup for consumers that need visibility evidence.
 * Unlike `lookupBindingsAt`, duplicate definitions retain every binding path,
 * so a weaker augmentation can contribute provenance even when a finalized
 * binding remains the candidate's canonical definition.
 */
export function findAllCallableBindingCandidatesInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): readonly CallableBindingCandidate[] {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return [];
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return [];

    if (scope.kind !== 'Object') {
      const lexical = collectCallableBindingCandidates([scope.bindings.get(callableName)]);
      if (lexical.length > 0) return lexical;

      const candidates = collectCallableBindingCandidates([
        scopes.bindings.get(currentId)?.get(callableName),
        scopes.bindingAugmentations.get(currentId)?.get(callableName),
        collectNamespaceFqnBindings(currentId, callableName, scopes),
        scopes.workspaceFqnBindings?.get(callableName),
      ]);
      if (candidates.length > 0) return candidates;
    }

    currentId = scope.parent;
  }
  return [];
}

/**
 * Look up all callable bindings (Function/Method/Constructor) by name
 * from the nearest scope in the chain that binds `callableName`.
 *
 * Preserves the original scope-walk boundary used by
 * `findCallableBindingInScope`: once any callable binding is found in a
 * scope, outer scopes are not consulted.
 */
/**
 * Every definition visible for `name` at the NEAREST scope that binds it,
 * filtered by `predicate` and deduped by `nodeId`.
 *
 * THE shared "collect all at the nearest binding scope" walk. `walkScopeChain`
 * answers the first-match question; this answers the how-many question, which is
 * what a caller needs before it can decline on ambiguity.
 *
 * Stops at the first scope that binds the name at all: an inner binding SHADOWS
 * an outer one, so continuing would report a shadowed outer definition as a
 * competing candidate and decline a name that is unambiguous at this point.
 *
 * Returns `[]` on a cycle or a missing scope. That is deliberate and matters:
 * an earlier copy of this walk `break`-ed instead and fell through to a
 * qualified-name fallback, so the same malformed input produced a different
 * answer depending on which copy the caller happened to reach.
 */
function findAllBindingsInScope(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
  predicate: (def: SymbolDefinition) => boolean,
): readonly SymbolDefinition[] {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return [];
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return [];

    // `Object` scopes are a hoist boundary only -- see walkScopeChain's
    // comment (#2545/#2551). Skip lookup here, still traverse to parent.
    if (scope.kind !== 'Object') {
      const out: SymbolDefinition[] = [];
      const seen = new Set<string>();
      const push = (def: SymbolDefinition): void => {
        if (!predicate(def)) return;
        if (seen.has(def.nodeId)) return;
        seen.add(def.nodeId);
        out.push(def);
      };

      // Local first: a binding in this scope shadows an imported one.
      for (const b of scope.bindings.get(name) ?? []) push(b.def);
      for (const b of lookupBindingsAt(currentId, name, scopes)) push(b.def);

      if (out.length > 0) return out;
    }
    currentId = scope.parent;
  }
  return [];
}

export function findAllCallableBindingsInScope(
  startScope: ScopeId,
  callableName: string,
  scopes: ScopeResolutionIndexes,
): readonly SymbolDefinition[] {
  return findAllBindingsInScope(
    startScope,
    callableName,
    scopes,
    (def) => def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor',
  );
}

/**
 * ISO C++ `[basic.lookup.unqual]` §7: ADL is suppressed when ordinary
 * unqualified lookup finds:
 *   - a name that is NOT a function or function template, OR
 *   - a block-scope function declaration that is NOT a using-declaration.
 *
 * Combined walker that stops at the **nearest scope** where `name` has any
 * binding (callable or non-callable) and returns:
 *   - `callables`: Function/Method/Constructor defs found at that scope
 *   - `nonCallableFound`: a non-function binding was present (variable, class, etc.)
 *   - `blockScopeDeclFound`: a callable was found at a Function or Block scope
 *     (block-scope function declaration that blocks ADL)
 *
 * One pass, one stop — no divergence between callable collection and blocker
 * detection.
 */
export function findCallableBindingsAndAdlBlocker(
  startScope: ScopeId,
  name: string,
  scopes: ScopeResolutionIndexes,
): {
  callables: readonly SymbolDefinition[];
  nonCallableFound: boolean;
  blockScopeDeclFound: boolean;
} {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId))
      return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined)
      return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };

    const callables: SymbolDefinition[] = [];
    const seen = new Set<string>();
    let nonCallableFound = false;
    let anyBinding = false;

    const process = (def: SymbolDefinition): void => {
      anyBinding = true;
      if (def.type === 'Function' || def.type === 'Method' || def.type === 'Constructor') {
        if (!seen.has(def.nodeId)) {
          seen.add(def.nodeId);
          callables.push(def);
        }
      } else {
        nonCallableFound = true;
      }
    };

    // `Object` scopes are a hoist boundary only (#2545/#2551) -- never
    // reached by C++'s ADL path in practice (no language reusing this
    // function emits `@scope.object`), guarded for consistency with the
    // other scope-chain walkers in this file.
    if (scope.kind !== 'Object') {
      const localBindings = scope.bindings.get(name);
      if (localBindings !== undefined) {
        for (const b of localBindings) {
          process(b.def);
        }
      }

      const importedBindings = lookupBindingsAt(currentId, name, scopes);
      for (const b of importedBindings) {
        process(b.def);
      }
    }

    if (anyBinding) {
      // ISO C++: a block-scope function declaration (Function or Block scope)
      // that is NOT a using-declaration blocks ADL. If we found callables at
      // a function/block scope, ADL must be suppressed.
      const blockScopeDeclFound =
        callables.length > 0 && (scope.kind === 'Function' || scope.kind === 'Block');
      return { callables, nonCallableFound, blockScopeDeclFound };
    }
    currentId = scope.parent;
  }
  return { callables: [], nonCallableFound: false, blockScopeDeclFound: false };
}

/**
 * Populate `ownerId` on every def structurally owned by a Class
 * scope — methods (defs in Function scopes whose parent is Class)
 * and class-body fields (defs directly in Class scopes).
 *
 * Generic OO ownership rule. Languages that want richer ownership
 * (e.g. inner-class qualification) can compose with this as a base
 * step.
 *
 * Mutates `parsed.localDefs` in place via type cast — `SymbolDefinition`
 * is `readonly` for consumers but the extractor returns plain objects.
 * Defs are shared by reference between `localDefs` and `Scope.ownedDefs`,
 * so this single mutation is visible from both sides.
 */
export function populateClassOwnedMembers(parsed: ParsedFile): void {
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  // Promote a def's qualifiedName from `methodName` to `ClassName.methodName`
  // when the def sits inside a class. Without this, two classes in the
  // same file that share a method name collide at the graph-bridge lookup
  // (`node-lookup.ts` keys by (filePath, qualifiedName) and falls back to
  // simple name only). Python's scope query doesn't emit
  // `@declaration.qualified_name` for nested methods, so the finalized
  // defs arrive here with simple names — we stamp the qualifier while
  // we're already walking class scopes for ownerId.
  const qualify = (def: SymbolDefinition, classDef: SymbolDefinition): void => {
    const q = def.qualifiedName;
    if (q === undefined || q.length === 0) return;
    if (q.includes('.')) return; // already qualified (dotted)
    // A synthesized anonymous-class def (Java `$`-chain binary name,
    // #2550/#2555 — `M3$2`, `EnumWrap$Mode$1`) already carries its
    // COMPLETE name. Prefixing it (`M3.M3$2`) desyncs from the
    // structure-phase node id (`M3$2.hook`), so same-named methods
    // across sibling enum-constant bodies collapse onto the first
    // body's node via the simple-name fallback (empirically caught in
    // review). Class-like only: `$`-named MEMBERS (legal in JS/TS)
    // still qualify normally against their class.
    if (isClassLike(def.type) && q.includes('$')) return;
    const classQ = classDef.qualifiedName;
    if (classQ === undefined || classQ.length === 0) return;
    (def as { qualifiedName: string }).qualifiedName = `${classQ}.${q}`;
  };

  // Depth invariant (verified empirically against Python scope-extractor
  // 2026-04-21): a nested `def helper` declared inside a method body
  // lives in its OWN Function scope whose parent is the method's Function
  // scope (not the Class scope). That means the `parentScope.kind ===
  // 'Class'` branch below only matches DIRECT class-scope children —
  // method defs themselves — and never stamps arbitrary nested defs with
  // `ownerId = classDef.nodeId`. If an adversarial reviewer raises this
  // as a potential false-attribution bug, verify first with a scope dump
  // on `class U: def save(self): def helper(): ...` — helper.ownerId will
  // remain undefined. The theoretical concern is real only if the
  // extractor ever stops creating scopes for inner defs.
  // `isShapeLike`, not `isClassLike`: OWNERSHIP is question (1) — "which
  // declaration do these members belong to?" — and an object-type alias owns
  // members exactly as the interface beside it does. Without this its members
  // get no `ownerId`, so nothing is registered under the alias and a receiver
  // typed as one finds the owner but never its members. Inheritance/MRO keep
  // `isClassLike`; see the predicate's docstring.
  for (const scope of parsed.scopes) {
    // Methods: function scope whose parent is a Class scope. Owner is
    // the parent's shape def.
    if (scope.parent !== null) {
      const parentScope = scopesById.get(scope.parent);
      if (parentScope !== undefined && parentScope.kind === 'Class') {
        const classDef = parentScope.ownedDefs.find((d) => isShapeLike(d.type));
        if (classDef !== undefined) {
          for (const def of scope.ownedDefs) {
            (def as { ownerId?: string }).ownerId = classDef.nodeId;
            qualify(def, classDef);
          }
        }
      }
    }
    // Class-body fields: defs directly owned by a Class scope (the
    // class-like def itself excluded).
    if (scope.kind === 'Class') {
      const classDef = scope.ownedDefs.find((d) => isShapeLike(d.type));
      if (classDef !== undefined) {
        for (const def of scope.ownedDefs) {
          if (def === classDef) continue;
          (def as { ownerId?: string }).ownerId = classDef.nodeId;
          qualify(def, classDef);
        }
      }
    }
  }
}

/**
 * Tag every def declared inside one or more `Namespace` scopes with its
 * enclosing-namespace path (`NS`, `Outer.Inner`) on a sidecar `namespacePrefix`
 * field — WITHOUT touching `qualifiedName`.
 *
 * Some scope-extractors qualify a nested type by its enclosing CLASS chain
 * (`A.Inner`) but drop the enclosing NAMESPACE, while the structure phase keys
 * the graph node by the full path (`NS.A.Inner`). `resolveDefGraphId` reads this
 * tag to retry the node lookup with the namespace-prefixed key before the
 * simple-name fallback, so same-tail nested bases don't collapse across sibling
 * namespace members (#1982). `qualifiedName` is deliberately left unchanged, so
 * the `qualifiedName`-keyed resolution index and existing namespace resolution
 * (brace-init, UDC ranking, two-phase lookup) are untouched.
 *
 * Language-agnostic: it acts only on `Namespace`-kind scopes (a namespace-free
 * language is a no-op) and is opt-in per provider (call after `populateOwners`).
 * Namespace segments are taken as each namespace def's own tail, so it composes
 * for nested namespaces regardless of whether the inner namespace's name is
 * stored simple or already dotted. Skips defs already carrying the prefix.
 */
export function tagNamespacePrefixes(
  parsed: ParsedFile,
  options: { readonly qualifiedNamesCarryNamespace?: boolean } = {},
): void {
  // Whether a def's `qualifiedName` may ALREADY encode its enclosing namespace.
  // Where it can (C++, C#), a name equal to — or prefixed by — the namespace path
  // must not be tagged again. Where it cannot, that guard misreads a coincidence:
  // a Rust `mod a { pub fn a() }` has `qualifiedName === 'a'` purely because the
  // item and its module share a name, and skipping it leaves the member looking
  // like it belongs to the PARENT module.
  const alreadyQualified =
    options.qualifiedNamesCarryNamespace === undefined
      ? true
      : options.qualifiedNamesCarryNamespace;
  const scopesById = new Map<ScopeId, ParsedFile['scopes'][number]>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  // Enclosing-namespace prefix for a scope: the dotted path of each ancestor
  // Namespace scope's name, outermost-first (`['Outer','Inner'] → 'Outer.Inner'`).
  const namespacePrefixOf = (scope: ParsedFile['scopes'][number]): string => {
    const segments: string[] = [];
    let parentId = scope.parent;
    while (parentId !== null) {
      const parent = scopesById.get(parentId);
      if (parent === undefined) break;
      if (parent.kind === 'Namespace') {
        const nsDef = parent.ownedDefs.find((d) => d.type === 'Namespace');
        const nsQ = nsDef?.qualifiedName;
        if (nsQ !== undefined && nsQ.length > 0) {
          const dot = nsQ.lastIndexOf('.');
          segments.unshift(dot === -1 ? nsQ : nsQ.slice(dot + 1));
        }
      }
      parentId = parent.parent;
    }
    return segments.join('.');
  };

  for (const scope of parsed.scopes) {
    if (scope.kind === 'Namespace') continue;
    const prefix = namespacePrefixOf(scope);
    if (prefix.length === 0) continue;
    for (const def of scope.ownedDefs) {
      const q = def.qualifiedName;
      if (q === undefined || q.length === 0) continue;
      if (alreadyQualified && (q === prefix || q.startsWith(`${prefix}.`))) continue;
      def.namespacePrefix = prefix;
    }
  }

  // #1993: also tag defs declared DIRECTLY in a Namespace scope with that
  // namespace's OWN full path. The loop above only reaches class-nested defs
  // (`A::Inner`); a deriving class like `NS1::DA` lives in the namespace scope and
  // is skipped, so it would carry no prefix and a same-tail cross-namespace base
  // tie (`NS1::A::Inner` vs `NS2::A::Inner`) could not be broken by the deriving
  // side. Composed identically to the class-nested path (enclosing tails + own
  // tail) so the two agree; still sidecar-only (`qualifiedName` untouched).
  for (const scope of parsed.scopes) {
    if (scope.kind !== 'Namespace') continue;
    const ownNsDef = scope.ownedDefs.find((d) => d.type === 'Namespace');
    const ownQ = ownNsDef?.qualifiedName;
    if (ownQ === undefined || ownQ.length === 0) continue;
    const ownTail = ownQ.slice(ownQ.lastIndexOf('.') + 1);
    const parentPrefix = namespacePrefixOf(scope);
    const fullPrefix = parentPrefix.length > 0 ? `${parentPrefix}.${ownTail}` : ownTail;
    for (const def of scope.ownedDefs) {
      if (def.type === 'Namespace') continue;
      const q = def.qualifiedName;
      if (q === undefined || q.length === 0) continue;
      if (alreadyQualified && (q === fullPrefix || q.startsWith(`${fullPrefix}.`))) continue;
      if (def.namespacePrefix !== undefined) continue;
      def.namespacePrefix = fullPrefix;
    }
  }
}

/**
 * Walk a scope chain upward looking for the innermost enclosing
 * Class scope and return that class's def. Used by per-language
 * `super` receiver branches to discover the dispatch base.
 */
export function findEnclosingClassDef(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Class') {
      const cd = scope.ownedDefs.find((d) => isClassLike(d.type));
      if (cd !== undefined) return cd;
    }
    currentId = scope.parent;
  }
  return undefined;
}

/**
 * Find a free-function def by simple name across all parsed files,
 * preferring scope-chain-visible bindings (import + finalized scope
 * bindings) before falling back to a workspace-wide simple-name scan.
 *
 * The fallback scan is intentionally loose so per-language compound
 * resolvers can find a callable target even when the binding chain
 * doesn't surface it (e.g. cross-package re-exports the finalize
 * pass missed). Strictly-typed languages may want to disable the
 * fallback by simply not calling this helper from their compound
 * resolver.
 */
export function findExportedDefByName(
  name: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  let currentId: ScopeId | null = inScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) break;
    // `Object` scopes are a hoist boundary only (#2545/#2551).
    if (scope.kind !== 'Object') {
      const local = scope.bindings.get(name);
      if (local !== undefined) {
        for (const b of local) {
          if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
        }
      }
      const finalized = lookupBindingsAt(currentId, name, scopes);
      for (const b of finalized) {
        if (b.def.type === 'Function' || b.def.type === 'Method') return b.def;
      }
    }
    currentId = scope.parent;
  }
  // Workspace-wide fallback: the first locally-declared callable binding
  // matching `name` across every file's Module scope (first-seen-by-file wins;
  // `origin === 'local'`, callable types Function/Method/Constructor). This is
  // precomputed ONCE into `index.exportedCallableByName` — byte-identical to the
  // old per-call scan over `moduleScopeByFile`, but O(1) and disk-read-free
  // (the old scan faulted every module scope in from disk under the out-of-core scope index). We use
  // this scope-derived index rather than `SemanticModel.symbols.lookupCallableByName`
  // because the `origin === 'local'` module-export-visibility filter is a scope
  // concept the raw symbol index doesn't express.
  return index.exportedCallableByName.get(name);
}

/**
 * Find a member of a class by simple name — delegates to
 * `SemanticModel.methods` (methods / functions / constructors) with a
 * fallback to `SemanticModel.fields` (properties / fields /
 * variables). After `runScopeResolution`'s reconciliation pass
 * populates both registries from `parsed.localDefs[i].ownerId`
 * (post-`populateOwners`), this is the single authoritative view of
 * class membership — no parallel scope-resolution index needed.
 *
 * Returns the first-seen overload for methods without arity or
 * return-type narrowing. Callers that need arity-aware dispatch use
 * `lookupMethodByOwner(owner, name, argCount)` directly.
 */
export function findOwnedMember(
  ownerDefId: string,
  memberName: string,
  model: SemanticModel,
): SymbolDefinition | undefined {
  const method = model.methods.lookupAllByOwner(ownerDefId, memberName)[0];
  if (method !== undefined) return method;
  return model.fields.lookupFieldByOwner(ownerDefId, memberName);
}

/**
 * Find a file-level def (top-of-module class / function / variable)
 * by simple name — consults the target file's Module scope's
 * finalized bindings. Only defs bound at module-scope with
 * `origin === 'local'` qualify, matching the historical
 * "module-export-visible" semantics. Class methods and class-body
 * fields bind at their containing class scope and are naturally
 * excluded.
 *
 * Reads from `WorkspaceResolutionIndex.moduleScopeByFile` (scope-tied
 * lookup that doesn't live on `SemanticModel`). This intentionally
 * does NOT call `lookupBindingsAt`: `findExportedDef` answers "what
 * did the target file declare locally at module scope?", while
 * `bindingAugmentations` models importer-side visibility created by
 * post-finalize hooks. Callers that need importer-visible exports use
 * `findExportedDefByName`, which is dual-channel aware.
 */
export function findExportedDef(
  targetFile: string,
  memberName: string,
  index: WorkspaceResolutionIndex,
): SymbolDefinition | undefined {
  const moduleScope = index.moduleScopeByFile.get(targetFile);
  if (moduleScope === undefined) return undefined;
  const refs = moduleScope.bindings.get(memberName);
  if (refs === undefined) return undefined;
  for (const ref of refs) {
    if (ref.origin === 'local') return ref.def;
  }
  return undefined;
}
