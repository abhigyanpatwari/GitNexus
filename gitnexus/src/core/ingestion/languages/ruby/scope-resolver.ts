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

const HERITAGE_PREFIX = '__heritage__:';

function emitRubyMixinEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
): void {
  const graphIdByName = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) {
        const simpleName = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
        graphIdByName.set(simpleName, graphId);
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
      if (!imp.targetRaw.startsWith(HERITAGE_PREFIX)) continue;
      const parts = imp.targetRaw.slice(HERITAGE_PREFIX.length).split(':');
      if (parts.length < 3) continue;
      const [kind, mixinName, className] = parts;
      const classGraphId = graphIdByName.get(className!);
      const mixinGraphId = graphIdByName.get(mixinName!);
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

  const PROPERTY_PREFIX = '__property__:';
  for (const parsed of parsedFiles) {
    for (const imp of parsed.parsedImports) {
      if (!imp.targetRaw.startsWith(PROPERTY_PREFIX)) continue;
      const parts = imp.targetRaw.slice(PROPERTY_PREFIX.length).split(':');
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
  // `extend` is excluded — it belongs to singleton dispatch only (legacy
  // `getInstanceAncestry` in heritage-map.ts explicitly drops extend entries).
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
