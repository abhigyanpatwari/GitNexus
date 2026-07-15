/**
 * Solidity `ScopeResolver` — registry-primary call/heritage resolution.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { solidityProvider } from '../solidity.js';
import {
  solidityArityCompatibility,
  solidityMergeBindings,
  resolveSolidityImportTarget,
  loadSolidityRemappings,
} from './index.js';
import { expandSolidityWildcardNames } from './expand-wildcards.js';

export const solidityScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Solidity,
  languageProvider: solidityProvider,
  importEdgeReason: 'solidity-scope: import',

  loadResolutionConfig: (repoPath) => loadSolidityRemappings(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveSolidityImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandSolidityWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming) => [
    ...solidityMergeBindings([...existing, ...incoming]),
  ],

  arityCompatibility: (callsite, def) => solidityArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
  constructorCallTargetsClass: true,
};
