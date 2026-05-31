/**
 * `runScopeResolution` — generic registry-primary resolution
 * orchestrator.
 *
 *     ParsedFile[]  (one per file via `extractParsedFile`)
 *        │  finalizeScopeModel(  + provider hooks adapted to FinalizeHooks)
 *        ▼
 *     ScopeResolutionIndexes
 *        │  resolveReferenceSites
 *        ▼
 *     ReferenceIndex
 *        │  emitReceiverBoundCalls (FIRST — see Contract Invariant I1)
 *        │  emitFreeCallFallback   (THEN)
 *        │  emitReferencesViaLookup (LAST — uses handledSites)
 *        │  emitImportEdges
 *        ▼
 *     KnowledgeGraph
 *
 * Per-language entry points (e.g. `runPythonScopeResolution` in
 * `languages/python/scope-resolver.ts`) construct an `ScopeResolver` and
 * delegate here.
 *
 * Plan: `docs/plans/2026-04-20-001-refactor-emit-pipeline-generalization-plan.md`.
 */

import type { ParsedFile, RegistryProviders } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { lookupOwnedMembersByOwner } from '../../model/owned-members-lookup.js';
import type { MutableSemanticModel, SemanticModel } from '../../model/semantic-model.js';
import { reconcileOwnership, validateOwnershipParity } from './reconcile-ownership.js';
import { validateBindingsImmutability } from './validate-bindings-immutability.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../finalize-orchestrator.js';
import { resolveReferenceSites, type ResolveStats } from '../../resolve-references.js';
import { buildGraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import { buildPopulatedMethodDispatch } from '../graph-bridge/method-dispatch.js';
import { tryEmitEdge } from '../graph-bridge/edges.js';
import { propagateImportedReturnTypes } from '../passes/imported-return-types.js';
import { emitReceiverBoundCalls } from '../passes/receiver-bound-calls.js';
import { emitFreeCallFallback } from '../passes/free-call-fallback.js';
import { emitReferencesViaLookup } from '../graph-bridge/references-to-edges.js';
import { emitImportEdges } from '../graph-bridge/imports-to-edges.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { findClassBindingInScope, findEnclosingClassDef } from '../scope/walkers.js';
import { buildWorkspaceResolutionIndex } from '../workspace-index.js';
import type { ResolutionOutcome, ResolutionOutcomeRecorder } from '../resolution-outcome.js';

import { logger } from '../../../logger.js';

/**
 * Resolve inheritance reference sites early and pre-emit their EXTENDS edges
 * before MRO construction. This lets template-base captures contribute to the
 * graph in time for `buildMro`, while `handledSites` prevents the generic
 * reference-edge bridge from re-emitting the same sites later.
 *
 * @returns Site keys to seed the downstream handled-site skip set.
 */
function preEmitInheritanceEdges(
  graph: KnowledgeGraph,
  scopes: ReturnType<typeof finalizeScopeModel>,
  nodeLookup: ReturnType<typeof buildGraphNodeLookup>,
): Set<string> {
  const handledSites = new Set<string>();
  const seen = new Set<string>();
  const existing = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('EXTENDS')) {
    existing.add(`${rel.sourceId}->${rel.targetId}`);
  }

  for (const site of scopes.referenceSites) {
    if (site.kind !== 'inherits') continue;
    const scope = scopes.scopeTree.getScope(site.inScope);
    const siteKey =
      scope?.filePath !== undefined
        ? `${scope.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`
        : undefined;
    if (siteKey !== undefined) {
      // Intentionally suppress every `inherits` site from the generic
      // reference bridge, even when this pre-pass can't emit an EXTENDS
      // edge. The shared bridge resolves the source via
      // `resolveCallerGraphId`, which can degrade class-heritage sites into
      // method-owned EXTENDS edges once methods exist on the class. This
      // pre-pass is the authoritative inheritance emitter, so broad
      // suppression keeps `buildMro` and the final graph class-owned.
      handledSites.add(siteKey);
    }

    const targetDef = findClassBindingInScope(site.inScope, site.name, scopes);
    if (targetDef === undefined) continue;

    const callerClass = findEnclosingClassDef(site.inScope, scopes);
    if (callerClass === undefined) continue;
    const callerGraphId = resolveDefGraphId(callerClass.filePath, callerClass, nodeLookup);
    const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
    if (callerGraphId === undefined || targetGraphId === undefined) continue;
    const edgeKey = `${callerGraphId}->${targetGraphId}`;
    if (existing.has(edgeKey)) continue;

    if (
      tryEmitEdge(
        graph,
        scopes,
        nodeLookup,
        site,
        targetDef,
        'scope-resolution: inherits',
        seen,
        0.85,
      )
    ) {
      existing.add(edgeKey);
    }
  }

  return handledSites;
}

export type ScopeResolutionSubPhase =
  | 'extracting'
  | 'analyzing types'
  | 'resolving references'
  | 'linking symbols';

interface RunScopeResolutionInput {
  readonly graph: KnowledgeGraph;
  /**
   * Semantic model populated by the legacy `parse` phase. Scope-
   * resolution consumes its `TypeRegistry` / `MethodRegistry` /
   * `SymbolTable` lookups instead of rebuilding parallel indexes from
   * `ParsedFile[]`. See ARCHITECTURE.md § "Semantic-model source of
   * truth". Tests that invoke `runScopeResolution` in isolation pass a
   * freshly-created `MutableSemanticModel` populated from the same
   * `ParsedFile[]` to mirror the pipeline shape.
   */
  readonly model: MutableSemanticModel;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly onWarn?: (message: string) => void;
  /**
   * Optional pre-parsed-Tree lookup keyed by file path. When the
   * pipeline's parse phase ran sequentially, it populated an
   * `ASTCache`; passing that here lets the per-file extract step
   * skip a second `tree-sitter parser.parse(...)` call. Cache miss
   * is safe — falls back to a fresh parse inside the provider.
   */
  readonly treeCache?: { get(filePath: string): unknown };
  /**
   * Opaque per-language import-resolution config (e.g. tsconfig path
   * aliases for TypeScript). Loaded once by the caller via
   * `provider.loadResolutionConfig(repoPath)` and threaded into every
   * `provider.resolveImportTarget` call. `undefined` when the
   * provider doesn't supply a config loader.
   */
  readonly resolutionConfig?: unknown;
  /**
   * Pre-extracted ParsedFile artifacts keyed by file path. When a
   * file is present here, the extract loop reuses it directly and
   * skips `extractParsedFile` (which would re-parse the file with
   * tree-sitter on the main thread). Only files matching the
   * provider's language are honored — the loop verifies this
   * implicitly by language filter at the call-site (scopeResolution
   * phase).
   *
   * Worker-mode parses produce these ParsedFile artifacts as a side
   * effect of `extractParsedFile` running inside the worker; threading
   * them here is what lets the warm-cache analyze run skip the ~58s
   * scope-resolution re-parse loop on a multi-thousand-file repo.
   * Cache miss is safe — falls back to fresh extract.
   */
  readonly preExtractedParsedFiles?: ReadonlyMap<string, ParsedFile>;
  /**
   * Optional additive diagnostics sink. Resolver passes call this when they
   * intentionally suppress an edge; the graph remains unchanged.
   */
  readonly recordResolutionOutcome?: ResolutionOutcomeRecorder;
  /**
   * Optional progress callback for UI updates during long-running scope
   * resolution. Called periodically during the extract loop and at each
   * sub-phase boundary (finalize, resolve, emit).
   *
   * @param subPhase  Current sub-phase name for display
   * @param current   Files processed so far (during extract) or total files (at phase boundaries)
   * @param total     Total files in this language
   */
  readonly onProgress?: (subPhase: ScopeResolutionSubPhase, current: number, total: number) => void;
}

interface RunScopeResolutionStats {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly importsEmitted: number;
  readonly resolve: ResolveStats;
  readonly referenceEdgesEmitted: number;
  readonly referenceSkipped: number;
  readonly resolutionOutcomes: readonly ResolutionOutcome[];
}

export function runScopeResolution(
  input: RunScopeResolutionInput,
  provider: ScopeResolver,
): RunScopeResolutionStats {
  const { graph, files } = input;
  const onWarn = input.onWarn ?? (() => {});
  const resolutionOutcomes: ResolutionOutcome[] = [];
  const recordResolutionOutcome: ResolutionOutcomeRecorder = (outcome) => {
    resolutionOutcomes.push(outcome);
    input.recordResolutionOutcome?.(outcome);
  };
  const PROF = process.env.PROF_SCOPE_RESOLUTION === '1';
  const tStart = PROF ? process.hrtime.bigint() : 0n;
  let fileContents: Map<string, string> | undefined;
  const getFileContents = (): Map<string, string> => {
    if (fileContents === undefined) {
      fileContents = new Map<string, string>();
      for (const f of files) fileContents.set(f.path, f.content);
    }
    return fileContents;
  };

  // ── Phase 1: extract each file → ParsedFile ────────────────────────────
  const parsedFiles: ParsedFile[] = [];
  let filesSkipped = 0;
  const treeCache = input.treeCache;
  const preExtracted = input.preExtractedParsedFiles;
  let preExtractedHits = 0;
  const progressInterval = files.length > 0 ? Math.max(1, Math.floor(files.length / 50)) : 1;
  input.onProgress?.('extracting', 0, files.length);
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    let parsed: ParsedFile | undefined;
    // Fast path: a worker (during the parse phase) already produced a
    // ParsedFile for this file via `extractParsedFile`. Reuse it
    // directly — skips a tree-sitter re-parse on the main thread.
    if (preExtracted !== undefined) {
      parsed = preExtracted.get(file.path);
      if (parsed !== undefined) preExtractedHits++;
    }
    if (parsed === undefined) {
      const cachedTree = treeCache?.get(file.path);
      parsed = extractParsedFile(
        provider.languageProvider,
        file.content,
        file.path,
        onWarn,
        cachedTree,
      );
      if (parsed === undefined) {
        filesSkipped++;
        continue;
      }
    }
    provider.populateOwners(parsed);
    parsedFiles.push(parsed);
    if (
      input.onProgress &&
      ((fileIdx + 1) % progressInterval === 0 || fileIdx === files.length - 1)
    ) {
      input.onProgress('extracting', fileIdx + 1, files.length);
    }
  }
  if (PROF && preExtracted !== undefined) {
    logger.warn(`[scope-resolution prof] pre-extracted hits: ${preExtractedHits}/${files.length}`);
  }
  provider.populateWorkspaceOwners?.(parsedFiles, { fileContents: getFileContents() });

  // Reconcile scope-resolution's ownership view into the SemanticModel.
  // See `reconcile-ownership.ts` for the full rationale (Contract
  // Invariant I9). Debug-mode validator runs immediately after to
  // catch drift between `parsed.localDefs` and the registries.
  //
  // PHASE BOUNDARY: `input.model` is `MutableSemanticModel` up to this
  // point (write phase: reconciliation). After this line no further
  // writes are expected — downstream passes consume `readonlyModel`
  // (narrowed to `SemanticModel`) so accidental writes would surface
  // as type errors.
  reconcileOwnership(parsedFiles, input.model);
  validateOwnershipParity(parsedFiles, input.model, onWarn);
  const readonlyModel: SemanticModel = input.model;

  if (parsedFiles.length === 0) {
    return {
      filesProcessed: 0,
      filesSkipped,
      importsEmitted: 0,
      resolve: { sitesProcessed: 0, referencesEmitted: 0, unresolved: 0 },
      referenceEdgesEmitted: 0,
      referenceSkipped: 0,
      resolutionOutcomes,
    };
  }

  const tExtract = PROF ? process.hrtime.bigint() : 0n;

  // ── Phase 2: finalize → ScopeResolutionIndexes ─────────────────────────
  input.onProgress?.('analyzing types', files.length, files.length);
  const allFilePaths = new Set(parsedFiles.map((f) => f.filePath));
  const nodeLookup = buildGraphNodeLookup(graph);

  const resolutionConfig = input.resolutionConfig;
  const finalized = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        provider.resolveImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),
      expandsWildcardTo: (targetModuleScope) =>
        provider.expandsWildcardTo?.(targetModuleScope, parsedFiles) ?? [],
      mergeBindings: (existing, incoming, scopeId) =>
        provider.mergeBindings(existing, incoming, scopeId),
    },
  });
  const preEmittedInheritanceSites = preEmitInheritanceEdges(graph, finalized, nodeLookup);
  // Call-based heritage hook (e.g., Ruby include/extend/prepend) — emits
  // IMPLEMENTS edges that `preEmitInheritanceEdges` cannot produce because
  // the heritage declarations are syntactic method calls, not grammar-level
  // heritage clauses. Must run BEFORE `buildMro` so MRO construction sees
  // the freshly-emitted IMPLEMENTS edges.
  provider.emitHeritageEdges?.(graph, parsedFiles, nodeLookup);
  // Implicit IMPORTS-edge hook — for languages whose files have compiler-
  // implicit cross-file visibility (no syntactic import statement). The
  // finalized-ImportEdge pipeline (`emitImportEdges`) cannot produce these
  // because there is no `ImportEdge` to materialize. Idempotent.
  provider.emitImplicitImportEdges?.(graph, parsedFiles, nodeLookup, resolutionConfig);
  // Rebuild the node lookup after heritage-edge emission. Languages like
  // Ruby create Property graph nodes inside `emitHeritageEdges`; those
  // nodes must be visible to downstream passes (`emitReceiverBoundCalls`
  // resolves write-access targets via `resolveDefGraphId` which consults
  // `nodeLookup`). Without this rebuild, Property nodes added by the
  // heritage hook are invisible and ACCESSES edges silently fail to emit.
  const postHeritageNodeLookup =
    provider.emitHeritageEdges !== undefined ? buildGraphNodeLookup(graph) : nodeLookup;
  const mroByClassDefId = provider.buildMro(graph, parsedFiles, postHeritageNodeLookup);
  const extendsOnlyMroByClassDefId = provider.buildExtendsOnlyMro?.(
    graph,
    parsedFiles,
    postHeritageNodeLookup,
  );

  // Replace the empty MethodDispatchIndex that finalizeScopeModel
  // builds by design with the populated one derived from the
  // language's MRO. Spread produces a fresh `ScopeResolutionIndexes`
  // instead of mutating the finalized result through an `as` cast —
  // downstream passes get an object whose readonly guarantees match
  // the type system.
  const indexes = {
    ...finalized,
    methodDispatch: buildPopulatedMethodDispatch(mroByClassDefId, extendsOnlyMroByClassDefId),
  };

  // Build the workspace resolution index ONCE — scope-valued lookups
  // (`classScopeByDefId`, `moduleScopeByFile`) that `SemanticModel`
  // cannot carry. Must run AFTER `populateOwners` (so owned defs are
  // attributed correctly) and AFTER finalize (so module-scope
  // bindings are available).
  const workspaceIndex = buildWorkspaceResolutionIndex(parsedFiles);

  // Cross-file implicit-namespace visibility (C#). Must run before
  // propagateImportedReturnTypes so the latter pass sees siblings'
  // class bindings when chasing return-type chains across files.
  // The hook writes to `bindingAugmentations` only; finalized
  // `indexes.bindings` remains immutable post-finalize (I8).
  if (provider.populateNamespaceSiblings !== undefined) {
    provider.populateNamespaceSiblings(parsedFiles, indexes, {
      fileContents: getFileContents(),
      treeCache,
      resolutionConfig,
    });
  }

  const tFinalize = PROF ? process.hrtime.bigint() : 0n;

  // Cross-package namespace typeBinding mirroring. Runs before
  // propagateImportedReturnTypes so the SCC-ordered pass sees the
  // mirrored bindings.
  if (provider.mirrorNamespaceTypeBindings !== undefined) {
    provider.mirrorNamespaceTypeBindings(parsedFiles, indexes, workspaceIndex, resolutionConfig);
  }

  // Cross-file return-type propagation (Contract Invariant I3 timing:
  // after finalize, before resolve). Split-timed separately so the
  // SCC-ordered pass's cost is observable (PR #1050 made this O(files)
  // with chain-follow per importer; quadratic regressions show up
  // here, not in finalize).
  if (provider.propagatesReturnTypesAcrossImports !== false) {
    propagateImportedReturnTypes(parsedFiles, indexes, workspaceIndex);
  }

  if (provider.populateRangeBindings !== undefined) {
    provider.populateRangeBindings(parsedFiles, indexes, {
      fileContents: getFileContents(),
      treeCache,
    });
  }
  const tPropagate = PROF ? process.hrtime.bigint() : 0n;

  // Opt-in I8 invariant guard. Runs once after all post-finalize hooks
  // (`populateNamespaceSiblings`, `propagateImportedReturnTypes`) have
  // had a chance to drift, so a single sweep covers the full
  // post-finalize surface visible to `resolveReferenceSites`. No-op in
  // default CLI runs; enabled by NODE_ENV=development or
  // VALIDATE_SEMANTIC_MODEL=1.
  validateBindingsImmutability(indexes, onWarn);

  // ── Phase 3: resolve references via Registry.lookup ────────────────────
  input.onProgress?.('resolving references', files.length, files.length);
  const registryProviders: RegistryProviders = {
    arityCompatibility: provider.arityCompatibility,
  };
  const { referenceIndex, stats: resolveStats } = resolveReferenceSites({
    scopes: indexes,
    providers: registryProviders,
    ownedMembersByOwner: (ownerDefId, memberName) =>
      lookupOwnedMembersByOwner(readonlyModel, ownerDefId, memberName),
  });
  const tResolve = PROF ? process.hrtime.bigint() : 0n;

  // ── Phase 4: emit graph edges (LOAD-BEARING ORDER — see I1) ────────────
  input.onProgress?.('linking symbols', files.length, files.length);
  const handledSites = new Set<string>(preEmittedInheritanceSites);
  const receiverExtras = emitReceiverBoundCalls(
    graph,
    indexes,
    parsedFiles,
    postHeritageNodeLookup,
    handledSites,
    provider,
    workspaceIndex,
    readonlyModel,
    {
      recordResolutionOutcome,
    },
  );
  const unresolvedReceiverExtras =
    provider.emitUnresolvedReceiverEdges !== undefined
      ? provider.emitUnresolvedReceiverEdges(
          graph,
          indexes,
          parsedFiles,
          postHeritageNodeLookup,
          handledSites,
          readonlyModel,
        )
      : 0;
  const freeCallExtras = emitFreeCallFallback(
    graph,
    indexes,
    parsedFiles,
    postHeritageNodeLookup,
    referenceIndex,
    handledSites,
    readonlyModel,
    workspaceIndex,
    {
      allowGlobalFallback: provider.allowGlobalFreeCallFallback === true,
      constructorCallTargetsClass: provider.constructorCallTargetsClass === true,
      isFileLocalDef: provider.isFileLocalDef,
      isCallableVisibleFromCaller: provider.isCallableVisibleFromCaller,
      resolveAdlCandidates: provider.resolveAdlCandidates,
      conversionRankFn: provider.conversionRankFn,
      constraintCompatibility: provider.constraintCompatibility,
      recordResolutionOutcome,
    },
  );
  const { emitted, skipped } = emitReferencesViaLookup(
    graph,
    indexes,
    referenceIndex,
    postHeritageNodeLookup,
    handledSites,
  );
  const importsEmitted = emitImportEdges(
    graph,
    indexes.imports,
    indexes.scopeTree,
    provider.importEdgeReason,
  );

  if (PROF) {
    const tEnd = process.hrtime.bigint();
    const ns = (a: bigint, b: bigint): number => Number(b - a) / 1_000_000;
    logger.warn(
      `[scope-resolution prof] extract=${ns(tStart, tExtract).toFixed(0)}ms` +
        ` finalize=${ns(tExtract, tFinalize).toFixed(0)}ms` +
        ` propagate=${ns(tFinalize, tPropagate).toFixed(0)}ms` +
        ` resolve=${ns(tPropagate, tResolve).toFixed(0)}ms` +
        ` emit=${ns(tResolve, tEnd).toFixed(0)}ms` +
        ` total=${ns(tStart, tEnd).toFixed(0)}ms` +
        ` (${parsedFiles.length} files)`,
    );
  }

  return {
    filesProcessed: parsedFiles.length,
    filesSkipped,
    importsEmitted,
    resolve: resolveStats,
    referenceEdgesEmitted: emitted + receiverExtras + unresolvedReceiverExtras + freeCallExtras,
    referenceSkipped: skipped,
    resolutionOutcomes,
  };
}
