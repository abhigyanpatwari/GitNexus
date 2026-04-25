/**
 * Python `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed
 * by the generic `runScopeResolution` orchestrator.
 *
 * The provider is a thin wiring object — Python's specific bits
 * (super recognizer, LEGB merge precedence, Python's relative-import
 * resolver, the simplified MRO walk) plug into `runScopeResolution`.
 *
 * Migration reference: when bringing up the next language
 * (TypeScript / Java / Kotlin / Ruby), copy this file's structure —
 * implement the 6 required `ScopeResolver` fields, optionally toggle
 * the 2 booleans, and register in `scope-resolution/pipeline/registry.ts`.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { pythonProvider } from '../python.js';
import {
  pythonArityCompatibility,
  pythonMergeBindings,
  resolvePythonImportTarget,
  type PythonResolveContext,
} from './index.js';

const pythonScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Python,
  languageProvider: pythonProvider,
  importEdgeReason: 'python-scope: import',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    // Copy the orchestrator's `ReadonlySet` into a `Set` because the
    // legacy Python resolver chain (`resolvePythonImportInternal` →
    // `resolveAbsoluteFromFiles` / `hasRepoCandidate`) is typed to
    // receive a mutable `Set<string>`. The copy is O(N) but called
    // once per import — trivial compared to the parser work.
    const ws: PythonResolveContext = { fromFile, allFilePaths: new Set(allFilePaths) };
    // `WorkspaceIndex` is an opaque `unknown` placeholder in the
    // shared contract, so `ws` passes structurally without a cast.
    return resolvePythonImportTarget(
      { kind: 'named', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  // Python LEGB precedence: local > import/namespace/reexport > wildcard.
  // The per-scope id is unused by pythonMergeBindings (tier ordering
  // is computed purely from BindingRef.origin), so we don't need to
  // synthesize a Scope.
  mergeBindings: (existing, incoming) => [...pythonMergeBindings([...existing, ...incoming])],

  // Adapter: pythonArityCompatibility predates RegistryProviders and
  // uses (def, callsite). ScopeResolver contract is (callsite, def).
  // Wrapper kept to honor both contracts without altering the legacy
  // shape that LanguageProvider.arityCompatibility consumes.
  arityCompatibility: (callsite, def) => pythonArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  isSuperReceiver: (text) => /^super\s*\(/.test(text),

  // Python is dynamically typed — field-fallback heuristic on, return-
  // type propagation across imports on. Both default to true; listed
  // explicitly here for documentation.
  fieldFallbackOnMethodLookup: true,
  propagatesReturnTypesAcrossImports: true,
};

export { pythonScopeResolver };
