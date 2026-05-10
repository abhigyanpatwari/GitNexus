/**
 * Java `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { javaProvider } from '../java.js';
import {
  javaArityCompatibility,
  javaMergeBindings,
  resolveJavaImportTarget,
  type JavaResolveContext,
} from './index.js';

const javaScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Java,
  languageProvider: javaProvider,
  importEdgeReason: 'java-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: JavaResolveContext = { fromFile, allFilePaths };
    return resolveJavaImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...javaMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => javaArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  // Java is statically typed — field-fallback heuristic stays off
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,

  // Java doesn't collapse member calls
  collapseMemberCallsByCallerTarget: false,

  // Hoist return-type bindings to Module scope for cross-file propagation
  hoistTypeBindingsToModule: true,
};

export { javaScopeResolver };
