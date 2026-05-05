/**
 * Scope-resolution → legacy graph-node ID bridging.
 *
 * Two functions:
 *   - `resolveDefGraphId` — turn a scope-resolution `SymbolDefinition`
 *     into the graph's node id for the corresponding legacy node.
 *   - `resolveCallerGraphId` — walk a scope chain from a reference
 *     site upward to find the enclosing function/method/class and
 *     return its graph-node id. Falls back to the File node for
 *     module-level calls so those still get an edge source.
 *
 * Next-consumer contract: language-agnostic. Any OO language with
 * file-level module semantics (TypeScript, Java, Go, Kotlin) can
 * reuse `resolveCallerGraphId` as-is. Languages with different
 * top-level semantics (COBOL programs, Rust crate modules) may want
 * a different file-level fallback — cross that bridge when they
 * migrate.
 */

import type { NodeLabel, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { generateId } from '../../../../lib/utils.js';
import { qualifiedKey, simpleKey, type GraphNodeLookup } from '../graph-bridge/node-lookup.js';
/**
 * Labels that may legitimately ANCHOR a CALLS/ACCESSES edge as the
 * source ("caller"). A Variable / Property can be the TARGET of an
 * edge (e.g., a write-access to `user.name`), but it cannot be a
 * caller — variables don't execute code, so attributing a call to a
 * sibling Variable in the same scope produces nonsense edges like
 * `Variable:create → Function:create` (which the simpleKey fallback
 * in `resolveDefGraphId` then silently rewrites to
 * `Function:create → Function:create`, a self-loop that doesn't exist
 * in the source).
 *
 * Module-level call expressions inside a `const X = expr(args)`
 * declaration are the canonical case where this used to fail: the
 * walk-up over module scope's ownedDefs (only Variables) would land
 * on the FIRST Variable, get name-aliased to its sibling Function
 * with the same simple name, and emit a self-CALLS. With this label
 * restricted to function/class-likes, those calls correctly fall
 * through to the File-node fallback at the bottom of the walk.
 */
function isCallerAnchorLabel(label: NodeLabel): boolean {
  return (
    label === 'Function' ||
    label === 'Method' ||
    label === 'Constructor' ||
    label === 'Class' ||
    label === 'Interface' ||
    label === 'Struct' ||
    label === 'Enum'
  );
}

/**
 * Look up a `SymbolDefinition` in the graph node lookup.
 *
 * Tries the type-prefixed fully-qualified key FIRST. That's the only
 * correct key when:
 *   - Two classes in the same file define a method with the same
 *     simple name (`class User: def save` + `class Document: def save`).
 *   - A top-level function and a class method share a simple name
 *     (`def save` + `class User: def save` — the Function's qualifier
 *     is just `save`, which would alias the Method's simple-key slot
 *     without the type prefix).
 *
 * Falls back to the simple name for definitions whose qualifier the
 * lookup didn't capture (rare, but keeps cross-file simple-name
 * resolution working for languages that don't yet synthesize
 * qualifiers).
 */
export function resolveDefGraphId(
  filePath: string,
  def: { qualifiedName?: string; type?: NodeLabel; parameterTypes?: readonly string[] },
  nodeLookup: GraphNodeLookup,
): string | undefined {
  const qn = def.qualifiedName;
  if (qn === undefined || qn.length === 0) return undefined;
  if (def.type !== undefined) {
    // Overload disambiguation: when the def carries parameter types,
    // try the parameter-typed key first so same-name same-arity
    // overloads route to their distinct graph nodes.
    if (
      def.type === 'Method' &&
      def.parameterTypes !== undefined &&
      def.parameterTypes.length > 0
    ) {
      const pKey = qualifiedKey(filePath, def.type, `${qn}~${def.parameterTypes.join(',')}`);
      const pHit = nodeLookup.get(pKey);
      if (pHit !== undefined) return pHit;
    }
    const qualifiedHit = nodeLookup.get(qualifiedKey(filePath, def.type, qn));
    if (qualifiedHit !== undefined) return qualifiedHit;
  }
  const simpleName = qn.lastIndexOf('.') === -1 ? qn : qn.slice(qn.lastIndexOf('.') + 1);
  return nodeLookup.get(simpleKey(filePath, simpleName));
}

/** Derive the simple (unqualified) name of a def from its `qualifiedName`. */
export function simpleQualifiedName(def: SymbolDefinition): string | undefined {
  const q = def.qualifiedName;
  if (q === undefined || q.length === 0) return undefined;
  const dot = q.lastIndexOf('.');
  return dot === -1 ? q : q.slice(dot + 1);
}

/**
 * Walk the scope chain from `startScope` upward looking for the first
 * scope whose `ownedDefs` contains a Function/Method/Class — that's
 * our caller anchor. Translate via `nodeLookup` to the graph-node ID.
 *
 * Module-level references (e.g. Python `u = models.User()` at top
 * level) have no enclosing function/method/class. Fall back to the
 * File node for the scope's filePath so those calls still get an
 * edge source. Matches legacy DAG behavior where module-level CALLS
 * edges originate from the file symbol.
 */
export function resolveCallerGraphId(
  startScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  nodeLookup: GraphNodeLookup,
): string | undefined {
  let current: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  let lastFilePath: string | undefined;
  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) break;
    lastFilePath = scope.filePath;

    // Prefer Function/Method/Constructor anchors; fall back to
    // Class/Interface/Struct/Enum. Variable/Property are NOT valid
    // caller anchors — see `isCallerAnchorLabel` for why.
    const fnDef = scope.ownedDefs.find(
      (d) => d.type === 'Function' || d.type === 'Method' || d.type === 'Constructor',
    );
    if (fnDef !== undefined) {
      const id = resolveDefGraphId(scope.filePath, fnDef, nodeLookup);
      if (id !== undefined) return id;
    }
    const classDef = scope.ownedDefs.find((d) => isCallerAnchorLabel(d.type));
    if (classDef !== undefined) {
      const id = resolveDefGraphId(scope.filePath, classDef, nodeLookup);
      if (id !== undefined) return id;
    }
    current = scope.parent;
  }
  // Module-level calls — fall back to the File node for the scope's filePath.
  if (lastFilePath !== undefined) {
    return generateId('File', lastFilePath);
  }
  return undefined;
}
