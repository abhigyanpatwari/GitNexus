/**
 * C# `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * Second migration after Python — see `pythonScopeResolver` for the
 * canonical shape.
 */

import type { ParsedFile } from 'gitnexus-shared';
import { CLASS_KINDS, SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import {
  populateClassOwnedMembers,
  resolveSameNamespaceInheritanceBase,
} from '../../scope-resolution/scope/walkers.js';
import { populateCsharpNamespacePrefixes } from './qualified-type-names.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import {
  canonicalizeWorkspaceBindings,
  canonicalModuleExports,
} from '../../scope-resolution/scope/canonicalize-bindings.js';
import { canonicalName } from './identifiers.js';
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
import { emitRazorViewComponentEdges } from './razor-view-components.js';

const declarationImports = new WeakMap<
  readonly ParsedFile[],
  ReadonlyMap<string, readonly string[]>
>();

const csharpScopeResolver: ScopeResolver = {
  moduleExports: (parsed) => canonicalModuleExports(parsed, canonicalName),
  populateWorkspaceReferences: (parsedFiles) =>
    canonicalizeWorkspaceBindings(parsedFiles, canonicalName),
  // Construction is keyword-prefixed: `new Service(db).doWork()` (#2708).
  constructionSyntax: { keyword: 'new' },
  language: SupportedLanguages.CSharp,
  languageProvider: csharpProvider,
  importEdgeReason: 'csharp-scope: using',

  loadResolutionConfig: (repoPath) => loadCsharpResolutionConfig(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig, context) => {
    // A using names a declaration, independently of its containing filename.
    // Prefer the already-extracted namespace identity; file suffixes are only
    // the fallback for imports with no source declaration in this workspace.
    const target = targetRaw.replace(/^global::/, '').replace(/@/g, '');
    let declarations = context && declarationImports.get(context.parsedFiles);
    if (context && !declarations) {
      const filesByName = new Map<string, Set<string>>();
      for (const parsed of context.parsedFiles) {
        for (const def of parsed.localDefs) {
          if (!CLASS_KINDS.includes(def.type) && def.type !== 'Namespace') continue;
          const qualified =
            def.namespacePrefix && !def.qualifiedName?.startsWith(def.namespacePrefix + '.')
              ? def.namespacePrefix + '.' + def.qualifiedName
              : def.qualifiedName;
          if (!qualified) continue;
          const key = qualified.replace(/@/g, '');
          const paths = filesByName.get(key) ?? new Set<string>();
          paths.add(parsed.filePath);
          filesByName.set(key, paths);
        }
      }
      declarations = new Map([...filesByName].map(([name, paths]) => [name, [...paths].sort()]));
      declarationImports.set(context.parsedFiles, declarations);
    }
    const exactFiles = declarations?.get(target);
    if (exactFiles?.length) return exactFiles;
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

  // The inheritance pre-pass runs before those siblings exist, so a base
  // declared in another file of the SAME named namespace binds here. Exact
  // namespace only (the `namespacePrefix` sidecar from `populateOwners`):
  // enclosing-namespace and global visibility stay with the shared chain.
  resolveImplicitInheritanceBase: (baseName, derivingClass, scopes) =>
    resolveSameNamespaceInheritanceBase(
      baseName,
      derivingClass,
      scopes,
      (def) => def.namespacePrefix,
    ),

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

  // Razor views stay out of the C# parser. Bind literal ViewComponent names
  // only onto in-repo classes (Spring-style: skip the SDK type, hop to the
  // workspace implementor).
  emitPostResolutionEdges: (graph, parsedFiles, nodeLookup, _indexes, ctx) => {
    const config = ctx.resolutionConfig as CsharpResolutionConfig | undefined;
    emitRazorViewComponentEdges(
      graph,
      parsedFiles,
      nodeLookup,
      config?.razorViewComponents,
      ctx.fileContents,
    );
  },
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
 *
 * A workspace may legally declare its OWN type named `String`, which shadows the
 * BCL simple name; this table then reads `IValidator<String>` as the `string`
 * instantiation and KEEPS that implementor in the fan-out. Deliberate, and the
 * safe direction: the alternative is pruning on the belief that two spellings
 * differ, which is the missing-edge failure `generic-instantiation.ts` is built
 * to avoid. Resolving instead of normalizing cannot settle it either — the
 * identity comparison needs a `definitionId` from BOTH sides, and a built-in
 * name has none, so "built-in versus workspace-declared" would be a new prune
 * with no positive evidence behind it. The result is one surplus edge in a
 * shape that is rare on its own terms, i.e. exactly the pre-#2912 fan-out for
 * that pair and no worse.
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

/** The BCL simple names the keywords alias. A spelling that reduces to one of
 *  these IS the predefined type; anything else that merely happens to sit in
 *  `System` is an ordinary type and keeps its qualifier. */
const CSHARP_PREDEFINED_TYPE_NAMES: ReadonlySet<string> = new Set(
  CSHARP_PREDEFINED_TYPE_ALIASES.values(),
);

const CSHARP_SYSTEM_QUALIFIER = /^(?:global::)?System\./;

function normalizeCsharpTypeArgument(name: string): string {
  const named = name.trim();
  // A keyword answers immediately: `string` → `String`.
  const aliased = CSHARP_PREDEFINED_TYPE_ALIASES.get(named);
  if (aliased !== undefined) return aliased;
  // Otherwise the `System.` qualifier is dropped so the fully-qualified
  // spelling of a predefined type meets that keyword: `System.String` →
  // `String` ≡ `string` → `String`. The optional `global::` alias qualifier goes
  // with it — `import-decomposer` already unwraps that spelling elsewhere, and
  // leaving it on would make `global::System.String` unequal to `string` and
  // prune a live implementor.
  //
  // ONLY when what remains is a predefined type. `System.Custom` is an ordinary
  // type that happens to live in `System`, and answering `Custom` for it would
  // equate it with an unrelated `Custom` elsewhere in the workspace. Returned as
  // written instead, which sends it to the identity comparison — the step that
  // can actually tell two declarations apart.
  const bare = named.replace(CSHARP_SYSTEM_QUALIFIER, '');
  return bare !== named && CSHARP_PREDEFINED_TYPE_NAMES.has(bare) ? bare : named;
}

export { csharpScopeResolver };
