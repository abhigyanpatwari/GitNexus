import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { rustProvider } from '../rust.js';
import { rustArityCompatibility, rustMergeBindings, resolveRustImportTarget } from './index.js';
import { populateRustOwners } from './method-owners.js';

export const rustScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Rust,
  languageProvider: rustProvider,
  importEdgeReason: 'rust-scope: use',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveRustImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  mergeBindings: (existing, incoming, scopeId) => rustMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => rustArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateRustOwners(parsed),

  isSuperReceiver: () => false,

  fieldFallbackOnMethodLookup: false,
  hoistTypeBindingsToModule: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,
};
