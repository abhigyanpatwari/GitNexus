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
import { generateId } from '../../../../lib/utils.js';
import { lookupOwnedMembersByOwner } from '../../model/owned-members-lookup.js';
import type { MutableSemanticModel, SemanticModel } from '../../model/semantic-model.js';
import { reconcileOwnership, validateOwnershipParity } from './reconcile-ownership.js';
import { validateBindingsImmutability } from './validate-bindings-immutability.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { finalizeScopeModel } from '../../finalize-orchestrator.js';
import { resolveReferenceSites, type ResolveStats } from '../../resolve-references.js';
import { buildGraphNodeLookup } from '../graph-bridge/node-lookup.js';
import {
  emitFileCfgs,
  emitFileReachingDefs,
  isEmitSafeCfg,
  DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
  DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
} from '../../cfg/emit.js';
import type { FunctionCfg } from '../../cfg/types.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import { buildPopulatedMethodDispatch } from '../graph-bridge/method-dispatch.js';
import { propagateImportedReturnTypes } from '../passes/imported-return-types.js';
import { emitReceiverBoundCalls } from '../passes/receiver-bound-calls.js';
import { emitFreeCallFallback } from '../passes/free-call-fallback.js';
import { emitReferencesViaLookup } from '../graph-bridge/references-to-edges.js';
import { emitImportEdges } from '../graph-bridge/imports-to-edges.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import { findEnclosingClassDef, resolveInheritanceBaseInScope } from '../scope/walkers.js';
import { buildWorkspaceResolutionIndex } from '../workspace-index.js';
import type { ResolutionOutcome, ResolutionOutcomeRecorder } from '../resolution-outcome.js';
import { logHeapProbe } from '../../utils/heap-probe.js';
import { parseTruthyEnv } from '../../utils/env.js';
import { TransitionalScopeTree } from '../../../../storage/scope-index-store.js';
import { forceGc } from '../../../../storage/parsedfile-store.js';

import { logger } from '../../../logger.js';

/**
 * Emit one class-owned inheritance edge directly (the inheritance pre-pass is
 * the authoritative emitter — see `preEmitInheritanceEdges`). Encapsulates the
 * dual dedup contract so the two sets' joint semantics live in one place:
 *   - `existing` — coarse per-`(caller, target, type)` gate, seeded from the
 *     graph (so this pass is a no-op when the legacy path already emitted it).
 *   - `seen` — per-site key shared with the generic edge bridge so the two
 *     passes never double-emit the same resolution.
 * The `dedupKey` and `rel:` id shape match `tryEmitEdge` exactly, so graph
 * output stays byte-identical. The caller is the enclosing class (NOT the
 * method/constructor `resolveCallerGraphId` would prefer — that broke MRO for
 * C# 12 primary constructors, #1951); the edge type is pre-discriminated.
 */
function emitInheritanceEdgeDirect(
  graph: KnowledgeGraph,
  seen: Set<string>,
  existing: Set<string>,
  callerGraphId: string,
  targetGraphId: string,
  edgeType: 'EXTENDS' | 'IMPLEMENTS',
  site: { readonly atRange: { startLine: number; startCol: number } },
): void {
  const edgeKey = `${edgeType}:${callerGraphId}->${targetGraphId}`;
  const dedupKey = `${edgeKey}:${site.atRange.startLine}:${site.atRange.startCol}`;
  if (existing.has(edgeKey) || seen.has(dedupKey)) return;
  seen.add(dedupKey);
  existing.add(edgeKey);
  graph.addRelationship({
    id: `rel:${dedupKey}`,
    sourceId: callerGraphId,
    targetId: targetGraphId,
    type: edgeType,
    confidence: 0.85,
    reason: 'scope-resolution: inherits',
  });
}

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
  // Tracks inheritance edges emitted during this pass so the structural
  // interface-implementation pass (emitDetectedInterfaceImplementations) and
  // repeated `inherits` sites don't double-emit. Starts empty: this pre-pass is
  // the authoritative inheritance emitter — no EXTENDS/IMPLEMENTS edges exist in
  // the graph before it runs (the legacy heritage path was removed in #942).
  const existing = new Set<string>();

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
      // pre-pass is the authoritative inheritance emitter and pins the source
      // to the enclosing class (via the `callerGraphId` override below), so
      // suppression keeps `buildMro` and the final graph class-owned.
      handledSites.add(siteKey);
    }

    // Resolve the deriving (caller) class first and reuse it as the enclosing
    // context for qualified-base resolution — avoids a second findEnclosingClassDef
    // walk per qualified site (#1982 perf). Both need the same enclosing class.
    const callerClass = findEnclosingClassDef(site.inScope, scopes);
    if (callerClass === undefined) continue;

    const targetDef = resolveInheritanceBaseInScope(
      site.inScope,
      site.name,
      scopes,
      site.rawQualifiedName,
      callerClass,
    );
    if (targetDef === undefined) continue;
    const callerGraphId = resolveDefGraphId(callerClass.filePath, callerClass, nodeLookup);
    const targetGraphId = resolveDefGraphId(targetDef.filePath, targetDef, nodeLookup);
    if (callerGraphId === undefined || targetGraphId === undefined) continue;
    // Discriminate EXTENDS vs IMPLEMENTS by the resolved target's symbol kind:
    // conforming to an interface OR mixing in a trait/protocol is IMPLEMENTS,
    // deriving from a class-like is EXTENDS. The discriminator is purely
    // symbol-kind-driven (no language is named here, per AGENTS.md): a base that
    // resolves to neither an Interface nor a Trait symbol always takes the
    // EXTENDS branch, so such languages are unchanged.
    const edgeType: 'EXTENDS' | 'IMPLEMENTS' =
      targetDef.type === 'Interface' || targetDef.type === 'Trait' ? 'IMPLEMENTS' : 'EXTENDS';
    emitInheritanceEdgeDirect(graph, seen, existing, callerGraphId, targetGraphId, edgeType, site);
  }

  return handledSites;
}

/**
 * Emit language-inferred structural interface implementations before MRO and
 * interface dispatch are built. Languages such as Go do not declare
 * `implements` explicitly, so their resolver can infer defId-level interface
 * satisfaction from parsed files and this bridge converts those defIds to
 * graph node ids.
 *
 * Existing explicit IMPLEMENTS edges win: the local `existing` set prevents
 * duplicate structural edges and keeps this hook language-neutral. The reason
 * string carries the provider language (`go-structural-implements`) so callers
 * can distinguish inferred edges from source-declared heritage.
 */
function emitDetectedInterfaceImplementations(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: ReturnType<typeof buildGraphNodeLookup>,
  provider: ScopeResolver,
  indexes: ReturnType<typeof finalizeScopeModel>,
  model: SemanticModel,
): number {
  if (provider.detectInterfaceImplementations === undefined) return 0;

  const graphIdByDefId = new Map<string, string>();
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class' && def.type !== 'Struct' && def.type !== 'Interface') continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId !== undefined) graphIdByDefId.set(def.nodeId, graphId);
    }
  }

  const existing = new Set<string>();
  for (const rel of graph.iterRelationshipsByType('IMPLEMENTS')) {
    existing.add(`${rel.sourceId}->${rel.targetId}`);
  }

  let emitted = 0;
  const detected = provider.detectInterfaceImplementations(parsedFiles, indexes, model);
  for (const [interfaceDefId, implementorDefIds] of detected) {
    const targetId = graphIdByDefId.get(interfaceDefId);
    if (targetId === undefined) continue;
    for (const implementorDefId of implementorDefIds) {
      const sourceId = graphIdByDefId.get(implementorDefId);
      if (sourceId === undefined) continue;
      const edgeKey = `${sourceId}->${targetId}`;
      if (existing.has(edgeKey)) continue;
      existing.add(edgeKey);
      graph.addRelationship({
        id: generateId('IMPLEMENTS', edgeKey),
        sourceId,
        targetId,
        type: 'IMPLEMENTS',
        confidence: 0.85,
        reason: `${provider.language}-structural-implements`,
      });
      emitted++;
    }
  }

  return emitted;
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
   * Optional pre-parsed-Tree lookup keyed by file path: a cache hit lets the
   * per-file extract step skip a second `tree-sitter parser.parse(...)` call.
   * Currently always empty — the only producer was the (removed) sequential
   * parser, and workers can't return native Trees across the MessageChannel,
   * so the parse phase no longer threads one. Kept as an extension point;
   * cache miss is safe (the provider re-parses).
   */
  readonly treeCache?: { get(filePath: string): unknown };
  /**
   * CFG/PDG opt-in (#2081 M1). When true, emit BasicBlock nodes + CFG edges
   * from each ParsedFile's worker-built `cfgSideChannel` during Phase-4 graph
   * emission (while the disk store is still live). Default/false ⇒ no CFG
   * nodes or edges and a byte-identical graph.
   */
  readonly pdg?: boolean;
  /** Per-function CFG edge cap. `undefined` ⇒ {@link DEFAULT_MAX_CFG_EDGES_PER_FUNCTION};
   *  `0` ⇒ no cap (unlimited). */
  readonly pdgMaxEdgesPerFunction?: number;
  /** Per-function REACHING_DEF edge cap (#2082 M2). `undefined` ⇒
   *  {@link DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION}; `0` ⇒ no cap. */
  readonly pdgMaxReachingDefEdgesPerFunction?: number;
  /**
   * Optional graph-node lookup built ONCE by the caller and shared across
   * every language pass. `buildGraphNodeLookup` scans the whole graph and is
   * language-agnostic, so rebuilding it per language wastes both CPU and ~GBs
   * of heap (on the kernel it is ~2 GB; a 5-file language would otherwise build
   * its own full copy that then overlaps the next language's). When omitted
   * (tests / isolated calls) the lookup is built locally as before. Providers
   * that add graph nodes mid-pass (e.g. Ruby heritage Property nodes) still
   * rebuild a fresh post-heritage lookup internally, so sharing the pre-loop
   * base is safe.
   */
  readonly prebuiltNodeLookup?: ReturnType<typeof buildGraphNodeLookup>;
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
   * Out-of-core scope index (disk-backed scope seal). When set AND `GITNEXUS_DISK_SCOPE_INDEX` is
   * enabled, the per-language `scopeTree` is sealed to a disk-backed store at
   * this path after resolve (before emit), and the heavy `Scope.bindings`
   * payload is dropped from heap — lowering the per-language peak (kernel:
   * ~20→~12 GB) so the analysis fits on smaller-RAM machines. Same storage path
   * as the ParsedFile store; a sibling `scope-index-store/` dir.
   */
  readonly scopeIndexStorePath?: string;
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
  logHeapProbe('sr-extract-start', `lang=${provider.language} files=${files.length}`);
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    let parsed: ParsedFile | undefined;
    // Fast path: a worker (during the parse phase) already produced a
    // ParsedFile for this file via `extractParsedFile`. Reuse it
    // directly — skips a tree-sitter re-parse on the main thread.
    let reusedPreExtracted = false;
    if (preExtracted !== undefined) {
      parsed = preExtracted.get(file.path);
      if (parsed !== undefined) {
        preExtractedHits++;
        reusedPreExtracted = true;
      }
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
    // Worker-boundary restore: a pre-extracted ParsedFile was produced by
    // `extractParsedFile` running INSIDE a worker, so any capture-time
    // module-level side-channel state (`emitScopeCaptures` side effects that
    // are NOT serialized onto the ParsedFile's scopes/defs — C++ ADL/namespace
    // marks) was populated in the worker process and is missing here. The
    // worker stashed a plain-data snapshot on `parsed.captureSideChannel` (via
    // `collectCaptureSideChannel`); write it back into the module maps now,
    // BEFORE populateOwners consumes the resolved ranges. NO re-parse — that is
    // the #1983 fix. The fresh-extract leg above already populated those marks
    // in this process, so it skips the restore. See
    // `ScopeResolver.applyCaptureSideChannel`.
    if (reusedPreExtracted && provider.applyCaptureSideChannel !== undefined) {
      provider.applyCaptureSideChannel(parsed);
    }
    provider.populateOwners(parsed);
    parsedFiles.push(parsed);
    if ((fileIdx + 1) % progressInterval === 0 || fileIdx === files.length - 1) {
      input.onProgress?.('extracting', fileIdx + 1, files.length);
      logHeapProbe(
        'sr-extract-progress',
        `lang=${provider.language} idx=${fileIdx + 1}/${files.length} parsedFiles=${parsedFiles.length} preExtractedHits=${preExtractedHits}`,
      );
    }
  }
  if (PROF && preExtracted !== undefined) {
    logger.warn(`[scope-resolution prof] pre-extracted hits: ${preExtractedHits}/${files.length}`);
  }
  logHeapProbe(
    'sr-extract-end',
    `lang=${provider.language} parsedFiles=${parsedFiles.length} preExtractedHits=${preExtractedHits} skipped=${filesSkipped}`,
  );
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
  logHeapProbe('sr-pre-nodeLookup', `lang=${provider.language}`);
  const nodeLookup = input.prebuiltNodeLookup ?? buildGraphNodeLookup(graph);
  logHeapProbe('sr-post-nodeLookup', `lang=${provider.language}`);

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
  logHeapProbe('sr-post-finalize', `lang=${provider.language}`);
  const preEmittedInheritanceSites = preEmitInheritanceEdges(graph, finalized, nodeLookup);
  // Call-based heritage hook (e.g., Ruby include/extend/prepend) — emits
  // IMPLEMENTS edges that `preEmitInheritanceEdges` cannot produce because
  // the heritage declarations are syntactic method calls, not grammar-level
  // heritage clauses. Must run BEFORE `buildMro` so MRO construction sees
  // the freshly-emitted IMPLEMENTS edges.
  provider.emitHeritageEdges?.(graph, parsedFiles, nodeLookup, finalized);
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
  emitDetectedInterfaceImplementations(
    graph,
    parsedFiles,
    postHeritageNodeLookup,
    provider,
    finalized,
    readonlyModel,
  );
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
  // Pass the scopeTree so the index's class/module Scope lookups are id-backed
  // views that delegate to it (out-of-core scope index) — the index pins no Scope objects, so the
  // disk seal can reclaim them. Byte-identical: the view returns the same Scope
  // the resident tree holds (or a value-identical revived one in disk mode).
  const workspaceIndex = buildWorkspaceResolutionIndex(parsedFiles, indexes.scopeTree);
  logHeapProbe('sr-post-workspaceIndex', `lang=${provider.language}`);

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
  logHeapProbe('sr-post-resolve', `lang=${provider.language}`);

  // ── Out-of-core scope seal boundary ─────────────────────────────────────
  // Pass-A (finalize + propagate + resolve) is done; all whole-language reads
  // of `Scope.bindings` are behind us. Emit reaches scopes ONLY via
  // `scopeTree.getScope` (a point lookup), so seal the TransitionalScopeTree to
  // disk now and drop the resident scopes. The scopes are pinned from THREE
  // sides: (1) the model's frozen `scopeTree` — released by `seal()` nulling its
  // resident backing from the inside; (2) `input.preExtractedParsedFiles` (held
  // by the caller for its own post-run release) — released here since run.ts is
  // its last reader after extract; (3) this function's `parsedFiles` — replaced
  // by a scope-stripped copy that keeps only what emit reads (referenceSites /
  // filePath / localDefs). All three released → the heavy payload is collectible.
  let emitParsedFiles: readonly ParsedFile[] = parsedFiles;
  if (
    input.scopeIndexStorePath !== undefined &&
    parseTruthyEnv(process.env.GITNEXUS_DISK_SCOPE_INDEX) &&
    indexes.scopeTree instanceof TransitionalScopeTree
  ) {
    logHeapProbe('sr-seal-pre', `lang=${provider.language}`);
    indexes.scopeTree.seal(input.scopeIndexStorePath);
    emitParsedFiles = parsedFiles.map((p) => ({ ...p, scopes: [] }));
    parsedFiles.length = 0;
    if (preExtracted !== undefined) (preExtracted as Map<string, ParsedFile>).clear();
    forceGc();
    logHeapProbe('sr-seal-post', `lang=${provider.language}`);
  }

  // ── Phase 4: emit graph edges (LOAD-BEARING ORDER — see I1) ────────────
  input.onProgress?.('linking symbols', files.length, files.length);
  const handledSites = new Set<string>(preEmittedInheritanceSites);
  const receiverExtras = emitReceiverBoundCalls(
    graph,
    indexes,
    emitParsedFiles,
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
          emitParsedFiles,
          postHeritageNodeLookup,
          handledSites,
          readonlyModel,
        )
      : 0;
  const freeCallExtras = emitFreeCallFallback(
    graph,
    indexes,
    emitParsedFiles,
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

  // Language-specific supplementary edges (e.g. Vue template-derived
  // BINDS_EVENT_HANDLER / EMITS_EVENT / CALLS / ACCESSES edges).
  // Runs last so the full graph — including import edges — is visible.
  if (provider.emitPostResolutionEdges !== undefined) {
    provider.emitPostResolutionEdges(graph, emitParsedFiles, postHeritageNodeLookup, indexes, {
      fileContents: getFileContents(),
      resolutionConfig,
    });
  }

  // ── CFG/PDG emission (#2081 M1, opt-in via `--pdg`) ──────────────────────
  // Emit BasicBlock nodes + CFG edges from each ParsedFile's worker-built
  // `cfgSideChannel`, HERE — the last point inside scope-resolution where the
  // ParsedFiles are still loaded (`emitParsedFiles` carries the channel; the
  // disk store is cleared right after this orchestrator returns, see phase.ts).
  // A post-`mro` phase would read empty data (KTD1). Off by default ⇒ zero
  // BasicBlock/CFG nodes/edges and a byte-identical graph.
  // Accumulated M2 reaching-defs time (solve + dedup + REACHING_DEF emit),
  // reported as the PROF `pdg=` segment. It is a SUBSET of `emit=` — the M1
  // CFG emit and the M2 solve interleave per file, so a separate checkpoint
  // pair can't bracket them; without this accumulator the M2 cost would
  // silently disappear into `emit=` and field regressions would be invisible.
  let pdgMs = 0;
  if (input.pdg === true) {
    let cfgBlocks = 0;
    let cfgEdges = 0;
    let cfgDroppedEdges = 0;
    let rdEdges = 0;
    let rdDropped = 0;
    let rdFacts = 0;
    let rdTruncated = 0;
    for (const pf of emitParsedFiles) {
      const cfgs = pf.cfgSideChannel;
      // Defensive: cfgSideChannel is opaque (`unknown`) and crosses the cache /
      // durable store. A stale or wrong-shape value (e.g. a pre-SCHEMA_BUMP
      // shard that slipped the version gate) must skip emission, not throw a
      // TypeError mid-graph-build and abort scope-resolution for the language.
      if (!Array.isArray(cfgs) || cfgs.length === 0) continue;
      try {
        // Per-element emit-safety filter (mirrors the parsedfile-store
        // reviver's POLICY: valid elements in a mixed array still emit; junk
        // is warned and skipped). isEmitSafeCfg lives in cfg/emit.ts next to
        // the id templating it defends — see its doc for why anchor-field and
        // endpoint-membership checks are load-bearing. Runs INSIDE the try so
        // even a predicate-time throw (e.g. a hostile getter) is isolated.
        const wellFormed = (cfgs as readonly (FunctionCfg | undefined | null)[]).filter(
          isEmitSafeCfg,
        );
        if (wellFormed.length < cfgs.length) {
          logger.warn(
            `[cfg] ${pf.filePath}: skipped ${cfgs.length - wellFormed.length} malformed ` +
              `cfgSideChannel element(s) (bad shape, missing id-anchor fields, or edge ` +
              `endpoints matching no block) — CFG for those functions omitted`,
          );
        }
        if (wellFormed.length === 0) continue;
        const emitted = emitFileCfgs(
          graph,
          wellFormed,
          input.pdgMaxEdgesPerFunction ?? DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
          // Log cap-overflow drops UNCONDITIONALLY (not via input.onWarn, which is
          // gated behind the semantic-model validator and silent in production) so
          // the per-function edge cap never truncates the CFG silently (R6/KTD6).
          (message) => logger.warn(message),
        );
        cfgBlocks += emitted.blocks;
        cfgEdges += emitted.edges;
        cfgDroppedEdges += emitted.droppedEdges;

        // M2 (#2082 U4): reaching definitions over the same validated CFGs.
        // In-memory facts are computed per function and dropped after the
        // bounded (defBlock, useBlock, binding) projection is persisted —
        // M3 recomputes via the same pure solver in-phase (KTD8). Timing is
        // PROF-gated like every other checkpoint here (zero cost when off).
        const t0 = PROF ? performance.now() : 0;
        const rd = emitFileReachingDefs(
          graph,
          wellFormed,
          input.pdgMaxReachingDefEdgesPerFunction ??
            DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
          (message) => logger.warn(message), // unconditional — R7, both layers
        );
        if (PROF) pdgMs += performance.now() - t0;
        rdEdges += rd.edges;
        rdDropped += rd.droppedEdges;
        rdFacts += rd.facts;
        rdTruncated += rd.truncatedFunctions;
      } catch (err) {
        // Last-resort isolation, mirroring the worker-side per-file try/catch:
        // a shape the predicate misses must cost this one file's CFG, not
        // abort the language's whole scope-resolution pass mid-graph-build.
        // NOTE a mid-emit throw can leave this file's already-inserted
        // BasicBlock nodes in the graph (addNode is not transactional) —
        // orphaned but inert; the predicate keeps every JSON-representable
        // bad shape from reaching this path at all.
        logger.warn(
          `[cfg] ${pf.filePath}: CFG emission failed (${err instanceof Error ? err.message : String(err)}) — ` +
            `this file's CFG is partial or absent`,
        );
      }
    }
    if (cfgBlocks > 0) {
      logger.debug(
        `[scope-resolution] CFG emit (lang=${provider.language}): ` +
          `${cfgBlocks} BasicBlock nodes, ${cfgEdges} CFG edges` +
          (cfgDroppedEdges > 0 ? `, ${cfgDroppedEdges} edges dropped (per-function cap)` : '') +
          `; ${rdEdges} REACHING_DEF edges (${rdFacts} facts)` +
          (rdDropped > 0 ? `, ${rdDropped} REACHING_DEF edges dropped (per-function cap)` : '') +
          (rdTruncated > 0 ? `, ${rdTruncated} function(s) hit the fact limit` : ''),
      );
    }
  }

  if (PROF) {
    const tEnd = process.hrtime.bigint();
    const ns = (a: bigint, b: bigint): number => Number(b - a) / 1_000_000;
    logger.warn(
      `[scope-resolution prof] extract=${ns(tStart, tExtract).toFixed(0)}ms` +
        ` finalize=${ns(tExtract, tFinalize).toFixed(0)}ms` +
        ` propagate=${ns(tFinalize, tPropagate).toFixed(0)}ms` +
        ` resolve=${ns(tPropagate, tResolve).toFixed(0)}ms` +
        ` emit=${ns(tResolve, tEnd).toFixed(0)}ms` +
        // pdg ⊆ emit: the M2 reaching-defs share of the emit bucket (#2082 U4).
        (input.pdg === true ? ` pdg=${pdgMs.toFixed(0)}ms` : '') +
        ` total=${ns(tStart, tEnd).toFixed(0)}ms` +
        ` (${parsedFiles.length} files)`,
    );
  }

  logHeapProbe('sr-end', `lang=${provider.language} parsedFiles=${parsedFiles.length}`);

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
