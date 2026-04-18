/**
 * `resolveTypeRef` — strict single-return resolver for `TypeRef`s
 * (RFC §4.6; Ring 2 SHARED #916).
 *
 * Narrower contract than `Registry.lookup`: no name-only global fallback, no
 * confidence ranking, no arity check. Used by `Registry.lookup` Step 2 (type-
 * binding propagation) and by any caller that wants the single best type-
 * target for an annotation without paying for the full evidence pipeline.
 *
 * **Algorithm (strict).** Walk the scope chain from `ref.declaredAtScope`:
 *
 *   1. At each scope, inspect `bindings.get(ref.rawName)`:
 *      - If one of the bindings is a **type-kind** def with a **strict origin**
 *        (`'local' | 'import' | 'namespace' | 'reexport'`), return it.
 *      - If any binding for this name exists at this scope but none qualifies
 *        (e.g., a local variable named `User` shadows an outer import of class
 *        `User`), return `null`. The nearer binding shadows; we do NOT fall
 *        through to the global qualified-name index.
 *      - Otherwise continue to the parent scope.
 *   2. If the raw name is a dotted path (e.g., `'models.User'`) and the scope
 *      walk produced no match, consult `QualifiedNameIndex.byQualifiedName`.
 *      Only accept **exactly one** type-kind hit — anything ambiguous returns
 *      `null` rather than a guess.
 *   3. Return `null`.
 *
 * **What `'strict' origins' means.** `'wildcard'` is intentionally excluded.
 * A wildcard-expanded name (`from x import *`) is too loose to use as an
 * anchor for type resolution — it gives no signal about whether the name was
 * actually imported. `Registry.lookup` may accept wildcard bindings at its
 * own discretion (with lower evidence weight); `resolveTypeRef` does not.
 *
 * **What 'type-kind' means.** The subset of `NodeLabel` that a type annotation
 * may legitimately reference: class-like, interface-like, enum-like, and
 * alias-like kinds. See `TYPE_KINDS` below.
 *
 * Pure function — safe to call repeatedly; no side effects.
 */

import type { NodeLabel } from '../graph/types.js';
import type { SymbolDefinition } from './symbol-definition.js';
import type { BindingRef, Scope, ScopeId, TypeRef } from './types.js';
import type { DefIndex } from './def-index.js';
import type { QualifiedNameIndex } from './qualified-name-index.js';

// ─── Public contracts ───────────────────────────────────────────────────────

/**
 * Minimal scope-lookup contract required by `resolveTypeRef`. Implemented by
 * the `ScopeTree` from #912; declared here so #916 can ship as a standalone
 * piece without a hard dependency on the full scope-tree implementation. Any
 * structure that hands back a `Scope` by `ScopeId` satisfies this contract.
 */
export interface ScopeLookup {
  getScope(id: ScopeId): Scope | undefined;
}

/**
 * All inputs `resolveTypeRef` needs from the semantic model. Bundled into a
 * context object so the call site stays short and the interface is stable as
 * additional indexes get threaded through in later rings.
 */
export interface ResolveTypeRefContext {
  readonly scopes: ScopeLookup;
  readonly defIndex: DefIndex;
  readonly qualifiedNameIndex: QualifiedNameIndex;
}

// ─── Strict policy constants ────────────────────────────────────────────────

/** `'wildcard'` is deliberately absent. See file header. */
const STRICT_ORIGINS: ReadonlySet<BindingRef['origin']> = new Set<BindingRef['origin']>([
  'local',
  'import',
  'namespace',
  'reexport',
]);

/**
 * `NodeLabel` values that may appear on the RHS of a type annotation.
 *
 * Includes the usual class-like and interface-like kinds plus the alias-like
 * ones (`TypeAlias`, `Typedef`). `Namespace` is excluded — it is a scope
 * container, not a value type. `Function` / `Method` / `Variable` are
 * excluded by design: a `rawName` bound to them at a strict origin is a
 * *shadowing* binding, which the algorithm short-circuits to `null`.
 */
const TYPE_KINDS: ReadonlySet<NodeLabel> = new Set<NodeLabel>([
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Union',
  'Trait',
  'TypeAlias',
  'Typedef',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
]);

// ─── Main entry point ──────────────────────────────────────────────────────

export function resolveTypeRef(ref: TypeRef, ctx: ResolveTypeRefContext): SymbolDefinition | null {
  // Phase 1: scope-chain walk anchored at the declaration site.
  let currentId: ScopeId | null = ref.declaredAtScope;
  const visited = new Set<ScopeId>();

  while (currentId !== null) {
    // Cycle guard — a well-formed scope tree never loops, but a bug in the
    // construction path should fail fast here rather than hanging.
    if (visited.has(currentId)) return null;
    visited.add(currentId);

    const scope = ctx.scopes.getScope(currentId);
    if (scope === undefined) return null; // broken chain = unresolvable

    const bindings = scope.bindings.get(ref.rawName);
    if (bindings !== undefined && bindings.length > 0) {
      // At least one binding exists at this scope → it is the shadowing site.
      // Either one of them qualifies, or the name is shadowed by a non-type.
      for (const binding of bindings) {
        if (!STRICT_ORIGINS.has(binding.origin)) continue;
        if (TYPE_KINDS.has(binding.def.type)) {
          return binding.def;
        }
      }
      // Shadowed by a non-type / non-strict-origin binding. Fail fast — no
      // global fallback, no walk to the parent.
      return null;
    }

    currentId = scope.parent;
  }

  // Phase 2: dotted fallback via `QualifiedNameIndex`. Only accept a unique
  // type-kind hit; anything ambiguous returns null (strict: no guesses).
  if (ref.rawName.includes('.')) {
    const candidates = ctx.qualifiedNameIndex.get(ref.rawName);
    let onlyTypeDef: SymbolDefinition | null = null;
    for (const defId of candidates) {
      const def = ctx.defIndex.get(defId);
      if (def === undefined) continue;
      if (!TYPE_KINDS.has(def.type)) continue;
      if (onlyTypeDef !== null) return null; // ambiguous
      onlyTypeDef = def;
    }
    if (onlyTypeDef !== null) return onlyTypeDef;
  }

  return null;
}
