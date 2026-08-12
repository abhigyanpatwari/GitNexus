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
import { populateCsharpNamespacePrefixes } from './qualified-type-names.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { csharpProvider } from '../csharp.js';
import {
  csharpArityCompatibility,
  csharpMergeBindings,
  resolveCsharpImportTarget,
  type CsharpResolveContext,
} from './index.js';
import { populateCsharpNamespaceSiblings } from './namespace-siblings.js';
import { loadCsharpResolutionConfig, type CsharpResolutionConfig } from './resolution-config.js';
import { unwrapCsharpElementType } from './accessor-unwrap.js';

const csharpScopeResolver: ScopeResolver = {
  // Construction is keyword-prefixed: `new Service(db).doWork()` (#2708).
  constructionSyntax: { keyword: 'new' },
  language: SupportedLanguages.CSharp,
  languageProvider: csharpProvider,
  importEdgeReason: 'csharp-scope: using',

  loadResolutionConfig: (repoPath) => loadCsharpResolutionConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    const config = resolutionConfig as CsharpResolutionConfig | undefined;
    const ws: CsharpResolveContext = {
      fromFile,
      allFilePaths,
      csharpConfigs: config?.csharpConfigs,
      namespaces: config?.namespaces,
    };
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

  populateOwners: (parsed: ParsedFile) => {
    populateClassOwnedMembers(parsed);
    // Sidecar-only namespace tagging (does NOT touch qualifiedName) so the
    // qualified constructor resolver can break same-tail collisions like
    // `new B.Foo()` by matching the explicit qualifier (#2046).
    populateCsharpNamespacePrefixes(parsed);
  },

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
  elementTypeOf: unwrapCsharpElementType,

  // C# matches legacy DAG by collapsing member-call CALLS edges to
  // `(caller, target)` — multiple `g.Greet(...)` sites from Main
  // yield ONE edge, not one per site.
  collapseMemberCallsByCallerTarget: true,
  freeCallsRequireInstanceOwnership: true,

  // C# hoists method return-type bindings to the enclosing Module
  // scope so `propagateImportedReturnTypes` can mirror them across
  // files. The compound-receiver walker needs to walk up from the
  // class scope to find them; see the contract field for rationale.
  hoistTypeBindingsToModule: true,

  // `IValidator<string>` and `IValidator<String>` are one instantiation, so the
  // dispatch fan-out must not read them as two (#2912). See the alias table.
  normalizeTypeArgument: normalizeCsharpTypeArgument,
};

/**
 * C# predefined type aliases — the 15 keywords the language defines as exact
 * synonyms for `System` types (`string` ≡ `System.String`), plus `nint`/`nuint`.
 * A codebase mixing the spellings is common enough that StyleCop ships a rule
 * about it (SA1121), so the two forms genuinely meet across files.
 *
 * Keyword → BCL simple name; anything else is returned unchanged, including the
 * BCL names themselves (already canonical) and any qualified spelling, which is
 * compared as written.
 */
const CSHARP_PREDEFINED_TYPE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['bool', 'Boolean'],
  ['byte', 'Byte'],
  ['sbyte', 'SByte'],
  ['char', 'Char'],
  ['decimal', 'Decimal'],
  ['double', 'Double'],
  ['float', 'Single'],
  ['int', 'Int32'],
  ['uint', 'UInt32'],
  ['long', 'Int64'],
  ['ulong', 'UInt64'],
  ['short', 'Int16'],
  ['ushort', 'UInt16'],
  ['nint', 'IntPtr'],
  ['nuint', 'UIntPtr'],
  ['object', 'Object'],
  ['string', 'String'],
]);

function normalizeCsharpTypeArgument(name: string): string {
  // `System.` is dropped first so the fully-qualified spelling of a predefined
  // type meets its keyword: `System.String` → `String` ≡ `string` → `String`.
  // Only that one namespace, and only as a whole prefix — an unrelated
  // `Foo.String` stays qualified and is compared as written.
  const trimmed = name.trim().replace(/^System\./, '');
  return CSHARP_PREDEFINED_TYPE_ALIASES.get(trimmed) ?? trimmed;
}

export { csharpScopeResolver };
