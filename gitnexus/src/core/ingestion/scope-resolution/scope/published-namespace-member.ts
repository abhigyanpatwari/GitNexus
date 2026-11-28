import {
  makeScopeId,
  type BindingRef,
  type LookupPurpose,
  type ParsedFile,
  type SourcePosition,
  type ScopeId,
  type SymbolDefinition,
} from 'gitnexus-shared';
import { lookupNameClaim } from './walkers.js';
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

interface Publication {
  readonly local: string;
  readonly ref: BindingRef;
}

function addPublication(
  byName: Map<string, Publication[]>,
  name: string,
  publication: Publication,
) {
  const published = byName.get(name);
  if (published) published.push(publication);
  else byName.set(name, [publication]);
}

const publicationsByBody = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  Map<ScopeId, Map<string, Publication[]>>
>();

/** Index a namespace body's public spellings once per scope tree. */
function publicBindings(body: ScopeId, scopes: ScopeResolutionIndexes) {
  const tree = scopes.scopeTree;
  let bodies = publicationsByBody.get(tree);
  if (!bodies) {
    bodies = new Map();
    publicationsByBody.set(tree, bodies);
  }
  let byName = bodies.get(body);
  if (byName) return byName;
  byName = new Map<string, Publication[]>();
  for (const [local, bindings] of tree.getScope(body)?.bindings ?? []) {
    for (const ref of bindings) {
      if (ref.def.namedExports === undefined) continue;
      for (const name of ref.def.namedExports) {
        addPublication(byName, name, { local, ref });
      }
      for (const name of ref.def.typeOnlyExports ?? []) {
        const erased: BindingRef = {
          def: ref.def,
          origin: 'reexport',
          via: {
            kind: 'reexport',
            localName: name,
            targetExportedName: local,
            targetFile: ref.def.filePath,
            typeOnly: true,
          },
        };
        addPublication(byName, name, { local, ref: erased });
      }
    }
  }
  bodies.set(body, byName);
  return byName;
}

const namespaceRoots = new WeakMap<ScopeResolutionIndexes['scopeTree'], Set<string>>();

function declaredNamespaceRoots(files: readonly ParsedFile[]): Set<string> {
  const roots = new Set<string>();
  for (const file of files) {
    for (const def of file.localDefs) {
      if (def.type === 'Namespace' && def.qualifiedName)
        roots.add(def.qualifiedName.split('.')[0]!);
    }
  }
  return roots;
}

/** Register names once after finalization. Other receivers can skip lexical namespace lookup. */
export function indexPublishedNamespaceRoots(
  files: readonly ParsedFile[],
  scopes: ScopeResolutionIndexes,
) {
  const roots = declaredNamespaceRoots(files);
  if (!roots.size) return;
  for (const file of files) {
    for (const entry of file.parsedImports) {
      if (!('localName' in entry) || roots.has(entry.localName)) continue;
      const bindings = scopes.bindings.get(file.moduleScope)?.get(entry.localName);
      if (bindings?.some(({ def }) => def.type === 'Namespace')) roots.add(entry.localName);
    }
  }
  namespaceRoots.set(scopes.scopeTree, roots);
}

/** A declared namespace may be local, imported under an alias, or project-global. */
export function declaredNamespaceValue(
  qualifier: string,
  name: string,
  scope: ScopeId,
  scopes: ScopeResolutionIndexes,
  position?: SourcePosition,
) {
  const roots = namespaceRoots.get(scopes.scopeTree);
  if (!roots) return;
  const dot = qualifier.indexOf('.');
  const root = dot < 0 ? qualifier : qualifier.slice(0, dot);
  if (!roots.has(root)) return;
  const claim = lookupNameClaim(scope, root, scopes, { purpose: 'value', position });
  if (claim.imports.some((edge) => edge.kind === 'namespace')) return;
  const path = dot < 0 ? [name] : [...qualifier.slice(dot + 1).split('.'), name];
  const candidates = namespaceCandidates(claim.bindings, path, scopes, 'value');
  // A merged class or function also owns its own static members.
  if (candidates === null) {
    const family = claim.scope?.bindings.get(root) ?? claim.bindings;
    if (family.some(({ def }) => def.type === 'Class' || def.type === 'Function')) return;
  }
  return candidates;
}

/** Resolve a path through the exports of lexically selected namespace declarations. */
export function publishedNamespaceMember(
  bindings: readonly BindingRef[],
  members: readonly string[],
  scopes: ScopeResolutionIndexes,
  purpose: LookupPurpose,
) {
  const candidates = namespaceCandidates(bindings, members, scopes, purpose);
  if (!candidates) return candidates;
  return candidates.size === 1 ? candidates.values().next().value : null;
}

interface NamespaceMember {
  scope: ScopeId;
  local: string;
  def: SymbolDefinition;
}

/** A declaration can claim a name even when it exports no member for this lookup purpose. */
function collectNamespaceMembers(
  owner: SymbolDefinition,
  name: string,
  scopes: ScopeResolutionIndexes,
  purpose: LookupPurpose,
  candidates: Map<string, NamespaceMember>,
): boolean {
  if (owner.type !== 'Namespace') return false;
  let known = false;
  for (const body of bodyScopes(owner, scopes)) {
    const published = publicBindings(body, scopes).get(name);
    if (
      published ||
      scopes.scopeTree
        .getScope(body)
        ?.bindings.get(name)
        ?.some(({ def }) => def.namedExports !== undefined)
    )
      known = true;
    for (const { local, ref } of published ?? []) {
      if (purpose === 'value' && ref.via?.typeOnly) continue;
      candidates.set(ref.def.nodeId, { scope: body, local, def: ref.def });
    }
  }
  return known;
}

function namespaceCandidates(
  bindings: readonly BindingRef[],
  members: readonly string[],
  scopes: ScopeResolutionIndexes,
  purpose: LookupPurpose,
) {
  let owners = bindings;
  for (const [index, name] of members.entries()) {
    let known = false;
    const candidates = new Map<string, NamespaceMember>();
    for (const { def } of owners) {
      if (collectNamespaceMembers(def, name, scopes, purpose, candidates)) known = true;
    }
    if (!candidates.size) return known ? null : undefined;
    if (index === members.length - 1) return candidates;
    owners = [...candidates.values()].map(({ def }) => ({ def, origin: 'local' }));
  }
  return undefined;
}

function mergeNamespaceBodyExports(
  exports: Map<string, Map<string, BindingRef>>,
  publications: ReadonlyMap<string, readonly Publication[]>,
) {
  for (const [name, members] of publications) {
    let published = exports.get(name);
    if (!published) {
      published = new Map();
      exports.set(name, published);
    }
    for (const { ref } of members) {
      const previous = published.get(ref.def.nodeId);
      if (!previous || (previous.via?.typeOnly && !ref.via?.typeOnly))
        published.set(ref.def.nodeId, ref);
    }
  }
}

/** Collect the visible exports when several namespace declarations form one scope. */
export function namespaceExportsForBindings(
  owners: readonly BindingRef[],
  scopes: ScopeResolutionIndexes,
): Map<string, BindingRef[]> {
  const exports = new Map<string, Map<string, BindingRef>>();
  for (const { def } of owners) {
    if (def.type !== 'Namespace') continue;
    for (const id of bodyScopes(def, scopes)) {
      mergeNamespaceBodyExports(exports, publicBindings(id, scopes));
    }
  }
  return new Map([...exports].map(([name, refs]) => [name, [...refs.values()]]));
}
