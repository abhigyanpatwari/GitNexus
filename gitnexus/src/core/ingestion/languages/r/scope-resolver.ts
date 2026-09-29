/**
 * R `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Thin wiring: import resolution reuses `resolveRImportTarget`
 * (`import-resolvers/r.ts`), the adapter step 2 of this plan added over the
 * existing `resolveRImportInternal`, with the repo's local R packages
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
 * heritage target this plan's fixtures name but never declare.
 */

import type { ParsedFile, ScopeId } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { findEnclosingClassDef, populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { generateId } from '../../../../lib/utils.js';
import { loadRPackageConfig } from '../../language-config.js';
import { resolveRImportTarget } from '../../import-resolvers/r.js';
import { rProvider } from '../r.js';
import { rArityCompatibility, rMergeBindings } from './simple-hooks.js';

/** Literal string `"VIRTUAL"` graph id — one node shared by every S4 class
 *  that names it as a base, minted lazily on first use. */
const VIRTUAL_CLASS_NAME = 'VIRTUAL';

/**
 * Mint the `VIRTUAL` placeholder Class node (once) and an EXTENDS edge from
 * every S4 class whose `contains=` names it, exactly the literal fixture
 * string `"VIRTUAL"` (§12 Q1) — not a general policy for arbitrary S4
 * base-type sentinels (`"numeric"`, `"list"`, …), which is a distinct,
 * out-of-scope design question (kaybenleroll/GitNexus, Issues To File #2).
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
    if (callerClass === undefined) continue;
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
 * Enumerate all top-level names exported from a target module scope's file.
 * `library()`/`require()` are R's wildcard imports — every top-level name of
 * the named local package becomes visible, UNFILTERED by NAMESPACE (a
 * `library()`/`require()` call brings the whole package's namespace into
 * scope regardless of what NAMESPACE declares as exported — verified during
 * the plan's stress-test round: `pkgA/NAMESPACE` does not export `ResultSet`,
 * yet `require("pkgA")` must still resolve it).
 */
function expandRWildcardNames(
  targetModuleScope: ScopeId,
  parsedFiles: readonly ParsedFile[],
): readonly string[] {
  const target = parsedFiles.find((p) => p.moduleScope === targetModuleScope);
  if (target === undefined) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const def of target.localDefs) {
    const qn = def.qualifiedName;
    if (qn === undefined || qn.length === 0 || qn.includes('.')) continue; // top-level only
    if (seen.has(qn)) continue;
    seen.add(qn);
    names.push(qn);
  }
  return names;
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

  // R has no `super`.
  isSuperReceiver: () => false,

  // R's dynamic-dispatch `self$field$method()` chains and R6/S4 field access
  // benefit from the same heuristic Ruby/Python rely on.
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
};
