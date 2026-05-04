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
import type { MutableSemanticModel, SemanticModel } from '../../model/semantic-model.js';
import { reconcileOwnership, validateOwnershipParity } from './reconcile-ownership.js';
import { validateBindingsImmutability } from './validate-bindings-immutability.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../finalize-orchestrator.js';
import { resolveReferenceSites, type ResolveStats } from '../../resolve-references.js';
import { buildGraphNodeLookup } from '../graph-bridge/node-lookup.js';
import { buildPopulatedMethodDispatch } from '../graph-bridge/method-dispatch.js';
import { propagateImportedReturnTypes } from '../passes/imported-return-types.js';
import { emitReceiverBoundCalls } from '../passes/receiver-bound-calls.js';
import { emitFreeCallFallback } from '../passes/free-call-fallback.js';
import { emitReferencesViaLookup } from '../graph-bridge/references-to-edges.js';
import { emitImportEdges } from '../graph-bridge/imports-to-edges.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { buildWorkspaceResolutionIndex } from '../workspace-index.js';

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
}

interface RunScopeResolutionStats {
  readonly filesProcessed: number;
  readonly filesSkipped: number;
  readonly importsEmitted: number;
  readonly resolve: ResolveStats;
  readonly referenceEdgesEmitted: number;
  readonly referenceSkipped: number;
}

export function runScopeResolution(
  input: RunScopeResolutionInput,
  provider: ScopeResolver,
): RunScopeResolutionStats {
  const { graph, files } = input;
  const onWarn = input.onWarn ?? (() => {});
  const PROF = process.env.PROF_SCOPE_RESOLUTION === '1';
  const tStart = PROF ? process.hrtime.bigint() : 0n;

  // ── Phase 1: extract each file → ParsedFile ────────────────────────────
  const parsedFiles: ParsedFile[] = [];
  let filesSkipped = 0;
  const treeCache = input.treeCache;
  for (const file of files) {
    const cachedTree = treeCache?.get(file.path);
    const parsed = extractParsedFile(
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
    provider.populateOwners(parsed);
    parsedFiles.push(parsed);
  }

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
    };
  }

  const tExtract = PROF ? process.hrtime.bigint() : 0n;

  // ── Phase 2: finalize → ScopeResolutionIndexes ─────────────────────────
  const allFilePaths = new Set(parsedFiles.map((f) => f.filePath));
  const nodeLookup = buildGraphNodeLookup(graph);
  const mroByClassDefId = provider.buildMro(graph, parsedFiles, nodeLookup);

  const resolutionConfig = input.resolutionConfig;
  const finalized = finalizeScopeModel(parsedFiles, {
    hooks: {
      resolveImportTarget: (targetRaw, fromFile) =>
        provider.resolveImportTarget(targetRaw, fromFile, allFilePaths, resolutionConfig),
      mergeBindings: (existing, incoming, scopeId) =>
        provider.mergeBindings(existing, incoming, scopeId),
    },
  });

  // Replace the empty MethodDispatchIndex that finalizeScopeModel
  // builds by design with the populated one derived from the
  // language's MRO. Spread produces a fresh `ScopeResolutionIndexes`
  // instead of mutating the finalized result through an `as` cast —
  // downstream passes get an object whose readonly guarantees match
  // the type system.
  const indexes = {
    ...finalized,
    methodDispatch: buildPopulatedMethodDispatch(mroByClassDefId),
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
    const fileContents = new Map<string, string>();
    for (const f of files) fileContents.set(f.path, f.content);
    provider.populateNamespaceSiblings(parsedFiles, indexes, {
      fileContents,
      treeCache,
    });
  }

  const tFinalize = PROF ? process.hrtime.bigint() : 0n;

  // Cross-file return-type propagation (Contract Invariant I3 timing:
  // after finalize, before resolve). Split-timed separately so the
  // SCC-ordered pass's cost is observable (PR #1050 made this O(files)
  // with chain-follow per importer; quadratic regressions show up
  // here, not in finalize).
  if (provider.propagatesReturnTypesAcrossImports !== false) {
    propagateImportedReturnTypes(parsedFiles, indexes, workspaceIndex);
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
  const registryProviders: RegistryProviders = {
    arityCompatibility: provider.arityCompatibility,
  };
  const { referenceIndex, stats: resolveStats } = resolveReferenceSites({
    scopes: indexes,
    providers: registryProviders,
  });
  const tResolve = PROF ? process.hrtime.bigint() : 0n;

  // ── Phase 4: emit graph edges (LOAD-BEARING ORDER — see I1) ────────────
  const handledSites = new Set<string>();
  const receiverExtras = emitReceiverBoundCalls(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    handledSites,
    provider,
    workspaceIndex,
    readonlyModel,
  );
  const freeCallExtras = emitFreeCallFallback(
    graph,
    indexes,
    parsedFiles,
    nodeLookup,
    referenceIndex,
    handledSites,
    readonlyModel,
    workspaceIndex,
  );
  const { emitted, skipped } = emitReferencesViaLookup(
    graph,
    indexes,
    referenceIndex,
    nodeLookup,
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
    console.warn(
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
    referenceEdgesEmitted: emitted + receiverExtras + freeCallExtras,
    referenceSkipped: skipped,
  };
}
