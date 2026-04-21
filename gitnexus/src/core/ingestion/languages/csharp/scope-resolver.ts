/**
 * C# `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * Second migration after Python — see `pythonScopeResolver` for the
 * canonical shape.
 */

import type { ParsedFile, Scope, WorkspaceIndex } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { csharpProvider } from '../csharp.js';
import {
  csharpArityCompatibility,
  csharpMergeBindings,
  resolveCsharpImportTarget,
  type CsharpResolveContext,
} from './index.js';
import { populateCsharpNamespaceSiblings } from './namespace-siblings.js';

const csharpScopeResolver: ScopeResolver = {
  language: SupportedLanguages.CSharp,
  languageProvider: csharpProvider,
  importEdgeReason: 'csharp-scope: using',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    // CsharpResolveContext expects a mutable Set; the orchestrator
    // hands us a ReadonlySet — safe to widen since the resolver only
    // reads.
    const ws: CsharpResolveContext = {
      fromFile,
      allFilePaths: allFilePaths as Set<string>,
    };
    return resolveCsharpImportTarget(
      { kind: 'namespace', localName: '_', importedName: '_', targetRaw },
      ws as unknown as WorkspaceIndex,
    );
  },

  // C# shadowing: local > using > using static.
  mergeBindings: (existing, incoming, scopeId) => {
    const fakeScope = { id: scopeId } as unknown as Scope;
    return [...csharpMergeBindings(fakeScope, [...existing, ...incoming])];
  },

  // Adapter: csharpArityCompatibility uses (def, callsite); the
  // contract is (callsite, def).
  arityCompatibility: (callsite, def) => csharpArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // C# uses `base` for super-class dispatch, not `super`. Match as a
  // plain identifier (no `()` call like Python's `super(...)`) — `base`
  // is a keyword-like receiver, not a callable.
  isSuperReceiver: (text) => text.trim() === 'base',

  // Same-namespace cross-file visibility — C# makes every type
  // declared in `namespace X` visible to other files declaring the
  // same namespace, without any `using` directive. See
  // `namespace-siblings.ts` for the implementation.
  populateNamespaceSiblings: populateCsharpNamespaceSiblings,

  // C# is statically typed — type information is reliable. Field-
  // fallback heuristic stays off (the type-binding layer already
  // produces precise owner types); return-type propagation on is fine
  // since signatures are authoritative.
  fieldFallbackOnMethodLookup: false,
  propagatesReturnTypesAcrossImports: true,
};

export { csharpScopeResolver };
