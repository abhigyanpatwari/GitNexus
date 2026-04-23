/**
 * C# `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * Second migration after Python — see `pythonScopeResolver` for the
 * canonical shape.
 */

import type { ParsedFile } from 'gitnexus-shared';
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
import { unwrapCsharpCollectionAccessor } from './accessor-unwrap.js';

const csharpScopeResolver: ScopeResolver = {
  language: SupportedLanguages.CSharp,
  languageProvider: csharpProvider,
  importEdgeReason: 'csharp-scope: using',

  resolveImportTarget: (targetRaw, fromFile, allFilePaths) => {
    const ws: CsharpResolveContext = { fromFile, allFilePaths };
    // `WorkspaceIndex` is an opaque `unknown` placeholder in the
    // shared contract, so `ws` passes structurally without a cast.
    return resolveCsharpImportTarget(
      { kind: 'namespace', localName: '_', importedName: '_', targetRaw },
      ws,
    );
  },

  // C# shadowing: local > using > using static. The per-scope id is
  // unused by the C# implementation (shadowing is computed purely
  // from the binding tier), so we don't need to synthesize a Scope.
  mergeBindings: (existing, incoming) => [...csharpMergeBindings([...existing, ...incoming])],

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

  // `data.Values` / `data.Keys` on Dictionary-like receivers unwrap
  // to the value / key element type. Other languages use method-call
  // syntax for the same access and leave this hook undefined.
  unwrapCollectionAccessor: unwrapCsharpCollectionAccessor,

  // C# matches legacy DAG by collapsing member-call CALLS edges to
  // `(caller, target)` — multiple `g.Greet(...)` sites from Main
  // yield ONE edge, not one per site.
  collapseMemberCallsByCallerTarget: true,

  // C# hoists method return-type bindings to the enclosing Module
  // scope so `propagateImportedReturnTypes` can mirror them across
  // files. The compound-receiver walker needs to walk up from the
  // class scope to find them; see the contract field for rationale.
  hoistTypeBindingsToModule: true,
};

export { csharpScopeResolver };
