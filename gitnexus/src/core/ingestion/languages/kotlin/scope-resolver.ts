import { SupportedLanguages, type ParsedFile } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { kotlinProvider } from '../kotlin.js';
import {
  kotlinArityCompatibility,
  kotlinMergeBindings,
  populateKotlinOwners,
  resolveKotlinImportTarget,
  type KotlinResolveContext,
} from './index.js';

/**
 * Kotlin scope resolver for RFC #909 Ring 3.
 *
 * Kotlin is intentionally registered but not yet listed in
 * `MIGRATED_LANGUAGES`, matching the Java migration pattern from #1482:
 * the resolver can run in shadow/forced mode, while production default
 * stays on the legacy DAG until registry-primary parity reaches the
 * RFC threshold. Forced mode currently passes 154/175 fixtures (88%),
 * including core import, receiver, companion, default-param, vararg,
 * constructor, local assignment-chain, and collection-iteration fixtures.
 * Remaining gaps are advanced TypeEnv behaviors such as smart casts,
 * cross-file iterable return propagation, method-chain fixpoint cases,
 * overload target-id selection, virtual dispatch, and interface default
 * method dispatch.
 */
export const kotlinScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Kotlin,
  languageProvider: kotlinProvider,
  importEdgeReason: 'kotlin-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: KotlinResolveContext = { fromFile, allFilePaths };
    return resolveKotlinImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  mergeBindings: (existing, incoming) => [...kotlinMergeBindings([...existing, ...incoming])],

  arityCompatibility: (callsite, def) => kotlinArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateKotlinOwners(parsed),

  isSuperReceiver: (text) => text.trim() === 'super',

  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
  collapseMemberCallsByCallerTarget: false,
  hoistTypeBindingsToModule: true,
};
