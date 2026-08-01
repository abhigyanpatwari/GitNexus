import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateGoOwners, populateGoWorkspaceOwners } from './method-owners.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { loadGoModulePath } from '../../language-config.js';
import { goProvider } from '../go.js';
import {
  goArityCompatibility,
  goMergeBindings,
  populateGoPackageSiblings,
  resolveGoImportTarget,
  mirrorGoNamespaceTypeBindings,
} from './index.js';
import { detectGoInterfaceImplementations } from './interface-impls.js';
import { populateGoRangeBindings } from './range-binding.js';
import { expandGoWildcardNames } from './expand-wildcards.js';
import { goMapValueType } from './interpret.js';

/** Slice `[]T` and array `[N]T` / `[...]T` → the element spelling. Hoisted —
 *  a literal inside the hook would mint a fresh RegExp per folded subscript. */
const GO_SLICE_ELEMENT_RE = /^\[[^\]]*\]\s*(.+)$/;

export const goScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Go,
  languageProvider: goProvider,
  importEdgeReason: 'go-scope: import',

  loadResolutionConfig: (repoPath: string) => loadGoModulePath(repoPath),

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) =>
    resolveGoImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandGoWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming, scopeId) => goMergeBindings(existing, incoming, scopeId),

  arityCompatibility: (callsite, def) => goArityCompatibility(def, callsite),

  // Only `*` — a pointer leaves the method set reachable by selector unchanged,
  // so `*Host` and `Host` name the same class for receiver typing. `[]` and
  // `map[…]` are deliberately NOT stripped here: they are containers whose
  // member set differs from the element's, and unwrapping them belongs to the
  // index step that consumed a subscript. (Field bindings never reach this
  // anyway — `normalizeGoTypeName` already strips them at capture. The one
  // binding that arrives decorated is the receiver self-binding, kept raw on
  // purpose for `method-owners.ts`.)
  stripTypePreservingDecoration: (typeName) =>
    typeName.startsWith('*') ? typeName.slice(1).trim() : undefined,

  // The subscript counterpart of the stripper above, and the reason the two are
  // separate hooks: `*` is safe to strip at any class lookup, `[]` / `map[K]`
  // only where the source actually indexed. Answers the `index` route only —
  // Go has no property-style collection view.
  //
  // Reads the AS-WRITTEN spelling (`[]*User`), not the capture-normalized name:
  // `normalizeGoTypeName` already collapsed that to `User`, which is exactly the
  // ambiguity that made an unanswered index step fold onto the container. The
  // element is returned STILL DECORATED (`*User`) — the index step looks it up
  // through `stripTypePreservingDecoration` above, so the pointer resolves.
  elementTypeOf: (containerType, via) => {
    if (via.kind !== 'index') return undefined;
    const t = containerType.trim();
    // `map[K]V` — a subscript yields V. Literally the same matcher
    // `normalizeGoTypeName` uses, so the two cannot disagree on what a map
    // spelling is.
    const mapValue = goMapValueType(t);
    if (mapValue !== undefined) return mapValue;
    // Slice `[]T` and array `[N]T` / `[...]T`.
    const sliceMatch = GO_SLICE_ELEMENT_RE.exec(t);
    if (sliceMatch !== null) return sliceMatch[1]!.trim();
    return undefined;
  },

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateGoOwners(parsed),
  populateWorkspaceOwners: (parsedFiles, ctx) => populateGoWorkspaceOwners(parsedFiles, ctx),

  isSuperReceiver: () => false,

  fieldFallbackOnMethodLookup: false,
  hoistTypeBindingsToModule: true,
  propagatesReturnTypesAcrossImports: true,
  allowGlobalFreeCallFallback: true,

  populateNamespaceSiblings: populateGoPackageSiblings,
  mirrorNamespaceTypeBindings: mirrorGoNamespaceTypeBindings,
  // Go has structural interfaces: implementations are inferred by signature,
  // then fed into generic MRO/interface-dispatch.
  detectInterfaceImplementations: detectGoInterfaceImplementations,
  populateRangeBindings: populateGoRangeBindings,
};
