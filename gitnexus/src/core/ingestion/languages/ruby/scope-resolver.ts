import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rubyProvider } from '../ruby.js';
import { rubyArityCompatibility, rubyMergeBindings, resolveRubyImportTarget } from './index.js';
import { populateClassOwnedMembers, isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';

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

export const rubyScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Ruby,
  languageProvider: rubyProvider,
  importEdgeReason: 'ruby-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveRubyImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming, scopeId) => rubyMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => rubyArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildRubyMro(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
