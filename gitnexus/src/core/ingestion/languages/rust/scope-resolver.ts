import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rustProvider } from '../rust.js';
import { rustArityCompatibility, rustMergeBindings, resolveRustImportTarget } from './index.js';
import { populateRustOwners } from './method-owners.js';
import { populateRustRangeBindings } from './range-binding.js';
import { isClassLike } from '../../scope-resolution/scope/walkers.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';

function buildRustMro(
  graph: Parameters<ScopeResolver['buildMro']>[0],
  parsedFiles: readonly ParsedFile[],
  nodeLookup: Parameters<ScopeResolver['buildMro']>[2],
): Map<string, string[]> {
  const baseMro = buildMro(graph, parsedFiles, nodeLookup, defaultLinearize);

  const defIdByGraphId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) defIdByGraphId.set(graphId, def.nodeId);
    }
  }

  const fileByDefId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      fileByDefId.set(def.nodeId, parsed.filePath);
    }
  }

  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    const childDefId = defIdByGraphId.get(rel.sourceId);
    const parentDefId = defIdByGraphId.get(rel.targetId);
    if (childDefId === undefined || parentDefId === undefined) continue;

    const childFile = fileByDefId.get(childDefId);
    const parentFile = fileByDefId.get(parentDefId);
    if (childFile !== parentFile) continue;

    const existing = baseMro.get(childDefId);
    if (existing !== undefined) {
      if (!existing.includes(parentDefId)) existing.push(parentDefId);
    } else {
      baseMro.set(childDefId, [parentDefId]);
    }
  }

  return baseMro;
}

export const rustScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Rust,
  languageProvider: rustProvider,
  importEdgeReason: 'rust-scope: use',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveRustImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming, scopeId) => rustMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => rustArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) => buildRustMro(graph, parsedFiles, nodeLookup),

  populateOwners: (parsed: ParsedFile) => populateRustOwners(parsed),

  isSuperReceiver: () => false,

  populateRangeBindings: populateRustRangeBindings,

  fieldFallbackOnMethodLookup: false,
  hoistTypeBindingsToModule: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
