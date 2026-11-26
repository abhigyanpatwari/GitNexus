import { makeScopeId, type BindingRef, type ScopeId, type SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';

const namespaceBodies = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  Map<ScopeId, readonly ScopeId[]>
>();

function bodyScopes(def: SymbolDefinition, scopes: ScopeResolutionIndexes): readonly ScopeId[] {
  const range = def.declarationRange;
  if (!range) return [];
  const tree = scopes.scopeTree;
  let cache = namespaceBodies.get(tree);
  if (!cache) {
    cache = new Map();
    namespaceBodies.set(tree, cache);
  }
  const id = makeScopeId({ filePath: def.filePath, kind: 'Namespace', range });
  const cached = cache.get(id);
  if (cached) return cached;
  const bodies = [
    id,
    ...tree.getChildren(id).filter((child) => {
      const body = tree.getScope(child);
      return (
        body?.kind === 'Block' &&
        body.range.endLine === range.endLine &&
        body.range.endCol === range.endCol
      );
    }),
  ];
  cache.set(id, bodies);
  return bodies;
}

/** Resolve a path through the exports of lexically selected namespace declarations. */
export function publishedNamespaceMember(
  bindings: readonly BindingRef[],
  members: readonly string[],
  scopes: ScopeResolutionIndexes,
) {
  let owners = bindings;
  for (const [index, name] of members.entries()) {
    let known = false;
    const candidates = new Map<string, { scope: string; def: SymbolDefinition }>();
    for (const { def } of owners) {
      if (def.type !== 'Namespace') continue;
      for (const body of bodyScopes(def, scopes)) {
        for (const binding of scopes.scopeTree.getScope(body)?.bindings.get(name) ?? []) {
          if (binding.def.namedExports === undefined) continue;
          known = true;
          if (binding.def.namedExports.includes(name))
            candidates.set(binding.def.nodeId, { scope: body, def: binding.def });
        }
      }
    }
    if (!candidates.size) return known ? null : undefined;
    if (index === members.length - 1)
      return candidates.size === 1 ? candidates.values().next().value : null;
    owners = [...candidates.values()].map(({ def }) => ({ def, origin: 'local' }));
  }
  return undefined;
}

/** Collect the visible exports when several namespace declarations form one scope. */
export function namespaceExportsForBindings(
  owners: readonly BindingRef[],
  scopes: ScopeResolutionIndexes,
): Map<string, BindingRef[]> {
  const exports = new Map<string, BindingRef[]>();
  for (const { def } of owners) {
    if (def.type !== 'Namespace') continue;
    for (const id of bodyScopes(def, scopes)) {
      for (const [name, members] of scopes.scopeTree.getScope(id)?.bindings ?? []) {
        for (const ref of members) {
          if (!ref.def.namedExports?.includes(name)) continue;
          const published = exports.get(name);
          if (published) published.push(ref);
          else exports.set(name, [ref]);
        }
      }
    }
  }
  return exports;
}
