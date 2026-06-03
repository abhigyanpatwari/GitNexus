import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rubyProvider } from '../ruby.js';
import { rubyArityCompatibility, rubyMergeBindings, resolveRubyImportTarget } from './index.js';
import { populateClassOwnedMembers, isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import { decodeMarker } from '../../utils/heritage-marker.js';

/**
 * #1991: resolve a BARE mixin reference (`include Loggable`) to a nested module by
 * the INCLUDING class's lexical scope — Ruby looks up a constant in the innermost
 * enclosing scope first. For owner `App.S`, try `App.Loggable`, then walk outward.
 * Returns undefined if no enclosing-scope-qualified module exists.
 */
function qualifyMixinByOwnerScope(
  mixinName: string,
  ownerName: string,
  graphIdByName: ReadonlyMap<string, string>,
): string | undefined {
  let prefix = ownerName;
  let dot = prefix.lastIndexOf('.');
  while (dot !== -1) {
    prefix = prefix.slice(0, dot);
    const g = graphIdByName.get(`${prefix}.${mixinName}`);
    if (g !== undefined) return g;
    dot = prefix.lastIndexOf('.');
  }
  return undefined;
}

function emitRubyMixinEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const graphIdByName = new Map<string, string>();
  // Secondary tail -> graphId map. The `__heritage__` marker carries the mixin
  // TARGET as the bare written name (`arg.text`, e.g. `Loggable`), not its full
  // qualifiedName, so a nested mixin module included by its short name misses the
  // full-qn map. We first resolve it lexically by the including class's enclosing
  // scope (`qualifyMixinByOwnerScope`); this tail map is the last resort. A genuine
  // same-tail collision is mapped to `null` so we REFUSE to guess (#1991) rather
  // than the old first-wins, which cross-wired App::Loggable / Web::Loggable.
  const graphIdByTail = new Map<string, string | null>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) {
        // Key by the FULL qualified name (`Outer.Inner`), NOT the simple tail.
        // Same-tail nested classes (`Outer::Inner` + `Other::Inner`) otherwise
        // collapse onto one `Inner` key (last-wins) and cross-wire their mixin /
        // attr_accessor owners (#1982). The `__heritage__`/`__property__` markers
        // carry the full qualified owner name in lockstep (see ruby/captures.ts).
        const fullName = def.qualifiedName ?? '';
        if (fullName.length > 0) {
          graphIdByName.set(fullName, graphId);
          const dot = fullName.lastIndexOf('.');
          const tail = dot === -1 ? fullName : fullName.slice(dot + 1);
          if (tail.length > 0) {
            const existingTail = graphIdByTail.get(tail);
            if (existingTail === undefined) graphIdByTail.set(tail, graphId);
            else if (existingTail !== null && existingTail !== graphId)
              graphIdByTail.set(tail, null); // same-tail collision — refuse to guess
          }
        }
      }
    }
  }

  const emitted = new Set<string>();
  // Pre-seed with existing IMPLEMENTS edges to avoid duplicates when the
  // parse-worker path already produced heritage (worker path for repos
  // with >= 15 files).
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    emitted.add(`${rel.sourceId}->${rel.targetId}:${rel.reason}`);
  }

  for (const parsed of parsedFiles) {
    for (const imp of parsed.parsedImports) {
      const decoded = decodeMarker(imp.targetRaw);
      if (decoded?.kind !== 'heritage') continue;
      const parts = decoded.fields;
      if (parts.length < 3) continue;
      const [kind, mixinName, className] = parts;
      const classGraphId = graphIdByName.get(className!);
      // Owner stays full-qn. The mixin target may be written by short name and miss
      // the full-qn map; resolve it lexically by the including class's enclosing
      // scope (`App::S` + `Loggable` -> `App::Loggable`), then fall back to the tail
      // map ONLY when unambiguous — never first-wins on a collision (#1982/#1991).
      const mixinGraphId =
        graphIdByName.get(mixinName!) ??
        qualifyMixinByOwnerScope(mixinName!, className!, graphIdByName) ??
        graphIdByTail.get(mixinName!) ??
        undefined;
      if (classGraphId === undefined || mixinGraphId === undefined) continue;
      const edgeKey = `${classGraphId}->${mixinGraphId}:${kind}`;
      if (emitted.has(edgeKey)) continue;
      emitted.add(edgeKey);
      graph.addRelationship({
        id: generateId('IMPLEMENTS', edgeKey),
        sourceId: classGraphId,
        targetId: mixinGraphId,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: kind!,
      });
    }
  }

  // Emit Property nodes + HAS_PROPERTY edges from __property__:... imports.
  // Skip if the parse-worker already created the property (worker path merges
  // Property nodes into the graph before scope-resolution runs).
  const existingProps = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('HAS_PROPERTY')) {
    const targetNode = graph.getNode(rel.targetId);
    if (targetNode !== undefined) {
      existingProps.add(`${rel.sourceId}->prop:${targetNode.properties.name}`);
    }
  }

  for (const parsed of parsedFiles) {
    for (const imp of parsed.parsedImports) {
      const decoded = decodeMarker(imp.targetRaw);
      if (decoded?.kind !== 'property') continue;
      const parts = decoded.fields;
      if (parts.length < 3) continue;
      const [_attrKind, propName, className] = parts;
      const classGraphId = graphIdByName.get(className!);
      if (classGraphId === undefined || propName === undefined) continue;

      const edgeKey = `${classGraphId}->prop:${propName}`;
      if (emitted.has(edgeKey) || existingProps.has(edgeKey)) continue;
      emitted.add(edgeKey);

      const propId = generateId('Property', `${parsed.filePath}:${className}.${propName}`);
      graph.addNode({
        id: propId,
        label: 'Property',
        properties: { name: propName, filePath: parsed.filePath },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', edgeKey),
        sourceId: classGraphId,
        targetId: propId,
        type: 'HAS_PROPERTY',
        confidence: 0.9,
        reason: 'attr',
      });
    }
  }
}

function buildRubyMro(
  graph: Parameters<ScopeResolver['buildMro']>[0],
  parsedFiles: readonly ParsedFile[],
  nodeLookup: Parameters<ScopeResolver['buildMro']>[2],
): Map<string, string[]> {
  // Step 1: EXTENDS chain via the generic MRO builder (direct class inheritance).
  const baseMro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  // Step 2: Build defId ↔ graphId bridge for class-like defs.
  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  // Step 3: Collect IMPLEMENTS edges, partitioned by reason.
  const prependByChild = new Map<string, string[]>();
  const includeByChild = new Map<string, string[]>();

  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const childDefId = defIdByGraphId.get(rel.sourceId);
    const parentDefId = defIdByGraphId.get(rel.targetId);
    if (childDefId === undefined || parentDefId === undefined) continue;

    const reason = rel.reason;
    if (reason === 'prepend') {
      let list = prependByChild.get(childDefId);
      if (list === undefined) {
        list = [];
        prependByChild.set(childDefId, list);
      }
      list.push(parentDefId);
    } else if (reason === 'include') {
      let list = includeByChild.get(childDefId);
      if (list === undefined) {
        list = [];
        includeByChild.set(childDefId, list);
      }
      list.push(parentDefId);
    }
  }

  // Step 4: Reorder MRO per Ruby semantics.
  // Order: prepend (reversed) → direct extends chain → include (reversed).
  // `extend` is excluded — it belongs to singleton dispatch only (the
  // instance-ancestry walk drops extend entries).
  // Reversed because Ruby declaration order means last-declared wins
  // (prepend B; prepend A → B checked before A).
  for (const defId of defIdByGraphId.values()) {
    const extendsChain = baseMro.get(defId) ?? [];
    const prepends = prependByChild.get(defId);
    const includes = includeByChild.get(defId);

    if (prepends === undefined && includes === undefined) continue;

    const reordered: string[] = [];
    if (prepends !== undefined) {
      for (let i = prepends.length - 1; i >= 0; i--) reordered.push(prepends[i]);
    }
    reordered.push(...extendsChain);
    if (includes !== undefined) {
      for (let i = includes.length - 1; i >= 0; i--) reordered.push(includes[i]);
    }
    baseMro.set(defId, reordered);
  }

  return baseMro;
}

/**
 * Enumerate all names exported from a target module scope's file.
 * Ruby's `require` / `require_relative` are wildcard imports — they bring
 * every top-level def (class, module, method, constant) from the target
 * file into the importer's scope. Without this hook the finalize pass
 * cannot materialize individual bindings from wildcard imports, which
 * blocks `propagateImportedReturnTypes` from mirroring return-type
 * typeBindings across files.
 */
function expandRubyWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0) continue;
    const name = qn.split('.').pop() ?? qn;
    if (name === '') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export const rubyScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Ruby,
  languageProvider: rubyProvider,
  importEdgeReason: 'ruby-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveRubyImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandRubyWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming, scopeId) => rubyMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => rubyArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildRubyMro(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  emitHeritageEdges: (graph, parsedFiles, nodeLookup) =>
    emitRubyMixinEdges(graph, parsedFiles, nodeLookup),

  fieldFallbackOnMethodLookup: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
