/**
 * R `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Thin wiring: import resolution reuses `resolveRImportTarget`
 * (`languages/r/import-target.ts`), an adapter over the existing
 * `resolveRImportInternal`, with the repo's local R packages
 * threaded through `loadRPackageConfig`. Heritage (R6 `inherit=`, S4
 * `contains=`) mostly rides the generic `@reference.inherits` mechanism —
 * R6/S4 base names are ordinary scope-bound class names, unlike Ruby's
 * `include`/`extend`, which are method calls. The one exception is S4's
 * `contains = "VIRTUAL"` sentinel (`setClass(x, contains = "VIRTUAL", ...)`,
 * R's spelling for an abstract base): no fixture ever declares
 * `setClass("VIRTUAL", ...)`, so the generic scope-based lookup
 * (`resolveInheritanceBaseInScope` / `findClassBindingInScope`) can never
 * find a binding for it — that lookup is scope-model-only and never
 * consults graph nodes directly. `emitRVirtualHeritageEdges` below mints
 * the placeholder `VIRTUAL` graph node and its EXTENDS edge directly,
 * mirroring Ruby's `emitRubyMixinEdges` shape for the same reason: a
 * heritage target that R code names but never declares.
 */

import type { ParsedFile, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import {
  findEnclosingClassDef,
  populateClassOwnedMembers,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import {
  loadRPackageConfig,
  recordedRPackageConfig,
  recordRPackageConfig,
  rSymbolVisibility,
} from './package-config.js';
import { rBareName } from './bare-name.js';
import { rResolveSelfMember } from './r6-self.js';
import { perFileSet } from '../../utils/per-file-set.js';
import { resolveRImportTarget } from './import-target.js';
import {
  isRGlobalNameFallbackPlausible,
  populateRNamespaceImports,
  rFileTopLevel,
} from './namespace-imports.js';
import { rProvider } from '../r.js';
import { populateRQualifiedCalls, resolveRQualifiedFreeCall } from './qualified-call.js';
import { rArityCompatibility, rMergeBindings } from './simple-hooks.js';

/** Literal string `"VIRTUAL"` graph id — one node shared by every S4 class
 *  that names it as a base, minted lazily on first use. */
const VIRTUAL_CLASS_NAME = 'VIRTUAL';

/**
 * Whether `def` is declared by a call that carries the class name as a string
 * (`setClass("A", ...)`, `setRefClass("A", ...)`): the name starts after the declaration
 * does. `A <- R6Class(...)` starts at its name. Only the call form can write the S4
 * sentinel `contains = "VIRTUAL"`; an R6 `inherit = VIRTUAL` yields an `inherits` reference
 * of the same name that is an ordinary base class.
 */
function isDeclaredByNamingCall(def: SymbolDefinition): boolean {
  const name = def.nameRange;
  const declaration = def.declarationRange;
  if (name === undefined || declaration === undefined) return false;
  return (
    name.startLine > declaration.startLine ||
    (name.startLine === declaration.startLine && name.startCol > declaration.startCol)
  );
}

/**
 * Mint the `VIRTUAL` placeholder Class node (once) and an EXTENDS edge from
 * every S4 class whose `contains=` names it (not an R6 class whose `inherit=` names a
 * class called `VIRTUAL`). Scope is deliberately limited to
 * the literal string `"VIRTUAL"`: other S4 base-type sentinels (`"numeric"`,
 * `"list"`, …) are not treated as placeholder classes, which would be a
 * separate design decision.
 *
 * Idempotent: re-seeds its dedup set from any `EXTENDS` edge already
 * targeting a node named `VIRTUAL` before emitting, and re-uses the graph's
 * existing `VIRTUAL` node instead of minting a second one when the
 * orchestrator re-runs resolution.
 */
function emitRVirtualHeritageEdges(
  graph: KnowledgeGraph,
  _parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  scopes?: ScopeResolutionIndexes,
): void {
  if (scopes === undefined) return;

  const virtualGraphId = generateId('Class', VIRTUAL_CLASS_NAME);
  const emitted = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    if (rel.targetId === virtualGraphId) emitted.add(rel.sourceId);
  }

  let virtualNodeMinted = graph.getNode(virtualGraphId) !== undefined;

  for (const site of scopes.referenceSites) {
    if (site.kind !== 'inherits' || site.name !== VIRTUAL_CLASS_NAME) continue;
    const callerClass = findEnclosingClassDef(site.inScope, scopes);
    if (callerClass === undefined || !isDeclaredByNamingCall(callerClass)) continue;
    const callerGraphId = resolveDefGraphId(callerClass.filePath, callerClass, nodeLookup);
    if (callerGraphId === undefined || emitted.has(callerGraphId)) continue;

    if (!virtualNodeMinted) {
      graph.addNode({
        id: virtualGraphId,
        label: 'Class',
        properties: { name: VIRTUAL_CLASS_NAME, filePath: callerClass.filePath },
      });
      virtualNodeMinted = true;
    }
    emitted.add(callerGraphId);
    graph.addRelationship({
      id: generateId('EXTENDS', `${callerGraphId}->${virtualGraphId}`),
      sourceId: callerGraphId,
      targetId: virtualGraphId,
      type: 'EXTENDS',
      confidence: 0.85,
      reason: 'scope-resolution: inherits (virtual)',
    });
  }
}

/**
 * `moduleScope` → its `ParsedFile`, built once per pass and keyed on the identity of the pass's
 * `parsedFiles` array, which finalize passes unchanged to every `expandsWildcardTo` call. The
 * lookup used to be `parsedFiles.find`, one scan of all files per `library()` edge: 450,000 edges
 * over 3,000 files took 5.9 s. As in the C, C++ and Python providers, the first file wins on a
 * repeated scope, as `find` did.
 */
const parsedFileByModuleScope = perFileSet(
  (parsedFiles: readonly ParsedFile[]): Map<ScopeId, ParsedFile> => {
    const index = new Map<ScopeId, ParsedFile>();
    for (const parsed of parsedFiles) {
      if (!index.has(parsed.moduleScope)) index.set(parsed.moduleScope, parsed);
    }
    return index;
  },
);

/**
 * Enumerate the top-level names a `library()`/`require()` of a target module scope's file brings
 * into scope (module-scope function and class bindings; functions nested in another function are
 * not). `library()`/`require()` are R's wildcard imports, and R attaches only a package's
 * EXPORTS: a name is kept when the target's package has no NAMESPACE, or the NAMESPACE provably
 * exports it (`rSymbolVisibility` is `public`). A name the NAMESPACE does not export, or may
 * export but cannot be proven to (unreadable NAMESPACE, a dropped or cut-short
 * `exportPattern()`), is left out: strict, because the edge this binding yields is a precise
 * 0.85 one. A bare call of such a name is not lost to the other tiers: the 0.5 unique-name guess
 * skips it only when it is proven private (`isRGlobalNameFallbackPlausible`).
 *
 * The package config is read from the target's `ParsedFile` (`recordedRPackageConfig`); without
 * one (hand-built input) nothing is filtered. The hook has no importer, so a `library(ownpkg)`
 * issued from inside the package loses the package's private names as well (a documented gap).
 * This reverses the earlier `load_all()` reading ("every name visible"): see
 * docs/languages/r-provider.md.
 *
 * A bare name is dropped when the same file also defines a dotted top-level
 * name with that tail (`foo` next to `print.foo`). The shared finalize indexes
 * every def by the text after its last `.`, so `foo` would be bound to
 * whichever of the two comes first in the file, and `print.foo` (an S3 method,
 * never callable as `foo()`) can win. The dropped name resolves through the
 * free-call fallback instead, where {@link rIsCallableVisibleFromCaller}
 * removes the dotted def from the candidates. Order-blind, like the matching
 * guard in `languages/r/import-target.ts`.
 */
export function expandRWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFileByModuleScope(parsedFiles).get(targetModuleScope);
  if (target === undefined) return [];
  const { names: topLevel, dottedTails } = rFileTopLevel(target);
  const cfg = recordedRPackageConfig(target);
  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0 || qn.includes('.')) continue; // no dotted names
    // `localDefs` is flat: it also lists functions nested in other functions, which a
    // `library()` does not bring into scope. Only module-scope bindings are top-level.
    // `topLevel` holds symbols and `qn` is the name as written, backticks included.
    if (!topLevel.has(rBareName(qn))) continue;
    if (dottedTails.has(qn)) continue; // shares its tail with an S3 method: see above (as written, as finalize keys it)
    if (cfg !== undefined && rSymbolVisibility(cfg, target.filePath, rBareName(qn)) !== 'public') {
      continue; // not an export of the package (or not provably one)
    }
    if (seen.has(qn)) continue;
    seen.add(qn);
    names.push(qn);
  }
  return names;
}

/**
 * A bare R call `foo(x)` can never invoke a def whose name contains a `.`
 * (`print.foo` is only reachable as `print.foo(...)` or through S3 dispatch),
 * yet the free-call fallback's simple-name index keys it under `foo`. Refuse
 * such candidates so `foo(x)` cannot collide with `print.foo`.
 *
 * Applies to every candidate the hook sees, including R6/R5 members whose
 * qualified name is `Class.member`. A bare `member(x)` never reaches an R6
 * member (it is called through `self$member()` or `obj$member()`), so the
 * refusal is right for R6. RefClass methods are different: a method calls its
 * siblings and inherited methods by bare name, and those calls get no edge
 * here (see "Limits" in `docs/languages/r-provider.md`).
 */
export function rIsCallableVisibleFromCaller(ctx: {
  readonly candidate: SymbolDefinition;
}): boolean {
  return !(ctx.candidate.qualifiedName ?? '').includes('.');
}

export const rScopeResolver: ScopeResolver = {
  language: SupportedLanguages.R,
  languageProvider: rProvider,
  importEdgeReason: 'r-scope: import',

  loadResolutionConfig: (repoPath: string) => loadRPackageConfig(repoPath),

  resolveImportTarget: resolveRImportTarget,

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandRWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: rMergeBindings,
  arityCompatibility: rArityCompatibility,

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  emitHeritageEdges: (graph, parsedFiles, nodeLookup, scopes) =>
    emitRVirtualHeritageEdges(graph, parsedFiles, nodeLookup, scopes),

  // `self$m()` where neither the class nor a parent defines `m` is unresolved, not a call of a
  // free function `m`.
  resolveReceiverMember: rResolveSelfMember,

  // R6's `super$method()` is not resolved: nothing binds `super` to the parent class, so there
  // is no receiver type to walk from. Off, rather than answering a wrong parent. (`self` is
  // bound, to the enclosing class, by `emitRScopeCaptures`; `private$` is not.)
  isSuperReceiver: () => false,

  // R's dynamic-dispatch `self$field$method()` chains and R6/S4 field access
  // benefit from the same heuristic Ruby/Python rely on. It does not bear on `self$m()` itself:
  // that is settled by the typed `self` and `resolveReceiverMember` above.
  fieldFallbackOnMethodLookup: true,

  // `source()` is a side-effect import (binds no name) — a cross-file free
  // call into a `source()`d file (e.g. `HelperFunc(x)`) has no lexical or
  // import binding to resolve through, so it resolves via a unique
  // workspace-wide name match instead. `library()`/`require()`'s own
  // wildcard-bound names still resolve through `expandsWildcardTo` above;
  // this only covers what that path cannot reach.
  allowGlobalFreeCallFallback: true,

  // A named import binds only to a MODULE-LEVEL definition of the target
  // file. Without this, `findExportByName` indexes every `localDefs` entry by
  // simple name, so an R6/R5 method named like an imported symbol could win
  // the binding over the top-level function.
  namedImportsBindTopLevelOnly: true,

  // NAMESPACE `importFrom()` names provided by a LOCAL package become
  // synthesised `named` imports (`resolveRImportTarget`'s named branch binds
  // them). Runs before finalize and over warm-cache ParsedFiles too.
  //
  // Followed by `populateRQualifiedCalls`: it decides each
  // `pkg::name()` site by the qualifier — drops external / ambiguous ones and
  // records the single definition a local one names for
  // `resolveQualifiedFreeCall` below. Import synthesis is unchanged and first.
  populateWorkspaceReferences: (parsedFiles, ctx) => {
    // The rename guard reads the NAMESPACE this pass was configured with (see `checkSafety`),
    // and looks it up by the ParsedFile objects it was handed. Both populate passes below
    // replace entries of `parsedFiles` with copies (import synthesis; any dropped `pkg::fn`
    // site), so the config is recorded against the objects as received, before any
    // replacement, and again against the final array.
    recordRPackageConfig(parsedFiles, ctx.resolutionConfig);
    populateRNamespaceImports(parsedFiles, ctx);
    populateRQualifiedCalls(parsedFiles, ctx);
    recordRPackageConfig(parsedFiles, ctx.resolutionConfig);
  },
  resolveQualifiedFreeCall: resolveRQualifiedFreeCall,

  // `populateRNamespaceImports` and `populateRQualifiedCalls` read only ParsedFile scopes, never source
  // text: without this, merely declaring the hook makes the pipeline read the
  // text of every R file on the main thread.
  postExtractSourceTextPolicy: 'uncached-files',

  // A bare call whose name the caller package's NAMESPACE imports from a
  // package other than the one the unique-name guess landed in is impossible
  // in R (see `isRGlobalNameFallbackPlausible` for the exact rule, the
  // qualifier-first handling of `pkg::name()` calls and the documented
  // `import()` limitation).
  isGlobalNameFallbackPlausible: isRGlobalNameFallbackPlausible,

  // The free-call fallback keys defs by the text after the last `.` of their
  // qualified name, so an S3 method `print.foo` sits next to a bare `foo` and
  // makes the bare call ambiguous (no edge). A bare call can never invoke a
  // dotted def, so drop those candidates.
  isCallableVisibleFromCaller: rIsCallableVisibleFromCaller,
};
