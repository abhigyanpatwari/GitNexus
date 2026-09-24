/**
 * Scope-tree walking primitives shared by the providers' `bindingScopeFor`
 * hooks.
 *
 * Language-neutral: parameterised over `ScopeKind` — the shared scope
 * vocabulary — and names no language, so it belongs in the core pipeline
 * rather than in any one provider (AGENTS.md § shared pipeline code).
 */

import type { Scope, ScopeId, ScopeTree } from 'gitnexus-shared';

/**
 * Walk up the scope chain to find the first scope whose `kind` matches
 * any of `kinds`. Returns the matching scope's id or `null` when no
 * ancestor matches (e.g., a return type binding emitted outside any
 * Module scope — shouldn't happen in well-formed input).
 *
 * Every provider that hoists a binding out of the scope it was captured in
 * needs exactly this walk: a field typed from a constructor call in a method
 * body belongs on the enclosing Class, a `var` on the enclosing Function or
 * Module, a method return type on the Module. Which `kind` to stop at is the
 * only per-language part, and that is the parameter.
 */
export function walkToScope(
  from: Scope,
  tree: ScopeTree,
  ...kinds: readonly Scope['kind'][]
): ScopeId | null {
  let cur: Scope | undefined = from;
  const kindSet = new Set(kinds);
  while (cur !== undefined) {
    if (kindSet.has(cur.kind)) return cur.id;
    const parentId: ScopeId | null = cur.parent ?? null;
    if (parentId === null) break;
    cur = tree.getScope(parentId);
  }
  return null;
}
