/**
 * Shared Analysis Orchestrator
 *
 * Extracts the core analysis pipeline from the CLI analyze command into a
 * reusable function that can be called from both the CLI and a server-side
 * worker process.
 *
 * IMPORTANT: This module must NEVER call process.exit(). The caller (CLI
 * wrapper or server worker) is responsible for process lifecycle.
 */

import { detectGraphWriteCollapse, type GraphWriteCollapseVerdict } from './index-freshness.js';
import { PDG_EDGE_TYPES } from './lbug/pdg-emit-sink.js';
import path from 'path';
import fs from 'fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { retryRename } from '../storage/fs-atomic.js';
import { acquireIndexLock } from '../storage/index-lock.js';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
import {
  logUnresolvedReceiverFiles,
  summarizeUnresolvedReceivers,
} from './ingestion/scope-resolution/unresolved-receivers.js';
import { summarizeUndecidedSatisfaction } from './ingestion/scope-resolution/undecided-satisfaction.js';
import { summarizeScopeExtractionFailures } from './ingestion/scope-resolution/scope-extraction-failures.js';
import type { KnowledgeGraph } from './graph/types.js';
import { resetDegradedParseCounter } from './tree-sitter/safe-parse.js';
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  closeLbugBeforeExit,
  loadCachedEmbeddings,
  deleteNodesForFiles,
  nodeTablesWithRowsForFiles,
  snapshotDerivedRelsForFiles,
  restoreDerivedRels,
  ensureEmbeddingRowDmlSafe,
  ensureFtsRowDmlSafe,
  readIndexCatalogSnapshot,
  INDEX_CATALOG_UNREADABLE,
  deleteAllCommunitiesAndProcesses,
  deleteAllInterprocTaintPaths,
  deleteAllCallSummaries,
  deleteAllInjects,
  deleteAllAdvisedBy,
  deleteAllDestinations,
  deleteSpringAopEvidenceNodes,
  deleteSpringAutoConfigurationDeclarations,
  deleteSpringAutoConfigurationSyntheticClasses,
  queryImportersBatch,
  loadFTSExtension,
  wipeLbugDbFiles,
  LbugWipeError,
  DELETE_FILES_CHUNK_SIZE,
} from './lbug/lbug-adapter.js';
import {
  estimateBufferPool,
  setBufferPoolSizeHint,
  resolveNativeSafeStorageDir,
} from './lbug/lbug-config.js';
import { escapeCypherString } from './lbug/cypher-escape.js';
import { chunk } from '../lib/utils.js';
import {
  buildSearchIndexesOrDegrade,
  ftsFailureIsFatal,
  createSearchFTSIndexes,
  summarizeFtsIndexBuildFailures,
  dropSearchFTSIndexes,
  missingSearchFTSIndexTables,
  initialiseSearchFTSStemmer,
  verifySearchFTSIndexes,
} from './search/fts-indexes.js';
import {
  cjkSegmentationModeMismatch,
  getSearchFTSCjkSegmentation,
  initialiseSearchFTSCjkSegmentation,
} from './search/cjk-segmentation.js';
import {
  getExtensionCapability,
  getExtensionCapabilities,
  getFtsCapability,
  resolveAnalyzeInstallPolicy,
} from './lbug/extension-loader.js';
import { diagnoseExtensionLoad } from './lbug/extension-load-error.js';
import {
  startWalCheckpointDriver,
  checkpointOnce,
  type WalCheckpointDriver,
} from './lbug/wal-checkpoint-driver.js';
import {
  quarantineSidecarsForDirtyRecovery,
  inspectLbugSidecars,
} from './lbug/sidecar-recovery.js';
import type { EmbeddingIdentity } from './embeddings/embedding-identity.js';
// Type-only (erased at compile time), so the lazy-embeddings convention
// (#2370: no embeddings module loads unless a run actually needs one) holds.
import type { EmbeddingPipelineResult } from './embeddings/embedding-pipeline.js';
import {
  getStoragePaths,
  resolveBranchPlacement,
  saveMeta,
  loadMeta,
  ensureGitNexusIgnored,
  registerRepo,
  adoptFlatBranchLabel,
  isReadOnlyFilesystemError,
  isRepoRegistered,
  cleanupOldKuzuFiles,
  reconcileMetadataFiles,
  isMissingFilesystemError,
  INDEX_METADATA_FILE,
  type AnalyzerRunnerIdentity,
  type RepoMeta,
} from '../storage/repo-manager.js';
import { DEFAULT_PDG_MAX_FUNCTION_LINES } from './ingestion/cfg/collect.js';
import {
  DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
  DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
  DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION,
} from './ingestion/cfg/emit.js';
import {
  DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
  DEFAULT_PDG_MAX_TAINT_HOPS,
} from './ingestion/taint/propagate.js';
import {
  DEFAULT_MAX_INTERPROC_HOPS,
  DEFAULT_PDG_MAX_INTERPROC_FINDINGS,
} from './ingestion/taint/interproc-solver.js';
import { DEFAULT_PDG_MAX_INTERPROC_EDGES } from './ingestion/taint/interproc-emit.js';
import { taintModelVersion } from './ingestion/taint/typescript-model.js';
import { parseTruthyEnv, parsePositiveIntEnv } from './ingestion/utils/env.js';
import { computeFileHashes, diffFileHashes } from '../storage/file-hash.js';
import {
  extractChangedSubgraph,
  computeEffectiveWriteSet,
} from './incremental/subgraph-extract.js';
import {
  collectSpringConfigConsumerDriftFiles,
  type PersistedSpringConfigConsumerRow,
} from './incremental/spring-config-drift.js';
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import { shouldEscalateIncrementalWrite } from './incremental/escalation-gate.js';
import {
  ftsTablesAmong,
  incrementalFtsTablesFromGraph,
  nodeTablesForIncrementalDelete,
  shouldPreservePersistedDerivedGraph,
} from './incremental/derived-writeback.js';
import { NODE_TABLES } from './lbug/schema.js';
import {
  loadParseCache,
  saveParseCache,
  pruneCache,
  PARSE_CACHE_VERSION,
} from '../storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../storage/parsedfile-store.js';
import {
  getCurrentCommit,
  getCurrentBranch,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
  isWorkingTreeDirty,
  listWorkingTreeDirtyPaths,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import { isGitNexusManagedPath } from '../storage/gitnexus-managed-paths.js';
import { getMaxFileSizeBytes } from './ingestion/utils/max-file-size.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { sanitizeDetectedBranch } from '../cli/analyze-config.js';
import {
  EMBEDDING_TABLE_NAME,
  EMBEDDING_DIMS,
  STALE_HASH_SENTINEL,
  SCHEMA_FINGERPRINT,
  schemaFingerprintMismatch,
  isSchemaFingerprintShaped,
  embeddingDimsMismatch,
} from './lbug/schema.js';
import { isSpringBeanCandidateSourceFile } from './ingestion/frameworks/spring/bean-catalog.js';
import { isSpringBeanFactoryDeclaration } from './ingestion/frameworks/spring/bean-factories.js';
import { SPRING_CONFIG_UNRESOLVED_PREFIX } from './ingestion/frameworks/spring/config-bindings.js';
import { classifySpringConfigFile } from './ingestion/pipeline-phases/spring-config.js';
import {
  SPRING_AOP_FEATURE,
  SPRING_BEAN_INVENTORY_FEATURE,
  SPRING_CONDITIONALS_FEATURE,
  SPRING_NON_HTTP_HANDLERS_FEATURE,
} from './ingestion/frameworks/spring/analysis-features.js';
import {
  JAVA_ENUM_INTERFACE_HERITAGE_FEATURE,
  JAVA_RECORD_COMPONENT_ACCESSORS_FEATURE,
  SPRING_CONFIG_BINDINGS_FEATURE,
} from './ingestion/languages/java/analysis-features.js';
import {
  CLASS_FRAMEWORK_ANNOTATIONS_FEATURE,
  findAnalysisFeatureMismatches,
  resolveAnalysisFeatureVersions,
} from './analysis-features.js';
import {
  analyzerRunnerIdentitiesEqual,
  finalizeAnalyzerRunnerIdentity,
  resolveAnalyzerRunnerIdentity,
} from './analyzer-identity.js';
// Static, and deliberately so: `embedding-count.ts` and `embedding-checkpoint.ts`
// live outside `core/embeddings/` precisely because the lazy-embeddings
// convention (#2370 — no embeddings module loads unless a run needs one) must
// keep holding while this counter and the checkpoint rules run on the ORDINARY
// path of every analyze. Neither imports anything native.
import {
  measurePersistedEmbeddingCount,
  persistedEmbeddingCountOrUndefined,
  resolvePersistedEmbeddingCount,
} from './embedding-count.js';
import {
  EMBEDDING_RESUME_MAX_ATTEMPTS,
  decideEmbeddingResume,
  mintInterruptedCheckpoint,
  mintPartialCheckpoint,
  mintUnverifiedCountCheckpoint,
} from './embedding-checkpoint.js';
import type { EmbeddingCheckpoint } from './embedding-checkpoint.js';

/**
 * Strip C0/C1 control characters from a progress/diagnostic message.
 *
 * Several guard notices below interpolate values read straight out of
 * `.gitnexus/gitnexus.json`, which is parsed with no runtime shape validation
 * (`loadMeta` does a bare `JSON.parse(...) as RepoMeta`) — the stamped schema
 * fingerprint, the runner-identity schema, the CJK mode. On the CLI path these
 * reach `console.log` and therefore the user's terminal, so a crafted value
 * carrying ANSI escapes (`\x1b[2J`, `\x1b]0;…`) would be replayed verbatim.
 *
 * Sanitizing at the funnel rather than per field: every message that ever
 * interpolates untrusted metadata is covered, including ones not written yet.
 * Newline and tab are preserved — multi-line notices are intentional.
 */
const stripControlCharacters = (msg: string): string =>
  msg.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');

const ANALYSIS_FEATURES = [
  CLASS_FRAMEWORK_ANNOTATIONS_FEATURE,
  SPRING_AOP_FEATURE,
  SPRING_BEAN_INVENTORY_FEATURE,
  SPRING_CONDITIONALS_FEATURE,
  SPRING_NON_HTTP_HANDLERS_FEATURE,
  SPRING_CONFIG_BINDINGS_FEATURE,
  JAVA_ENUM_INTERFACE_HERITAGE_FEATURE,
  JAVA_RECORD_COMPONENT_ACCESSORS_FEATURE,
] as const;

interface PersistedFrameworkAnnotationRow {
  readonly id?: unknown;
  readonly frameworkAnnotations?: unknown;
}

interface PersistedSpringBeanDeclarationRow {
  readonly id?: unknown;
  readonly filePath?: unknown;
  readonly reason?: unknown;
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function collectFrameworkAnnotationDriftFiles(
  graph: KnowledgeGraph,
  persistedRows: readonly PersistedFrameworkAnnotationRow[],
): Set<string> {
  const persistedById = new Map<string, readonly string[]>();
  for (const row of persistedRows) {
    if (typeof row.id === 'string') {
      persistedById.set(row.id, stringList(row.frameworkAnnotations));
    }
  }

  const driftFiles = new Set<string>();
  graph.forEachNode((node) => {
    if (node.label !== 'Class') return;
    const current = stringList(node.properties.frameworkAnnotations);
    const persisted = persistedById.get(node.id) ?? [];
    if (
      current.length !== persisted.length ||
      current.some((annotation, index) => annotation !== persisted[index])
    ) {
      const filePath = node.properties.filePath;
      if (typeof filePath === 'string') driftFiles.add(filePath);
    }
  });
  return driftFiles;
}

function collectSpringBeanDeclarationDriftFiles(
  graph: KnowledgeGraph,
  persistedRows: readonly PersistedSpringBeanDeclarationRow[],
): Set<string> {
  const persisted = new Map<string, { readonly filePath: string; readonly reason: string }>();
  for (const row of persistedRows) {
    if (
      typeof row.id === 'string' &&
      typeof row.filePath === 'string' &&
      typeof row.reason === 'string' &&
      isSpringBeanFactoryDeclaration({ type: 'DECLARES', reason: row.reason })
    ) {
      persisted.set(row.id, { filePath: row.filePath, reason: row.reason });
    }
  }

  const current = new Map<string, { readonly filePath: string; readonly reason: string }>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== 'DECLARES') continue;
    if (!isSpringBeanFactoryDeclaration(relationship)) continue;
    const declaration = graph.getNode(relationship.targetId);
    if (declaration === undefined || typeof declaration.properties.filePath !== 'string') continue;
    current.set(declaration.id, {
      filePath: declaration.properties.filePath,
      reason: relationship.reason,
    });
  }

  const driftFiles = new Set<string>();
  for (const [id, value] of current) {
    const prior = persisted.get(id);
    if (prior === undefined || prior.reason !== value.reason) driftFiles.add(value.filePath);
  }
  for (const [id, value] of persisted) {
    if (!current.has(id)) driftFiles.add(value.filePath);
  }
  return driftFiles;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  onProgress: (phase: string, percent: number, message: string) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  /**
   * Force a full re-index of the pipeline. Callers may OR this with
   * other flags that imply re-analysis (e.g. `--skills`), so the value
   * here is the PIPELINE-force signal, NOT the registry-collision
   * bypass. See `allowDuplicateName` below.
   */
  force?: boolean;
  /** Repair only search indexes without re-running full parsing/indexing. */
  repairFts?: boolean;
  /** Emit per-index FTS create logs. */
  verbose?: boolean;
  embeddings?: boolean;
  /**
   * Override the auto-skip node-count cap for embedding generation.
   * `undefined` (default) keeps the built-in 50,000-node safety limit;
   * `0` disables the cap entirely; any positive integer sets a custom cap.
   * Mapped from the CLI's `--embeddings [limit]` argument.
   */
  embeddingsNodeLimit?: number;
  /**
   * Explicitly drop any embeddings present in the existing index instead of
   * preserving them. Only meaningful when `embeddings` is false/undefined:
   * the default behavior in that case is to load the previously generated
   * embeddings and re-insert them after the rebuild so a routine
   * re-analyze does not silently wipe a long embedding pass (#issue: analyze
   * silently wipes existing embeddings when run without --embeddings).
   */
  dropEmbeddings?: boolean;
  skipGit?: boolean;
  /** Skip AGENTS.md and CLAUDE.md gitnexus block updates. */
  skipAgentsMd?: boolean;
  /** Omit volatile symbol/relationship counts from AGENTS.md and CLAUDE.md. */
  noStats?: boolean;
  /** Skip installing standard GitNexus skill files directly under .claude/skills/. */
  skipSkills?: boolean;
  /**
   * Build the CFG/PDG substrate (#2081 M1). Forwarded to `PipelineOptions.pdg`,
   * which threads to BOTH the worker (CFG build, via workerData) AND
   * scope-resolution (BasicBlock/CFG emit gate). Off by default.
   */
  pdg?: boolean;
  /** Per-function source-line cap for worker-side CFG construction (#2081 M1).
   *  Forwarded to `PipelineOptions.pdgMaxFunctionLines`. No CLI flag in M1 —
   *  programmatic / server analyze-worker path only; the worker applies
   *  `DEFAULT_PDG_MAX_FUNCTION_LINES` when unset. */
  pdgMaxFunctionLines?: number;
  /** Per-function CFG edge cap. Forwarded to `PipelineOptions.pdgMaxEdgesPerFunction`. */
  pdgMaxEdgesPerFunction?: number;
  /** Per-function REACHING_DEF edge cap (#2082 M2). Forwarded to
   *  `PipelineOptions.pdgMaxReachingDefEdgesPerFunction`. */
  pdgMaxReachingDefEdgesPerFunction?: number;
  /** Per-function CDG edge cap (#2085 M5). Forwarded to
   *  `PipelineOptions.pdgMaxCdgEdgesPerFunction`. No CLI flag or rc key —
   *  programmatic / server path only, like the other pdg caps. */
  pdgMaxCdgEdgesPerFunction?: number;
  /** Per-function taint findings cap (#2083 M3). Forwarded to
   *  `PipelineOptions.pdgMaxTaintFindingsPerFunction`. No CLI flag or rc key
   *  (KTD8) — programmatic / server path only, like the other pdg caps. */
  pdgMaxTaintFindingsPerFunction?: number;
  /** Per-finding taint hop cap (#2083 M3, KTD6). Forwarded to
   *  `PipelineOptions.pdgMaxTaintHops`. No CLI flag or rc key (KTD8). */
  pdgMaxTaintHops?: number;
  /** Per-run cross-function findings/hops/edges caps (#2084 review P1-3).
   *  Forwarded to the matching `PipelineOptions.pdgMaxInterproc*`; resolved
   *  into `RepoMeta.pdg`. No CLI flag or rc key (KTD8). */
  pdgMaxInterprocFindings?: number;
  pdgMaxInterprocHops?: number;
  pdgMaxInterprocEdges?: number;
  /**
   * Stream the BasicBlock + intra-file PDG-edge layer to CSV-on-disk during the
   * emit loop instead of materializing it in the in-memory graph, bounding peak
   * RSS to O(chunk) for full-kernel-scale repos (#2202). Only engages on a full
   * rebuild — `resolveStreamPdgEmit` additionally requires `force === true`
   * (the pre-pipeline guarantee of a full rebuild). May also be enabled via
   * `GITNEXUS_STREAM_PDG_EMIT`. Memory-only; byte-identical output; not stamped
   * into `RepoMeta.pdg`. */
  streamPdgEmit?: boolean;
  /** Streamed PDG-emit write buffer (rows). `undefined` ⇒
   *  `DEFAULT_PDG_EMIT_CHUNK_ROWS`. May also be set via
   *  `GITNEXUS_PDG_EMIT_CHUNK_SIZE`. Memory-only (#2202). */
  pdgEmitChunkSize?: number;
  /** Streamed structural graph emit (#2680). Honored only on a full rebuild
   *  (`force === true`). May also be enabled via `GITNEXUS_STREAM_GRAPH_EMIT`.
   *  Trades community detection, process extraction and PDG taint summaries for
   *  a ~2.9x reduction of in-memory graph heap. */
  streamGraphEmit?: boolean;
  /**
   * Default branch threaded into generated AGENTS.md / CLAUDE.md so the
   * regression-compare example uses the configured branch instead of a
   * hardcoded "main" (#243). Resolved by the CLI; `undefined` here keeps the
   * "main" fallback for non-CLI callers (e.g. the server analyze worker).
   */
  defaultBranch?: string;
  /**
   * Index-branch selector (#2106, #2354). Distinct from `defaultBranch` (which
   * only affects generated AGENTS.md/CLAUDE.md base_ref text). When set, this
   * run is pinned to a per-branch index slot (`branches/<slug>/`) unless the
   * label matches the flat slot's recorded branch. When `undefined`, the run
   * always targets the flat workspace slot, which follows the checked-out
   * working tree; the auto-detected branch is only recorded as the slot's
   * informational label. Detached HEAD / non-git also map to the flat slot.
   */
  branch?: string;
  /**
   * User-provided alias for the registry `name` (#829). When set,
   * forwarded to `registerRepo` so the indexed repo is stored under
   * this alias instead of the path-derived basename.
   */
  registryName?: string;
  /**
   * Bypass the `RegistryNameCollisionError` guard and allow two paths
   * to register under the same `name` (#829). Controlled by the
   * dedicated `--allow-duplicate-name` CLI flag, intentionally
   * independent from `--force` — users who hit the collision guard
   * should be able to accept the duplicate without paying the cost
   * of a pipeline re-index.
   */
  allowDuplicateName?: boolean;
  /**
   * Worker pool size override, threaded from the CLI `--workers` flag.
   * Forwarded to `PipelineOptions.workerPoolSize` so the parse phase
   * sizes the pool without `analyzeCommand` mutating `process.env`.
   * Must be a positive integer — `0` hard-errors (sequential parsing was
   * removed); `undefined` defers to the env / auto-formula fallback.
   */
  workerPoolSize?: number;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers, forwarded to
   * `PipelineOptions.fetchWrappers` (#1589/#1852 residual). Sourced from the CLI
   * `.gitnexusrc` `fetchWrappers` list. `undefined`/empty leaves the route
   * consumer scan unchanged.
   */
  fetchWrappers?: string[];
  /**
   * Explicit local Spring Boot Actuator snapshot input (#2418), forwarded to
   * the Spring enrichment phase. Undefined keeps static-only analysis.
   */
  springActuatorPath?: string;
  /**
   * Explicit local AsyncAPI 3.x document input, forwarded to the destination
   * phase. Undefined keeps source-only address resolution.
   */
  asyncApiSpecPath?: string;
  /**
   * The caller will `process.exit()` immediately after this analyze returns (the
   * CLI `analyze` command). When set, the finalize/error close CHECKPOINTs for
   * durability but skips the native `conn.close()`/`db.close()`, which can
   * double-free in LadybugDB's `ClientContext` destructor after large `--pdg`
   * writes (gdb-confirmed) — aborting the process AFTER a fully-written index.
   * Process exit reclaims the handles. Long-lived callers (MCP server, tests)
   * leave this unset so they get a real close. See `closeLbug`. */
  skipNativeCloseOnExit?: boolean;
  /**
   * Stage an incremental write in a copy of the live index before publishing
   * it. Used by long-lived watch mode so a failed refresh leaves the previous
   * graph readable. Currently supported on POSIX, where an open DB can be
   * atomically renamed; Windows retains the established in-place path.
   */
  atomicIncremental?: boolean;
}

const liveIndexMutationRisks = new WeakSet<object>();

function recordLiveIndexMutationRisk(error: unknown): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    liveIndexMutationRisks.add(error);
  }
}

/** Whether a failed analyze may already have changed the live DB. */
export function analyzeFailureMayHaveMutatedLiveIndex(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    liveIndexMutationRisks.has(error)
  );
}

export interface AnalyzeResult {
  repoName: string;
  repoPath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /** The raw pipeline result — only populated when needed by callers (e.g. skill generation). */
  pipelineResult?: any;
  /** True when analyze only repaired FTS indexes and skipped pipeline re-analysis. */
  ftsRepairedOnly?: boolean;
  /**
   * True when the FTS extension was unavailable so search-index creation was
   * skipped (offline-first degradation). The graph is fully queryable; only
   * full-text/BM25 search is disabled. Lets callers (CLI summary, server) and
   * the persisted meta surface the degraded state instead of reporting healthy.
   */
  /**
   * Set when the post-write integrity check found far fewer relationships in
   * the DB than the pipeline produced. Surfaced on the RESULT, not only in
   * metadata, because the CLI and the analyze worker both report completion
   * from this object — and a run whose edges are mostly gone must not be able
   * to print "indexed successfully" and exit 0.
   */
  graphWriteCollapsed?: { expected: number; persisted: number };
  ftsSkipped?: boolean;
  /**
   * Why FTS was skipped, when `ftsSkipped` is true (#2658 review L2):
   * `extension-unavailable` (the LadybugDB FTS extension could not load — the
   * offline-first case, remedied by installing it) vs `build-failed` (the
   * extension loaded but the index build/verify failed non-fatally — remedied by
   * `--repair-fts`, not by installing the extension). Lets the CLI show the
   * correct recovery hint instead of always blaming a missing extension.
   */
  ftsSkipReason?: 'extension-unavailable' | 'build-failed';
  /**
   * True when the index this run produced/validated is the flat workspace
   * slot (#2106 R2, inverted by #2354 to follow the checked-out branch).
   * `false` for a pinned `--branch` sub-index. Lets the CLI skip repo-root
   * AGENTS.md/CLAUDE.md refreshes (e.g. the base_ref fast-path) for a pinned
   * branch analyze, mirroring the in-pipeline `if (!placement.branch)` gate.
   * (The historical "primary" name is kept — it is public API surface.)
   */
  isPrimaryBranch?: boolean;
  /** Measured work performed by a successful incremental refresh. */
  incrementalStats?: {
    changedFiles: number;
    reparsedFiles: number;
    affectedDependents: number;
    deletedFiles: number;
    writeMode: 'incremental' | 'full';
  };
}

/**
 * Logged when the optional FTS extension cannot be loaded or installed during
 * a full analyze. Kept as a named constant so the env-var/command guidance
 * stays in one place (mirrors the VECTOR message in embedding-pipeline.ts).
 */
// Class-neutral lead, reused for the missing-dependency degrade path (#2383 F2):
// its remedy already explains that reinstalling will NOT help, so appending the
// generic "install with network access" tail below would contradict it.
const FTS_UNAVAILABLE_LEAD = 'FTS extension unavailable; skipping search-index creation.';
const FTS_UNAVAILABLE_MESSAGE =
  `${FTS_UNAVAILABLE_LEAD} ` +
  'Full-text/BM25 search will be disabled until the LadybugDB FTS extension is ' +
  'installed once with network access (GITNEXUS_LBUG_EXTENSION_INSTALL=auto) or ' +
  'pre-installed for offline use. Run `gitnexus doctor` for details.';

// Re-export the pure flag-derivation helper so external callers (and tests)
// keep importing from this module's stable surface.
export { deriveEmbeddingMode, DEFAULT_EMBEDDING_NODE_LIMIT } from './embedding-mode.js';
export type { EmbeddingMode } from './embedding-mode.js';
import {
  deriveEmbeddingMode as _deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from './embedding-mode.js';
import type { GraphEmitManifest } from './lbug/graph-emit-sink.js';

/**
 * Relationships RESIDENT in the in-memory graph, excluding the PDG layers —
 * the heap-side counterpart of the sink's `structuralRows` subtotal and of
 * `getLbugStats().structuralEdges`, counted by the same `PDG_EDGE_TYPES`
 * predicate so all three measure one population.
 *
 * A type-aware scan rather than `graph.relationshipCount`, because that count is
 * PDG-INCLUSIVE on every run that does not stream. `resolveStreamPdgEmit` and
 * `resolveStreamGraphEmit` BOTH require `force === true`, so with no `--force`
 * there is no sink at all and `scope-resolution/pipeline/run.ts` writes the PDG
 * layers into the ordinary graph (`input.pdgEmitSink ?? graph`). Measured
 * directly: one `runScopeResolution({ pdg: true })` with no sink leaves
 * `relationshipCount = 1`, all of it `CFG`. A first-time `analyze --pdg` on a
 * fresh repo is a FULL write (so the collapse check runs) and a non-streaming
 * one, so `relationshipCount` there compares structural-plus-PDG against a
 * structural-only measurement — the same false collapse the streamed path
 * already fixed, on the default configuration rather than the `--force` one.
 *
 * `forEachRelationshipFields` is the zero-allocation columnar scan (~90 ms per
 * million edges) and `pipelineResult.graph` is always the RAW graph, never the
 * sink, so this never has to recall an offloaded edge.
 *
 * `NaN` when the graph cannot be scanned at all, which is the SAME fact the
 * previous `graph.relationshipCount` read produced for such a graph (`undefined
 * + streamedRows`), and which `detectGraphWriteCollapse` maps to an explicit
 * `'unmeasurable'`. Its docstring already names "a graph implementation that
 * reports no total, a lightweight pipeline result" as an expected input, so
 * calling an absent method here would convert a documented no-verdict into a
 * crashed analyze.
 */
export function countStructuralRelationships(
  graph: Partial<Pick<KnowledgeGraph, 'forEachRelationshipFields'>> | undefined,
): number {
  if (typeof graph?.forEachRelationshipFields !== 'function') return Number.NaN;
  let structural = 0;
  graph.forEachRelationshipFields((_sourceId, _targetId, type) => {
    if (!PDG_EDGE_TYPES.has(type)) structural++;
  });
  return structural;
}

/**
 * The STRUCTURAL relationship count a healthy write is expected to persist.
 *
 * Exported and called by production rather than mirrored in a test. That is the
 * point: the wiring test kept a LOCAL COPY of this expression "because the
 * production expression is inline in a 3000-line function", and a copy cannot
 * catch a term the original got wrong. It did not catch this one.
 *
 * BOTH terms are objects, not pre-selected numbers, and for the same reason:
 * every defect this expression has had was a wrong FIELD chosen at a call site
 * no unit test can reach — first `totalRows` over `structuralRows`, then
 * `relationshipCount` over the structural subtotal. Taking the graph and the
 * manifest puts both choices inside the tested function.
 */
export function computeExpectedStructuralRelationships(
  /**
   * The in-memory graph, NOT its `relationshipCount`. That count includes the
   * PDG layers whenever they did not stream — which is every run without
   * `--force`, i.e. the default configuration. A graph that cannot be scanned
   * yields `NaN`, i.e. an explicit no-verdict, exactly as an absent
   * `relationshipCount` did.
   */
  graph: Partial<Pick<KnowledgeGraph, 'forEachRelationshipFields'>> | undefined,
  /**
   * The MANIFEST, not a pre-selected number. Taking the whole object puts the
   * `structuralRows` / `totalRows` choice INSIDE the tested function — the
   * choice that was wrong before, and that a numeric parameter leaves at an
   * untestable call site.
   */
  graphEmitManifest: Pick<GraphEmitManifest, 'structuralRows' | 'totalRows'> | undefined,
): number {
  return countStructuralRelationships(graph) + (graphEmitManifest?.structuralRows ?? 0);
}

/**
 * Which `graphWriteCollapsed` stamp a finished run should PERSIST.
 *
 * Split on the VERDICT, never on the write mode. `saveMeta` overwrites
 * meta.json atomically rather than merging, so returning `undefined` DELETES
 * the stamp — and the stamp is what marks the index incomplete and forces the
 * rebuild that repairs it. Only a positive `'healthy'` measurement earns that
 * deletion; `'unmeasurable'` means this run compared nothing, and a run that
 * measured nothing has repaired nothing.
 *
 * Exported and called by production for the same reason
 * {@link computeExpectedStructuralRelationships} is: the previous version of
 * this decision lived inline in a 3000-line function, where no unit test could
 * reach it, and it shipped implementing a documented three-way taxonomy as a
 * two-way branch on `wroteChangedSubgraphOnly`.
 */
export function selectPersistedCollapseStamp(
  verdict: GraphWriteCollapseVerdict,
  /** The stamp already on disk. Survives every non-`'healthy'` verdict. */
  previousStamp: RepoMeta['graphWriteCollapsed'],
): RepoMeta['graphWriteCollapsed'] {
  switch (verdict.verdict) {
    case 'collapsed':
      return { expected: verdict.expected, persisted: verdict.persisted };
    case 'healthy':
      return undefined;
    case 'unmeasurable':
      return previousStamp;
  }
}

export const PHASE_LABELS: Record<string, string> = {
  extracting: 'Scanning files',
  structure: 'Building structure',
  parsing: 'Parsing code',
  imports: 'Resolving imports',
  calls: 'Tracing calls',
  heritage: 'Extracting inheritance',
  scopeResolution: 'Resolving types',
  communities: 'Detecting communities',
  processes: 'Detecting processes',
  complete: 'Pipeline complete',
  lbug: 'Loading into LadybugDB',
  fts: 'Creating search indexes',
  embeddings: 'Generating embeddings',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full GitNexus analysis pipeline.
 *
 * This is the shared core extracted from the CLI `analyze` command. It
 * handles: pipeline execution, LadybugDB loading, FTS indexing, embedding
 * generation, metadata persistence, and AI context file generation.
 *
 * The function communicates progress and log messages exclusively through
 * the {@link AnalyzeCallbacks} interface — it never writes to stdout/stderr
 * directly and never calls `process.exit()`.
 */
/**
 * Collect the recorded parse-cache chunk keys across the flat + every branch
 * metadata directory under a flat `.gitnexus` storage, EXCLUDING `excludeDir`
 * (the current run's own meta dir) so a single-branch repo collects nothing and
 * its prune stays byte-identical to today (#2106 R6 — the byte-identity claim
 * is about the PRUNE result; the metadata FILENAME read here changed with
 * PR #2363's rename, checking `gitnexus.json` first then the legacy
 * `meta.json` mirror). `complete` is false when a sibling metadata file exists
 * but fails to read or parse — callers then retain the whole shared cache
 * rather than over-evict another branch's still-live shards. Exported for
 * testing.
 */
export const collectBranchCacheKeys = async (
  storagePath: string,
  excludeDir?: string,
): Promise<{ keys: Set<string>; complete: boolean }> => {
  const keys = new Set<string>();
  let complete = true;
  const metaDirs = [storagePath];
  const branchesDir = path.join(storagePath, 'branches');
  const slugs = await fs.readdir(branchesDir).catch(() => [] as string[]);
  for (const slug of slugs) metaDirs.push(path.join(branchesDir, slug));
  for (const dir of metaDirs) {
    if (excludeDir && path.resolve(dir) === path.resolve(excludeDir)) continue;
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, INDEX_METADATA_FILE), 'utf-8');
    } catch (newErr) {
      if (!isMissingFilesystemError(newErr)) {
        complete = false;
        continue;
      }
      try {
        raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf-8');
      } catch (legacyErr) {
        if (!isMissingFilesystemError(legacyErr)) complete = false;
        continue; // no metadata here — not a branch index, not a failure
      }
    }
    try {
      const parsed = JSON.parse(raw) as { cacheKeys?: unknown };
      if (Array.isArray(parsed.cacheKeys)) {
        for (const k of parsed.cacheKeys) if (typeof k === 'string') keys.add(k);
      }
    } catch {
      complete = false; // present but corrupt → fail-safe toward retention
    }
  }
  return { keys, complete };
};

/**
 * Resolve the requested `--pdg` configuration to the shape recorded in
 * `RepoMeta.pdg`, or `undefined` for a pdg-off run. Caps resolve to their
 * defaults so an explicit-default run compares equal to a default run
 * (`0` = unlimited is preserved as `0`). Pure + exported for testing.
 */
type PdgOptions = Pick<
  AnalyzeOptions,
  | 'pdg'
  | 'pdgMaxFunctionLines'
  | 'pdgMaxEdgesPerFunction'
  | 'pdgMaxReachingDefEdgesPerFunction'
  | 'pdgMaxCdgEdgesPerFunction'
  | 'pdgMaxTaintFindingsPerFunction'
  | 'pdgMaxTaintHops'
  | 'pdgMaxInterprocFindings'
  | 'pdgMaxInterprocHops'
  | 'pdgMaxInterprocEdges'
>;

export const resolvePdgConfig = (options: PdgOptions): RepoMeta['pdg'] =>
  options.pdg === true
    ? {
        maxFunctionLines: options.pdgMaxFunctionLines ?? DEFAULT_PDG_MAX_FUNCTION_LINES,
        maxEdgesPerFunction: options.pdgMaxEdgesPerFunction ?? DEFAULT_MAX_CFG_EDGES_PER_FUNCTION,
        maxReachingDefEdgesPerFunction:
          options.pdgMaxReachingDefEdgesPerFunction ??
          DEFAULT_PDG_MAX_REACHING_DEF_EDGES_PER_FUNCTION,
        // #2085 M5: control-dependence cap. Absent on any pre-M5 (M2/M3/M4-era)
        // stamp → the key-union pdgModeMismatch trips the first CDG-aware run
        // over an existing `--pdg` index and forces the full writeback that
        // materialises CDG edges for every file without `--force`.
        maxCdgEdgesPerFunction:
          options.pdgMaxCdgEdgesPerFunction ?? DEFAULT_PDG_MAX_CDG_EDGES_PER_FUNCTION,
        // #2083 M3: taint caps + model identity. The key-union comparator in
        // pdgModeMismatch picks these up structurally — an M2-era stamp lacks
        // all three, so the first M3 run over an M2 `--pdg` index trips a full
        // writeback that populates TAINTED/SANITIZES rows without `--force`.
        maxTaintFindingsPerFunction:
          options.pdgMaxTaintFindingsPerFunction ?? DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
        maxTaintHops: options.pdgMaxTaintHops ?? DEFAULT_PDG_MAX_TAINT_HOPS,
        // #2084 review P1-3: cross-function caps. Absent on an M3-era stamp →
        // pdgModeMismatch trips the first run that adds them (key-union),
        // forcing the full writeback that re-materialises TAINT_PATH bounded.
        maxInterprocFindings: options.pdgMaxInterprocFindings ?? DEFAULT_PDG_MAX_INTERPROC_FINDINGS,
        maxInterprocHops: options.pdgMaxInterprocHops ?? DEFAULT_MAX_INTERPROC_HOPS,
        maxInterprocEdges: options.pdgMaxInterprocEdges ?? DEFAULT_PDG_MAX_INTERPROC_EDGES,
        // Built-in model digest (KTD7/R7): persisted findings must never
        // outlive the model that produced them — ANY model-content change
        // ships as a new digest and repopulates the taint edges.
        taintModelVersion,
        // #2201 review R3: reaching-defs solver identity. The SSA-sparse rewrite
        // computes full facts for deep-loop functions the dense worklist used to
        // truncate to empty, so an existing `--pdg` index carries stale-truncated
        // REACHING_DEF rows. Absent on any pre-#2201 stamp → the key-union
        // pdgModeMismatch trips on the first upgraded run and forces the full
        // writeback that recomputes the fuller coverage (no `--force` needed).
        // Bump this tag on any future change to which facts the solver emits.
        reachingDefSolver: 'ssa-sparse-v1',
        // PDG FU-C: this run records CALL_SUMMARY return-value-ascent edges.
        // Absent on any pre-FU-C (v3) stamp → the key-union pdgModeMismatch trips
        // the first FU-C-aware run over an existing `--pdg` index and forces the
        // full writeback that materialises CALL_SUMMARY edges without `--force`;
        // and `impact`'s PDG mode reads its absence to note "no return-value
        // ascent (re-index for CALL_SUMMARY)" on a v3 index (intra slice intact).
        hasCallSummary: true,
      }
    : undefined;

/**
 * Whether streaming/chunked PDG graph emit (#2202) engages this run.
 *
 * Streaming flushes the BasicBlock + intra-file PDG-edge layer to CSV-on-disk
 * during the emit loop and never lands it in the in-memory graph, bounding peak
 * RSS to O(chunk). It is sound ONLY on a full rebuild: the incremental
 * writeback (`extractChangedSubgraph`) reads BasicBlock nodes back out of the
 * in-memory graph, which streaming has already offloaded. `force === true` is
 * the pre-pipeline guarantee of a full rebuild — `isIncremental` has
 * `!force` as a necessary condition — so gating on it avoids the deliberately
 * absent pre-pipeline incremental prediction (see the `isIncremental` note).
 *
 * Requires `pdg === true` (nothing to stream otherwise). Enabled by either the
 * explicit `streamPdgEmit` option or the `GITNEXUS_STREAM_PDG_EMIT` env toggle.
 * Memory-only — NOT part of {@link resolvePdgConfig}, so toggling it never
 * trips `pdgModeMismatch`. Read every call (not memoized) so `vi.stubEnv`
 * works in tests. Pure + exported for testing.
 */
export const resolveStreamPdgEmit = (options: {
  pdg?: boolean;
  force?: boolean;
  streamPdgEmit?: boolean;
}): boolean =>
  options.pdg === true &&
  options.force === true &&
  (options.streamPdgEmit === true || parseTruthyEnv(process.env.GITNEXUS_STREAM_PDG_EMIT));

/**
 * Resolve whether streamed structural graph emit is on for this run (#2680).
 *
 * **On by default.** It costs nothing observable: the sink answers a complete
 * relationship read, so community detection, process extraction, the taint
 * fixpoint and the local-symbol pruner all behave exactly as they do without it
 * — the edges simply live in columns and on disk instead of as objects. There is
 * no reason to make a user opt in to using less memory.
 *
 * Two conditions still bound it:
 *
 * - `force === true`. Sound only on a full rebuild, because the incremental
 *   writeback (`extractChangedSubgraph`) reads relationships back out of the
 *   in-memory graph. Same gate, and same reason, as {@link resolveStreamPdgEmit}.
 * - `GITNEXUS_STREAM_GRAPH_EMIT=0` (or an explicit `streamGraphEmit: false`)
 *   turns it off. The escape hatch exists for bisecting a suspected
 *   streaming-related fault, not as a routine choice.
 *
 * Memory-only: not part of {@link resolvePdgConfig}, so toggling never trips
 * `pdgModeMismatch`. Read every call (not memoized) so `vi.stubEnv` works.
 */
export const resolveStreamGraphEmit = (options: {
  force?: boolean;
  streamGraphEmit?: boolean;
}): boolean => {
  if (options.force !== true) return false;
  if (options.streamGraphEmit !== undefined) return options.streamGraphEmit;
  // Unset ⇒ on. Set ⇒ honour it, so `=0` / `=false` is the escape hatch.
  const raw = process.env.GITNEXUS_STREAM_GRAPH_EMIT;
  return raw === undefined || raw === '' ? true : parseTruthyEnv(raw);
};

/**
 * Resolve the streamed PDG-emit write-buffer size (#2202). Explicit option wins
 * over `GITNEXUS_PDG_EMIT_CHUNK_SIZE`; `undefined` ⇒ the sink's
 * `DEFAULT_PDG_EMIT_CHUNK_ROWS`. Memory-only; does not affect emitted bytes.
 */
export const resolvePdgEmitChunkSize = (options: {
  pdgEmitChunkSize?: number;
}): number | undefined => {
  // Only honor a positive-integer explicit option; `0`/negative is NOT nullish
  // so `?? env` would pass it through and make the sink flush every row.
  const opt = options.pdgEmitChunkSize;
  if (opt !== undefined && Number.isInteger(opt) && opt > 0) return opt;
  return parsePositiveIntEnv(process.env.GITNEXUS_PDG_EMIT_CHUNK_SIZE);
};

/**
 * Whether the requested `--pdg` configuration differs from the one the
 * existing index's DB rows were built under (#2099 F1). An absent recorded
 * stamp means pdg-off (every legacy meta — `--pdg` shipped opt-in). Any
 * mismatch means the incremental writeback (which only persists changed-file
 * nodes) cannot produce a coherent index: off→on would silently drop the
 * freshly built CFG layer, on→off would strand zombie BasicBlocks — so the
 * caller forces a full writeback. Pure + exported for testing.
 */
export const pdgModeMismatch = (recorded: RepoMeta['pdg'], options: PdgOptions): boolean => {
  const requested = resolvePdgConfig(options);
  if (!requested && !recorded) return false;
  if (!requested || !recorded) return true;
  // Structural comparison over the KEY UNION of both resolved records — not a
  // hand-maintained field list. Both sides come fully resolved from
  // resolvePdgConfig, so any new emit-affecting knob added there joins the
  // comparison automatically (M1's hand-extended comparator was the trap this
  // closes: a knob it missed would silently strand a stale projection). It is
  // also what makes the M1→M2 upgrade work with zero extra code: an M1-era
  // stamp lacks maxReachingDefEdgesPerFunction, so `4000 !== undefined` trips
  // a full writeback that populates REACHING_DEF rows without `--force`.
  const reqRecord = requested as Record<string, unknown>;
  const recRecord = recorded as Record<string, unknown>;
  // INVARIANT: every value stamped by resolvePdgConfig MUST be a SCALAR (string /
  // number / boolean). This comparison is a shallow `!==`, so an OBJECT or ARRAY
  // value would compare by REFERENCE — two structurally-equal values from
  // different runs would always be `!==`, tripping pdgModeMismatch on every
  // re-analyze and forcing a needless full writeback. e.g. do NOT change
  // `hasCallSummary: true` to a per-language object like `{ ts: true, ... }`; keep
  // any diagnostic refinement in the impact CONSUMER (see pdg-impact.ts
  // assemblePdgImpactResult, which reports empty ascent from the persisted
  // CALL_SUMMARY data), not in this version discriminator.
  for (const key of new Set([...Object.keys(reqRecord), ...Object.keys(recRecord)])) {
    if (reqRecord[key] !== recRecord[key]) return true;
  }
  return false;
};

/**
 * The storage paths + resolved branch placement a run will write to. Computed
 * once, up front, so the `runFullAnalysis` wrapper can lock the ACTUAL write
 * directory (#2658). `metaDir` — not `getStoragePaths(repoPath, options.branch)`
 * — is the lock scope: a `--branch X` that owns the flat slot resolves to the
 * flat `.gitnexus`, so scoping off the raw option would lock the wrong dir.
 */
interface WriteTarget {
  storagePath: string;
  repoHasGit: boolean;
  currentCommit: string;
  checkedOutBranch: string | null;
  branchLabel: string | null;
  placement: { branch?: string };
  lbugPath: string;
  metaPath: string;
  metaDir: string;
}

/**
 * Resolve which storage slot this analyze writes to, including branch
 * placement (#2106/#2354). Extracted from the top of the pipeline so the lock
 * scope (`metaDir`) is known before the lock is acquired. Throws the same
 * `--branch` / checked-out mismatch error the pipeline used to throw inline, so
 * that failure still surfaces before any lock is taken.
 */
async function resolveWriteTarget(repoPath: string, options: AnalyzeOptions): Promise<WriteTarget> {
  // `storagePath` is ALWAYS the flat `.gitnexus` — content-addressed caches
  // (parse-cache, parsedfile-store) and kuzu-migration cleanup live there and
  // are shared across branches (#2106 KTD7).
  const { storagePath } = getStoragePaths(repoPath);
  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  // Normalize the auto-detected branch the same way an explicit `--branch` is
  // validated (#2106 R1): a git ref the branch-name rules forbid becomes `null`
  // → the flat slot, matching that a later `--branch <that-ref>` query would
  // also be rejected. A normal ref round-trips index-time/query-time labels.
  const checkedOutBranch = repoHasGit
    ? (sanitizeDetectedBranch(getCurrentBranch(repoPath)) ?? null)
    : null;
  // Analyze indexes the working tree, not an arbitrary ref. An explicit
  // `--branch X` while a DIFFERENT branch Y is checked out would write Y's
  // content into X's slot, corrupting X (#2106). Refuse the mismatch. Detached
  // HEAD / non-git (checkedOutBranch === null) still allow an explicit label.
  if (options.branch && checkedOutBranch && options.branch !== checkedOutBranch) {
    throw new Error(
      `--branch "${options.branch}" does not match the checked-out branch "${checkedOutBranch}". ` +
        `Check out "${options.branch}" before indexing it, or omit --branch to index the current branch.`,
    );
  }
  const branchLabel = options.branch ?? checkedOutBranch;
  const placement = options.branch ? await resolveBranchPlacement(repoPath, branchLabel) : {};
  const { lbugPath, metaPath } = getStoragePaths(repoPath, placement.branch);
  return {
    storagePath,
    repoHasGit,
    currentCommit,
    checkedOutBranch,
    branchLabel,
    placement,
    lbugPath,
    metaPath,
    metaDir: path.dirname(metaPath),
  };
}

/**
 * Run the full analysis under an exclusive, index-directory-scoped write lock
 * (#2658). A second concurrent `analyze` on the same slot waits here for the
 * first to finish, then falls through to the normal freshness check inside —
 * so a run whose work the holder already did returns `alreadyUpToDate` in
 * seconds instead of rebuilding (single-flight coalescing), while a run for a
 * genuinely-changed tree does one follow-up incremental. No new flag: waiting
 * is the default, which is what hook-driven re-index wants.
 *
 * The lock is held by whichever process runs the pipeline (the heap-respawn
 * child, or the original) — see index-lock.ts for why ownership lives with the
 * writer, not a supervising parent. Released as soon as the write completes or
 * throws; the post-analysis steps in the CLI (skills, registry) run lock-free.
 */
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  runnerIdentityAtBootstrap?: AnalyzerRunnerIdentity,
): Promise<AnalyzeResult> {
  // Validate operator-provided FTS config before anything else — a typo fails
  // here in ms, without taking the lock. (createSearchFTSIndexes reuses the
  // cached value via getSearchFTSStemmer.)
  initialiseSearchFTSStemmer();
  initialiseSearchFTSCjkSegmentation();
  // Scope the degraded-parse log throttle to this run (module-level counter
  // would otherwise stay saturated on a reused process).
  resetDegradedParseCounter();

  const log = (msg: string) => callbacks.onLog?.(stripControlCharacters(msg));
  const acquireOpts = {
    log,
    onWaitStart: () =>
      callbacks.onProgress('lock', 0, 'Waiting for another analyze to finish on this index…'),
  };

  let writeTarget = await resolveWriteTarget(repoPath, options);
  let lock = await acquireIndexLock(writeTarget.metaDir, acquireOpts);
  try {
    // #2658 review H2: acquireIndexLock can wait up to the timeout ceiling,
    // during which git HEAD/branch — and thus the resolved write slot — may
    // change (a commit lands, a branch is switched, or another writer adopts the
    // flat slot). The pre-wait snapshot must NOT be reused: re-resolve UNDER the
    // lock so the freshness check (`existingMeta.lastCommit === currentCommit`)
    // and the meta stamps see current git state, honoring the module's "re-check
    // freshness after acquiring" contract. If the slot itself moved we hold the
    // WRONG lock — release and re-acquire the correct one. Bounded so a
    // pathologically churning checkout can't loop forever; after the cap we
    // proceed on the current lock. The loop is INSIDE the try so a re-resolve
    // that throws (e.g. a `--branch` that stopped matching the now-switched
    // checkout) still releases the held lock via `finally` (no leak).
    const MAX_RELOCK = 3;
    for (let attempt = 0; attempt < MAX_RELOCK; attempt++) {
      const fresh = await resolveWriteTarget(repoPath, options);
      if (fresh.metaDir === writeTarget.metaDir) {
        writeTarget = fresh; // same slot — adopt the freshly-read commit/branch/placement
        break;
      }
      log(
        `Index write target moved while waiting for the lock ` +
          `(${writeTarget.metaDir} → ${fresh.metaDir}); re-acquiring the correct slot.`,
      );
      lock.release();
      writeTarget = fresh;
      lock = await acquireIndexLock(fresh.metaDir, acquireOpts);
      if (attempt === MAX_RELOCK - 1) {
        log('Index write target still moving after repeated re-acquire; proceeding on this lock.');
      }
    }
    return await runFullAnalysisInner(
      repoPath,
      options,
      callbacks,
      writeTarget,
      runnerIdentityAtBootstrap,
    );
  } finally {
    lock.release();
  }
}

async function runFullAnalysisInner(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  writeTarget: WriteTarget,
  runnerIdentityAtBootstrap?: AnalyzerRunnerIdentity,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(stripControlCharacters(msg));
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  // FTS-config validation and the degraded-parse counter reset happen in the
  // `runFullAnalysis` wrapper (before the lock is taken).

  // Write target (storage paths + resolved branch placement) was computed by
  // the `runFullAnalysis` wrapper — which needs `metaDir` up front to acquire
  // the exclusive index lock BEFORE any of the freshness/write work below
  // (#2658). `storagePath` is ALWAYS the flat `.gitnexus`; `placement.branch`
  // selects a `branches/<slug>/` sub-slot only for an explicit `--branch` that
  // does not own the flat slot. See resolveWriteTarget for the full contract.
  const { storagePath, repoHasGit, currentCommit, branchLabel, placement, lbugPath, metaDir } =
    writeTarget;

  // Start each analyze with a clean buffer-pool hint: any pre-pipeline DB open
  // (e.g. the embeddings-cache open) falls back to the default until the hint is
  // set from the built graph below, so a prior run's size can't leak in.
  setBufferPoolSizeHint(undefined);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  // Keep gitnexus.json and the legacy meta.json mirror in sync (fresher
  // indexedAt wins; nothing is deleted). Best-effort: loadMeta has its own
  // legacy fallback, so a reconciliation failure (read-only mount, full disk)
  // must never abort the analyze run — a repo that indexed fine read-only
  // before the rename must keep doing so.
  try {
    await reconcileMetadataFiles(repoPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    log(`Metadata reconciliation failed (non-critical${code ? `, ${code}` : ''}); continuing.`);
  }

  const existingMeta = await loadMeta(metaDir);

  // ── FTS-only repair path ────────────────────────────────────────────
  if (options.repairFts) {
    if (!existingMeta) {
      throw new Error(
        'Cannot repair FTS indexes because this repository has not been analyzed yet. ' +
          'Run `gitnexus analyze` first to create the initial index, then retry `--repair-fts`.',
      );
    }
    if (existingMeta.incrementalInProgress) {
      // #2409 / tri-review 4669518496 (R6): a dirty flag means the previous
      // run died mid-writeback — the graph may be half-written and its WAL
      // possibly poisoned. This branch returns early, so the dirty-recovery
      // sidecar quarantine below would never run: repairing FTS now would
      // open the DB and replay that WAL pre-quarantine, and even a
      // survivable open would certify FTS over a half-written graph.
      throw new Error(
        'Cannot repair FTS indexes: the index is mid-incremental-recovery ' +
          '(a previous analyze run did not complete cleanly). ' +
          'Run `gitnexus analyze` first — it recovers the index automatically — ' +
          'then retry `--repair-fts`.',
      );
    }
    let lbugStat;
    try {
      lbugStat = await fs.lstat(lbugPath);
    } catch {
      throw new Error(
        `Cannot repair FTS indexes: graph store at ${lbugPath} is missing. ` +
          'Run `gitnexus analyze` (full) to rebuild from scratch.',
      );
    }
    if (!lbugStat.isFile()) {
      const foundType = lbugStat.isDirectory()
        ? 'a directory'
        : lbugStat.isSymbolicLink()
          ? 'a symbolic link'
          : lbugStat.isSocket()
            ? 'a socket'
            : lbugStat.isBlockDevice()
              ? 'a block device'
              : lbugStat.isCharacterDevice()
                ? 'a character device'
                : lbugStat.isFIFO()
                  ? 'a FIFO'
                  : 'not a regular file';
      throw new Error(
        `Cannot repair FTS indexes: graph store at ${lbugPath} is ${foundType} (expected a file). ` +
          'Run `gitnexus analyze` (full) to rebuild from scratch.',
      );
    }
    try {
      await initLbug(lbugPath);
      // Gate on FTS availability BEFORE touching any index. createSearchFTSIndexes
      // now DROPs each index before recreating it (so schema changes reach existing
      // DBs); if the extension were unavailable, the drops would run and leave the
      // DB index-less, only failing at the create step. Fail loudly first — mirrors
      // the analyze path's `if (ftsAvailable)` gate below — so an unavailable
      // extension never destroys the existing indexes.
      const repairFtsAvailable = await loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (!repairFtsAvailable) {
        // Surface the load-side reason (#2374): "not pre-installed" was wrong
        // and doctor never installed anything, so the old message trapped
        // users in a query → repair-fts → doctor loop with no way out.
        // NOTE: deliberately the exported `getExtensionCapabilities()` rather
        // than `getFtsCapability()`. The #2383 regression tests stub that
        // export to inject a classified load failure; routing through the
        // helper bypasses the stub (ESM internal calls do not see a module
        // mock), and the classified VC++/ELF remedy silently degrades to
        // generic text — which is exactly the contradiction #2383 fixed.
        const rawFtsReason = getExtensionCapabilities().find((c) => c.name === 'fts')?.reason;
        const ftsReason = rawFtsReason?.replace(/\.$/, '');
        // A missing runtime dependency (Windows error 126, #2374) is not healed
        // by re-installing — the file is already present. Route that class to the
        // classified remedy (install VC++ redist / OpenSSL) instead of the old
        // "retry the network install" text that trapped the user in a loop.
        const { kind, remedy } = diagnoseExtensionLoad(rawFtsReason);
        const remedyTail =
          kind === 'missing_dependency'
            ? ` ${remedy}`
            : '. Retry with network access and GITNEXUS_LBUG_EXTENSION_INSTALL=auto to install it, ' +
              'or pre-install the extension file; run `gitnexus doctor` for live FTS status.';
        throw new Error(
          'Cannot repair FTS indexes: the LadybugDB FTS extension failed to load' +
            (ftsReason ? ` — ${ftsReason}` : '') +
            remedyTail,
        );
      }
      progress('fts', 85, 'Repairing search indexes...');
      const repairFailures = await createSearchFTSIndexes({
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const missing = await verifySearchFTSIndexes(executeQuery);
      if (missing.length > 0) {
        // #2889: name WHY each index is missing when the build itself said so.
        // Repair now rebuilds every table it can before reporting, so the tables
        // absent from this list were genuinely repaired even on a failed run —
        // previously the first failure aborted the sweep and the message could
        // only ever list "missing", never a reason. Same sentence the analyze
        // degrade path prints, so one failure does not read two ways.
        const reasons =
          repairFailures.length > 0 ? ` ${summarizeFtsIndexBuildFailures(repairFailures)}.` : '';
        throw new Error(
          `FTS repair failed - missing indexes after rebuild: ${missing.join(', ')}.${reasons} ` +
            'Run `gitnexus analyze --force` to perform a full graph+FTS rebuild; ' +
            'if that also fails, verify FTS extension availability via `gitnexus doctor`.',
        );
      }
      await ensureGitNexusIgnored(repoPath);
      // #2767: stamp ONLY capabilities.fts so a long-lived MCP session's
      // ensureInitialized() has an explicit, correctly-scoped signal that FTS
      // changed — indexedAt/lastCommit/runnerIdentity/stats are copied through
      // untouched (see the "must not claim a new analyzer identity" comment
      // below). capabilities is forensic/no-programmatic-readers-until-now, so
      // graph/vectorSearch are backfilled with conservative, honest defaults
      // when a legacy meta.json predates this field entirely — repair-fts
      // never touched them and cannot claim a capability it did not verify.
      // Best-effort: a write failure must not turn an already-successful FTS
      // rebuild into a reported repair failure.
      try {
        // Re-read the on-disk meta immediately before writing, rather than
        // reusing `existingMeta` (captured before the FTS rebuild ran, which
        // can span real wall-clock time). Another writer to this same
        // gitnexus.json in the interim — e.g. the HTTP server's background
        // embedding-checkpoint job — must not have its update silently
        // reverted by this stamp overwriting a stale snapshot. Falls back to
        // `existingMeta` only if the file became unreadable in that window.
        const latestMeta = (await loadMeta(metaDir)) ?? existingMeta;
        await saveMeta(metaDir, {
          ...latestMeta,
          capabilities: {
            graph: latestMeta.capabilities?.graph ?? {
              provider: 'ladybugdb',
              status: 'available',
            },
            fts: { provider: 'ladybugdb-fts', status: 'available' },
            vectorSearch: latestMeta.capabilities?.vectorSearch ?? {
              provider: 'exact-scan',
              status: 'unavailable',
              exactScanLimit: 0,
            },
          },
        });
      } catch (err) {
        log(
          `FTS capability stamp write failed (non-critical, repair itself succeeded${
            err instanceof Error ? `: ${err.message}` : ''
          }); continuing.`,
        );
      }
      progress('fts', 90, 'Search indexes ready');
      progress('done', 100, 'Done');
      if (options.registryName) {
        await registerRepo(repoPath, existingMeta, {
          name: options.registryName,
          allowDuplicateName: options.allowDuplicateName,
          branch: placement.branch,
        });
      }
      return {
        repoName:
          options.registryName ??
          getInferredRepoName(repoPath) ??
          path.basename(resolveRepoIdentityRoot(repoPath)),
        repoPath,
        stats: existingMeta.stats ?? {},
        ftsRepairedOnly: true,
      };
    } finally {
      await closeLbug().catch(() => {});
    }
  }

  // Resolve once per real analysis run so every successful metadata write
  // carries one coherent receipt. The FTS-only repair path above intentionally
  // returns without restamping: it does not regenerate the graph represented by
  // RepoMeta and therefore must not claim a new analyzer identity.
  const runnerIdentity =
    runnerIdentityAtBootstrap ?? resolveAnalyzerRunnerIdentity(import.meta.url);
  if (!analyzerRunnerIdentitiesEqual(runnerIdentity, runnerIdentity)) {
    throw new Error('Analyzer bootstrap supplied a malformed runner identity receipt');
  }

  let resumeEmbeddingCheckpoint = false;
  let pendingEmbeddingNodeIds = new Set<string>();
  let embeddingIdentityForRun: EmbeddingIdentity | undefined;
  // The marker this run resumed, so Phase 5 can tell "the retry cleared the
  // set" from "the retry failed the same way again" and bound the latter — see
  // `nextAttemptCount` in embedding-checkpoint.ts (#2790).
  let resumedEmbeddingCheckpoint: EmbeddingCheckpoint | undefined;
  if (existingMeta?.embeddingCheckpoint) {
    const checkpoint = existingMeta.embeddingCheckpoint;
    // The verdict itself lives in embedding-checkpoint.ts, shared with
    // `POST /api/embed` — two readers of one marker must not be able to
    // disagree about what it means.
    //
    // The identity stays LAZY, as it has to: the flag and retry-budget verdicts
    // short-circuit before one is needed, and resolving it means importing an
    // embeddings module (#2370 — none loads unless a run actually needs one).
    // `decideEmbeddingResume` asks for it by aborting on `undefined`, which is
    // the only abort it can reach without one.
    let decision = decideEmbeddingResume(checkpoint, undefined, options);
    if (decision.action === 'abort') {
      const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
      embeddingIdentityForRun = resolveEmbeddingIdentity();
      decision = decideEmbeddingResume(checkpoint, embeddingIdentityForRun, options);
    }
    if (decision.action === 'abort') throw new Error(decision.error);
    log(decision.log);
    if (options.dropEmbeddings) {
      // --drop-embeddings has always implied a rebuild here; the decision only
      // covers the marker.
      options = { ...options, force: true };
    }
    if (decision.action === 'resume') {
      resumeEmbeddingCheckpoint = true;
      pendingEmbeddingNodeIds = new Set(decision.pendingNodeIds);
      resumedEmbeddingCheckpoint = decision.resumedFrom;
    }
  }

  // ── Crash recovery: dirty flag forces full rebuild ────────────────
  // If the previous incremental run set incrementalInProgress and didn't
  // clear it, the on-disk index may be in a half-state. Cheapest path
  // back to a known-good index is to wipe + rebuild from scratch.
  if (existingMeta?.incrementalInProgress) {
    const dirty = existingMeta.incrementalInProgress;
    const dirtyDetails =
      typeof dirty === 'object'
        ? [
            dirty.phase ? `phase=${dirty.phase}` : undefined,
            `toWrite=${dirty.toWriteCount}`,
            dirty.importerExpansion !== undefined
              ? `importerExpansion=${dirty.importerExpansion}`
              : undefined,
            dirty.effectiveWriteCount !== undefined
              ? `effectiveWrite=${dirty.effectiveWriteCount}`
              : undefined,
            dirty.deleteCount !== undefined ? `deleteCount=${dirty.deleteCount}` : undefined,
            // Only stamped when > 0 (tri-review 4669518496 P2-5): its
            // presence means the crashed run's importer expansion was
            // already degraded — the write set may have been under-expanded
            // before the crash.
            dirty.droppedImporterChunks !== undefined
              ? `droppedImporterChunks=${dirty.droppedImporterChunks}`
              : undefined,
          ]
            .filter(Boolean)
            .join(', ')
        : 'legacy dirty flag';
    log(
      // "analyze run", not "incremental run" — since #2099 F1 the flag is a
      // generic dirty marker written by BOTH writeback branches.
      'Previous analyze run did not complete cleanly (incrementalInProgress flag set); ' +
        `last dirty state: ${dirtyDetails}; ` +
        'forcing full rebuild to restore a known-good index.',
    );
    options = { ...options, force: true };
    // Reload meta after clearing the flag in-memory; we still want fileHashes
    // for the post-rebuild meta carry-over, but force=true ensures the
    // rebuild path executes.
    //
    // #2409 defect 2: the crashed writeback's WAL can be poisoned — replaying
    // it kills the process natively, and the first DB open of this recovery
    // run (the embedding-cache preservation open below) happens BEFORE the
    // rebuild wipe that would discard it. Park the WAL/shadow sidecars aside
    // now, while nothing is open, so every open in this run is replay-free.
    // The rebuild wipes the DB regardless, so no committed data is at stake.
    const { removed, failed } = await quarantineSidecarsForDirtyRecovery(lbugPath, log);
    if (removed.length > 0) {
      log(
        `Dirty-state recovery discarded ${removed.map((p) => path.basename(p)).join(', ')} ` +
          'from the interrupted run (the file could not be moved aside, so its bytes were ' +
          'removed — post-mortem forensics lost). Recovery proceeds with full embedding ' +
          'preservation.',
      );
    }
    if (failed.length > 0) {
      // FIX 1 (this shipping review, replacing the tri-review 4669518496
      // P2-3 drop-shape design): under a persistent lock the old drop-shape
      // run derived its embedding mode as "drop", ran the WHOLE pipeline,
      // and then died at the rebuild wipe on the very same handle — wasting
      // minutes and zeroing embeddings on the way. A possibly-poisoned
      // sidecar still sits next to the DB (any pre-wipe open would replay it
      // and die), so failing here, in seconds, with the same actionable
      // typed error the wipe would eventually throw is strictly better —
      // and the CLI's LbugWipeError handler already renders it
      // (recoveryHint 'lbug-wipe-failed'). The message is self-contained
      // (headline + paths + lock guidance) because serve forwards only
      // err.message over worker IPC.
      throw new LbugWipeError(failed, {
        headline:
          "Cannot start dirty-state recovery — the interrupted run's LadybugDB sidecars " +
          'could neither be moved aside nor removed:',
      });
    }
  }

  // ── pdg-mode flip forces full writeback (#2099 F1) ─────────────────
  // The incremental writeback persists only changed-file nodes, so a pdg
  // config differing from the one the DB rows were built under cannot be
  // reconciled incrementally: off→on silently drops the freshly built CFG
  // layer ("Incremental: changed=0", zero BasicBlock rows), on→off strands
  // zombie blocks for unchanged files. MUST sit before the alreadyUpToDate
  // fast path below — a clean-tree flip would otherwise early-return without
  // running the pipeline at all. The notice is deliberately NOT gated on
  // options.force: --skills implies force with no message of its own, and a
  // mode change deserves a diagnostic regardless of why a rebuild happens.
  if (existingMeta && pdgModeMismatch(existingMeta.pdg, options)) {
    const pdgOn = options.pdg === true;
    const capsOnly = !!existingMeta.pdg && pdgOn; // both-on can only mismatch via caps
    const was = existingMeta.pdg ? 'with --pdg' : 'without --pdg';
    const now = pdgOn ? 'with --pdg' : 'without --pdg';
    log(
      `pdg mode changed (index built ${was}, this run is ${now}` +
        `${capsOnly ? ', but with different caps' : ''}); forcing a full ` +
        `rebuild so the CFG layer is ${pdgOn ? 'fully persisted' : 'fully removed'}. ` +
        `Tip: set \`pdg: ${pdgOn}\` in .gitnexusrc to pin the mode across runs.`,
    );
    options = { ...options, force: true };
  }

  // ── schema mismatch forces full rebuild (#2289 P1, #2798) ─────────
  // Mirrors the pdg-mode block above: an index whose tables were created from
  // a different DDL cannot be reconciled by an incremental top-up — a
  // same-commit re-analyze would strand stale rows next to new-schema writes,
  // and LadybugDB fixes a relation table's endpoint pairs at CREATE time, so
  // edges the old shape cannot hold are simply dropped. MUST sit before the
  // alreadyUpToDate fast path below: an unchanged-commit clean tree would
  // otherwise early-return without ever reaching the `isIncremental` gate.
  //
  // Forcing here is what recreates the schema: `force` makes the run a full
  // rebuild, which wipes the database file and re-runs the DDL against an
  // empty one. Re-running `CREATE … TABLE` over the EXISTING database would
  // not help — runSchemaCreationQueries suppresses "already exists", so the
  // new shape would never be applied.
  //
  // ABSENT covers two cases and forces in both: an index from a GitNexus
  // older than this field (the backward-compatibility path — one rebuild, then
  // it is stamped), and a non-git repo, which never stamps it (see the meta
  // literal below) and takes the `currentCommit === ''` rebuild branch below
  // regardless.
  //
  // The two cases must not be told the same story. Blaming "an older GitNexus
  // version" is FALSE for a non-git repo — the field is absent by design there,
  // so this build would keep saying it about an index this exact build just
  // wrote, on every run, forever. A stamp is only named when it has the shape
  // SCHEMA_FINGERPRINT produces; anything else degrades to a neutral
  // placeholder, and a non-git repo is additionally told WHY it has no stamp.
  if (existingMeta && schemaFingerprintMismatch(existingMeta.schemaFingerprint)) {
    const stamped = existingMeta.schemaFingerprint;
    const origin = isSchemaFingerprintShaped(stamped) ? stamped : 'an unidentified GitNexus build';
    const nonGitNote =
      stamped === undefined && !repoHasGit
        ? ' Non-git repositories never record a schema fingerprint, so this run rebuilds regardless.'
        : '';
    log(
      `index schema changed (built by ${origin}, this build is ${SCHEMA_FINGERPRINT}); forcing a ` +
        `full re-analyze so the database is recreated from the current schema.${nonGitNote}`,
    );
    options = { ...options, force: true };
  }

  // ── a recorded graph-write collapse forces a full rebuild ────────
  //
  // Every other meta-driven trigger above and below gets a block here;
  // `graphWriteCollapsed` was recorded and then never read by anything
  // (`grep -rn graphWriteCollapsed src/` showed writes only). The consequence is
  // the worst available: a collapsed index whose commit has not changed takes
  // the `alreadyUpToDate` fast path, prints "Already up to date", exits 0, and
  // keeps doing so forever. The one state that means "most of your edges are
  // gone" was the one state that repaired itself only if the user happened to
  // pass `--force`.
  //
  // Forcing is the correct remedy rather than merely re-running: the collapse
  // means the persisted graph disagrees with what the pipeline produced, and an
  // incremental pass over unchanged files would write nothing and re-stamp the
  // same broken index as fresh.
  if (existingMeta?.graphWriteCollapsed) {
    const { expected, persisted } = existingMeta.graphWriteCollapsed;
    log(
      `previous run persisted ${persisted} of ${expected} expected relationships ` +
        `(recorded as a graph-write collapse); forcing a full re-analyze rather than ` +
        `reporting an index this build already knows is incomplete.`,
    );
    options = { ...options, force: true };
  }

  // ── independently-versioned analysis capabilities ────────────────
  // `schemaFingerprint` is reserved for graph-wide incremental invariants. Some
  // persisted semantics apply only to repositories containing relevant source
  // files, so they carry exact feature versions instead. This guard must also
  // run before alreadyUpToDate: a feature can change what is EXTRACTED without
  // changing the DDL, so an index whose `schemaFingerprint` matches this build
  // can still be missing that feature's evidence (e.g. the Class
  // frameworkAnnotations values, or Java/Kotlin Bean evidence) — the fingerprint
  // guard above would wave it through.
  const persistedFilePaths = Object.keys(existingMeta?.fileHashes ?? {});
  const expectedPersistedAnalysisFeatures = resolveAnalysisFeatureVersions(
    ANALYSIS_FEATURES,
    persistedFilePaths,
  );
  const persistedAnalysisFeatureMismatches = existingMeta
    ? findAnalysisFeatureMismatches(
        existingMeta.analysisFeatures,
        expectedPersistedAnalysisFeatures,
      )
    : [];
  let analysisFeatureMismatchLogged = false;
  if (existingMeta && persistedAnalysisFeatureMismatches.length > 0) {
    log(
      `analysis capabilities changed (${persistedAnalysisFeatureMismatches.join(', ')}); ` +
        `forcing a full rebuild so persisted feature evidence is complete.`,
    );
    options = { ...options, force: true };
    analysisFeatureMismatchLogged = true;
  }

  // Analyzer provenance is part of freshness, not merely diagnostics. A
  // same-commit fast path must not preserve metadata produced by an older,
  // malformed, or dependency/native-different runner. Force a real rebuild so
  // the graph and its schema-v4 receipt are finalized atomically together.
  if (existingMeta && !analyzerRunnerIdentitiesEqual(existingMeta.runnerIdentity, runnerIdentity)) {
    const stampedRunnerSchema = (
      existingMeta.runnerIdentity as { schemaVersion?: unknown } | undefined
    )?.schemaVersion;
    log(
      `analyzer runner identity changed (stamped schema ${String(stampedRunnerSchema ?? 'missing')}, ` +
        `this build uses schema ${runnerIdentity.schemaVersion}); forcing a full rebuild so the ` +
        'index provenance matches the analyzer and dependency/native runtime that produced it.',
    );
    options = { ...options, force: true };
  }

  if (
    existingMeta &&
    cjkSegmentationModeMismatch(existingMeta.cjkSegmentation, getSearchFTSCjkSegmentation())
  ) {
    log(
      `CJK segmentation mode changed (index built with '${existingMeta.cjkSegmentation ?? 'none'}', ` +
        `this run resolves '${getSearchFTSCjkSegmentation()}'); forcing a full rebuild so indexed ` +
        `text and query-time segmentation stay in sync.`,
    );
    options = { ...options, force: true };
  }

  // ── embedding width mismatch forces full rebuild (#2798) ──────────
  // The half of the schema `SCHEMA_FINGERPRINT` deliberately cannot cover:
  // `CodeEmbedding.embedding` is declared `FLOAT[EMBEDDING_DIMS]`, and that
  // width comes from `GITNEXUS_EMBEDDING_DIMS` at module load, so folding it
  // into a digest of CODE would make the same build disagree with itself under
  // two envs. Without this block a dims flip on a same-commit clean tree fired
  // NO guard: the fast path below returned over a FLOAT[384] table while this
  // process embedded at 768. The one older reaction (in the embedding-restore
  // block further down) discards the CACHE and re-embeds — into a column whose
  // width it never revisits.
  //
  // Forcing is again what repairs it, and for the same reason as the
  // fingerprint guard: only a full rebuild wipes the database and re-runs the
  // DDL, and `runSchemaCreationQueries` suppresses "already exists", so
  // re-running CREATE over the existing DB would silently keep the old width.
  // Not conditioned on the index actually holding vectors — the table is
  // created for every index either way, and nothing but a rebuild can retype it.
  //
  // ABSENT is NOT a mismatch here (see embeddingDimsMismatch for the argument):
  // it means an index predating the field, whose width is unknown but was
  // consistent with the env that wrote it, and which the fingerprint guard
  // above already rebuilds — that rebuild is where the stamp lands.
  if (existingMeta && embeddingDimsMismatch(existingMeta.embeddingDims, EMBEDDING_DIMS)) {
    // Only NAME a recorded width that could be one, for the reason the
    // fingerprint guard gates its stamp on `isSchemaFingerprintShaped`:
    // meta.json is a schema-less JSON.parse of on-disk state, so a value that
    // is not a positive integer is not worth quoting back at the user.
    const recordedDims = existingMeta.embeddingDims;
    const built =
      typeof recordedDims === 'number' && Number.isInteger(recordedDims) && recordedDims > 0
        ? `FLOAT[${recordedDims}]`
        : 'an unrecognized width';
    log(
      `embedding dimensions changed (index built with ${built}, this run embeds at ` +
        `${EMBEDDING_DIMS}); forcing a full rebuild so the vector column is recreated at the ` +
        `new width. Tip: set GITNEXUS_EMBEDDING_DIMS (or --embedding-dims) to pin it across runs.`,
    );
    options = { ...options, force: true };
  }

  // Actuator snapshots are external runtime inputs and are intentionally not
  // hashed or persisted. Rebuild on every enabled run so updated snapshots
  // cannot hit the git freshness fast path; rebuild once when the option is
  // removed so stale runtime-only evidence is cleared from the index.
  const springActuatorRequested = options.springActuatorPath !== undefined;
  const springActuatorPreviouslyEnabled = existingMeta?.springActuator?.enabled === true;
  const previousActuatorInputs: unknown = existingMeta?.springActuator?.repoRelativeInputs;
  const retainedActuatorInputs = Array.isArray(previousActuatorInputs)
    ? previousActuatorInputs.filter((input): input is string => typeof input === 'string')
    : [];
  if (springActuatorRequested) {
    const resolvedRepo = path.resolve(repoPath);
    const resolvedInput = path.resolve(repoPath, options.springActuatorPath!);
    const relativeInput = path.relative(resolvedRepo, resolvedInput);
    const springActuatorRepoRelativeInput =
      relativeInput === ''
        ? '.'
        : relativeInput === '..' ||
            relativeInput.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativeInput)
          ? null
          : relativeInput.split(path.sep).join('/');
    if (
      springActuatorRepoRelativeInput !== null &&
      !retainedActuatorInputs.includes(springActuatorRepoRelativeInput)
    ) {
      retainedActuatorInputs.push(springActuatorRepoRelativeInput);
    }
    if (!options.force) {
      log('Spring Actuator runtime enrichment requested; forcing a full rebuild.');
    }
    options = { ...options, force: true };
  } else if (springActuatorPreviouslyEnabled) {
    if (
      !Array.isArray(previousActuatorInputs) ||
      previousActuatorInputs.some((input) => typeof input !== 'string')
    ) {
      throw new Error(
        'Cannot safely disable Spring Actuator runtime enrichment because the previous ' +
          'index did not record whether its snapshot was inside the repository. Re-run once ' +
          'with the previous --spring-actuator path, then run again without it.',
      );
    }
    log('Spring Actuator runtime enrichment disabled; rebuilding to remove runtime evidence.');
    options = { ...options, force: true };
  }
  const springActuatorScanExclusions =
    retainedActuatorInputs.length === 0 ? undefined : retainedActuatorInputs;

  // AsyncAPI documents are the same class of input as Actuator snapshots and
  // need the same treatment, for a reason git cannot see: the documents live
  // outside the tree as often as in it, and NOTHING about replacing one moves
  // the commit or dirties the working tree. Without this, the second run of an
  // out-of-band cache — the workflow the option exists for — takes the
  // already-up-to-date fast path below, never opens a document, and serves the
  // previous run's addresses while reporting success. Measured, not reasoned:
  // editing a document and re-running printed "Already up to date" and left the
  // old address in the graph.
  //
  // Forcing the rebuild also settles a second defect for free. A synthetic
  // `File` node for an out-of-tree document (`asyncapi:<label>`) carries a path
  // that is in no write set and is not covered by `isGraphWideNode`, so on an
  // incremental writeback the node is dropped while its edges — anchored to a
  // graph-wide `Destination` — are kept, and the edges then COPY against a row
  // that was never written. A full rebuild has no incremental subgraph to get
  // that wrong, so the pair cannot come apart.
  const asyncApiSpecRequested = options.asyncApiSpecPath !== undefined;
  const asyncApiSpecPreviouslyEnabled = existingMeta?.asyncApiSpec?.enabled === true;
  if (asyncApiSpecRequested) {
    if (!options.force) {
      log('AsyncAPI document reading requested; forcing a full rebuild.');
    }
    options = { ...options, force: true };
  } else if (asyncApiSpecPreviouslyEnabled) {
    log('AsyncAPI document reading disabled; rebuilding to remove document-derived evidence.');
    options = { ...options, force: true };
  }

  // ── Early-return: already up to date ──────────────────────────────
  if (
    existingMeta &&
    !existingMeta.embeddingCheckpoint &&
    !options.force &&
    existingMeta.lastCommit === currentCommit
  ) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      // For git repos, even if HEAD matches lastCommit, the working tree
      // may have uncommitted changes. Only short-circuit when the working
      // tree is also clean — otherwise fall through to the incremental
      // path which will hash-diff and update only changed files.
      //
      // We exclude paths that GitNexus itself writes during analyze:
      //   .gitnexus/                  — db / parse cache / meta.json
      //   .claude/, .cursor/          — auto-generated agent skill files
      //   AGENTS.md, CLAUDE.md        — auto-updated stats blocks
      // Counting them as dirty would perpetually defeat the up-to-date
      // fast path because the previous analyze just wrote them
      // (regression vs PR #1233 behavior).
      const dirty = isWorkingTreeDirty(repoPath);
      // Registration wrinkle around the fast path (#2264). A prior
      // `analyze --name X` that hit a name collision writes meta.json (meta-save
      // runs before registerRepo) then fails before registering, leaving the
      // index up-to-date but UNREGISTERED. When the user re-runs with
      // --allow-duplicate-name they explicitly want it registered, so fall
      // through to the pipeline (which registers it, honoring the flag) instead
      // of early-returning an unregistered repo the flag could never heal.
      // For a PLAIN analyze we deliberately do NOT self-heal: an up-to-date but
      // unregistered repo early-returns here and the CLI's assertAnalysisFinalized
      // surfaces it as a hard failure (#1169) rather than silently registering a
      // possibly half-finalized index. `isRepoRegistered` is only read on the
      // opt-in branch so the common fast path keeps its single-stat cost.
      const healUnregistered =
        options.allowDuplicateName === true && !(await isRepoRegistered(repoPath));
      // §5.C is deliberately NOT self-healed here. An #2841 FTS-forced rebuild
      // stamps `lastCommit`, so a plain rerun lands on this fast path and the
      // search indexes stay missing until the next content change. The fix for
      // that is the ADVICE, not a probe: the degraded-search warning now points
      // at `gitnexus analyze --repair-fts` (which rebuilds the indexes without
      // re-parsing anything) instead of "then rerun".
      //
      // An auto-heal probe was tried and reverted. It could not distinguish
      // "extension was missing" from "index build failed" without a stamped
      // discriminator, so a deterministic build failure (#2544/#2546) re-analyzed
      // the whole repo on every invocation forever; it opened the live index on
      // the millisecond fast path; and it turned this early return into a full
      // re-analysis whenever an index authored where FTS was unavailable was
      // later read on a host where it loads — which is a legitimate, common
      // state, and the invariant `analyzer-identity-cli.test.ts` pins.
      if (!dirty && !healUnregistered) {
        if (options.registryName) {
          await registerRepo(repoPath, existingMeta, {
            name: options.registryName,
            allowDuplicateName: options.allowDuplicateName,
            branch: placement.branch,
          });
          if (!placement.branch) {
            try {
              await generateAIContextFiles(
                repoPath,
                storagePath,
                options.registryName,
                existingMeta.stats ?? {},
                undefined,
                {
                  skipAgentsMd: options.skipAgentsMd,
                  skipSkills: options.skipSkills,
                  noStats: options.noStats,
                  defaultBranch: options.defaultBranch,
                  // Fast path does not re-run PDG. Using `options.pdg` would
                  // strip PDG bullets from AGENTS.md on a rename-only analyze.
                  hasPdg: existingMeta.pdg != null,
                  hasSpringActuator: existingMeta.springActuator?.enabled === true,
                },
              );
            } catch {
              /* best-effort — never fail the fast path over a context refresh */
            }
          }
        }
        // ── #2354: restamp the workspace label on a same-commit branch flip ──
        // The flat slot follows the checked-out working tree; a branch switch
        // at the SAME commit with a clean tree changes nothing the pipeline
        // must rebuild, but the slot's informational `branch` label (and the
        // registry copy that query-side branch scoping reads) would go stale.
        // Detached HEAD / non-git (branchLabel === null) keeps the existing
        // stamp, mirroring the end-of-run meta write.
        if (!placement.branch && branchLabel && existingMeta.branch !== branchLabel) {
          // Adopt first, stamp last (#2364 review F3): this block's retry
          // guard is `existingMeta.branch !== branchLabel`, so stamping the
          // meta before the registry/shadow cleanup would flip the guard and
          // lock in any partial failure — with saveMeta last, a failed adopt
          // leaves the guard true and the next same-commit run self-heals
          // (adopt is idempotent). The whole sync is best-effort: the label
          // is informational and the flat DB content is byte-valid for both
          // labels here (same commit, clean tree), so an "Already up to
          // date" run must not fail over it; read-only storage — the
          // documented Docker :ro workflow (#1549) — degrades to a warning.
          try {
            await adoptFlatBranchLabel(repoPath, branchLabel);
            await saveMeta(metaDir, { ...existingMeta, branch: branchLabel });
          } catch (err) {
            // EACCES/EPERM also arise from ownership problems and transient
            // Windows locks, so keep the real error visible alongside the
            // #1549 read-only hint instead of replacing it.
            const reason = isReadOnlyFilesystemError(err)
              ? `${(err as Error).message} — storage may be read-only (#1549)`
              : (err as Error).message;
            log(
              `Warning: could not restamp the workspace branch label (${reason}); will retry on the next run.`,
            );
          }
        }
        await ensureGitNexusIgnored(repoPath);
        return {
          // `resolveRepoIdentityRoot` collapses worktree roots to the
          // canonical repo basename (#1259) but leaves arbitrary subdirs
          // and `--skip-git` paths unchanged (#1232/#1233 intent preserved).
          repoName:
            options.registryName ??
            getInferredRepoName(repoPath) ??
            path.basename(resolveRepoIdentityRoot(repoPath)),
          repoPath,
          stats: existingMeta.stats ?? {},
          alreadyUpToDate: true,
          isPrimaryBranch: !placement.branch,
        };
      }
    }
  }

  // ── Cache embeddings from existing index before rebuild ────────────
  // Four modes:
  //   --embeddings              -> load cache, restore, then generate any new ones
  //   --force (with existing
  //    embeddings)              -> auto-imply --embeddings: load cache, restore,
  //                                regenerate embeddings for new/changed nodes
  //                                (a forced re-index of an embedded repo
  //                                shouldn't quietly downgrade to "preserve only")
  //   (default)                 -> if existing index has embeddings, preserve them
  //                                (load + restore, but do not generate); otherwise no-op
  //   --drop-embeddings         -> skip cache load entirely; rebuild wipes embeddings
  //
  // The default-preserve branch is what makes a routine `analyze` (e.g. a
  // post-commit hook) safe: a multi-minute embedding pass is no longer
  // silently dropped just because the caller omitted `--embeddings`.
  let cachedEmbeddingNodeIds = new Set<string>();
  let cachedEmbeddings: CachedEmbedding[] = [];

  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const {
    forceRegenerateEmbeddings,
    preserveExistingEmbeddings,
    shouldGenerateEmbeddings: derivedShouldGenerateEmbeddings,
    shouldLoadCache: derivedShouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);
  const shouldGenerateEmbeddings = derivedShouldGenerateEmbeddings || resumeEmbeddingCheckpoint;
  const shouldLoadCache = derivedShouldLoadCache || resumeEmbeddingCheckpoint;

  if (options.dropEmbeddings && existingEmbeddingCount > 0) {
    log(
      `Dropping ${existingEmbeddingCount} existing embeddings (--drop-embeddings). ` +
        `Re-run with --embeddings to regenerate.`,
    );
  } else if (forceRegenerateEmbeddings) {
    log(
      `--force on a repo with ${existingEmbeddingCount} existing embeddings: ` +
        `regenerating embeddings for new/changed nodes. ` +
        `Pass --drop-embeddings to wipe them instead.`,
    );
  } else if (preserveExistingEmbeddings) {
    log(
      `Preserving ${existingEmbeddingCount} existing embeddings. ` +
        `Pass --embeddings to also generate embeddings for new/changed nodes, ` +
        `or --drop-embeddings to wipe them.`,
    );
  }

  // We *always* load the embedding cache when one is requested (regardless
  // of the predicted `willTryIncremental`). The post-pipeline branch may
  // disagree with the prediction (e.g. when the pipeline produces zero
  // File nodes, `isIncremental` flips false and the full-rebuild path
  // wipes the DB) — loading unconditionally is cheap insurance against
  // silently dropping embeddings on a mispredicted run. The re-insert
  // step gates itself on the actual `isIncremental` value to avoid
  // PK-conflicts when the incremental writeback path keeps the rows.
  //
  // This is the FIRST DB open of the run — the one #2409 defect 2 is about.
  // On a dirty-recovery run it happens only after the sidecar quarantine
  // moved (or removed) the crashed run's WAL/shadow; when neither was
  // possible the dirty block above already threw a LbugWipeError, so this
  // open is replay-free by construction (FIX 1 of this shipping review).
  if (shouldLoadCache && existingMeta) {
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initLbug(lbugPath);
      const cached = await loadCachedEmbeddings();
      cachedEmbeddingNodeIds = cached.embeddingNodeIds;
      cachedEmbeddings = cached.embeddings;
      await closeLbug();
    } catch (err: any) {
      // Surface cache-load failures explicitly: silently swallowing here would
      // re-introduce the original silent-data-loss symptom (embeddings end up
      // at 0 in meta.json with no diagnostic) through a different door.
      log(
        `Warning: could not load cached embeddings ` +
          `(${err?.message ?? String(err)}). ` +
          `Embeddings will not be preserved on this run.`,
      );
      cachedEmbeddingNodeIds = new Set<string>();
      cachedEmbeddings = [];
      try {
        await closeLbug();
      } catch {
        /* swallow */
      }
    }
  }

  // ── Load incremental parse cache ──────────────────────────────────
  // Content-addressed: safe to reuse across `--force` runs (chunks whose
  // file contents haven't changed produce identical worker output).
  // Loaded into a single ParseCache object that the pipeline mutates
  // in-place (cache hits leave entries unchanged; misses add new ones).
  const parseCache = await loadParseCache(storagePath);

  // Streamed structural emit (#2680). Resolved ONCE, so the pipeline flag and
  // the CSV-dir resolution below cannot disagree — and resolved HERE, not at
  // function entry, because the POSITION is load-bearing: the gate is
  // `options.force`, and every freshness guard above REBINDS `options` with
  // `force: true` (embedding-checkpoint drop, dirty-flag recovery, pdg-mode
  // flip, schema-fingerprint change, analysis-feature drift, runner-identity change,
  // CJK-mode change). Resolving before them froze the answer at `false` for
  // every rebuild they trigger — including the whole-fleet rebuild an
  // schema-fingerprint change forces on every existing index at once,
  // which is exactly when the #2649 memory relief matters most. So this MUST
  // stay below the last guard that can set `force` and above its first use.
  // (The post-pipeline analysis-feature re-check can also set `force`, but the
  // pipeline has already run by then; that run emits non-streamed, precisely as
  // `resolveStreamPdgEmit` — read fresh at the same point — behaves.)
  const streamGraphEmitActive = resolveStreamGraphEmit(options);

  // #3016: hold back Leiden and flow extraction when the persisted metadata
  // says this run is a candidate for a surgical incremental write, whose
  // derived layer is reused rather than recomputed. Deliberately the same
  // conditions as the `isIncremental` decision below MINUS the two that only
  // the pipeline can answer (the analysis-feature re-check and a non-empty
  // file list), so this is a superset: every run that turns out incremental
  // had the phases skipped, and the runs that do not are caught by
  // `runDeferredDerivedPhases` once the write plan is known. Excluded on the
  // streaming path because that is a full rebuild by construction, and the
  // deferred phases must not write into a finalized emit sink.
  const skipDerivedGraphPhases =
    !streamGraphEmitActive &&
    !options.force &&
    !!existingMeta &&
    !!existingMeta.fileHashes &&
    Object.keys(existingMeta.fileHashes).length > 0 &&
    repoHasGit &&
    !schemaFingerprintMismatch(existingMeta.schemaFingerprint);

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  const pipelineResult = await runPipelineFromRepo(
    repoPath,
    (p) => {
      const phaseLabel = PHASE_LABELS[p.phase] || p.phase;
      const scaled = Math.round(p.percent * 0.6);
      const message = p.detail
        ? `${p.message || phaseLabel} (${p.detail})`
        : p.message || phaseLabel;
      progress(p.phase, scaled, message);
    },
    {
      parseCache,
      workerPoolSize: options.workerPoolSize,
      // CFG/PDG opt-in (#2081 M1). PipelineOptions.pdg fans out to the worker
      // build gate (workerData.pdg) and the scope-resolution emit gate.
      pdg: options.pdg === true,
      pdgMaxFunctionLines: options.pdgMaxFunctionLines,
      pdgMaxEdgesPerFunction: options.pdgMaxEdgesPerFunction,
      pdgMaxReachingDefEdgesPerFunction: options.pdgMaxReachingDefEdgesPerFunction,
      pdgMaxCdgEdgesPerFunction: options.pdgMaxCdgEdgesPerFunction,
      pdgMaxTaintFindingsPerFunction: options.pdgMaxTaintFindingsPerFunction,
      pdgMaxTaintHops: options.pdgMaxTaintHops,
      pdgMaxInterprocFindings: options.pdgMaxInterprocFindings,
      pdgMaxInterprocHops: options.pdgMaxInterprocHops,
      pdgMaxInterprocEdges: options.pdgMaxInterprocEdges,
      // Streaming/chunked PDG emit (#2202) — gated to full-rebuild runs
      // (force === true) so the incremental writeback never reads back an
      // offloaded BasicBlock layer. Memory-only; byte-identical output.
      streamPdgEmit: resolveStreamPdgEmit(options),
      pdgEmitChunkSize: resolvePdgEmitChunkSize(options),
      // Streamed structural emit (#2680) — same full-rebuild gate as the PDG
      // toggle above, for the same incremental-writeback reason.
      streamGraphEmit: streamGraphEmitActive,
      // Resolved ONLY when streaming is active: on a Windows non-ASCII storage
      // path this helper mkdtempSyncs a real directory, so evaluating it
      // unconditionally would leak one temp dir per analyze even with the flag
      // off. The PDG sibling resolves inside its guard for the same reason.
      graphEmitCsvDir: streamGraphEmitActive
        ? resolveNativeSafeStorageDir(storagePath, 'graph-csv')
        : undefined,
      fetchWrappers: options.fetchWrappers,
      skipDerivedGraphPhases,
      springActuatorPath: options.springActuatorPath,
      asyncApiSpecPath: options.asyncApiSpecPath,
      springActuatorScanExclusions,
    },
  );

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  progress('lbug', 60, 'Loading into LadybugDB...');

  // Compute current per-file content hashes from the pipeline's File nodes.
  // Used both to drive the incremental DB writeback (when eligible) and to
  // populate meta.json.fileHashes for the next run.
  const allFilePaths: string[] = [];
  pipelineResult.graph.forEachNode((n) => {
    if (n.label === 'File') {
      const fp = n.properties?.filePath as string | undefined;
      if (fp) allFilePaths.push(fp);
    }
  });
  const newFileHashes = await computeFileHashes(repoPath, allFilePaths);
  const currentAnalysisFeatures = resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, allFilePaths);
  const currentAnalysisFeatureMismatches = existingMeta
    ? findAnalysisFeatureMismatches(existingMeta.analysisFeatures, currentAnalysisFeatures)
    : [];
  if (
    existingMeta &&
    currentAnalysisFeatureMismatches.length > 0 &&
    !analysisFeatureMismatchLogged
  ) {
    // Covers a repository gaining or losing its first applicable source file:
    // the persisted file list cannot predict that transition before the
    // pipeline, but an incremental top-up would leave unchanged rows incomplete.
    log(
      `analysis capabilities changed (${currentAnalysisFeatureMismatches.join(', ')}); ` +
        `forcing a full rebuild so persisted feature evidence is complete.`,
    );
    options = { ...options, force: true };
  }

  // Decide incremental vs full at THIS point (post-pipeline, pre-DB).
  // All eligibility conditions are checked here against the actual
  // pipeline output — no separate pre-pipeline prediction to desync from
  // (Bugbot review on PR #1479: a prediction that flipped post-pipeline
  // could skip the embedding cache load and then take the full-rebuild
  // path, silently losing embeddings).
  const isIncremental =
    !options.force &&
    !!existingMeta &&
    // Belt and braces, not a second gate: the guard above already set `force`
    // on exactly this condition, and `!options.force` short-circuits before
    // this conjunct is reached. Kept so the eligibility contract reads whole.
    !schemaFingerprintMismatch(existingMeta.schemaFingerprint) &&
    currentAnalysisFeatureMismatches.length === 0 &&
    !!existingMeta.fileHashes &&
    Object.keys(existingMeta.fileHashes).length > 0 &&
    repoHasGit &&
    allFilePaths.length > 0;

  const hashDiff = isIncremental
    ? diffFileHashes(newFileHashes, existingMeta!.fileHashes)
    : undefined;

  // #3016: `skipDerivedGraphPhases` was decided BEFORE the pipeline, from the
  // persisted metadata alone, so it can only ever be a bet that this run stays
  // surgical. Settle the bet here, where `isIncremental` and the deletion set
  // are both known, and pay it off by running the held-back phases whenever the
  // write plan needs a freshly derived layer:
  //   - not incremental      → full rebuild writes the whole graph, and a graph
  //                            with no Community/Process nodes would publish an
  //                            index with no communities and no flows;
  //   - added/changed/deleted files → the persisted derived layer can miss new
  //                            symbols, keep stale memberships, or reference
  //                            removed ids. Only an empty file-hash diff is a
  //                            proof that Leiden/flows still match.
  const preserveDerivedLayer =
    skipDerivedGraphPhases &&
    isIncremental &&
    !!hashDiff &&
    shouldPreservePersistedDerivedGraph(hashDiff);
  if (skipDerivedGraphPhases && !preserveDerivedLayer) {
    progress('communities', 58, 'Detecting code communities and flows...');
    await pipelineResult.runDeferredDerivedPhases?.();
  }

  // #2 atomic index publish: on a full rebuild, build the fresh DB at a temp
  // path and swap it over the live index in one rename at the very end, so a
  // concurrent MCP reader opening mid-build only ever sees the previous
  // complete index (never a wiped/half-built file) and a crash leaves the old
  // index intact. The whole build flows through the singleton connection, so
  // only initLbug/wipeLbugDbFiles below take the temp target.
  //
  // POSIX only: the common CLI/serve-worker analyze paths skip the native close
  // (closeLbugBeforeExit, #2264) and leave the build handle open at swap time.
  // POSIX renames an open file cleanly; a same-process open handle blocks the
  // rename on Windows. Windows keeps the current in-place behavior
  // (buildPath === lbugPath, no swap) until that is resolved (see §12/follow-up).
  const isFullRebuild = !(isIncremental && hashDiff);
  // Where the swap is allowed:
  //  - POSIX renames an open file, so the usual skip-native-close (#2264) is
  //    fine and the swap always applies.
  //  - Windows can swap only when a real close is safe to release the build
  //    handle before the rename — i.e. NOT a --pdg run (the #2264 destructor
  //    crash). Unverified on Windows CI; falls back to in-place otherwise.
  const posixSwap = process.platform !== 'win32';
  // #2614 Windows: the forced real-close before the rename re-bets that #2264 is
  // --pdg-only, which is unproven (the CLI/worker skip the native close
  // UNCONDITIONALLY) and unverifiable without a Windows runner. Keep it opt-in
  // (GITNEXUS_ATOMIC_WINDOWS_SWAP=1) so the default Windows analyze stays on the
  // proven in-place path; enable it only to test the Windows swap.
  const windowsSwapOk =
    process.platform === 'win32' &&
    options.pdg !== true &&
    process.env.GITNEXUS_ATOMIC_WINDOWS_SWAP === '1';
  // Incremental atomicity stages the whole index before mutation. It remains
  // opt-in for ordinary analyze runs; watch mode requests it for failure
  // preservation. The copy requests a filesystem clone and records its actual
  // duration, while Node falls back to a normal copy where reflinks are absent.
  const wantAtomicIncremental =
    isIncremental &&
    !!hashDiff &&
    process.platform !== 'win32' &&
    (options.atomicIncremental === true || process.env.GITNEXUS_ATOMIC_INCREMENTAL === '1');
  // #2614 F3: the copy-then-swap stages ONLY the main lbug file, so a live index
  // carrying an orphan .wal/.shadow (a silently-failed prior checkpoint) would
  // be copied incompletely and lose that delta. Only take the atomic path when
  // the live index is a consolidated single file; otherwise fall back to the
  // in-place writeback, which the next open replays correctly.
  const atomicIncremental =
    wantAtomicIncremental && (await inspectLbugSidecars(lbugPath)).kind === 'clean';
  if (wantAtomicIncremental && !atomicIncremental) {
    log('atomic-incremental: live index carries orphan sidecars — using in-place writeback');
  }
  // `let` (#2841 review H2): an escalation discovered ~440 lines below — from
  // EITHER cause, a blocked extension or an oversized write set — can upgrade
  // an in-place incremental write to a staged one, because that valve's plan is
  // wipe-then-COPY over this very path. See the upgrade at the escalation
  // valve. Nothing between here and there reads either binding except
  // `initLbug(buildPath)`, which the upgrade re-runs against the staging path.
  let useAtomicSwap = (isFullRebuild || atomicIncremental) && (posixSwap || windowsSwapOk);
  // Set only at the first operation that can mutate the live graph store.
  // Pre-write failures (config, lock, parsing, metadata, importer expansion)
  // remain retryable even when this platform cannot use an atomic swap.
  let liveIndexMutationStarted = false;
  // #2658: a per-run staging name (was the fixed `lbug.new`). Even under the
  // single-writer lock, a unique name means a crashed run's half-built staging
  // file can never be mistaken for — or clobber — a live run's; the lock's
  // orphan sweep (sweepStagingArtifacts) reclaims stragglers on the next
  // acquire. The `.staging.` prefix is what that sweep matches.
  let buildPath = useAtomicSwap ? `${lbugPath}.staging.${randomUUID()}` : lbugPath;

  if (isIncremental && hashDiff) {
    log(
      `Incremental: changed=${hashDiff.changed.length}, ` +
        `added=${hashDiff.added.length}, ` +
        `deleted=${hashDiff.deleted.length} ` +
        `(skipping wipe + ${
          allFilePaths.length - hashDiff.toWrite.length
        } unchanged file rows preserved)`,
    );
    // Set the dirty flag BEFORE any destructive DB mutation. Cleared on
    // success at the meta-save step. Scoped to this branch's meta.json.
    const now = Date.now();
    await saveMeta(metaDir, {
      ...existingMeta!,
      incrementalInProgress: {
        startedAt: now,
        updatedAt: now,
        phase: 'pre-write',
        toWriteCount: hashDiff.toWrite.length,
        directWriteCount: hashDiff.toWrite.length,
      },
    });
    if (atomicIncremental) {
      // Stage the live index into the temp so the in-place delete/writeback
      // below mutates the COPY, and the end-of-run swap publishes it atomically.
      // Clear any stale temp first (a crashed run), then clone/copy the
      // consolidated single-file live index.
      await wipeLbugDbFiles(buildPath);
      const copyStartedAt = Date.now();
      await fs.copyFile(lbugPath, buildPath, fsConstants.COPYFILE_FICLONE);
      log(
        `atomic-incremental: staged ${lbugPath} in ${Date.now() - copyStartedAt}ms ` +
          '(copy-on-write requested; filesystem fallback is allowed)',
      );
    }
  } else {
    // Full rebuild path: wipe DB files first.
    // Set the dirty flag BEFORE the wipe whenever a prior meta exists,
    // mirroring the incremental branch above (#2099 F1, KTD2b). Without it a
    // full rebuild crashing between the wipe and the end-of-run saveMeta
    // leaves a meta that vouches for a DB it no longer matches — the next
    // clean-tree run's fast path would certify a destroyed DB (or, after a
    // pdg flip, certify zombie/missing BasicBlock rows indefinitely).
    // toWriteCount: 0 is the full-path sentinel (no incremental write set).
    if (existingMeta) {
      const now = Date.now();
      await saveMeta(metaDir, {
        ...existingMeta,
        incrementalInProgress: {
          startedAt: now,
          updatedAt: now,
          phase: 'full-rebuild',
          toWriteCount: 0,
        },
      });
    }
    await closeLbug();
    // Shared loud wipe (#2409 + tri-review 4669518496 P2-4). The 4-file
    // family list — `.shadow` included, because a checkpoint-in-flight crash
    // leaves a shadow sidecar that is replay poison next to a freshly created
    // DB file — lives in wipeLbugDbFiles so this site and the escalation
    // valve below can never drift. Failures now throw a typed LbugWipeError
    // (ENOENT-verified removal) instead of silently letting initLbug reopen
    // a still-populated DB this run believes it wiped.
    //
    // With the atomic swap (POSIX), this wipes the TEMP build target
    // (`buildPath` = `<lbugPath>.new`, clearing any stragglers from a crashed
    // run) and leaves the live index untouched until the end-of-run swap. On
    // Windows buildPath === lbugPath, so this is the original in-place wipe.
    if (buildPath === lbugPath) liveIndexMutationStarted = true;
    try {
      await wipeLbugDbFiles(buildPath);
    } catch (error) {
      if (liveIndexMutationStarted) recordLiveIndexMutationRisk(error);
      throw error;
    }
  }

  // Size the buffer pool to the graph just built by the pipeline (a page cache
  // over the on-disk index, which scales with node/edge count) instead of the
  // fixed 2 GiB default, whose eager commit dominates large-repo analyze. The
  // size is clamped to [COPY-safety floor, default], so it only ever shrinks
  // the pool; env override / no-hint paths are unchanged. See
  // resolveBufferManagerSize / estimateBufferPool.
  setBufferPoolSizeHint(
    estimateBufferPool(
      pipelineResult.graph.nodeCount +
        pipelineResult.graph.relationshipCount +
        // Streamed edges left the heap but still get COPYed, so they are part of
        // the real load volume (#2680). The hint only ever SHRINKS the pool, so
        // omitting them would starve the COPY at exactly the scale streaming
        // exists to serve.
        (pipelineResult.graphEmitManifest?.totalRows ?? 0),
    ),
  );

  // Full rebuild (POSIX) builds into the temp `buildPath`; incremental and
  // Windows use `buildPath === lbugPath` in place.
  try {
    await initLbug(buildPath);
  } catch (error) {
    if (liveIndexMutationStarted) recordLiveIndexMutationRisk(error);
    throw error;
  }

  // Manual WAL checkpoint driver (#1741): periodically drain the WAL
  // from JS so the un-retriable native auto-checkpoint almost never
  // has work left to do. Failures of the manual CHECKPOINT are absorbed
  // by the driver's bounded retry; the final un-recoverable error still
  // surfaces via the surrounding write that follows the failed flush.
  // Opt-out via `GITNEXUS_WAL_MANUAL_CHECKPOINT=0` (the driver itself
  // returns a no-op handle when disabled). Analyze-only: MCP and serve
  // paths continue to rely on the close-time CHECKPOINT in `safeClose`.
  // `let`: the incremental branch's escalation valve (#2409) stops this driver
  // around its close→wipe→reopen strategy switch and starts a fresh one.
  let walCheckpointDriver: WalCheckpointDriver = startWalCheckpointDriver();
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    // #2409 escalation valve outcome, hoisted above the incremental branch so
    // the vector-index recreation seam in Phase 4 below can tell "surgical
    // incremental" (DB files survived — the HNSW index with them) apart from
    // "escalated full write" (DB wiped, index destroyed) — tri-review
    // 4669518496 P1.
    let escalatedFullWrite = false;
    let incrementalStats: AnalyzeResult['incrementalStats'];
    // Phase 3.5's restore scope (FIX 3 of this shipping review): on the
    // SURGICAL write plan this is the exact file set whose rows
    // deleteNodesForFiles just removed — only THOSE files' cached embedding
    // rows need re-inserting (everything else still sits in the DB, and
    // re-inserting it would PK-conflict). `null` means the DB was wiped
    // (full rebuild or escalated write): the embedding table is fresh and
    // every cached row must come back. Deriving this in memory replaces the
    // old whole-table `RETURN e.id` pre-read, which rescanned data this
    // process already holds and — worse — ran a read against the DB between
    // writeback and finalize for no recovery benefit.
    let deletedFilePathsForRestore: Set<string> | null = null;
    // True once this run has persisted only a CHANGED SUBGRAPH. The post-write
    // collapse check compares the whole in-memory graph against the whole DB,
    // which is only a like-for-like comparison on a full rebuild.
    let wroteChangedSubgraphOnly = false;
    let incrementalFtsRebuildTables: Set<string> | undefined;
    if (isIncremental && hashDiff) {
      // ── Incremental DB writeback ───────────────────────────────────
      // 0. Expand the writable set with transitive importers of
      //    changed/deleted files (bounded BFS).
      //
      //    Reason (Bugbot/Claude review on PR #1479): when a barrel /
      //    re-export file C changes, cross-file resolution may update
      //    CALLS edges between two unchanged files A and B (A imports
      //    from C, C re-exports something from B). Those refined edges
      //    live in `ctx.graph` but would be excluded from the subgraph
      //    if neither endpoint is in the changed set. To catch this,
      //    files that imported (directly OR transitively, through
      //    other unchanged intermediaries) any changed file get pulled
      //    into the writable set so their rows are deleted + rewritten
      //    against the refined edges.
      //
      //    BFS bound: MAX_IMPORTER_BFS_DEPTH. Practically sized to
      //    catch nested barrel chains (e.g. `index.ts → submodule/index.ts
      //    → submodule/impl.ts`) without ballooning into a near-full-
      //    rebuild on monorepos with deep re-export pyramids. Beyond
      //    this depth, the "incremental ≡ full-rebuild" invariant is
      //    self-acknowledged as best-effort; `--force` remains the
      //    escape hatch documented in GUARDRAILS.md.
      //
      //    `queryImportersBatch` reads `IMPORTS` from the pre-pipeline DB
      //    state, so the result is "files that USED TO import the
      //    target" — exactly the set whose previously-stored edges may
      //    no longer match what cross-file resolution produces this run.
      const MAX_IMPORTER_BFS_DEPTH = 4;
      // Escalation thresholds (#2409) live with shouldEscalateIncrementalWrite
      // in incremental/escalation-gate.ts (pure predicate, boundary-tested).
      const writableFiles = new Set<string>(hashDiff.toWrite);
      const directlyChangedCount = writableFiles.size;
      const dirtyStartedAt = existingMeta!.incrementalInProgress?.startedAt ?? Date.now();
      // Dropped-chunk observability (tri-review 4669518496 P2-5): counts
      // importer-BFS chunks whose IMPORTS query failed across ALL depths
      // (degrade-don't-fail — the expansion shrinks instead of the run
      // dying). Stamped into the #2410 crash diagnostics by
      // saveIncrementalDirtyState ITSELF (FIX 6 of this shipping review),
      // not by per-call-site spreads: the closure rebuilds its object from
      // scratch on every call, so a count riding along at only some sites
      // meant any newly added save site would silently erase it — exactly
      // the phases where #2409-class crashes happen. >0-only semantics
      // unchanged: unconditional zero-stamping would churn every
      // strict-equality consumer of the diagnostics shape.
      let droppedImporterChunks = 0;
      const saveIncrementalDirtyState = async (
        phase: string,
        extra: Partial<NonNullable<RepoMeta['incrementalInProgress']>> = {},
      ): Promise<void> => {
        await saveMeta(metaDir, {
          ...existingMeta!,
          incrementalInProgress: {
            startedAt: dirtyStartedAt,
            updatedAt: Date.now(),
            phase,
            toWriteCount: writableFiles.size,
            directWriteCount: directlyChangedCount,
            ...(droppedImporterChunks > 0 ? { droppedImporterChunks } : {}),
            ...extra,
          },
        });
      };

      // Shadow-seed: for ADDED files, the importer query returns 0 (the new
      // file has no IMPORTS rows in the pre-pipeline DB yet). But pre-
      // existing unchanged files may have IMPORTS edges whose module-
      // resolution claim the newcomer can steal under standard JS/TS
      // resolution (Bugbot review on PR #1479). For each added file we
      // derive the shadow candidates and, if the candidate was a known
      // file in the prior meta, seed it into the BFS frontier so its
      // importers — surfaced via the importer BFS — get their CALLS edges
      // re-resolved against the new file. See shadow-candidates.ts for
      // the full pattern catalogue.
      const priorFileSet = new Set<string>(
        existingMeta?.fileHashes ? Object.keys(existingMeta.fileHashes) : [],
      );
      const shadowSeed: string[] = [];
      for (const added of hashDiff.added) {
        for (const cand of shadowCandidatesFor(added)) {
          if (priorFileSet.has(cand) && !writableFiles.has(cand)) {
            shadowSeed.push(cand);
          }
        }
      }

      {
        // Batched per depth level (#2409): one IN-list query per ~200-path
        // chunk instead of one query per frontier file — a ~700-file frontier
        // used to cost ~700 sequential lock-taking round-trips (~5.6s). The
        // closure is identical: importers already in writableFiles are not
        // re-frontiered, exactly like the per-file loop's membership check.
        let frontier: string[] = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowSeed];
        for (let depth = 0; depth < MAX_IMPORTER_BFS_DEPTH && frontier.length > 0; depth++) {
          const importers = await queryImportersBatch(frontier, {
            onChunkFailure: () => {
              droppedImporterChunks += 1;
            },
          });
          const nextFrontier: string[] = [];
          for (const i of importers) {
            if (!writableFiles.has(i)) {
              writableFiles.add(i);
              nextFrontier.push(i);
            }
          }
          frontier = nextFrontier;
        }
      }
      const importerExpansion = writableFiles.size - directlyChangedCount;
      incrementalStats = {
        changedFiles: hashDiff.changed.length + hashDiff.added.length + hashDiff.deleted.length,
        reparsedFiles: pipelineResult.reparsedFileCount,
        affectedDependents: importerExpansion,
        deletedFiles: hashDiff.deleted.length,
        writeMode: 'incremental',
      };
      await saveIncrementalDirtyState('importer-bfs', {
        importerExpansion,
        shadowSeedCount: shadowSeed.length,
      });
      if (importerExpansion > 0) {
        log(
          `Incremental: +${importerExpansion} importer(s) added to writable set ` +
            `(BFS depth ≤ ${MAX_IMPORTER_BFS_DEPTH}` +
            (shadowSeed.length > 0 ? `, ${shadowSeed.length} shadow-seed(s)` : '') +
            `)`,
        );
      }

      // 1. Compute the EFFECTIVE write-set (Finding 1). Two layers,
      //    composed:
      //      (a) `writableFiles` — toWrite ∪ transitive importers of
      //          changed/deleted files (the bounded BFS above, reading
      //          IMPORTS from the pre-pipeline DB).
      //      (b) `computeEffectiveWriteSet` — walks the NEW graph's
      //          edges and pulls in any unchanged-side file that sits
      //          on a writable-boundary-crossing edge (catches refined
      //          cross-file CALLS edges that the pre-run DB couldn't
      //          predict, e.g. a barrel re-export shifting `foo` from
      //          B to D).
      //    The composed set is the input to BOTH deleteNodesForFiles
      //    and extractChangedSubgraph — asymmetry between the two would
      //    leave stale rows or PK-conflict at COPY time.
      const effectiveWriteSet = computeEffectiveWriteSet(pipelineResult.graph, writableFiles);

      const springConfigChanged =
        hashDiff.toWrite.some((filePath) => classifySpringConfigFile(filePath) !== null) ||
        hashDiff.deleted.some((filePath) => classifySpringConfigFile(filePath) !== null);
      if (springConfigChanged) {
        const unresolvedPrefix = escapeCypherString(SPRING_CONFIG_UNRESOLVED_PREFIX);
        const persistedSpringConfigConsumers = (await executeQuery(
          'MATCH (n:Property) ' +
            `WHERE n.description CONTAINS '${unresolvedPrefix}' ` +
            'RETURN n.id AS id, n.description AS description ' +
            'UNION ALL ' +
            'MATCH (n:Class) ' +
            `WHERE n.description CONTAINS '${unresolvedPrefix}' ` +
            'RETURN n.id AS id, n.description AS description ' +
            'UNION ALL ' +
            'MATCH (n:Record) ' +
            `WHERE n.description CONTAINS '${unresolvedPrefix}' ` +
            'RETURN n.id AS id, n.description AS description',
        )) as PersistedSpringConfigConsumerRow[];
        const springConfigConsumerDriftFiles = collectSpringConfigConsumerDriftFiles(
          pipelineResult.graph,
          persistedSpringConfigConsumers,
        );
        for (const filePath of springConfigConsumerDriftFiles) effectiveWriteSet.add(filePath);
        if (springConfigConsumerDriftFiles.size > 0) {
          log(
            `Incremental: +${springConfigConsumerDriftFiles.size} file(s) added for ` +
              'Spring config consumer property drift',
          );
        }
      }

      // `frameworkAnnotations` is derived from cross-file JVM visibility, so
      // an unchanged Class row can change when a same-package declaration is
      // added or removed without producing an IMPORTS edge. Compare the fresh
      // graph against the pre-write DB and rewrite only files whose persisted
      // value drifted. Add them after edge-boundary expansion: relationships
      // touching these files are already included by extractChangedSubgraph,
      // while pulling every unchanged neighbor would add no correctness.
      // Only supported Spring Bean source changes can alter this property;
      // avoid materializing every persisted Class row for unrelated language
      // updates. Check deleted paths too so removing/renaming a Java shadowing
      // declaration still refreshes unchanged Spring candidates.
      const beanSourceChanged =
        hashDiff.toWrite.some(isSpringBeanCandidateSourceFile) ||
        hashDiff.deleted.some(isSpringBeanCandidateSourceFile);
      if (beanSourceChanged) {
        const persistedFrameworkAnnotations = (await executeQuery(
          'MATCH (c:Class) ' + 'RETURN c.id AS id, c.frameworkAnnotations AS frameworkAnnotations',
        )) as PersistedFrameworkAnnotationRow[];
        const frameworkAnnotationDriftFiles = collectFrameworkAnnotationDriftFiles(
          pipelineResult.graph,
          persistedFrameworkAnnotations,
        );
        for (const filePath of frameworkAnnotationDriftFiles) effectiveWriteSet.add(filePath);
        if (frameworkAnnotationDriftFiles.size > 0) {
          log(
            `Incremental: +${frameworkAnnotationDriftFiles.size} file(s) added for ` +
              'framework annotation property drift',
          );
        }

        const persistedSpringBeanDeclarations = (await executeQuery(
          'MATCH (m:Method)-[r:CodeRelation]->(b:CodeElement) ' +
            "WHERE r.type = 'DECLARES' AND r.reason STARTS WITH 'spring-bean-factory:' " +
            'RETURN b.id AS id, b.filePath AS filePath, r.reason AS reason',
        )) as PersistedSpringBeanDeclarationRow[];
        const springBeanDeclarationDriftFiles = collectSpringBeanDeclarationDriftFiles(
          pipelineResult.graph,
          persistedSpringBeanDeclarations,
        );
        for (const filePath of springBeanDeclarationDriftFiles) effectiveWriteSet.add(filePath);
        if (springBeanDeclarationDriftFiles.size > 0) {
          log(
            `Incremental: +${springBeanDeclarationDriftFiles.size} file(s) added for ` +
              'Spring Bean factory declaration drift',
          );
        }
      }
      // Deduped: deleted entries may already appear via importer-BFS
      // expansion (the importer BFS can return a now-deleted path), which
      // would otherwise hand deleteNodesForFiles the same path twice in one
      // batch (Bugbot LOW finding on PR #1479).
      const filesToDelete = [...new Set([...effectiveWriteSet, ...hashDiff.deleted])];
      await saveIncrementalDirtyState('effective-write-set', {
        importerExpansion,
        shadowSeedCount: shadowSeed.length,
        effectiveWriteCount: effectiveWriteSet.size,
        deleteCount: filesToDelete.length,
      });

      // Escalation valve (#2409): when the effective write set covers most of
      // the repo, per-file surgery is strictly worse than the proven
      // wipe-and-bulk-COPY plan — the same data volume lands either way, but
      // the surgical plan pays per-table deletes plus COPY-into-non-empty
      // tables, and at this size it measured SLOWER than a full DB load. The
      // pipeline already produced the FULL graph (it always does), so only the
      // DB write plan changes here; fileHashes/meta bookkeeping is identical.
      // Thresholds + the AND-gate live in incremental/escalation-gate.ts.
      const writeFraction = effectiveWriteSet.size / Math.max(1, allFilePaths.length);
      // VECTOR gate (#2623) — load the extension BEFORE a single embedding row
      // is touched. `deleteNodesForFiles` below opens with the CodeEmbedding
      // join-delete, and LadybugDB refuses all DML on a table carrying its HNSW
      // index unless VECTOR is loaded on this connection; nothing else on this
      // path loads it until Phase 4, so every incremental run over a DB that
      // already built `code_embedding_idx` died here. Same seam the FTS drop
      // occupies at the head of this branch (#2589): index lifecycle first,
      // then rows. UNCONDITIONAL — not gated on `shouldGenerateEmbeddings` —
      // because a DB carrying the index from an earlier `--embeddings` run hits
      // the identical wall on a plain incremental run.
      //
      // When VECTOR genuinely cannot load, the table is immutable (the index
      // cannot be dropped without the extension either), so surgery is
      // impossible: fall through to the escalation valve's wipe-and-COPY plan,
      // which rebuilds the DB files outright and needs no embedding-row DML.
      //
      // FTS twin (#2841): the identical wall exists for every table carrying an
      // FTS index — LadybugDB refuses the DML at BIND time, so even a zero-row
      // DETACH DELETE fails, and `DROP_FTS_INDEX` is itself an FTS-extension
      // function (there is no SQL `DROP INDEX` at all), so the indexes cannot be
      // cleared in place either. Same verdict, same remedy: escalate. Both gates
      // share ONE `SHOW_INDEXES` read — they answer different questions about the
      // same catalog snapshot, and nothing between here and the write plan
      // creates or drops an index.
      const indexCatalogRows = await readIndexCatalogSnapshot();
      const embeddingRowDmlSafe = await ensureEmbeddingRowDmlSafe(indexCatalogRows);
      const ftsRowDmlSafe = await ensureFtsRowDmlSafe(indexCatalogRows);
      const extensionForcedRebuild = !embeddingRowDmlSafe || !ftsRowDmlSafe;
      // `!options.dropEmbeddings` (H1): this rescue reads the rows back OUT of
      // the DB, so it must never fire on the one path whose entire purpose is to
      // destroy them. `--drop-embeddings` deliberately leaves `cachedEmbeddings`
      // empty (`deriveEmbeddingMode` returns `shouldLoadCache: false` for it by
      // construction — see the four-mode comment at the cache-load site), and its
      // `options.force = true` conversion sits INSIDE
      // `if (existingMeta?.embeddingCheckpoint)`, so a repo without a checkpoint
      // stays incremental and arrives here holding exactly the state the rescue
      // reads as "the index metadata did not account for them" — restoring the N
      // rows the operator just asked to wipe, printing `Preserving N` on top of
      // this run's own `Dropping N` line, and exiting 0.
      //
      // The predicate has to be the FLAG, not `shouldLoadCache`: that would also
      // disable the rescue in the case it exists for (meta says 0 embeddings
      // while rows survive ⇒ `hasExisting` false ⇒ `shouldLoadCache` false), i.e.
      // it would fix the wipe by deleting the safeguard. Covers
      // `--drop-embeddings --embeddings` too — the rescue repopulates
      // `cachedEmbeddingNodeIds`, which Phase 4 hands `runEmbeddingPipeline` as
      // the already-embedded set, so the very nodes the user asked to REGENERATE
      // would be skipped.
      if (extensionForcedRebuild && !options.dropEmbeddings && cachedEmbeddings.length === 0) {
        // The escalation below WIPES the DB files, and Phase 3.5 restores
        // embedding rows from `cachedEmbeddings` — which is only populated when
        // `deriveEmbeddingMode` saw `meta.stats.embeddings > 0`. A DB whose meta
        // under-reports its embeddings (meta restored from an older run, or a
        // count that never got stamped) would therefore have every vector
        // silently destroyed by a rebuild it did not ask for. Read them now,
        // while the DB is still intact — a plain MATCH, which needs no VECTOR
        // extension. Rows whose owning node is gone are dropped by Phase 3.5's
        // live-graph filter, exactly as on any other wiped path.
        const rescued = await loadCachedEmbeddings();
        if (rescued.embeddings.length > 0) {
          cachedEmbeddings = rescued.embeddings;
          cachedEmbeddingNodeIds = rescued.embeddingNodeIds;
          log(
            `Preserving ${rescued.embeddings.length} embedding row(s) across the forced rebuild ` +
              `(the index metadata did not account for them).`,
          );
        }
      }
      // Hoisted out of the `||` below (§5.D): the size verdict has to be KNOWN
      // even when a blocked extension already forced the rebuild, or the message
      // cannot report both. Pure predicate over three numbers
      // (incremental/escalation-gate.ts), so evaluating it unconditionally costs
      // nothing and has no side effects.
      const sizeForcedRebuild = shouldEscalateIncrementalWrite(
        filesToDelete.length,
        effectiveWriteSet.size,
        allFilePaths.length,
      );
      if (extensionForcedRebuild || sizeForcedRebuild) {
        escalatedFullWrite = true;
        // #3016: escalation converts this run into a wipe + full bulk COPY of
        // the in-memory graph, so the derived layer the skip was betting on
        // preserving has to exist in that graph after all. Same reasoning as
        // the not-incremental branch above, just discovered later.
        if (preserveDerivedLayer) {
          progress('communities', 63, 'Detecting code communities and flows...');
          await pipelineResult.runDeferredDerivedPhases?.();
        }
        // Every live cause is named, not just the first: a DB can carry BOTH a
        // vector index and FTS indexes, and reporting one cause while the other
        // is equally fatal is how #2841 stayed mis-diagnosed for so long. §5.D:
        // that argument crosses the extension/size boundary too, so the size
        // cause is APPENDED here rather than selected between — the old either/or
        // ternary dropped the write-set line whenever an extension also blocked.
        const escalationCauses: string[] = [];
        const degradedEffects: string[] = [];
        // H5: `readIndexCatalogRows()` returning nothing means "could not prove
        // anything", and both gates correctly fail CLOSED on it — but a
        // fail-closed sentinel is not evidence. Asserting "the CodeEmbedding
        // vector index exists" from it is affirmatively FALSE on a repo that
        // never enabled embeddings, and the only truthful signal (the adapter's
        // `Could not read the LadybugDB index catalog` warning) goes to the pino
        // stderr stream, NOT this `onLog` callback — so `gitnexus serve` and the
        // analyze worker UI would show the invented claim alone. Emit one honest
        // cause naming the unsettled read instead of two fabricated ones.
        // Tested against the explicit sentinel, NOT truthiness: §5.A made the
        // failed read representable (`INDEX_CATALOG_UNREADABLE`) precisely so
        // "the caller passed nothing" and "the caller tried and could not prove
        // anything" stop sharing one value — and the sentinel is a Symbol, so a
        // `!indexCatalogRows` test would silently never fire here.
        const indexCatalogUnreadable = indexCatalogRows === INDEX_CATALOG_UNREADABLE;
        // `extensionForcedRebuild &&`: an unreadable catalog is only a CAUSE
        // when it actually blocked something. A size-only escalation whose
        // catalog read happened to fail still had both gates answer "safe"
        // (both extensions loaded), and claiming otherwise would trade one
        // invented cause for another.
        if (extensionForcedRebuild && indexCatalogUnreadable) {
          const blockedExtensions = [
            !embeddingRowDmlSafe ? 'VECTOR' : undefined,
            !ftsRowDmlSafe ? 'FTS' : undefined,
          ].filter((name): name is string => name !== undefined);
          escalationCauses.push(
            `the LadybugDB index catalog could not be read (the read error is on the analyzer's ` +
              `warning stream), so neither a live ${EMBEDDING_TABLE_NAME} vector index nor a live ` +
              `FTS search index could be ruled out, and the ${blockedExtensions.join(' and ')} ` +
              `extension${blockedExtensions.length > 1 ? 's' : ''} could not be loaded to rewrite ` +
              `indexed rows in place either`,
          );
        }
        if (!embeddingRowDmlSafe) {
          if (!indexCatalogUnreadable) {
            escalationCauses.push(
              `the ${EMBEDDING_TABLE_NAME} vector index exists but the VECTOR extension could not be ` +
                `loaded, so embedding rows cannot be rewritten in place`,
            );
          }
          degradedEffects.push(
            'Semantic search falls back to exact scan until VECTOR is available.',
          );
        }
        if (!ftsRowDmlSafe) {
          if (!indexCatalogUnreadable) {
            // Self-contained subject (H5): `join('; and ')` used to render "…the
            // CodeEmbedding vector index exists … and THIS INDEX carries FTS
            // search indexes…", pointing "this index" at the vector index just
            // named — and an index does not carry indexes.
            escalationCauses.push(
              `the graph store carries one or more FTS search indexes but the FTS extension could ` +
                `not be loaded, so no indexed table can be written in place (LadybugDB refuses the ` +
                `write at bind time, and the indexes cannot be dropped without the extension either)`,
            );
          }
          degradedEffects.push('Full-text/BM25 search stays degraded until FTS is available.');
        }
        if (sizeForcedRebuild) {
          escalationCauses.push(
            `the effective write set covers ${effectiveWriteSet.size}/${allFilePaths.length} ` +
              // Display clamp only (predicate unchanged): BFS-found deleted
              // importers can push the numerator past the CURRENT file list, so
              // the raw fraction can exceed 1 — see the population-mismatch note
              // on shouldEscalateIncrementalWrite (tri-review 4669518496).
              `files (${Math.min(100, Math.round(writeFraction * 100))}%)`,
          );
        }
        // Remedy by CLASSIFICATION, never hand-written (#2841 review H3). The
        // old tail always said "run `gitnexus doctor` … or set
        // GITNEXUS_LBUG_EXTENSION_INSTALL=auto", which is affirmatively WRONG
        // for the `missing_dependency` class (Windows error 126 / absent
        // OpenSSL 3, #2374/#2669): its own remedy states that reinstalling will
        // not help, and that class is precisely the environment this escalation
        // path was registered for on the Windows matrix. Every other rendering
        // in this file already routes through `diagnoseExtensionLoad` — the
        // FTS_UNAVAILABLE_LEAD degrade log and the `--repair-fts` failure tail
        // — so this one does too, once per BLOCKED extension and with that
        // extension's own label, because the FTS-specific advice the classifier
        // emits (`gitnexus analyze --repair-fts`) must never be dispensed for
        // VECTOR. Emitted verbatim and alone: only the classified remedy
        // reaches the user, never the raw load `reason`, so the message stays
        // path-free (#2374/#2375 redaction contract). Reached exactly when an
        // extension blocked the write — `degradedEffects` is pushed by the two
        // `!…RowDmlSafe` branches above and by nothing else, and each of those
        // gates only answers `false` after its own load attempt failed, so the
        // capability record it reads is always populated. Looked up through the
        // shared `getExtensionCapability`/`getFtsCapability` accessors rather
        // than a sixth hand-spelled `.find((c) => c.name === …)`: the extension
        // NAME is the one string the lookup is keyed on, and it belongs in
        // extension-loader.ts.
        const extensionRemedies = [
          !embeddingRowDmlSafe
            ? { reason: getExtensionCapability('VECTOR')?.reason, label: 'VECTOR' }
            : undefined,
          !ftsRowDmlSafe ? { reason: getFtsCapability()?.reason, label: 'FTS' } : undefined,
        ]
          .filter((e): e is { reason: string | undefined; label: string } => e !== undefined)
          .map(({ reason, label }) => diagnoseExtensionLoad(reason, label).remedy);
        log(
          `Incremental: ${escalationCauses.join('; and ')} — switching to a full DB write ` +
            `(wipe + bulk COPY) for this run; file-level incremental bookkeeping is unaffected.` +
            (degradedEffects.length > 0
              ? ` ${degradedEffects.join(' ')} ${extensionRemedies.join(' ')}`
              : ''),
        );
        // toWriteCount: 0 is the established full-path dirty-flag sentinel;
        // the real counters ride along for crash diagnostics.
        await saveIncrementalDirtyState('escalated-full-write', {
          toWriteCount: 0,
          importerExpansion,
          shadowSeedCount: shadowSeed.length,
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        // Strategy switch: stop the checkpoint driver around the close so its
        // in-flight CHECKPOINT can't race the reopen, drop the DB files
        // (sidecars included), and bulk-load the full graph into a fresh DB —
        // byte-for-byte the full-rebuild write plan. The wipe is the shared
        // ENOENT-verified helper (#2409 + tri-review 4669518496 P2-4): a
        // surviving family member throws a typed LbugWipeError here instead
        // of letting the reopen below resurrect the rows this run just chose
        // to replace wholesale.
        // #2841 review H2 — never destroy the only complete index before its
        // replacement is durable. `buildPath` was frozen ~440 lines above, while
        // this run was still classified incremental, so it still points AT the
        // live index: escalating without this upgrade means
        // `wipeLbugDbFiles(lbugPath)` followed by a bulk COPY in place, and an
        // interrupt, ENOSPC, or COPY failure anywhere in that window leaves NO
        // complete index at all.
        //
        // That invariant is about RECOVERABILITY, which does not depend on why
        // the run escalated — the wipe-then-COPY plan below is identical for
        // both causes, so a size-forced escalation loses the index to a Ctrl-C
        // exactly as an extension-forced one does. Both stage. The escalation
        // rebuilds from the in-memory graph the pipeline already produced, so
        // staging costs no `fs.copyFile` of the old DB: it is peak disk plus a
        // rename — precisely what a plain `--force` full rebuild already pays
        // unconditionally on POSIX.
        //
        // Safe because the gate runs BEFORE any row DML: the DB open at
        // `buildPath` is unmutated, so switching targets loses nothing. The
        // end-of-run swap publishes the staging file atomically, and a failure
        // anywhere before it leaves the previous index live (its own comment
        // says so) with the dirty flag already stamped above for recovery.
        //
        // Knock-on effects of flipping `useAtomicSwap` here, both intended:
        // `ftsFailureIsFatal(..., useAtomicSwap)` now aborts instead of
        // degrading on an FTS *integrity* error — which is exactly that
        // predicate's documented staging contract (throwing abandons a
        // throwaway file and keeps the live index) — and `forceRealCloseForSwap`
        // engages on Windows, which is why the upgrade is gated on the same
        // `posixSwap || windowsSwapOk` policy that governs every other swap.
        // …but NOT when we are escalating out of ignorance. An unreadable
        // catalog means `CALL SHOW_INDEXES()` itself failed, which on a real
        // index means the store is damaged — e.g. a stray directory sitting at
        // `lbug.wal.checkpoint` makes every open of that path an IO exception.
        // Staging would then quietly write a fresh index NEXT to the damage,
        // swap it in, and exit 0: the run "succeeds", the broken sidecar
        // survives untouched, and the next in-place writeback trips over it
        // again. Building in place keeps the underlying IO fault on the failure
        // path where the operator gets a diagnosis (this is what
        // `analyze-wal-checkpoint-failure.test.ts` pins). Staging protects a
        // HEALTHY live index from a machine-level cause; it must not be used to
        // route around a damaged one.
        const catalogWasReadable = indexCatalogRows !== INDEX_CATALOG_UNREADABLE;
        if (catalogWasReadable && !useAtomicSwap && (posixSwap || windowsSwapOk)) {
          useAtomicSwap = true;
          buildPath = `${lbugPath}.staging.${randomUUID()}`;
          log(
            'Incremental: building the replacement index alongside the live one and swapping it in ' +
              'at the end, so an interrupted rebuild leaves the current index intact.',
          );
        }
        await walCheckpointDriver.stop();
        await closeLbug();
        if (buildPath === lbugPath) liveIndexMutationStarted = true;
        await wipeLbugDbFiles(buildPath);
        await initLbug(buildPath);
        walCheckpointDriver = startWalCheckpointDriver();
        await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
          progress('lbug', pct, msg);
        });
      } else {
        // 1a. Drop every FTS index before touching a single row (#2589).
        //     `deleteNodesForFiles` below DETACH DELETEs rows out of tables
        //     that otherwise still carry the FTS index built at the end of
        //     the PREVIOUS analyze run — Phase 3 doesn't drop+rebuild it
        //     until well after this delete completes. LadybugDB's FTS
        //     extension is not proven to survive DML against an indexed
        //     table (its own docs never demonstrate it), and that ordering
        //     is exactly what produced "FTS index 'file_fts' is
        //     inconsistent: term is missing during delete". Dropping first
        //     removes the hazard outright; Phase 3's createSearchFTSIndexes
        //     rebuilds every index from the final row set regardless, so
        //     this is a no-op on its own drop step there.
        // Reuse the snapshot read at the gate above (#2841 cleanup): same run,
        // same connection, and nothing on this branch creates or drops an index
        // in between — so re-reading would only weaken the one-read invariant
        // the snapshot type exists to enforce.
        if (buildPath === lbugPath) liveIndexMutationStarted = true;
        // FTS narrowing is independent of Leiden/flow reuse: even when this
        // run re-derives communities, Ladybug still cannot DML a live FTS
        // index (#2589), so only the tables this write set touches should
        // lose their index. The probe is a question about the DB rather than
        // the fresh graph — a symbol the edit DELETED is in no fresh graph
        // but is still a row that has to go.
        const tablesWithRows = await nodeTablesWithRowsForFiles(filesToDelete, NODE_TABLES);
        // Narrowing 1 — the FTS sweep, from "every configured index" to "the
        // indexes this run must touch". Three sources, and dropping any one of
        // them strands something:
        //   - what the writeback DELETES (the probe above), because a symbol
        //     the edit removed is in no fresh graph but is still a row;
        //   - what it INSERTS (the fresh graph), because inserting under a live
        //     FTS index is the same #2589 hazard as deleting under one;
        //   - what is MISSING right now, because narrowing to the written
        //     tables would otherwise leave keyword search degraded forever on
        //     tables whose index a previous escalation dropped — the next full
        //     rebuild would be the only thing that ever restored them.
        // An unreadable catalog proves nothing about that third set, so it
        // withdraws the narrowing entirely rather than guess.
        const missingFts = await missingSearchFTSIndexTables(indexCatalogRows);
        const touchedFts = missingFts
          ? new Set([
              ...ftsTablesAmong(tablesWithRows),
              ...incrementalFtsTablesFromGraph(pipelineResult.graph, new Set(filesToDelete)),
              ...missingFts,
            ])
          : undefined;
        // Graph-wide Spring synthetic Class nodes are DETACH DELETEd on this
        // branch even when Class is not in the write set
        // (`deleteSpringAutoConfigurationSyntheticClasses`). Always include
        // Class so class_fts is not live across that DML (#2589), including
        // when the fresh graph no longer materializes the synthetics but the
        // DB still holds them.
        if (touchedFts) {
          touchedFts.add('Class');
        }
        incrementalFtsRebuildTables = touchedFts;
        // MEMBER_OF / STEP_IN_PROCESS / ENTRY_POINT_OF edges hang off the nodes
        // the DETACH DELETE below removes, so preserving the Community/Process
        // nodes preserves only half the layer unless these are reattached after
        // the subgraph write puts the member nodes back. Only the probed tables
        // can own such an edge, so they are the only ones worth scanning.
        const derivedSnapshot = preserveDerivedLayer
          ? await snapshotDerivedRelsForFiles(filesToDelete, [...tablesWithRows])
          : [];
        await dropSearchFTSIndexes(indexCatalogRows, incrementalFtsRebuildTables);
        // 1b. Remove the write set's existing rows — batched (#2409): one
        //     DETACH DELETE per table per 200-file chunk. The former per-file
        //     loop issued a count + delete per table per FILE — ~13k
        //     single-row write transactions on a ~700-file write set — which
        //     made this phase slower than a full rebuild and is the WAL-append
        //     storm behind the native mid-writeback deaths in #2409. Errors
        //     are NOT swallowed anymore: a zero-match file is a no-op by
        //     construction, so anything thrown is a real engine failure that
        //     must surface instead of silently skipping (that silent skip was
        //     how #2409 hid its root cause).
        progress('lbug', 62, `Removing rows for changed files (0/${filesToDelete.length})...`);
        await deleteNodesForFiles(filesToDelete, {
          onChunk: (done, total) =>
            progress('lbug', 62, `Removing rows for changed files (${done}/${total})...`),
          nodeTables: incrementalFtsRebuildTables
            ? nodeTablesForIncrementalDelete(NODE_TABLES, incrementalFtsRebuildTables)
            : undefined,
        });
        // Surgical path: Phase 3.5 restores exactly these files' embedding
        // rows (FIX 3). Sound because deleteNodesForFiles propagates errors
        // — reaching this line means every listed file's rows are gone
        // deterministically — and this process holds the exclusive DB lock,
        // so no concurrent writer can disturb the derivation.
        deletedFilePathsForRestore = new Set(filesToDelete);
        if (!preserveDerivedLayer) {
          // 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
          //    from the fresh pipeline output below. Required for the
          //    "Leiden runs on the FULL graph" correctness invariant.
          await deleteAllCommunitiesAndProcesses();
        }
        // 2a. Drop INJECTS edges (DI collection injection, #2200) — their
        //     validity is a whole-program property (a third-file change to the
        //     interface or an implementer creates/invalidates edges between two
        //     untouched files), so endpoint-writability extraction can't refresh
        //     them; extractChangedSubgraph re-includes all of them from the
        //     fresh graph (isGraphWideRelType). UNCONDITIONAL, next to the
        //     Communities delete — NOT inside the `options.pdg` block below: the
        //     di phase runs on every persisting analyze (same !skipGraphPhases
        //     regime as communities/processes) while the graph-wide re-include
        //     is unconditional, so a pdg-gated delete would append without
        //     deleting on every non-pdg incremental run (N runs = N copies of
        //     every INJECTS row; CodeRelation has no PK and no read-side dedup).
        await deleteAllInjects();
        // 2b. Spring AOP pointcuts are matched against the full resolved graph;
        // a third-file change can invalidate an edge between unchanged files.
        // Rebuild the complete ADVISED_BY set on every incremental writeback.
        await deleteAllAdvisedBy();
        await deleteSpringAopEvidenceNodes();
        // 2b-bis. Drop the whole async messaging overlay. A RESOLVED
        //     Destination deliberately stores no filePath (so the per-file
        //     DETACH DELETE cannot cut a node shared across files), which also
        //     means the per-file delete can never REMOVE one that is now
        //     orphaned, and the endpoint-writability extract can never ADD one
        //     introduced by a new file. Delete-all here plus the graph-wide
        //     re-include in extractChangedSubgraph rebuilds the layer whole;
        //     the springDestinations phase recomputes it from the full file
        //     list on every persisting analyze, so nothing is lost. Both halves
        //     must move together — deleting without the re-include drops the
        //     layer, re-including without the delete duplicates its edges.
        await deleteAllDestinations();
        // 2c. Drop Spring-owned DECLARES edges (#2415). The
        //     auto-configuration phase scans every metadata file and recomputes
        //     the full set each run; exact reason filtering leaves declarations
        //     owned by other metadata systems untouched.
        await deleteSpringAutoConfigurationDeclarations();
        // 2d. Drop source-unavailable auto-configuration placeholders. Fresh
        //     synthetic nodes are graph-wide in extractChangedSubgraph, so this
        //     also removes an orphan when a newly-added real class takes over.
        await deleteSpringAutoConfigurationSyntheticClasses();
        // 2e. Drop interprocedural TAINT_PATH edges (#2084 M4 U6) when pdg is on
        //     — their validity is a whole-program property (an A→C flow can be
        //     invalidated by a change to an intermediate function on a third
        //     file), so endpoint-writability extraction can't refresh them.
        //     extractChangedSubgraph re-includes all of them from the fresh
        //     graph (isGraphWideRelType), mirroring Community/Process.
        if (options.pdg === true) {
          await deleteAllInterprocTaintPaths();
          // 2f. Drop CALL_SUMMARY edges (PDG FU-C) on an incremental `--pdg`
          //     writeback. They are re-included from the FULL fresh graph
          //     (isGraphWideRelType) and the callSummaries phase recomputes every
          //     summary each run, so delete-all-then-rebuild keeps an unchanged
          //     function's summary from being lost — same contract as TAINT_PATH.
          await deleteAllCallSummaries();
        }

        // 3. Extract the changed subgraph from the FULL ctx.graph and write
        //    only that. Unchanged-file rows in the DB stay untouched. Pass
        //    the SAME effectiveWriteSet so the subgraph and the deletes
        //    cover identical files (asymmetry would silently corrupt).
        const subgraph = extractChangedSubgraph(pipelineResult.graph, effectiveWriteSet, {
          includeDerivedGraphWide: !preserveDerivedLayer,
        });
        wroteChangedSubgraphOnly = true;
        await saveIncrementalDirtyState('load-graph', {
          importerExpansion,
          shadowSeedCount: shadowSeed.length,
          effectiveWriteCount: effectiveWriteSet.size,
          deleteCount: filesToDelete.length,
        });
        await loadGraphToLbug(subgraph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
          progress('lbug', pct, msg);
        });
        if (preserveDerivedLayer && derivedSnapshot.length > 0) {
          await restoreDerivedRels(derivedSnapshot);
        }
      }

      // Boundary drain (#2409): checkpoint at the end of the incremental
      // writeback so the WAL it accumulated never lingers into the FTS and
      // embedding phases — a later crash leaves only post-checkpoint WAL for
      // the next open to replay. Near-instant when the periodic driver has
      // kept up; rides the driver's bounded retry via runCheckpointWithRetry.
      await checkpointOnce();
    } else {
      // ── Full rebuild ───────────────────────────────────────────────
      // Pass the streamed PDG-emit manifest (#2202) so the BasicBlock layer that
      // was flushed to CSV during the emit loop is COPY'd alongside the
      // structural CSVs. Only ever set on a full rebuild (streaming is
      // force-gated), so the incremental branch above never carries it.
      await loadGraphToLbug(
        pipelineResult.graph,
        pipelineResult.repoPath,
        storagePath,
        (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
          progress('lbug', pct, msg);
        },
        pipelineResult.pdgEmitManifest,
        pipelineResult.graphEmitManifest,
      );
    }

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    // The analyze (write) path owns building the search indexes, so it uses
    // the `auto` install policy (LOAD-first, then one bounded INSTALL) —
    // symmetric with the VECTOR/embeddings path below and consistent with the
    // #726 contract. The global `load-only` default (PR #1161) governs the
    // serve/query read paths, not this one. When the extension still cannot be
    // loaded (genuinely offline + not pre-installed, or policy forced to
    // load-only/never), degrade gracefully — exactly like the VECTOR path — so
    // analyze still produces a fully queryable graph; only full-text/BM25
    // search falls back. `--repair-fts` (whose sole job is FTS) still fails
    // loudly on its own path above.
    progress('fts', 85, 'Creating search indexes...');
    const ftsAvailable = await loadFTSExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
    // Tracks whether search indexes actually ended up usable this run — starts
    // as ftsAvailable (extension loaded) but flips to false below when the
    // build/verify step itself fails, so capabilities.fts.status / ftsSkipped
    // stay honest even though that failure no longer aborts the whole analyze.
    let ftsReady = ftsAvailable;
    // Why FTS ended up skipped (#2658 review L2): extension-unavailable up front,
    // or build-failed in the degrade branch below.
    let ftsSkipReason: 'extension-unavailable' | 'build-failed' | undefined = ftsAvailable
      ? undefined
      : 'extension-unavailable';
    if (ftsAvailable) {
      // Degrade rather than throw: createSearchFTSIndexes re-tokenizes every
      // stored row on every run, so a native tokenizer error on a single
      // pre-existing row (#2544/#2546) must not discard this run's otherwise-
      // successful graph/embeddings work — only keyword search degrades.
      const ftsResult = await buildSearchIndexesOrDegrade(executeQuery, {
        tables: incrementalFtsRebuildTables,
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      if (ftsResult.ok) {
        progress('fts', 90, 'Search indexes ready');
      } else if (ftsFailureIsFatal(ftsResult.failureClass, useAtomicSwap)) {
        // #2658: an IO/rename/checkpoint/corruption failure while building FTS
        // is a genuinely broken build on this disk — not a concurrent writer
        // (the single-writer lock rules that out). ONLY fatal on the atomic-swap
        // path: the graph was built into a throwaway staging DB, so throwing
        // before the swap abandons the staging file and leaves the previous live
        // index intact. On an in-place build the live DB is already mutated and
        // cannot be rolled back by throwing (see ftsFailureIsFatal) — those
        // degrade in the branch below instead.
        throw new Error(
          `Search index build failed with an integrity error and the analysis was aborted ` +
            `to avoid publishing a broken index: ${ftsResult.error}. The previous index is ` +
            `left intact. Re-run \`gitnexus analyze\`; if it persists, check the disk for space ` +
            `or corruption.`,
        );
      } else {
        ftsReady = false;
        ftsSkipReason = 'build-failed';
        log(
          `FTS index build failed (${ftsResult.error}) — keyword search degraded this run. ` +
            'Graph and embeddings analysis completed successfully. Run `gitnexus analyze --repair-fts` to retry.',
        );
        progress('fts', 90, 'Search indexes skipped (build failed)');
      }
    } else {
      // For a missing runtime dependency (#2374) the file is present, so the
      // generic "install it with network access" tail in FTS_UNAVAILABLE_MESSAGE
      // contradicts the remedy's own "reinstalling will NOT help" (#2383 F2). Lead
      // with the class-neutral sentence and append only the classified remedy.
      // Same #2383 mock seam as the repair path above — keep the exported
      // `getExtensionCapabilities()` lookup here.
      const ftsReason = getExtensionCapabilities().find((c) => c.name === 'fts')?.reason;
      const { kind, remedy } = diagnoseExtensionLoad(ftsReason);
      log(
        kind === 'missing_dependency'
          ? `${FTS_UNAVAILABLE_LEAD} ${remedy}`
          : FTS_UNAVAILABLE_MESSAGE,
      );
      progress('fts', 90, 'Search indexes skipped (FTS unavailable)');
    }

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    // Runs on BOTH the full-rebuild path and the incremental path:
    //   - Full rebuild / escalated write: DB was wiped, every cached row
    //     needs to come back.
    //   - Incremental (surgical): changed/deleted files' rows were just
    //     deleted by deleteNodesForFiles (a REAL delete since tri-review
    //     4669518496 P2-1 — it joins embedding rows through their owning
    //     nodes), so changed-file vectors need to come back; unchanged-file
    //     rows still exist. Bugbot review on PR #1479 flagged that gating
    //     this on `!isIncremental` silently lost changed-file embeddings.
    //
    // Restore discipline (tri-review 4669518496 / KTD10, restore scope
    // derived in memory since FIX 3 of this shipping review) — filtered and
    // conflict-free, replacing the old insert-everything-and-swallow shape:
    //   1. Live-graph filter: rows whose nodeId no longer exists in the
    //      freshly-built FULL graph are dropped. The cache was read BEFORE
    //      the pipeline ran, so it still carries deleted files' rows —
    //      re-inserting them resurrected orphans (wholesale onto the wiped
    //      paths' empty table) now that the delete above is real.
    //   2. Restore-scope filter, derived WITHOUT touching the DB (the old
    //      shape pre-read every surviving embedding id back out of the
    //      table it had just written): on a wiped path
    //      (`deletedFilePathsForRestore === null`) the table is fresh, so
    //      every live row comes back; on the surgical path only rows whose
    //      owning node's filePath is in the just-join-deleted set are
    //      inserted — everything else still sits in the DB and would
    //      PK-conflict. The derivation is sound because deleteNodesForFiles
    //      propagates errors (a completed writeback means a deterministic
    //      delete outcome) and this process holds the exclusive DB lock (no
    //      concurrent writer).
    // The per-batch try/catch stays as a last-resort guard only — it no
    // longer fires on the happy path.
    let restoredEmbeddingCount = 0;
    if (cachedEmbeddings.length > 0) {
      const cachedDims = cachedEmbeddings[0].embedding.length;
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        cachedEmbeddings = [];
        cachedEmbeddingNodeIds = new Set();
      } else {
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        // (1) Live-graph filter — the FULL pipeline graph (always produced),
        // NOT the incremental subgraph, or unchanged files' rows would be
        // dropped from the restore set.
        const liveEmbeddings = cachedEmbeddings.filter(
          (e) => pipelineResult.graph.getNode(e.nodeId) !== undefined,
        );
        // (2) Restore-scope filter (see the discipline note above).
        const rowsToRestore =
          deletedFilePathsForRestore === null
            ? liveEmbeddings
            : liveEmbeddings.filter((e) => {
                const filePath = pipelineResult.graph.getNode(e.nodeId)?.properties?.filePath;
                return typeof filePath === 'string' && deletedFilePathsForRestore!.has(filePath);
              });
        progress('embeddings', 88, `Restoring ${rowsToRestore.length} cached embeddings...`);
        const EMBED_BATCH = 200;
        for (const batch of chunk(rowsToRestore, EMBED_BATCH)) {
          try {
            await batchInsert(executeWithReusedStatement, batch);
            restoredEmbeddingCount += batch.length;
          } catch {
            /* last-resort guard — conflict-free by construction above */
          }
        }

        // Legacy-orphan sweep (FIX 3, finder B): the live-graph filter's
        // REJECTS — cached rows whose owning node no longer exists — are the
        // rows stranded by the era when the embedding delete was a no-op
        // (tri-review 4669518496 P2-1; schema version stays 6), plus this
        // run's just-deleted files' rows (already join-deleted above — the
        // exact-id DELETE matches nothing for those, so including them is a
        // harmless no-op rather than worth a fragile nodeId parse to
        // exclude). On the SURGICAL path the true legacy orphans still sit
        // in the DB and the node join can never reach them again (no owning
        // node), so delete them by exact row id. On wiped paths the rejects
        // were simply not restored — nothing to sweep. Legacy-tolerant: a
        // sweep failure must never fail a completed writeback, so the whole
        // sweep warns-and-continues.
        if (deletedFilePathsForRestore !== null) {
          const orphanRowIds = cachedEmbeddings
            .filter((e) => pipelineResult.graph.getNode(e.nodeId) === undefined)
            .map((e) => `${e.nodeId}:${e.chunkIndex}`);
          if (orphanRowIds.length > 0) {
            try {
              for (const batch of chunk(orphanRowIds, DELETE_FILES_CHUNK_SIZE)) {
                const listLiteral = `[${batch
                  .map((id) => `'${escapeCypherString(id)}'`)
                  .join(', ')}]`;
                await executeQuery(
                  `MATCH (e:${EMBEDDING_TABLE_NAME}) WHERE e.id IN ${listLiteral} DELETE e`,
                );
              }
              log(
                `Swept ${orphanRowIds.length} cached embedding row(s) with no live owning ` +
                  'node — legacy orphans stranded while the embedding delete was a no-op; ' +
                  'ids already removed with their files match nothing.',
              );
            } catch (err) {
              log(
                `Warning: could not sweep ${orphanRowIds.length} orphaned embedding ` +
                  `row(s) (${(err as Error).message}); they are unreachable by search ` +
                  'joins and will be retried next run.',
              );
            }
          }
        }
      }
    }

    // ── Phase 4: Embeddings (90–98%) ──────────────────────────────────
    const stats = await getLbugStats();

    // Post-write integrity: the pipeline knows exactly how many relationships
    // it produced, and `stats` is what the DB hands back after the write, so a
    // large shortfall is provable rather than inferred — no comparison against
    // the previous index needed. This is the guard for a refresh that reports
    // SUCCESS while leaving the index unusable: edges collapsing to a fraction
    // of what was built, or a `CodeRelation` table that never materialized
    // (which surfaces here as a persisted count of zero).
    //
    // A RATIO, not equality: some relationship types legitimately do not round
    // -trip one-for-one, and `--pdg` writes MORE rows into the same table than
    // the call-graph produced, so demanding equality would fire on healthy
    // runs. Only a collapse is a defect.
    //
    // Fail-safe when `expected` reads 0: an implementation that offloads
    // relationships out of memory may no longer be able to report a total, and
    // a false "your index is broken" is worse than a missed one.
    //
    // STREAMED EDGES COUNT. When `GraphEmitSink` streaming is active the bulk
    // types (CALLS/IMPORTS/REFERENCES/ACCESSES) leave the heap at parse time and
    // never enter `relationshipCount`, so a bare count understates `expected` by
    // most of the edge volume and the ratio passes trivially. Streaming is on for
    // any `force === true` run — which includes the crash/schema-mismatch
    // recovery paths AND the `analyze --force` retry this check's own warning
    // tells the operator to run. Same correction, and for the same reason, as
    // the buffer-pool hint earlier in this file.
    //
    // `structuralRows`, NOT `totalRows`. The manifest's `totalRows` is a
    // buffer-pool size hint and counts EVERY streamed row; PDG edges stream
    // through this same sink (measured: `pdgEmitManifest` absent, zero PDG
    // resident in the graph, 179,676 streamed rows of which ~110k were PDG), so
    // using it compared a structural-plus-PDG expectation against the
    // structural-only measurement below and declared a healthy `--pdg` index
    // INCOMPLETE — 200,501 against 64,764 on a real repo, with every row
    // present. The stamp then forced a rebuild on the next run, which repeated
    // it: a permanent loop on an undamaged index.
    //
    // A pair key cannot separate them — it is `From|To` NODE LABELS, and a PDG
    // edge shares `Function|Function` with `CALLS` — so the sink counts the
    // split at the point it writes, where `relationship.type` is in hand.
    //
    // The GRAPH, not `graph.relationshipCount`. That count is PDG-inclusive on
    // every run that does NOT stream, and streaming needs `force === true`
    // (`resolveStreamGraphEmit` opens with `if (options.force !== true) return
    // false`, `resolveStreamPdgEmit` the same), so plain `analyze --pdg` has no
    // sink and `run.ts` writes the PDG layers into the ordinary graph. A first
    // run on a fresh repo has no `existingMeta`, so it is not incremental and
    // this check RUNS — comparing structural-plus-PDG against structural-only
    // and failing a healthy index. `computeExpectedStructuralRelationships`
    // therefore counts the heap side type-aware too, so both sides measure the
    // same population in every configuration rather than only under `--force`.
    const expectedRelationships = computeExpectedStructuralRelationships(
      pipelineResult.graph,
      pipelineResult.graphEmitManifest,
    );
    // `getLbugStats` returns `edges: undefined` when the count could not be
    // taken, which is a different fact from zero — an edge query that throws
    // must not read as a measured collapse. `nodes > 0` is independent evidence
    // the DB was readable at all, but it says nothing about whether the EDGE
    // query threw, so both conditions are required.
    //
    // STRUCTURAL ONLY, and that is the whole correction. `expected` above counts
    // the in-memory graph plus the streamed STRUCTURAL manifest; the streamed
    // PDG layers never enter `graph.relationshipCount`. But `stats.edges` counts
    // EVERY `CodeRelation` row, and PDG writes into that same table — so on a
    // `--pdg` run the two sides measured different populations and the surplus
    // masked real loss. With 1,000 structural edges expected and 4,000 PDG rows
    // persisted, losing EVERY structural edge still read `persisted = 4000` and
    // cleared the ratio: a total wipeout, reported healthy, on exactly the large
    // repos `--pdg` is used for.
    //
    // Padding `expected` with the PDG rows instead does NOT fix it — it makes
    // the universes match but leaves the ratio judging a minority population:
    // 4,000 of 5,000 still clears 0.5. Only comparing structural against
    // structural asks the question the check exists to ask.
    //
    // FALLBACK when the structural query alone failed. `structuralEdges` is the
    // newer, filtered, `IN`-predicate query; before it existed only `edges` had
    // to succeed, and routing the whole check through the newer one made a
    // single throw disable the guard AND — since the stamp now triggers the
    // automatic rebuild — the repair it drives. When this run had no PDG layer
    // the two counts are equal by construction (nothing writes a PDG row), so
    // `edges` answers the same question and the guard keeps working. With
    // `--pdg` on there is no substitute and the absence stands: it becomes an
    // explicit `'unmeasurable'` verdict below, which preserves rather than
    // erases the previous stamp.
    const structuralCountMissed = stats.nodes > 0 && stats.structuralEdges === undefined;
    const persistedRelationships =
      stats.nodes > 0
        ? (stats.structuralEdges ?? (options.pdg === true ? undefined : stats.edges))
        : undefined;
    // Never swallowed. The count is taken inside a `catch {}` in `getLbugStats`,
    // so without this line a failed measurement is indistinguishable from a
    // healthy one in the logs — and "measured nothing" reading as "measured
    // fine" is the whole class of defect this area keeps producing.
    if (structuralCountMissed) {
      log(
        `Warning: the structural relationship count could not be read` +
          `${stats.structuralEdgesError ? ` (${stats.structuralEdgesError})` : ''}` +
          `${
            persistedRelationships === undefined
              ? '; the graph-write-collapse check produced no verdict this run and any ' +
                'previously recorded collapse is kept rather than cleared.'
              : `; falling back to the unfiltered edge count (${stats.edges}), which is ` +
                'equal to it on this run because no PDG layer was written.'
          }`,
      );
    }
    // NOT COMPARABLE ON AN INCREMENTAL WRITE. That path persists only
    // `extractChangedSubgraph(...)` while both counts here are whole-scope: the
    // full in-memory graph against the entire DB. A 10,000-edge index whose
    // incremental rewrite lost 200 replacements reads 9,800 against 10,000 —
    // comfortably above the ratio — so a corrupt index would be certified
    // complete, and the reverse (a small change to a large index) would report
    // a collapse that did not happen. Producing no verdict is the honest answer
    // until the check is given the write-set delta to compare against; that is
    // the same fail-safe the `expected === 0` case already takes.
    const collapseVerdict: GraphWriteCollapseVerdict = wroteChangedSubgraphOnly
      ? { verdict: 'unmeasurable', reason: 'incremental-write' }
      : detectGraphWriteCollapse(expectedRelationships, persistedRelationships);
    const graphWriteCollapsed =
      collapseVerdict.verdict === 'collapsed'
        ? { expected: collapseVerdict.expected, persisted: collapseVerdict.persisted }
        : undefined;

    // SPLIT ON THE VERDICT, NOT THE WRITE MODE. `saveMeta` is a full atomic
    // overwrite, not a merge, so whichever branch omits the field DELETES the
    // stamp from meta.json — and the stamp is what marks the index incomplete
    // and forces the repairing rebuild.
    //
    // Three-way, explicitly:
    //   collapse detected -> stamp it
    //   healthy           -> CLEAR it (the index really is healthy now)
    //   no verdict        -> carry the previous stamp forward
    //
    // Keying on `wroteChangedSubgraphOnly` implemented that as a TWO-way and got
    // the third case wrong wherever it arose on a FULL run: a run whose
    // structural count could not be READ (the `catch {}` in `getLbugStats`,
    // reachable through the `withConnLock` contention the comment on that call
    // warns about) reaches no verdict, but took the "full run ⇒ clear it"
    // branch and erased a stamp recording real, unrepaired loss. The next run
    // then found nothing forcing a rebuild, took `alreadyUpToDate`, printed
    // "Already up to date" and exited 0 — permanently, which is exactly the
    // failure the stamp exists to prevent.
    //
    // Mirrors `branch: branchLabel ?? existingMeta?.branch` a few lines down in
    // the meta write, which had the preserve-on-absence shape all along.
    const persistedCollapseStamp = selectPersistedCollapseStamp(
      collapseVerdict,
      existingMeta?.graphWriteCollapsed,
    );
    if (graphWriteCollapsed) {
      log(
        `Warning: graph write incomplete — the pipeline produced ${expectedRelationships} ` +
          `relationships but only ${persistedRelationships} are readable from the index. Recording the ` +
          `index as INCOMPLETE (graph-write-collapsed) rather than fresh; re-run ` +
          `\`gitnexus analyze --force\`.`,
      );
    }
    let embeddingSkipped = true;
    let semanticMode: 'vector-index' | 'exact-scan' | undefined;
    // Hoisted out of the Phase 4 block so the Phase 5 gate can tell "the
    // pipeline attempted work and produced nothing" apart from "the pipeline
    // had nothing to attempt" (#2790). `undefined` ≡ the pipeline never ran.
    let embeddingResult: EmbeddingPipelineResult | undefined;
    // What Phase 5 stamps as `embeddingCheckpoint`. `undefined` ≡ clear it
    // (the clean-run contract). Built inside Phase 4 so it carries the identity
    // of the run that actually wrote it — see the assignment below (#2790).
    let pendingEmbeddingCheckpoint: RepoMeta['embeddingCheckpoint'];

    if (shouldGenerateEmbeddings) {
      const { skipForCap, capDisabled, nodeLimit } = deriveEmbeddingCap(
        stats.nodes,
        resumeEmbeddingCheckpoint ? 0 : options.embeddingsNodeLimit,
      );
      if (!skipForCap) {
        embeddingSkipped = false;
        if (capDisabled && stats.nodes > DEFAULT_EMBEDDING_NODE_LIMIT) {
          log(
            `Embedding node-count cap disabled — generating embeddings for ` +
              `${stats.nodes.toLocaleString()} nodes. Ensure sufficient memory; ` +
              `the default ${DEFAULT_EMBEDDING_NODE_LIMIT.toLocaleString()}-node ` +
              `cap exists to prevent OOM.`,
          );
        }
      } else {
        log(
          `Embeddings skipped: ${stats.nodes.toLocaleString()} nodes exceeds ` +
            `the ${nodeLimit.toLocaleString()}-node safety cap. ` +
            `Override with \`--embeddings 0\` to disable the cap, or ` +
            `\`--embeddings <n>\` to set a custom cap.`,
        );
      }
    }

    // ── Vector-index recreation after a wipe-and-restore (tri-review
    // 4669518496 P1 / KTD1) ────────────────────────────────────────────
    // The full-rebuild and escalated-incremental write plans wipe the DB
    // files — the HNSW index with them. Phase 3.5 brought the embedding ROWS
    // back, but on a preserve-only run nothing recreates the index: semantic
    // search silently loses its vector lane (>10k-embedding repos return
    // empty under the exact-scan cap) while meta certified 'vector-index'.
    // Recreate it here, where every gate input is settled:
    //   - restoredEmbeddingCount > 0 — rows actually came back;
    //   - dbWasWiped — surgical incremental runs keep their index (HNSW
    //     self-maintains on insert/delete); only wiped DBs lost it;
    //   - embeddingSkipped — evaluated AFTER the deriveEmbeddingCap decision
    //     above, NOT `!shouldGenerateEmbeddings`: when Phase 4 really runs,
    //     the pipeline builds the index itself after all inserts (firing this
    //     seam first would swap its bulk build for per-row live HNSW
    //     maintenance on the hottest flow), while a capped >50k-node repo has
    //     shouldGenerateEmbeddings=true yet never runs the pipeline — exactly
    //     the case a naive gate would leave index-less again.
    // buildVectorIndex carries its own extension-policy gate and
    // warn-on-failure; the boolean feeds semanticMode so the finalize stamp
    // reflects the DB's ACTUAL state even when recreation fails (extension
    // unavailable → 'exact-scan').
    const dbWasWiped = !isIncremental || escalatedFullWrite;
    if (restoredEmbeddingCount > 0 && dbWasWiped && embeddingSkipped) {
      // Re-import at the seam rather than thread a mutable capture from
      // Phase 3.5 (FIX 3 of this shipping review — the captured function was
      // a fragile moving part): dynamic imports are memoized, and
      // `restoredEmbeddingCount > 0` proves Phase 3.5 already loaded the
      // module, so the lazy-embeddings convention (#2370) holds — no
      // embeddings module loads unless a restore actually happened.
      const { buildVectorIndex } = await import('./embeddings/embedding-pipeline.js');
      const vectorIndexReady = await buildVectorIndex();
      semanticMode = vectorIndexReady ? 'vector-index' : 'exact-scan';
    }

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      if (!embeddingIdentityForRun) {
        const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
        embeddingIdentityForRun = resolveEmbeddingIdentity();
      }
      const embeddingIdentity = embeddingIdentityForRun;
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      // ── A checkpoint save writes ONLY the checkpoint (#2790) ──────────
      // This used to write a full, SUCCESS-shaped meta: new `lastCommit`, new
      // `fileHashes`, `incrementalInProgress: undefined`. All three are lies at
      // this point in the run. The first `onCheckpointWindowStart` fires at
      // batchIndex 0 — before a single embedding row exists — and on a full
      // rebuild the graph is still in the unpublished staging DB
      // (`${lbugPath}.staging.<uuid>`), which the atomic swap only renames into
      // place AFTER Phase 5. A Phase 4 crash therefore threw the whole staging
      // build away while leaving a meta claiming the new commit and the new
      // file hashes: the next run diffed those advanced hashes, got
      // changed=0/added=0/deleted=0, took the incremental path and "preserved"
      // the OLD graph forever — the exact log line reported in #2790 — with the
      // `incrementalInProgress` crash-recovery contract (repo-manager.ts) also
      // cleared mid-run, so nothing could force the rebuild that would heal it.
      //
      // Freshness fields may only advance once the index is published. So:
      // re-read the on-disk meta immediately before writing (the shape the
      // /api/embed checkpoint writer in server/api.ts already uses, which also
      // keeps a concurrent writer's update from being reverted by a stale
      // snapshot) and replace ONLY `embeddingCheckpoint` — plus
      // `stats.embeddings` when the caller actually MEASURED the live count
      // (the post-window `onCheckpoint`). The window-start callback passes
      // nothing: restating the previous run's count there both re-published a
      // stale number and clobbered the live count a preceding `onCheckpoint`
      // had just written.
      const saveEmbeddingCheckpoint = async (
        checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        },
        pendingNodeIds: string[],
        embeddings?: number,
      ): Promise<void> => {
        const latestMeta = (await loadMeta(metaDir)) ?? existingMeta;
        // First-ever analyze of this repo: no meta exists on disk yet (the
        // pre-wipe dirty stamp only fires when one does). Mint the minimum
        // RepoMeta requires, with `lastCommit: ''` — never `currentCommit` —
        // so a crash here cannot make the next run mistake the discarded
        // staging build for an indexed commit.
        const base: RepoMeta = latestMeta ?? {
          repoPath,
          lastCommit: '',
          indexedAt: new Date().toISOString(),
        };
        await saveMeta(metaDir, {
          ...base,
          ...(embeddings === undefined ? {} : { stats: { ...base.stats, embeddings } }),
          // Written by a run that is still IN FLIGHT — see the `kind` doc in
          // repo-manager.ts.
          embeddingCheckpoint: mintInterruptedCheckpoint(
            embeddingIdentity,
            checkpoint,
            pendingNodeIds,
          ),
        });
      };

      embeddingResult = await runEmbeddingPipeline(
        executeQuery,
        executeWithReusedStatement,
        (p) => {
          const scaled = 90 + Math.round((p.percent / 100) * 8);
          const label =
            p.phase === 'loading-model'
              ? httpMode
                ? 'Connecting to embedding endpoint...'
                : 'Loading embedding model...'
              : `Embedding ${p.nodesProcessed || 0}/${p.totalNodes || '?'}`;
          progress('embeddings', scaled, label);
        },
        {},
        cachedEmbeddingNodeIds.size > 0 ? cachedEmbeddingNodeIds : undefined,
        existingEmbeddings,
        {
          forceReembedNodeIds: pendingEmbeddingNodeIds,
          onCheckpointWindowStart: async ({ nodeIds, ...checkpoint }) => {
            await saveEmbeddingCheckpoint(checkpoint, nodeIds);
          },
          // ── The mid-run count is a DIAGNOSTIC, not a gate (#2790) ──────
          // This used to run the count query bare. THIS callback's rejection
          // propagates out of `runEmbeddingPipeline` and kills the whole
          // analyze, so an unavailable count took the run down BEFORE Phase 5
          // ran at all — meaning the tri-state Phase 5 added for exactly this
          // case could never execute.
          //
          // The shared counter (embedding-count.ts) answers `unknown` instead,
          // and `undefined` is already `saveEmbeddingCheckpoint`'s "do not
          // touch stats.embeddings" signal — so the checkpoint still lands,
          // with whatever count is already on disk left alone.
          onCheckpoint: async (checkpoint) => {
            await checkpointOnce();
            const measured = await measurePersistedEmbeddingCount(executeQuery);
            if (measured.kind === 'unknown') {
              log(
                `Warning: could not measure persisted embeddings at the embedding checkpoint ` +
                  `(${measured.reason}); the checkpoint is saved with the last known count.`,
              );
            }
            await saveEmbeddingCheckpoint(
              checkpoint,
              [],
              persistedEmbeddingCountOrUndefined(measured),
            );
          },
        },
      );
      // ── A partial run must NOT clear the checkpoint (#2790) ───────────
      // Dropped nodes hold zero embedding rows, but "zero rows" alone heals
      // nothing: a plain `gitnexus analyze` derives shouldGenerateEmbeddings
      // = false whenever the index already has embeddings, so the pipeline is
      // never called and the nodes stay missing until someone passes
      // --embeddings/--force/--drop-embeddings. Retaining the checkpoint is
      // what restores the pre-#2790 heal: the resume path above forces
      // shouldGenerateEmbeddings regardless of flags and feeds
      // `pendingNodeIds` into `forceReembedNodeIds`. Stamped with THIS run's
      // identity so a later model/provider change trips the resume mismatch
      // error rather than resuming under a foreign identity.
      if (embeddingResult.failedNodeIds.length > 0) {
        // `'partial'` and its attempt chain — see the `kind` doc in
        // repo-manager.ts and `nextAttemptCount` in embedding-checkpoint.ts.
        pendingEmbeddingCheckpoint = mintPartialCheckpoint(
          embeddingIdentity,
          embeddingResult,
          resumedEmbeddingCheckpoint,
        );
      }
      if (embeddingResult.semanticMode === 'exact-scan') {
        semanticMode = 'exact-scan';
        log(
          'Semantic embeddings were generated without a VECTOR index; ' +
            'queries will use exact-scan fallback within the configured limit.',
        );
      } else {
        semanticMode = 'vector-index';
      }
    }

    // ── Phase 5: Finalize (98–100%) ───────────────────────────────────
    progress('done', 98, 'Saving metadata...');

    // Count embeddings in the index (cached + newly generated). Tri-state, and
    // measured by the SHARED counter rather than a local copy — see
    // embedding-count.ts. What that buys HERE: the old silent `catch {}` left
    // "cannot ask" indistinguishable from "wrote nothing", so a diagnostic
    // failure crashed the run at the gate below with no clue why.
    const measuredEmbeddingCount = await measurePersistedEmbeddingCount(executeQuery);
    const embeddingCount = persistedEmbeddingCountOrUndefined(measuredEmbeddingCount);
    if (measuredEmbeddingCount.kind === 'unknown') {
      // Not silent any more: the operator gets the reason the count is unknown.
      log(
        `Warning: could not count persisted embeddings ` +
          `(${measuredEmbeddingCount.reason}); treating the embedding count as unknown.`,
      );
    }

    // ── Phase 5 embedding gate (#2790) ────────────────────────────────
    // Four genuinely different states used to collapse into
    // `embeddingCount === 0`, and the gate hard-crashed on three of them:
    //   1. the pipeline never ran (cap-skipped / not requested) —
    //      `embeddingSkipped`, still short-circuited;
    //   2. the pipeline ran but had NOTHING to embed (totalNodes 0 after the
    //      incremental filter — e.g. a resume whose pending sweep deleted the
    //      last rows) over a legitimately empty table;
    //   3. the count query failed or answered non-numerically (above) — a
    //      diagnostic failure, not an indexing failure;
    //   4. the pipeline embedded and NOTHING persisted — the real defect.
    // Only (4) throws. `attemptedEmbedding` is what separates it from (2):
    // `nodesProcessed` is now the REAL completed-node count and
    // `failedNodeIds` names the nodes whose rows were dropped, so
    // "attempted" ≡ at least one node was walked to a conclusion.
    const attemptedEmbedding =
      !embeddingSkipped &&
      embeddingResult !== undefined &&
      (embeddingResult.nodesProcessed > 0 || embeddingResult.failedNodeIds.length > 0);

    if (attemptedEmbedding && stats.nodes > 0 && embeddingCount === 0) {
      throw new Error(
        'Embedding generation completed without persisted embeddings. ' +
          'The index was not registered to avoid silently reporting embeddings: 0. ' +
          'Check the embedding endpoint/model configuration (GITNEXUS_EMBEDDING_URL / ' +
          'GITNEXUS_EMBEDDING_MODEL) and re-run `gitnexus analyze --embeddings`; ' +
          'the graph itself is unaffected, so `--drop-embeddings` indexes without them.',
      );
    }

    if (embeddingCount === undefined) {
      log(
        'Warning: registering the index without a verified embedding count — the count query ' +
          'did not answer, so stats.embeddings falls back to the last known value. ' +
          'Re-run `gitnexus analyze --embeddings` if semantic search comes back empty.',
      );
    }

    // ── An unverifiable count must leave a way back (#2790) ───────────────
    // The carry-forward below is a GUESS, and the guess is load-bearing (see
    // embedding-count.ts). Clearing the checkpoint on top of it would report
    // unqualified success and erase the only record that this index was never
    // verified.
    //
    // Retain an identity-matching recovery marker instead — `'unverified-count'`,
    // whose whole job is to force the next run past the same-commit fast return
    // so the count can be re-derived (see the `kind` doc in repo-manager.ts).
    // Self-limiting: once the count answers, the marker is cleared, and the run
    // it forces embeds nothing, so `attemptedEmbedding` is false and nothing is
    // re-planted.
    if (
      attemptedEmbedding &&
      embeddingCount === undefined &&
      pendingEmbeddingCheckpoint === undefined &&
      embeddingIdentityForRun !== undefined
    ) {
      log(
        'Retaining an embedding checkpoint so the next `gitnexus analyze` re-derives the count ' +
          'instead of publishing an unverified one as final (#2790).',
      );
      pendingEmbeddingCheckpoint = mintUnverifiedCountCheckpoint(embeddingIdentityForRun, {
        nodesProcessed: embeddingResult?.nodesProcessed ?? 0,
        totalNodes: embeddingResult?.nodesProcessed ?? 0,
        chunksProcessed: embeddingResult?.chunksProcessed ?? 0,
      });
    }

    // A partial index that is honest about itself beats no index — see the
    // `kind` doc in repo-manager.ts for why the dropped nodes are safe to ship.
    if (embeddingResult !== undefined && embeddingResult.failedNodeIds.length > 0) {
      log(
        `Warning: ${embeddingResult.failedNodeIds.length} node(s) lost their embeddings to ` +
          'embedding-endpoint failures and were dropped from this index (#2790). ' +
          'They are recorded as an embedding checkpoint, so the next `gitnexus analyze` run ' +
          'resumes from it and re-embeds exactly those nodes — `gitnexus status` reports the ' +
          `index as incomplete until it succeeds, and the retry gives up after ` +
          `${EMBEDDING_RESUME_MAX_ATTEMPTS} consecutive failures rather than staying incomplete ` +
          'forever. Pass --force or --drop-embeddings to abandon them instead.',
      );
    }

    // What we can honestly persist as the embedding count: the measurement when
    // there is one, else the LAST KNOWN figure — never a fabricated 0 (see
    // embedding-count.ts). Folded by the shared `resolvePersistedEmbeddingCount`
    // so the CLI and the server cannot drift apart on the carry-forward the way
    // they already had on the measurement.
    //
    // "Last known" is the LATEST ON-DISK meta, re-read here (#2790). It used to
    // read `existingMeta`, which is assigned exactly once — before any
    // embedding work — so the fallback republished the pre-run figure and
    // OVERWROTE the fresher count this run's own terminal `onCheckpoint` had
    // already written to disk: prior meta says 0, a clean run inserts
    // embeddings and checkpoints the real count, the final probe is
    // unavailable, and finalization carries the stale 0 forward while reporting
    // success. `loadMeta` never throws (it returns null), and the checkpoint
    // writer already re-reads the same way, so this is the same freshness
    // discipline applied to the same field.
    const latestMetaForCount =
      embeddingCount === undefined ? ((await loadMeta(metaDir)) ?? existingMeta) : undefined;
    const persistedEmbeddingCount = resolvePersistedEmbeddingCount(
      measuredEmbeddingCount,
      latestMetaForCount?.stats?.embeddings,
    );

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    // `semanticMode` is authoritative when set (Phase 4 reported what it
    // built, or the wipe-and-restore seam above verified/recreated the index
    // — tri-review 4669518496 P1). When unset, prefer the PREVIOUS run's
    // persisted stamp over the platform capability (FIX 3, finder A): the
    // unset case is exactly a run that neither wiped nor generated — e.g. a
    // surgical incremental whose index survived in place — and such a run
    // cannot change whether the HNSW index exists, so carrying the persisted
    // observation forward is strictly more truthful than re-deriving from
    // what the platform COULD do. Only the two positive observations carry
    // ('vector-index'/'exact-scan'); 'unavailable'/absent falls through to
    // the platform default rather than pinning a stale negative.
    const persistedStatus = existingMeta?.capabilities?.vectorSearch.status;
    const persistedSemanticMode: 'vector-index' | 'exact-scan' | undefined =
      persistedStatus === 'vector-index' || persistedStatus === 'exact-scan'
        ? persistedStatus
        : undefined;
    const effectiveSemanticMode =
      semanticMode ??
      persistedSemanticMode ??
      (runtimeCapabilities.semanticMode === 'vector-index' ? 'vector-index' : 'exact-scan');

    // Convert the post-run file-hash map to the on-disk Record<string,string>
    // shape consumed by RepoMeta.fileHashes.
    const newFileHashesRecord: Record<string, string> = {};
    for (const [k, v] of newFileHashes) newFileHashesRecord[k] = v;

    const resolutionOutcomes = pipelineResult.resolutionOutcomes ?? [];
    logUnresolvedReceiverFiles(resolutionOutcomes);

    // Annotated so the capabilities stamp below is compile-checked against
    // RepoMeta's status unions (tri-review 4669518496 P1/U3) — an unannotated
    // literal widens the vectorSearch.status ternary to `string` and the
    // honesty contract silently decays to "whatever interpolates".
    const meta: RepoMeta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      runnerIdentity,
      // Persist only normalized repo-relative exclusions, never absolute paths
      // or payloads. Keep them after runtime enrichment is disabled so a later
      // ordinary scan cannot rediscover an unchanged snapshot as source/FTS.
      ...(springActuatorRequested || retainedActuatorInputs.length > 0
        ? {
            springActuator: {
              enabled: springActuatorRequested,
              repoRelativeInputs: retainedActuatorInputs,
            },
          }
        : {}),
      // Written only while enabled. Once the option is dropped, the disable
      // transition above has already forced the cleanup rebuild, so carrying a
      // `{ enabled: false }` stamp forward would only make every subsequent run
      // re-decide a question that is already settled.
      ...(asyncApiSpecRequested ? { asyncApiSpec: { enabled: true } } : {}),
      // Branch identity this index represents (#2106). Recorded for the flat
      // slot too (so resolveBranchPlacement knows which branch owns it). When
      // the label is null (detached HEAD / non-git re-analyze) we PRESERVE an
      // existing stamp rather than stripping it — otherwise a detached re-index
      // of the primary (e.g. CI's `actions/checkout` default) would un-claim the
      // flat slot and let the next branch analyze overwrite the primary index.
      // Stays absent only when never stamped (fresh detached/non-git repo).
      branch: branchLabel ?? existingMeta?.branch,
      // Captured here (not at registration) so it travels with the
      // on-disk meta.json — sibling-clone fingerprinting works for
      // out-of-tree consumers (group-status, future tooling) without
      // a second git shellout. `undefined` when the repo has no
      // origin remote, which is fine: paths-only repos behave as
      // before.
      remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
      // Absent on a healthy FULL run; present it and the index reports as
      // incomplete rather than fresh (`graph-write-collapsed`). Carried forward
      // when this run had no verdict — see `persistedCollapseStamp`.
      ...(persistedCollapseStamp ? { graphWriteCollapsed: persistedCollapseStamp } : {}),
      // R3-1. Not a health signal — the index is complete and correct. This
      // records which fields the per-language inference declined to link so a
      // later query can say WHY it is returning nothing, instead of leaving an
      // empty result that reads as "unused".
      ...(pipelineResult.propertyInference?.crossLanguageNames?.length
        ? {
            crossLanguageProperties: pipelineResult.propertyInference.crossLanguageNames.map(
              (e) => ({ name: e.name, languages: [...e.languages] }),
            ),
          }
        : {}),
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities:
          pipelineResult.communityResult?.stats.totalCommunities ??
          existingMeta?.stats?.communities,
        processes:
          pipelineResult.processResult?.stats.totalProcesses ?? existingMeta?.stats?.processes,
        embeddings: persistedEmbeddingCount,
      },
      capabilities: {
        graph: { provider: 'ladybugdb', status: runtimeCapabilities.graph },
        // Reflect what this analyze run actually produced: when the FTS
        // extension was unavailable the indexes were skipped, so record
        // 'unavailable' rather than the static runtime default. Keeps
        // meta.json / `gitnexus doctor` honest about degraded search.
        fts: {
          provider: 'ladybugdb-fts',
          status: ftsReady ? runtimeCapabilities.fts : 'unavailable',
          // Persist WHICH cause degraded FTS, not merely THAT it degraded
          // (#2841 review H1). `status` alone collapses "the extension could
          // not load" and "the extension loaded but the build failed" into one
          // value, and §5.C's fast-path probe reads that value: with the cause
          // erased it must guess, guesses `extension-unavailable`, and a
          // `build-failed` run therefore re-analyzes the whole repo on every
          // subsequent no-op run — the build fails identically (an
          // un-tokenizable stored row, #2544/#2546, is deterministic), restamps
          // 'unavailable', and the next run does it again. Stamping the
          // discriminator the run already computed makes the read exact instead.
          skipReason: ftsReady ? undefined : ftsSkipReason,
        },
        vectorSearch: {
          provider: effectiveSemanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
          // Reads the MEASURED count, not `persistedEmbeddingCount` (#2790).
          // The carry-forward exists so a later `--force` doesn't discard a
          // live cache — it is a guess, and a guess must never certify the
          // vector lane: `--drop-embeddings` + a failed count probe would
          // otherwise stamp 'vector-index' with 5000 embeddings over a table
          // holding zero. Unknown reads as 'unavailable' (the status union has
          // no unknown member, and adding one would touch every consumer);
          // the downgrade is recoverable — 'unavailable' is not carried
          // forward as `persistedSemanticMode`, so the next run that can
          // count restamps the real mode.
          status:
            embeddingCount !== undefined && embeddingCount > 0
              ? effectiveSemanticMode
              : 'unavailable',
          exactScanLimit: runtimeCapabilities.exactScanLimit,
          reason: runtimeCapabilities.reason,
        },
      },
      // Incremental-indexing fields. Populated for git repos so the next
      // analyze run can take the incremental DB-writeback path. Setting
      // incrementalInProgress to undefined explicitly clears any prior
      // dirty flag (full and incremental success paths converge here).
      // Derived digest of the DDL this run created the tables from (#2798).
      // Git-only: non-git repos never take the incremental path.
      schemaFingerprint: hasGitDir(repoPath) ? SCHEMA_FINGERPRINT : undefined,
      unresolvedReceiverMembers: summarizeUnresolvedReceivers(resolutionOutcomes),
      scopeExtractionFailures: summarizeScopeExtractionFailures(
        pipelineResult.scopeExtractionFailures,
      ),
      // A receipt certifies that every scope-capable source file was inspected.
      // Optional grammars may be unavailable by design; omitting the receipt in
      // that case makes readers report an unverified lower bound.
      scopeExtractionReceipt: pipelineResult.unavailableScopeLanguageFiles === 0 ? 1 : undefined,
      // Carried forward ONLY when this run could not measure — `saveMeta` writes
      // a fresh object, so omitting the key deletes a prior record and turns a
      // hedged answer back into a confident one. A run that DID measure always
      // wins, including when it measured nothing: vendoring the missing
      // dependency and re-analyzing has to be able to clear the hedge, or the
      // field becomes permanent noise and readers learn to ignore it.
      undecidedInterfaceSatisfaction:
        pipelineResult.undecidedSatisfaction === undefined
          ? existingMeta?.undecidedInterfaceSatisfaction
          : summarizeUndecidedSatisfaction(pipelineResult.undecidedSatisfaction),
      analysisFeatures: currentAnalysisFeatures,
      // Always stamped with the live resolved mode (#2331/#2339) — unlike
      // `pdg` below, 'none' is a meaningful value to compare, not an
      // absence, so this is never conditionally omitted.
      cjkSegmentation: getSearchFTSCjkSegmentation(),
      // The FLOAT[N] width this run created the vector column at (#2798).
      // Always stamped, like `cjkSegmentation` and unlike `schemaFingerprint`:
      // the CodeEmbedding table is created for every index, git or not, so
      // absence has exactly one meaning — an index older than the field.
      embeddingDims: EMBEDDING_DIMS,
      fileHashes: hasGitDir(repoPath) ? newFileHashesRecord : undefined,
      indexCoverage: hasGitDir(repoPath)
        ? {
            maxFileSizeBytes: getMaxFileSizeBytes(),
            dirtyPaths: (
              listWorkingTreeDirtyPaths(repoPath) ?? Object.keys(newFileHashesRecord)
            ).filter(
              (rel) => newFileHashesRecord[rel] !== undefined && !isGitNexusManagedPath(rel),
            ),
          }
        : undefined,
      // This branch's full live chunk-key set (#2106 R6). `usedKeys` is every
      // chunk hash touched in this scan — cache HITS included (see parse-impl
      // usedKeys.add) — so it's complete even on an incremental run. Persisted
      // so a sibling branch's prune can union it and not evict our shards.
      cacheKeys: [...parseCache.usedKeys],
      incrementalInProgress: undefined as RepoMeta['incrementalInProgress'],
      // Cleared on a clean run; otherwise the marker Phase 4/5 minted above
      // (see the `kind` doc in repo-manager.ts).
      embeddingCheckpoint: pendingEmbeddingCheckpoint,
      // The effective pdg config this run's DB rows were built under
      // (#2099 F1). `undefined` on pdg-off runs — this meta is a fresh
      // literal (no spread of existingMeta), so omission is what CLEARS the
      // stamp after an on→off flip; the next pdgModeMismatch then compares
      // off==off and incremental eligibility is restored.
      pdg: resolvePdgConfig(options),
    };
    // Re-resolve at the commit boundary. Long analyses can overlap an npm
    // upgrade, rebuilt dist tree, or native dependency replacement; stamping
    // the start-of-run receipt after such a mutation would falsely certify a
    // graph produced by two analyzer identities. Stable-read validation lives
    // inside the resolver, and a mismatch leaves the dirty flag intact so the
    // next run takes the established full-recovery path.
    meta.runnerIdentity = finalizeAnalyzerRunnerIdentity(import.meta.url, runnerIdentity);
    // #2614 F1: the freshness stamp (saveMeta) is written AFTER the atomic swap
    // below — never here — so a concurrent MCP reader can't observe
    // meta.indexedAt = T_new while lbugPath still resolves to the pre-swap
    // inode (which latched the reader on the stale index permanently). The meta
    // object is fully computed at this point; only its write is deferred.

    // Persist the incremental parse cache for the next run. Wraps in
    // try/catch so a cache-write failure never breaks an otherwise
    // successful indexing run. Prune stale chunk-hash entries first so
    // the cache file size stays bounded across runs (chunks whose
    // composition no longer matches anything in the current scan are
    // dead weight; the parse phase populates `usedKeys` as it processes
    // chunks).
    try {
      // #2106 R6: the parse cache + durable store are shared across branches.
      // Before pruning to this run's keys, fold in the OTHER branches' recorded
      // chunk keys so a branch switch doesn't evict their still-live shards.
      // Adding to usedKeys makes them survive pruneCache AND land in the saved
      // index (saveParseCache builds the index from usedKeys). Excludes this
      // run's own meta dir, so a single-branch repo folds in nothing → prune
      // set byte-identical to today.
      const { keys: siblingKeys, complete } = await collectBranchCacheKeys(storagePath, metaDir);
      if (complete) {
        for (const k of siblingKeys) parseCache.usedKeys.add(k);
      } else {
        // Fail-safe toward retention: a sibling meta was unreadable, so keep
        // everything currently loaded rather than evict on incomplete info.
        log('Parse cache: a branch meta was unreadable — retaining all cached chunks (#2106).');
        for (const k of parseCache.entries.keys()) parseCache.usedKeys.add(k);
      }
      const pruned = pruneCache(parseCache, parseCache.usedKeys);
      if (pruned > 0) {
        log(`Parse cache: pruned ${pruned} stale chunk entries`);
      }
      const savedKeys = await saveParseCache(storagePath, parseCache);
      // Prune the durable ParsedFile store to EXACTLY the parse cache's
      // surviving keys (#2038 warm-cache coverage), so the two content-addressed
      // stores stay coherent: a chunk is "cached" iff both its parse-cache shard
      // and its durable shards exist. A quarantined chunk (in usedKeys but with
      // no parse-cache shard) drops its durable subdir here and re-dispatches
      // next run. Same try/catch — a durable-store write failure must never
      // break an otherwise successful run (next run treats it as a miss).
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storagePath),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );
    } catch (e) {
      log(`Warning: could not save parse cache (${(e as Error).message}); continuing.`);
    }

    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    const projectName = await registerRepo(repoPath, meta, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
      // Non-primary branch runs upsert into the entry's branches[]; the
      // primary/flat run (placement.branch === undefined) refreshes the
      // top-level fields (#2106).
      branch: placement.branch,
    });

    // ── #2354: the flat workspace slot has adopted this run's branch ──────
    // Drop a now-shadowed `branches/<slug>/` sub-index for the same label
    // (unreachable once the flat slot serves it) and align the registry's
    // top-level branch label. Best-effort like the parse-cache save above
    // (#2364 review F5): the index is complete and registered, and a failure
    // here leaves only a stale registry label / undeleted shadowed dir —
    // never wrong routing, because the flat meta this run already stamped is
    // what applyBranchScope trusts. Retried by the next content-changing run
    // (same-commit fast-path runs skip it: their guard compares the
    // already-stamped meta label).
    if (!placement.branch && branchLabel) {
      try {
        await adoptFlatBranchLabel(repoPath, branchLabel);
      } catch (e) {
        log(
          `Warning: could not sync the workspace branch label (${(e as Error).message}); continuing.`,
        );
      }
    }

    // Keep generated .gitnexus contents ignored without editing the user's root .gitignore.
    await ensureGitNexusIgnored(repoPath);

    // ── Generate AI context files (best-effort) ───────────────────────
    let aggregatedClusterCount = 0;
    if (pipelineResult.communityResult?.communities) {
      const groups = new Map<string, number>();
      for (const c of pipelineResult.communityResult.communities) {
        const label = c.heuristicLabel || c.label || 'Unknown';
        groups.set(label, (groups.get(label) || 0) + c.symbolCount);
      }
      aggregatedClusterCount = Array.from(groups.values()).filter((count) => count >= 5).length;
    }

    // Only (re)generate the repo-root AI context files (AGENTS.md / CLAUDE.md /
    // skills) for the primary/flat index (#2106). A non-primary branch analyze
    // must not churn the repo's committed AGENTS.md with branch-specific stats.
    if (!placement.branch) {
      try {
        await generateAIContextFiles(
          repoPath,
          storagePath,
          projectName,
          {
            files: pipelineResult.totalFileCount,
            nodes: stats.nodes,
            edges: stats.edges,
            communities:
              pipelineResult.communityResult?.stats.totalCommunities ??
              existingMeta?.stats?.communities,
            clusters: aggregatedClusterCount,
            processes:
              pipelineResult.processResult?.stats.totalProcesses ?? existingMeta?.stats?.processes,
          },
          undefined,
          {
            skipAgentsMd: options.skipAgentsMd,
            skipSkills: options.skipSkills,
            noStats: options.noStats,
            defaultBranch: options.defaultBranch,
            hasPdg: options.pdg === true,
            hasSpringActuator: options.springActuatorPath !== undefined,
          },
        );
      } catch {
        // Best-effort — don't fail the entire analysis for context file issues
      }
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    // Stop the manual checkpoint driver before closeLbug so its
    // in-flight CHECKPOINT cannot race the `safeClose` CHECKPOINT.
    await walCheckpointDriver.stop();
    // CLI callers (about to process.exit) skip the native close to dodge a
    // LadybugDB destructor double-free after --pdg writes — closeLbugBeforeExit
    // CHECKPOINTs for durability then leaves the handles for process exit to
    // reclaim (#2264). Long-lived callers close for real.
    //
    // On Windows a swap must release the build handle before the rename (a
    // same-process open file can't be renamed), so it forces a real close —
    // safe because windowsSwapOk excludes --pdg (the #2264 case). POSIX renames
    // an open file, so it keeps the skip-native-close there.
    const forceRealCloseForSwap = useAtomicSwap && process.platform === 'win32';
    await (options.skipNativeCloseOnExit && !forceRealCloseForSwap
      ? closeLbugBeforeExit()
      : closeLbug());

    // #2 atomic publish: the fresh index was built at buildPath (a full rebuild,
    // or an opt-in atomic incremental that copied the live index in first). Swap
    // it over the live lbugPath in one rename so an MCP reader that opened
    // mid-build only ever saw the previous complete index — never a wiped/
    // half-built file. The close above checkpoint-consolidated buildPath to a
    // single file (no .wal), so the rename publishes a complete index; a reader
    // holding the old inode keeps a consistent stale snapshot until the pool
    // re-opens onto the new one (the pool staleness invalidation). Runs only on
    // success — a thrown error skips this, leaving the live index intact and the
    // temp build to be cleared by the next run's wipe.
    // Only publish if the build actually produced a DB at buildPath. A
    // degenerate run (empty repo, or a mocked pipeline that never opened the
    // store) leaves nothing to swap — skip rather than throw ENOENT.
    const builtDbExists = useAtomicSwap
      ? await fs.stat(buildPath).then(
          () => true,
          () => false,
        )
      : false;
    if (useAtomicSwap && builtDbExists) {
      await retryRename(buildPath, lbugPath);
      liveIndexMutationStarted = true;
      // Clear any sidecars orphaned beside the replaced file. A cleanly-closed
      // prior index has none; a crashed one could, and it would be replay
      // poison next to the freshly published index. Best-effort.
      for (const suffix of ['.wal', '.shadow', '.wal.checkpoint'] as const) {
        await fs.rm(`${lbugPath}${suffix}`, { force: true }).catch(() => {});
      }
      // #2614 F4: if the final checkpoint silently failed, the build may still
      // carry a residual .wal/.shadow under the temp name. MOVE it beside the
      // published index (not orphan/delete it) so the next open replays the
      // delta, rather than leaving it under a name LadybugDB never reconciles.
      for (const suffix of ['.wal', '.shadow'] as const) {
        await fs.rename(`${buildPath}${suffix}`, `${lbugPath}${suffix}`).catch(() => {});
      }
    }

    // #2614 F1: stamp the freshness metadata now that the index is published.
    // When meta.indexedAt becomes visible, lbugPath already resolves to the new
    // inode, so a reader reiniting on the stamp opens the fresh graph rather
    // than latching on the old one. Leaving the dirty flag set across the swap
    // is a crash-safety improvement: a failed swap leaves the previous index
    // live and the next run recovers via the full-rebuild path.
    await saveMeta(metaDir, meta);

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
      ...(graphWriteCollapsed ? { graphWriteCollapsed } : {}),
      ftsSkipped: !ftsReady,
      ftsSkipReason: ftsReady ? undefined : ftsSkipReason,
      isPrimaryBranch: !placement.branch,
      incrementalStats: incrementalStats
        ? {
            ...incrementalStats,
            writeMode: escalatedFullWrite ? 'full' : 'incremental',
          }
        : undefined,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error. Stop the driver first
    // so its retry loop cannot extend an already-failing analyze.
    try {
      await walCheckpointDriver.stop();
    } catch {
      /* swallow — surface path is the rethrow below */
    }
    try {
      // Skip the native close on the error path too: a real conn.close() after
      // large --pdg writes can itself abort in LadybugDB's ClientContext
      // destructor (#2264 review P2), turning an actionable exit-1 into a raw
      // SIGABRT. closeLbugBeforeExit leaves the handles open, but the CLI catch
      // now force-exits when isLbugReady() (analyze.ts, #2264 review P1), so the
      // process still terminates — no hang, no abort. flushWAL keeps the partial
      // index durable; process exit reclaims the handles. Long-lived callers
      // (skipNativeCloseOnExit unset) close for real.
      await (options.skipNativeCloseOnExit ? closeLbugBeforeExit() : closeLbug());
    } catch {
      /* swallow */
    }
    // Reclaim the staging index this run created (#2841 cleanup). Without this
    // a failed staged build orphans a FULL copy of the index — hundreds of MB on
    // a large repo — until the next `acquireIndexLock` sweeps `lbug.staging.`
    // artifacts, and the failure most likely to leave one (a machine whose
    // extension cannot load) is also the one least likely to be followed by
    // another analyze. Only ever removes a path this run minted: `buildPath`
    // differs from `lbugPath` exactly when the atomic-swap plan is in effect,
    // and the live index is never that path. Best-effort by construction — the
    // rethrow below is the surface, and the lock's sweep remains the backstop.
    if (useAtomicSwap && buildPath !== lbugPath) {
      try {
        await wipeLbugDbFiles(buildPath);
      } catch {
        /* swallow — orphan reclamation must never mask the real failure */
      }
    }
    if (liveIndexMutationStarted) {
      // Preserve the original error identity/prototype: callers distinguish
      // IndexLockTimeoutError and other domain failures with `instanceof`.
      recordLiveIndexMutationRisk(err);
    }
    throw err;
  }
}
