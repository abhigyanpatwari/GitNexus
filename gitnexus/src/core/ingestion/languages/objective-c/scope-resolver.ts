import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';

import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cArityCompatibility } from '../c/arity.js';
import { cMergeBindings } from '../c/merge-bindings.js';
import { clearStaticNames, expandCWildcardNames, isStaticName } from '../c/static-linkage.js';
import { objectiveCProvider } from '../objective-c.js';
import { applyObjectiveCCaptureSideChannel } from './capture-side-channel.js';
import { populateObjectiveCWorkspaceOwners } from './ownership.js';
import { emitObjectiveCSourceSiteEdges } from './relationships.js';
import { resolveObjectiveCImportTarget } from './import-target.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';

export const objectiveCScopeResolver: ScopeResolver = {
  language: SupportedLanguages.ObjectiveC,
  languageProvider: objectiveCProvider,
  importEdgeReason: 'objective-c-scope: import',

  loadResolutionConfig: () => {
    clearStaticNames();
    return null;
  },

  applyCaptureSideChannel: applyObjectiveCCaptureSideChannel,

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) =>
    resolveObjectiveCImportTarget(targetRaw, fromFile, allFilePaths),

  collectScopeContextPaths({
    primaryFilePaths,
    preExtractedByPath,
    entryFileContents,
    allScannedPaths,
  }) {
    const visited = new Set(primaryFilePaths);
    const queue = [...primaryFilePaths];
    const fallbackParsed = new Map<string, ParsedFile>();
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current === undefined) continue;
      let parsed = preExtractedByPath.get(current) ?? fallbackParsed.get(current);
      if (parsed === undefined) {
        const source = entryFileContents.get(current);
        if (source !== undefined) {
          parsed = extractParsedFile(objectiveCProvider, source, current);
          if (parsed !== undefined) fallbackParsed.set(current, parsed);
        }
      }
      if (parsed === undefined) continue;

      for (const parsedImport of parsed.parsedImports) {
        const target = resolveObjectiveCImportTarget(
          parsedImport.targetRaw,
          current,
          allScannedPaths,
        );
        if (target === null || !/\.h$/i.test(target) || visited.has(target)) continue;
        visited.add(target);
        queue.push(target);
      }
    }
    return visited;
  },

  // A C/C++-classified header in the Objective-C import closure must be
  // re-extracted with the Objective-C grammar. The authoritative cached shard
  // remains untouched and is still reused by its primary language pass.
  acceptPreExtractedParsedFile: (parsed: ParsedFile) =>
    parsed.language === SupportedLanguages.ObjectiveC,

  expandsWildcardTo: expandCWildcardNames,

  mergeBindings: (existing, incoming, scopeId) => cMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, definition) => cArityCompatibility(definition, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed) => populateClassOwnedMembers(parsed),
  populateWorkspaceOwners: (parsedFiles) => populateObjectiveCWorkspaceOwners(parsedFiles),

  emitHeritageEdges: (graph, parsedFiles, nodeLookup) =>
    emitObjectiveCSourceSiteEdges(graph, parsedFiles, nodeLookup),

  isSuperReceiver: (receiver) => receiver.trim() === 'super',
  resolveThisViaEnclosingClass: true,
  isEnclosingClassReceiver: (receiver) => receiver.trim() === 'self',

  resolveReceiverMember(ownerDef, _memberName, callsite, scopes, model) {
    if (callsite.candidateNames === undefined) return undefined;
    const ownerChain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
    for (const ownerId of ownerChain) {
      const candidates = new Map<string, SymbolDefinition>();
      for (const candidateName of callsite.candidateNames) {
        for (const definition of model.methods.lookupAllByOwner(ownerId, candidateName)) {
          candidates.set(definition.nodeId, definition);
        }
      }
      if (candidates.size === 1) {
        return { kind: 'resolved', definition: candidates.values().next().value! };
      }
      if (candidates.size > 1) {
        return { kind: 'ambiguous', candidateIds: [...candidates.keys()] };
      }
    }
    return undefined;
  },

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  allowGlobalFreeCallFallback: true,

  isFileLocalDef: (definition: SymbolDefinition) => {
    const simpleName = definition.qualifiedName?.split('.').pop() ?? '';
    return isStaticName(definition.filePath, simpleName);
  },
};
