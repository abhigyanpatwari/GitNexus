import type { BindingRef, ParsedFile, ScopeId, SourcePosition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { collectNamespaceTargets, type NamespaceTargetOptions } from './namespace-targets.js';

const compare = (a: SourcePosition, b: SourcePosition): number =>
  a.startLine - b.startLine || a.startCol - b.startCol;

/** Per-file namespace snapshots change only when a claim or binding activates.
 * Keep only the target maps here: receiver type lookup still needs each site's
 * exact position, even when its namespace snapshot is shared with other sites.
 */
export function createNamespaceTargetCache(
  parsed: Pick<ParsedFile, 'moduleScope' | 'scopes'>,
  scopes: ScopeResolutionIndexes,
  options: Omit<NamespaceTargetOptions, 'inScope' | 'position'>,
  importsBindAtLexicalScope: boolean,
) {
  const boundaries: SourcePosition[] = [];
  const scopeIds = new Set<ScopeId>();
  const importNames = new Set<string>();
  const accessibleNamespaces = new Set<string>();
  const tree = scopes.scopeTree;
  let complete = typeof tree?.getChildren === 'function';
  let requiresLexicalLookup = importsBindAtLexicalScope;
  const collectBindings = (bindings: ReadonlyMap<string, readonly BindingRef[]> | undefined) => {
    if (bindings === undefined) return;
    for (const refs of bindings.values()) {
      for (const ref of refs)
        if (ref.availableFrom !== undefined) boundaries.push(ref.availableFrom);
    }
  };

  // Sealed disk-backed ParsedFiles have no scopes left in their arrays. Walk
  // the index using point lookups, never scopeTree.byId (unsupported on disk).
  const pending = [parsed.moduleScope, ...parsed.scopes.map((scope) => scope.id)];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (scopeIds.has(id)) continue;
    scopeIds.add(id);
    const scope = tree?.getScope(id);
    if (scope === undefined) {
      complete = false;
      continue;
    }
    if (scope.nameClaims !== undefined) requiresLexicalLookup = true;
    for (const claim of scope.nameClaims ?? []) {
      if (claim.availableFrom !== undefined) boundaries.push(claim.availableFrom);
    }
    collectBindings(scope.bindings);
    collectBindings(scopes.bindings?.get(id));
    collectBindings(scopes.bindingAugmentations?.get(id));
    for (const edge of scopes.imports?.get(id) ?? scope.imports) importNames.add(edge.localName);
    for (const namespace of scopes.accessibleNamespacesByScope?.get(id) ?? []) {
      accessibleNamespaces.add(namespace);
    }
    if (typeof tree.getChildren === 'function') pending.push(...tree.getChildren(id));
    if (scope.parent !== null) pending.push(scope.parent);
    if (scope.lookupPolicy?.parentScope !== undefined) pending.push(scope.lookupPolicy.parentScope);
  }
  // These shared binding channels can also shadow an import. Inspect only the
  // imported names, rather than scanning the workspace for every source file.
  for (const name of importNames) {
    for (const ref of scopes.workspaceFqnBindings?.get(name) ?? []) {
      if (ref.availableFrom !== undefined) boundaries.push(ref.availableFrom);
    }
    for (const namespace of accessibleNamespaces) {
      for (const ref of scopes.namespaceFqnBindings?.get(namespace)?.get(name) ?? []) {
        if (ref.availableFrom !== undefined) boundaries.push(ref.availableFrom);
      }
    }
  }
  boundaries.sort(compare);
  const activations = boundaries.filter(
    (point, i) => i === 0 || compare(point, boundaries[i - 1]!) !== 0,
  );
  const byScope = new Map<ScopeId, Map<number | string, Map<string, string[]>>>();

  const at = (inScope = parsed.moduleScope, position?: SourcePosition): Map<string, string[]> => {
    let bucket: number | string = -1; // An unspecified position sees every activation.
    if (position !== undefined) {
      if (!complete || !scopeIds.has(inScope)) {
        // Partial/legacy index views cannot prove that two positions have the
        // same active claims. Retain exact-position caching in that case.
        bucket = `${position.startLine}:${position.startCol}`;
      } else {
        let lo = 0;
        let hi = activations.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (compare(activations[mid]!, position) <= 0) lo = mid + 1;
          else hi = mid;
        }
        bucket = lo;
      }
    }
    let snapshots = byScope.get(inScope);
    if (snapshots === undefined) {
      snapshots = new Map();
      byScope.set(inScope, snapshots);
    }
    let targets = snapshots.get(bucket);
    if (targets === undefined) {
      targets = collectNamespaceTargets(parsed, scopes, { ...options, inScope, position });
      snapshots.set(bucket, targets);
    }
    return targets;
  };
  return { at, requiresLexicalLookup: requiresLexicalLookup || !complete };
}
