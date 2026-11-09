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

import {
  detectGraphWriteCollapse,
  getGraphIncompleteReasons,
  type GraphWriteCollapseVerdict,
} from './index-freshness.js';
import {
  resolveFtsDisableReason,
  getFtsDisabledReason,
  withExplicitFtsDisablement,
  FTS_DISABLED_MESSAGE,
  DEFAULT_GRAPH_CAPABILITY,
  DEFAULT_VECTOR_SEARCH_CAPABILITY,
  type FtsSkipReason,
} from './search/fts-policy.js';
import {
  allowsFtsCrashWalPark,
  buildFtsDirtyStamp,
  inferNativeAbortSkip,
  isBoundaryCheckpointFatal,
  isFtsStagingDirty,
  resolveFtsWritePlan,
  shouldRefuseFtsCrashWal,
  shouldRefuseRepairFtsWhileDirty,
  shouldStampFtsDirtyPhase,
} from './search/fts-crash-marker.js';
import { PDG_EDGE_TYPES } from './lbug/pdg-emit-sink.js';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { retryRename } from '../storage/fs-atomic.js';
import { assertLbugPublicationReady, consolidateLbugForPublication } from './lbug/publication.js';
import { requireExclusiveIndexLock, sweepStagingArtifacts } from '../storage/index-lock.js';
import { acquireAnalysisSlotLock } from '../storage/analysis-slot-lock.js';
import { resolveEmbeddingRecovery } from '../storage/embedding-recovery.js';
import { invalidateNodeWorkspacePackages } from './ingestion/languages/typescript/workspace-packages.js';
import {
  logNameFallbackSummary,
  summarizeNameFallback,
  countCallsByLanguage,
} from './ingestion/scope-resolution/name-fallback-summary.js';
import type { RouteHookConfig } from './ingestion/language-provider.js';
import { routeHookConfigKey } from './ingestion/route-hook-config.js';
import {
  logUnresolvedReceiverFiles,
  summarizeUnresolvedReceivers,
} from './ingestion/scope-resolution/unresolved-receivers.js';
import { summarizeUndecidedSatisfaction } from './ingestion/scope-resolution/undecided-satisfaction.js';
import { summarizeScopeExtractionFailures } from './ingestion/scope-resolution/scope-extraction-failures.js';
import { summarizeUnresolvedOverloads } from './ingestion/scope-resolution/unresolved-overloads.js';
import type { KnowledgeGraph } from './graph/types.js';
import {
  publishAnalysisAfterProcessExit,
  type AnalysisPhaseTarget,
  type PreparedAnalysisHandoff,
} from './analysis-phase-supervisor.js';
import { reconcileGraphNodeIdentities } from './incremental/write-reconciliation.js';
import { resetDegradedParseCounter } from './tree-sitter/safe-parse.js';
import {
  initLbug,
  acquireInitLock,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  forEachQueryRow,
  executeWithReusedStatement,
  closeLbug,
  drainAnalysisNativeResources,
  closeLbugBeforeExit,
  loadCachedEmbeddings,
  queryImportersBatch,
  loadFTSExtension,
  wipeLbugDbFiles,
  LbugWipeError,
} from './lbug/lbug-adapter.js';
import {
  estimateBufferPool,
  setBufferPoolSizeHint,
  resolveNativeSafeStorageDir,
  getEffectiveBufferPoolSize,
  LBUG_MAX_DB_SIZE,
  maxDbSizeReachedRemedy,
  pastEofReadRemedy,
  type StagedBuildMode,
} from './lbug/lbug-config.js';
import { chunk } from '../lib/utils.js';
import {
  buildSearchIndexesOrDegrade,
  ftsFailureIsFatal,
  createSearchFTSIndexes,
  summarizeFtsIndexBuildFailures,
  initialiseSearchFTSStemmer,
  verifySearchFTSIndexes,
} from './search/fts-indexes.js';
import { getFtsIndexes } from './search/fts-schema.js';
import {
  applyContentRetention,
  contentRetentionFromEnvironment,
  contentRetentionMismatch,
  ftsProfileForContentRetention,
} from './content-retention.js';
import {
  cjkSegmentationModeMismatch,
  getSearchFTSCjkSegmentation,
  initialiseSearchFTSCjkSegmentation,
} from './search/cjk-segmentation.js';
import {
  getExtensionCapabilities,
  getFtsCapability,
  resolveAnalyzeInstallPolicy,
} from './lbug/extension-loader.js';
import {
  diagnoseExtensionLoad,
  extractExtensionPath,
  usesClassifiedLoadRemedy,
} from './lbug/extension-load-error.js';
import { resolveFtsVersionPair } from './lbug/vendored-extension-path.js';
import {
  startWalCheckpointDriver,
  checkpointOnce,
  runCheckpointWithRetry,
  isManualCheckpointEnabled,
  readCheckpointActivity,
  type CheckpointActivity,
  type WalCheckpointDriver,
} from './lbug/wal-checkpoint-driver.js';
import {
  ftsCrashParkFailureMessage,
  quarantineSidecarsForDirtyRecovery,
} from './lbug/sidecar-recovery.js';
import { collectFailureEvidence, type FailureEvidenceTargets } from './lbug/failure-evidence.js';
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
  readRegistry,
  findRegistryEntryByRepoPath,
  setShareOptOut,
  adoptFlatBranchLabel,
  isReadOnlyFilesystemError,
  isRepoRegistered,
  cleanupOldKuzuFiles,
  reconcileMetadataFiles,
  ensureStoragePathWritable,
  isMissingFilesystemError,
  INDEX_METADATA_FILE,
  CONTENT_RETENTION_SCHEMA_VERSION,
  type AnalyzerRunnerIdentity,
  type ContentRetention,
  type RepoMeta,
} from '../storage/repo-manager.js';
import {
  ANALYZE_FORCE_STORAGE_REQUIREMENTS,
  ANALYZE_STORAGE_REQUIREMENTS,
  defaultStoragePath,
  requireRegisteredStoragePath,
  requireStoragePath,
  resolveStoragePath,
} from '../storage/storage-resolver.js';
import {
  isSharedStoreDisabled,
  resolveGraphPath,
  resolveGraphWritePath,
  resolveSharedStore,
  storeRootOfCheckoutSlot,
  type SharedStoreLayout,
} from '../storage/shared-store.js';
import { LBUG_DIRECTORY } from '../storage/storage-constants.js';
import {
  ensurePrivateSharedGraph,
  leaveSharedStore,
  optedInSlotToLeave,
  registerLeftStore,
  publishSharedGraph,
  resolveOptedInStore,
  seedSharedSlot,
} from './shared-store-analyze.js';
import {
  publishAnalysisParseCache,
  loadAnalysisParseCache,
  stageAnalysisParseCache,
} from './analysis-parse-cache.js';
import {
  beginInPlaceAnalysis,
  prepareAnalysisPublication,
  publishPreparedAnalysis,
  readPreparedAnalysis,
} from './analysis-publication.js';
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
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import {
  formatInvalidProcessDetectionOverride,
  processDetectionBudgetMismatch,
  resolveProcessDetectionBudget,
  toProcessDetectionStamp,
  uncertifyProcessDetectionStamp,
} from './ingestion/process-detection-budget.js';
import {
  resolveParseCacheIdentity,
  finalizeParseCacheIdentity,
  type ParseCacheIdentity,
  type ParseCacheIdentityResolution,
} from './parse-cache-identity.js';
import {
  loadParseCache,
  createColdParseRebuildDir,
  getColdParseRebuildDir,
  emptyParseCache,
  forgetCreatedParseCacheDir,
} from '../storage/parse-cache.js';
import {
  getCurrentCheckout,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
  isWorkingTreeDirty,
  listWorkingTreeDirtyPaths,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import { isGitNexusManagedPath } from '../storage/gitnexus-managed-paths.js';
import { walkRepositoryPaths } from './ingestion/filesystem-walker.js';
import { getMaxFileSizeBytes } from './ingestion/utils/max-file-size.js';
import { getIncludeDotDirs, includeDotDirsCoverage } from './ingestion/utils/include-dot-dirs.js';
import {
  cacheRowCount,
  discardScopedEmbeddingSpills,
  disposeEmbeddingSpill,
  withEmbeddingSpillScope,
  emptyCachedEmbeddingsSnapshot,
  EmbeddingSpillReader,
  materializeCachedEmbeddings,
  normalizeCachedEmbeddings,
  snapshotEmbeddingDims,
  type CachedEmbeddingsSnapshot,
} from './embeddings/embedding-restore-spill.js';
import { assertUniqueEmbeddingKeys, EmbeddingIntegrityError } from './embeddings/embedding-keys.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { formatRejectedBranchForLog, sanitizeDetectedBranch } from './git-ref.js';
import {
  EMBEDDING_DIMS,
  STALE_HASH_SENTINEL,
  SCHEMA_FINGERPRINT,
  schemaFingerprintMismatch,
  isSchemaFingerprintShaped,
  embeddingDimsMismatch,
} from './lbug/schema.js';
import { SPRING_ROUTE_BINDINGS_FEATURE } from './ingestion/frameworks/spring/analysis-features.js';
import { springVendorPrefixesKey } from './ingestion/frameworks/spring/vendor-prefixes.js';
import {
  findAnalysisFeatureMismatches,
  resolveAnalysisFeatureVersions,
} from './analysis-features.js';
import { ANALYSIS_FEATURES } from './analysis-feature-registry.js';
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
import {
  RebuildReasonCollector,
  readStoredRebuildReasons,
  type RebuildReason,
  type RebuildReasonKey,
} from './rebuild-reasons.js';

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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeCallbacks {
  /** Process-local cancellation; never serialized through options/IPC. */
  signal?: AbortSignal;
  /** Exit-only frontends admit their supervisor before opening a graph writer. */
  onGraphWork?: () => void | Promise<void>;
  /** Let a serving parent refresh graph readers before paid embedding work. */
  onGraphPublished?: () => Promise<void>;
  onProgress: (
    phase: string,
    percent: number,
    message: string,
    details?: import('./analysis-progress.js').AnalysisPhaseProgress,
  ) => void;
  onLog?: (message: string) => void;
}

export interface AnalyzeOptions {
  /** Internal phase coordination. Entry points activate this together with
   * the published embedding continuation; never a user-facing mode switch. */
  graphPublication?: 'auto' | 'inline' | 'after-exit';
  /** Frozen per-invocation allocations; entrypoints resolve these before destructive work. */
  resources?: import('./analysis-resource-budget.js').AnalysisResourceBudget;
  /**
   * Rebuild the graph and FTS. Parser output is still reused from the
   * content-addressed parse cache unless `useParseCache` is false.
   * The caller's value is the user's explicit `--force` (the `user-force`
   * rebuild reason); other flags that imply re-analysis (`skills`,
   * `useParseCache: false`) contribute their own reasons instead of being
   * folded in here. NOT the registry-collision bypass — see
   * `allowDuplicateName` below.
   */
  force?: boolean;
  /**
   * `--skills`: skill generation needs a freshly built `pipelineResult`, so
   * the run rebuilds (the `skills` rebuild reason).
   */
  skills?: boolean;
  /**
   * Reuse content-addressed parser output. Defaults to true. When false,
   * analysis reparses every file and publishes a new parse-cache generation
   * only after a successful run (live shards stay untouched if the run fails).
   */
  useParseCache?: boolean;
  /** Repair only search indexes without re-running full parsing/indexing. */
  repairFts?: boolean;
  skipFts?: boolean;
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
  /**
   * Internal auto-sync mode: resolve `pdg` from the live index metadata only
   * after acquiring its writer lock. An explicit `pdg` value always wins.
   */
  preserveExistingPdg?: boolean;
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
   *  The sink answers a complete relationship read, so community detection,
   *  process extraction, and PDG taint summaries still run; streaming reduces
   *  in-memory graph heap (~2.9x) by keeping those edges on disk. */
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
   * Join the shared store of this registered worktree (name or path), after
   * checking the remote URL matches (#3352). Persisted through the registry.
   */
  shareWith?: string;
  /** Leave the shared store and index into `<repo>/.gitnexus` (#3352). */
  noShare?: boolean;
  /**
   * Worker pool size override, threaded from the CLI `--workers` flag.
   * Forwarded to `PipelineOptions.workerPoolSize` so the parse phase
   * sizes the pool without `analyzeCommand` mutating `process.env`.
   * Must be a positive integer — `0` hard-errors (sequential parsing was
   * removed); `undefined` defers to the env / auto-formula fallback.
   */
  workerPoolSize?: number;
  /**
   * Process-detection budget overrides (#3313). Threaded to
   * `PipelineOptions` without mutating `process.env`. Unset fields fall
   * back to `GITNEXUS_*` env, then shipped defaults / the dynamic
   * `maxProcesses` formula.
   */
  maxProcesses?: number;
  maxProcessBranching?: number;
  maxProcessTraceDepth?: number;
  maxEntryPointCandidates?: number;
  /**
   * Extra fetch-wrapper function names to treat as HTTP consumers, forwarded to
   * `PipelineOptions.fetchWrappers` (#1589/#1852 residual). Sourced from the CLI
   * `.gitnexusrc` `fetchWrappers` list. `undefined`/empty leaves the route
   * consumer scan unchanged.
   */
  fetchWrappers?: string[];
  /**
   * Declared router-framework aliases and handler-wrapper callees, forwarded to
   * `PipelineOptions` and stamped into meta so a changed value rebuilds Routes.
   */
  routeHookConfig?: RouteHookConfig;
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
   * Retained for existing callers. Graph writes now always build a fresh
   * database, using the full-rebuild publication policy on each platform.
   * No copy of the prior graph is needed for incremental refreshes.
   */
  atomicIncremental?: boolean;
}

const liveIndexMutationRisks = new WeakSet<object>();

function recordLiveIndexMutationRisk(error: unknown): void {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    liveIndexMutationRisks.add(error);
  }
}

/**
 * `String(value)` for a thrown value that never throws: the failure handler runs it
 * before any cleanup, and an exotic throw (a null-prototype object, a throwing
 * `toString`) must not abort that cleanup or mask the original failure.
 */
function describeThrown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unprintable thrown value]';
  }
}

/** Every staged graph write is a fresh rebuild, including one-file edits. */
const stagedBuildModeOf = (staged: boolean): StagedBuildMode =>
  staged ? 'staged-rebuild' : 'in-place';

/**
 * The diagnosis (#3529, #3530) for a classified analyze failure — its remedy and
 * `Failure evidence — ` lines — or undefined when `failureMessage` is not one of
 * those failures, so nothing else pays for the stats. Measures the index files,
 * so call it BEFORE the database closes: closing can checkpoint the staging file,
 * and a later stat would record the post-close size and make genuine growth look
 * like a short file — the misreading the evidence exists to settle. Never throws.
 */
async function diagnoseClassifiedFailure(
  failureMessage: string,
  buildMode: StagedBuildMode,
  targets: FailureEvidenceTargets,
  checkpointsSince: CheckpointActivity,
): Promise<string | undefined> {
  const remedy =
    maxDbSizeReachedRemedy(failureMessage, buildMode) ??
    pastEofReadRemedy(failureMessage, buildMode);
  if (!remedy) return undefined;
  const evidenceLines = await collectFailureEvidence(targets, checkpointsSince);
  // 0 is the pass-through sentinel for LadybugDB's native default, not a size.
  const bufferPool = getEffectiveBufferPoolSize();
  const configuredLine =
    `configured max DB size ${LBUG_MAX_DB_SIZE} B, ` +
    `buffer pool ${bufferPool === 0 ? "LadybugDB's native 80%-of-RAM default" : `${bufferPool} B`}`;
  return [
    remedy,
    ...[...evidenceLines, configuredLine].map((line) => `Failure evidence — ${line}`),
  ].join('\n');
}

/**
 * What an analyze failure rethrows: `err` with `diagnosis` appended to its
 * message, or a wrapper carrying it when `err` is not an Error.
 *
 * The message is the one channel every caller surfaces: `analyze --watch` wires
 * no log sink unless GITNEXUS_VERBOSE=1 and the auto-sync worker launcher drops
 * progress messages, yet both print the rethrown message. Appended in place, so
 * the error keeps its identity and prototype (`instanceof` checks and live-mutation
 * tracking key on the object), and after the native text, so classifiers anchored
 * on it still match. Call it once per error so the diagnosis is appended once.
 * Best effort: a throwing log sink or an unwritable `message` never replaces `err`.
 */
function attachFailureDiagnosis(
  err: unknown,
  failureMessage: string,
  diagnosis: string | undefined,
  log: (msg: string) => void,
): unknown {
  let failure: unknown = err;
  const bestEffort = (deliver: () => void): void => {
    try {
      deliver();
    } catch {
      /* swallow — the caller rethrows `failure` */
    }
  };
  if (diagnosis) {
    bestEffort(() => {
      const text = stripControlCharacters(diagnosis);
      if (err instanceof Error) err.message = `${err.message}\n${text}`;
      // A non-Error has no message to extend; wrap it so the diagnosis still travels.
      else failure = new Error(`${failureMessage}\n${text}`, { cause: err });
    });
  } else if (
    /max(?:imum)?(?: database| db)? size|database size limit|maxDBSize/i.test(failureMessage)
  ) {
    // A max-size message the engine worded differently keeps the generic hint.
    bestEffort(() =>
      log(
        'The database size limit was reached. Set GITNEXUS_LBUG_MAX_DB_SIZE to a larger ' +
          'byte limit before retrying analyze; retained complete embeddings can be reused.',
      ),
    );
  }
  return failure;
}

function formatMetaWriteFailureReason(err: unknown): string {
  return isReadOnlyFilesystemError(err)
    ? `${(err as Error).message} — storage may be read-only (#1549)`
    : (err as Error).message;
}

/** Whether a failed analyze may already have changed the live DB. */
export function analyzeFailureMayHaveMutatedLiveIndex(error: unknown): boolean {
  return (
    ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
    liveIndexMutationRisks.has(error)
  );
}

export interface AnalyzeResult {
  /** Exit-only graph phase awaiting its supervisor's verified publication. */
  preparedGraph?: PreparedAnalysisHandoff;
  repoName: string;
  repoPath: string;
  /** The exact storage slot selected and validated for this analysis. */
  storagePath: string;
  stats: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  alreadyUpToDate?: boolean;
  /**
   * Keys of every rebuild reason this run collected (#3137), in collection
   * order — including the non-forcing `escalated-full-write`. Empty when the
   * run took the fast path, ran incrementally, or rebuilt only structurally
   * (no git, no stored file hashes, an empty file list).
   */
  rebuildReasons: RebuildReasonKey[];
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
   * `--repair-fts`, not by installing the extension) vs `native-abort` (inferred
   * on the next run from an FTS-phase crash) vs `tuple-missing` (no packaged
   * artifact for this platform). Lets the CLI show the correct recovery hint
   * instead of always blaming a missing extension.
   * `disabled-by-flag` and `disabled-by-env` record intentional opt-out;
   * neither calls for extension installation or repair.
   */
  ftsSkipReason?: FtsSkipReason;
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
 * `rejectedDetectedBranch` is log-only (the detect-reject warning after lock
 * settle); it does not change placement.
 */
interface WriteTarget {
  storagePath: string;
  repoHasGit: boolean;
  currentCommit: string;
  checkedOutBranch: string | null;
  /** Raw checkout name when git returned one the branch-name rules reject. */
  rejectedDetectedBranch: string | null;
  branchLabel: string | null;
  placement: { branch?: string };
  lbugPath: string;
  metaPath: string;
  metaDir: string;
  /** Set when this checkout writes into a shared sibling store (#3352). */
  sharedStore?: SharedStoreLayout;
}

/** Adoption must not move the checkout away from its unfinished private work.
 * Only inspected during a local-to-shared transition; established shared slots
 * keep their existing fast path. Branch jobs belong to the same local root. */
async function hasRetainedAnalysisWork(root: string): Promise<boolean> {
  const pending = async (slot: string): Promise<boolean> => {
    try {
      await fs.lstat(path.join(slot, 'analysis-publication.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const meta = await loadMeta(slot);
    return Boolean(meta?.incrementalInProgress || meta?.embeddingJob || meta?.embeddingCheckpoint);
  };
  if (await pending(root)) return true;
  let branches;
  try {
    branches = await fs.opendir(path.join(root, 'branches'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for await (const branch of branches) {
    if (branch.isDirectory() && (await pending(path.join(root, 'branches', branch.name))))
      return true;
  }
  return false;
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
  // are shared across branches (#2106 KTD7). Always re-run requireStoragePath:
  // a cached path string must not skip ownership (STORAGE_PATH can move to a
  // foreign slot while the lock is waited out). `--force` may adopt a
  // repository-local foreign slot; so may `--skills` or a parse-cache bypass —
  // each forces the rebuild just as `--force` does (#3137), just under its own
  // named reason instead of being folded into `options.force` itself, so this
  // check re-derives the same predicate the pre-#3137 folded `force` used. The
  // non-force set stays ANALYZE_STORAGE. A linked-worktree checkout writes its
  // own slot in the shared store (#3352); that slot replaces any
  // repository-local `.gitnexus`, which is left untouched.
  const storageRequirements =
    options.force || options.skills || options.useParseCache === false
      ? ANALYZE_FORCE_STORAGE_REQUIREMENTS
      : ANALYZE_STORAGE_REQUIREMENTS;
  if (options.noShare && resolveSharedStore(repoPath)) {
    // Fail before any lock or indexing; only an opted-in clone can leave.
    throw new Error(
      '--no-share: linked worktrees always use the shared index store. ' +
        'Set GITNEXUS_SHARED_STORE=off to index every checkout into its own .gitnexus.',
    );
  }
  const sharingOff = options.noShare || isSharedStoreDisabled();
  let sharedStore = sharingOff
    ? undefined
    : (resolveSharedStore(repoPath) ?? (await resolveOptedInStore(repoPath, options.shareWith)));
  const previousStorage = resolveStoragePath(repoPath);
  let retainedStorage: string | undefined;
  if (
    sharedStore &&
    path.resolve(previousStorage) !== path.resolve(sharedStore.checkoutSlot) &&
    !storeRootOfCheckoutSlot(previousStorage) &&
    (await hasRetainedAnalysisWork(previousStorage))
  ) {
    // Re-resolved after ordinary lock acquisition as well: if the previous
    // writer completes while we wait, adoption can proceed on the next lock.
    retainedStorage = previousStorage;
    sharedStore = undefined;
  }
  // A checkout still registered in a store after sharing was turned off
  // indexes into its own `.gitnexus` again; its slot is left for `clean --gc`.
  const leavingStore = !sharedStore && storeRootOfCheckoutSlot(previousStorage) !== null;
  const explicitStorage =
    retainedStorage ??
    sharedStore?.checkoutSlot ??
    (leavingStore ? defaultStoragePath(repoPath) : undefined);
  const storagePath = explicitStorage
    ? await requireRegisteredStoragePath(
        { path: repoPath, storagePath: explicitStorage },
        storageRequirements,
      )
    : await requireStoragePath(repoPath, storageRequirements);
  const repoHasGit = hasGitDir(repoPath);
  const checkout = repoHasGit ? getCurrentCheckout(repoPath) : { commit: '', branch: null };
  const currentCommit = checkout.commit;
  // Normalize the auto-detected branch the same way an explicit `--branch` is
  // validated (#2106 R1): a git ref the branch-name rules forbid becomes `null`
  // → the flat slot, matching that a later `--branch <that-ref>` query would
  // also be rejected. A normal ref round-trips index-time/query-time labels.
  // Keep the raw rejected name so `runFullAnalysis` can warn once after the
  // lock settles. Detached / non-git / empty detect stay `null` here and silent.
  const rawDetectedBranch = checkout.branch;
  const checkedOutBranch = sanitizeDetectedBranch(rawDetectedBranch) ?? null;
  const rejectedDetectedBranch =
    rawDetectedBranch != null && checkedOutBranch === null ? rawDetectedBranch : null;
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
  const placement = options.branch
    ? await resolveBranchPlacement(repoPath, branchLabel, storagePath)
    : {};
  const paths = getStoragePaths(repoPath, placement.branch, storagePath);
  const { metaPath } = paths;
  // Owned generation files stay writable in place. Only an immutable shared
  // commit pointer resolves to a fresh slot-local write target.
  const lbugPath = storeRootOfCheckoutSlot(storagePath)
    ? resolveGraphWritePath(path.dirname(metaPath))
    : paths.lbugPath;
  return {
    storagePath,
    repoHasGit,
    currentCommit,
    checkedOutBranch,
    rejectedDetectedBranch,
    branchLabel,
    placement,
    lbugPath,
    metaPath,
    metaDir: path.dirname(metaPath),
    sharedStore,
  };
}

async function removeColdParseRebuildDir(
  dir: string | undefined,
  ignoreErrors: boolean,
): Promise<void> {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (!ignoreErrors) throw err;
  }
}

interface ParseIdentityRun {
  resolve(): ParseCacheIdentityResolution;
  /** Slot-owned staging parent; includes any late writes to a retired run's child. */
  storagePath?: string;
}

async function retainsPreparedGraph(metadataDirectory: string): Promise<boolean> {
  return fs.lstat(path.join(metadataDirectory, 'analysis-publication.json')).then(
    () => true,
    (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
  );
}

/** Preview the registry's existing name precedence without advancing freshness.
 * The continuation checks it again under the slot lock before publication. */
async function preparedAnalysisName(repoPath: string, options: AnalyzeOptions): Promise<string> {
  if (options.registryName !== undefined) return options.registryName;
  const existing = findRegistryEntryByRepoPath(await readRegistry(), repoPath);
  const inferred = getInferredRepoName(repoPath);
  if (
    existing &&
    existing.name !== path.basename(path.resolve(existing.path)) &&
    existing.name !== inferred &&
    existing.name !== path.basename(resolveRepoIdentityRoot(existing.path))
  )
    return existing.name;
  return inferred ?? path.basename(resolveRepoIdentityRoot(repoPath));
}

async function recoverPreparedGraph(
  target: WriteTarget,
  repoPath: string,
  options: AnalyzeOptions,
  log: (message: string) => void,
): Promise<RepoMeta | undefined> {
  const prepared = await retainsPreparedGraph(target.metaDir);
  if (prepared && !(await readPreparedAnalysis(target.metaDir))) return undefined;
  // Publication removes the graph receipt before the optional cache is merged.
  // Recover that crash window using only the currently published generation.
  const alreadyPublished = prepared ? undefined : await loadMeta(target.metaDir);
  let pendingCache: Awaited<ReturnType<typeof loadAnalysisParseCache>>;
  if (!prepared) {
    if (!alreadyPublished?.graphGeneration || alreadyPublished.incrementalInProgress)
      return undefined;
    try {
      pendingCache = await loadAnalysisParseCache(target.metaDir, alreadyPublished);
    } catch (error) {
      log(`Warning: could not recover the prepared parse cache (${(error as Error).message}).`);
      return undefined;
    }
    if (!pendingCache) return undefined;
  }
  if (!options.resources) throw new Error('Graph publication requires admitted resources');
  const metadata =
    alreadyPublished ??
    (await publishPreparedAnalysis(target.metaDir, {
      saveMetadata: (meta) => saveMeta(target.metaDir, meta),
      verify: async (file, meta) => {
        if (meta.repoPath !== repoPath)
          throw new Error('Prepared graph belongs to another checkout');
        const { drainEmbeddingSidecarForAnalysis } =
          await import('./embeddings/embedding-sidecar-client.js');
        await drainEmbeddingSidecarForAnalysis();
        await drainAnalysisNativeResources();
        const { verifyPublishedAnalysisGraph } = await import('./analysis-graph-verification.js');
        await verifyPublishedAnalysisGraph(file, meta, {
          bufferPoolBytes: options.resources!.parse.graphPoolBytes,
          threads: options.resources!.parse.nativeThreads,
        });
      },
    }));
  if (!metadata) throw new Error('Prepared graph disappeared under its writer lock');
  await registerRepo(repoPath, metadata, {
    name: options.registryName,
    allowDuplicateName: options.allowDuplicateName,
    branch: target.placement.branch,
    storagePath: target.storagePath,
  });
  try {
    const cache = pendingCache ?? (await loadAnalysisParseCache(target.metaDir, metadata));
    if (cache)
      await publishAnalysisParseCache(cache, {
        storagePath: target.storagePath,
        metadataDirectory: target.metaDir,
        cacheRoot: target.sharedStore?.cachesDir ?? target.storagePath,
        publishedGeneration: metadata.graphGeneration?.id,
        sharedStore: target.sharedStore,
        collectBranchKeys: collectBranchCacheKeys,
        log,
      });
  } catch (error) {
    log(
      `Warning: could not publish the prepared parse cache (${(error as Error).message}); continuing.`,
    );
  }
  return metadata;
}

/** Complete an exit-only writer's exact attempt, without invoking the parser or
 * regenerating context/skills. The launcher must wait for actual process exit
 * before starting this continuation in its separately admitted process. */
export async function continuePreparedAnalysis(
  handoff: PreparedAnalysisHandoff,
  writerPid: number,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  signal?: AbortSignal,
): Promise<RepoMeta> {
  const resources = options.resources;
  if (!resources) throw new Error('Graph continuation requires admitted resources');
  const log = (message: string) => callbacks.onLog?.(stripControlCharacters(message));
  // Publication resolves the target before locking and again under the lock.
  // Retain that verified target for its callbacks; an extra snapshot here is
  // overwritten before use and adds synchronous Git probes to every handoff.
  let target: Awaited<ReturnType<typeof resolveWriteTarget>>;
  const resolveTarget = async (): Promise<AnalysisPhaseTarget> => {
    target = await resolveWriteTarget(handoff.repoPath, options);
    return {
      repoPath: handoff.repoPath,
      storagePath: target.storagePath,
      metadataDirectory: target.metaDir,
      repoName: await preparedAnalysisName(handoff.repoPath, options),
      commit: target.currentCommit,
    };
  };
  const finalize = async (metadata: RepoMeta): Promise<RepoMeta> => {
    const prior = options.noShare ? await optedInSlotToLeave(handoff.repoPath) : undefined;
    await registerRepo(handoff.repoPath, metadata, {
      name: options.registryName,
      allowDuplicateName: options.allowDuplicateName,
      branch: target.placement.branch,
      storagePath: target.storagePath,
    });
    if (!target.placement.branch && target.branchLabel) {
      try {
        await adoptFlatBranchLabel(handoff.repoPath, target.branchLabel, target.storagePath);
      } catch (error) {
        log(`Warning: could not sync the workspace branch label (${(error as Error).message}).`);
      }
    }
    if (target.sharedStore && !target.placement.branch) {
      await publishSharedGraph(target.sharedStore, handoff.repoPath, target.currentCommit, log, {
        name: options.registryName,
        allowDuplicateName: options.allowDuplicateName,
      });
    } else if (!target.sharedStore) {
      if (prior) await leaveSharedStore(handoff.repoPath, prior, target.storagePath, log);
      else await registerLeftStore(handoff.repoPath, target.storagePath);
    }
    if (options.noShare) await setShareOptOut(handoff.repoPath, true);
    else if (options.shareWith) await setShareOptOut(handoff.repoPath, false);
    return (await loadMeta(target.metaDir)) ?? metadata;
  };
  let metadata = await publishAnalysisAfterProcessExit(handoff, writerPid, {
    resolveTarget,
    saveMetadata: (meta) => saveMeta(target.metaDir, meta),
    verify: async (file, meta) => {
      const { drainEmbeddingSidecarForAnalysis } =
        await import('./embeddings/embedding-sidecar-client.js');
      await drainEmbeddingSidecarForAnalysis();
      await drainAnalysisNativeResources();
      const { verifyPublishedAnalysisGraph } = await import('./analysis-graph-verification.js');
      await verifyPublishedAnalysisGraph(file, meta, {
        bufferPoolBytes: resources.embedding.graphPoolBytes,
        threads: resources.embedding.nativeThreads,
      });
    },
    finalizeGraph: async (meta) => {
      const published = await finalize(meta);
      try {
        const cache = await loadAnalysisParseCache(target.metaDir, published);
        if (cache)
          await publishAnalysisParseCache(cache, {
            storagePath: target.storagePath,
            metadataDirectory: target.metaDir,
            cacheRoot: target.sharedStore?.cachesDir ?? target.storagePath,
            publishedGeneration: published.graphGeneration?.id,
            sharedStore: target.sharedStore,
            collectBranchKeys: collectBranchCacheKeys,
            log,
          });
        await removeColdParseRebuildDir(getColdParseRebuildDir(target.metaDir), false);
      } catch (error) {
        log(`Warning: could not publish the prepared parse cache (${(error as Error).message}).`);
      }
      callbacks.onProgress('graph-ready', 90, 'Graph published', { graphPhase: 'ready' });
      if (
        !_deriveEmbeddingMode(options, published.stats?.embeddings ?? 0).shouldGenerateEmbeddings &&
        !published.embeddingJob &&
        !published.embeddingCheckpoint
      )
        await callbacks.onGraphPublished?.();
      return published;
    },
    signal,
    log,
    onWaitStart: () => callbacks.onProgress('lock', 0, 'Waiting to publish the prepared graph…'),
  });
  const generate = _deriveEmbeddingMode(
    options,
    metadata.stats?.embeddings ?? 0,
  ).shouldGenerateEmbeddings;
  if (generate || metadata.embeddingJob || metadata.embeddingCheckpoint) {
    signal?.throwIfAborted();
    const lock = await acquireAnalysisSlotLock(handoff.metadataDirectory, { sweep: false, log });
    try {
      requireExclusiveIndexLock(lock, 'Embedding continuation requires exclusive index ownership');
      const current = await resolveTarget();
      for (const key of [
        'repoPath',
        'storagePath',
        'metadataDirectory',
        'repoName',
        'commit',
      ] as const)
        if (current[key] !== handoff[key])
          throw new Error('Analysis target changed before embedding; retry analysis.');
      const { runAnalysisEmbeddingPhase } = await import('./analysis-embedding-phase.js');
      metadata = await runAnalysisEmbeddingPhase({
        metadataDirectory: target.metaDir,
        graphPath: resolveGraphPath(target.metaDir),
        resources,
        callbacks,
        nodeLimit: options.embeddingsNodeLimit,
        expectedGeneration: handoff.publicationId,
        signal,
      });
      metadata = await finalize(metadata);
      // The graph writer deliberately retained staging files across its exit.
      // Reclaim them only after the replacement vectors are published, while
      // still holding the ordinary slot lock.
      sweepStagingArtifacts(target.metaDir, log);
    } finally {
      lock.release();
    }
  }
  callbacks.onProgress('done', 100, 'Done', { graphPhase: 'ready' });
  return metadata;
}

function effectiveParseCacheIdentity(
  identity: ParseCacheIdentity,
  options: Pick<AnalyzeOptions, 'pdg' | 'pdgMaxFunctionLines'>,
): NonNullable<RepoMeta['parseCacheIdentity']> {
  return {
    base: identity.base,
    ...(options.pdg === true
      ? {
          pdg: {
            identity: identity.pdg,
            maxFunctionLines: options.pdgMaxFunctionLines ?? DEFAULT_PDG_MAX_FUNCTION_LINES,
          },
        }
      : {}),
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
  callbacks.signal?.throwIfAborted();
  if (options.graphPublication && !options.resources)
    throw new Error('Graph publication requires admitted resources');
  if (options.graphPublication === 'after-exit' && !options.skipNativeCloseOnExit)
    throw new Error('Deferred publication requires an exit-only graph writer');
  if (options.graphPublication === 'inline' && options.skipNativeCloseOnExit)
    throw new Error('Inline publication requires physical native release');
  // Validate operator-provided FTS config before anything else — a typo fails
  // here in ms, without taking the lock. (createSearchFTSIndexes reuses the
  // cached value via getSearchFTSStemmer.)
  if (options.repairFts && resolveFtsDisableReason(options.skipFts)) {
    throw new Error('--repair-fts cannot be used with --skip-fts or GITNEXUS_SKIP_FTS=1.');
  }
  initialiseSearchFTSStemmer();
  initialiseSearchFTSCjkSegmentation();
  const contentRetention = contentRetentionFromEnvironment();
  // Scope the degraded-parse log throttle to this run (module-level counter
  // would otherwise stay saturated on a reused process).
  resetDegradedParseCounter();
  // The workspace-package memo is per process: this run must see the tree as it
  // is now, not as the previous run in a long-lived watch/server process saw it.
  invalidateNodeWorkspacePackages(repoPath);

  const log = (msg: string) => callbacks.onLog?.(stripControlCharacters(msg));
  let parseIdentityResolution: ParseCacheIdentityResolution | undefined;
  const parseRun: ParseIdentityRun = {
    // Lazy so FTS-only repair neither inspects nor restamps parser provenance.
    resolve: () => (parseIdentityResolution ??= resolveParseCacheIdentity(import.meta.url)),
  };
  const acquireOpts = {
    log,
    // Resolve and validate the canonical slot under the lock before cleanup.
    sweep: false,
    onWaitStart: () =>
      callbacks.onProgress('lock', 0, 'Waiting for another analyze to finish on this index…'),
  };

  let writeTarget = await resolveWriteTarget(repoPath, options);
  let lock = await acquireAnalysisSlotLock(writeTarget.metaDir, acquireOpts);
  let retainParseStage = false;
  return withEmbeddingSpillScope(async () => {
    try {
      requireExclusiveIndexLock(
        lock,
        `Cannot acquire the index lock at ${writeTarget.metaDir}; refusing an unlocked analysis.`,
      );
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
        // Never pass the pre-lock storagePath as already-validated: requireStoragePath
        // must run again under the lock so a now-foreign slot aborts (and finally
        // still releases the lock).
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
        lock = await acquireAnalysisSlotLock(fresh.metaDir, acquireOpts);
        requireExclusiveIndexLock(
          lock,
          `Cannot acquire the index lock at ${fresh.metaDir}; refusing an unlocked analysis.`,
        );
        if (attempt === MAX_RELOCK - 1) {
          log(
            'Index write target still moving after repeated re-acquire; proceeding on this lock.',
          );
        }
      }
      if (writeTarget.rejectedDetectedBranch) {
        log(
          `Warning: checkout "${formatRejectedBranchForLog(writeTarget.rejectedDetectedBranch)}" is not a usable index label; continuing.`,
        );
      }
      if (options.graphPublication === 'auto') {
        const prior = await loadMeta(writeTarget.metaDir);
        const separate = Boolean(
          (await retainsPreparedGraph(writeTarget.metaDir)) ||
          prior?.graphGeneration ||
          prior?.embeddingJob ||
          (!options.dropEmbeddings && prior?.embeddingCheckpoint) ||
          _deriveEmbeddingMode(options, prior?.stats?.embeddings ?? 0).shouldGenerateEmbeddings,
        );
        options = {
          ...options,
          graphPublication: separate
            ? options.skipNativeCloseOnExit
              ? 'after-exit'
              : 'inline'
            : undefined,
        };
      }
      // Only this canonical slot is locked. Its deterministic parser stage
      // can only belong to an interrupted predecessor; sibling stages live
      // under their own meta directories and must remain untouched. Reclaim
      // before freshness/FTS-only early returns as well as parsing runs.
      const slotToLeave = options.noShare ? await optedInSlotToLeave(repoPath) : undefined;
      if (options.graphPublication) {
        const recovered = await recoverPreparedGraph(writeTarget, repoPath, options, log);
        if (recovered?.graphPath)
          writeTarget = {
            ...writeTarget,
            lbugPath: resolveGraphWritePath(writeTarget.metaDir),
          };
      }
      await removeColdParseRebuildDir(getColdParseRebuildDir(writeTarget.metaDir), false);
      const flatShared = writeTarget.placement.branch ? undefined : writeTarget.sharedStore;
      if (flatShared) {
        await seedSharedSlot(flatShared, repoPath, log, (meta) => {
          if (options.repairFts) return true;
          const resolved = parseRun.resolve();
          const pdg =
            options.preserveExistingPdg && options.pdg === undefined
              ? meta.pdg !== undefined
              : options.pdg;
          return (
            resolved.ok &&
            isDeepStrictEqual(
              meta.parseCacheIdentity,
              effectiveParseCacheIdentity(resolved.identity, { ...options, pdg }),
            )
          );
        });
      }
      sweepStagingArtifacts(writeTarget.metaDir, log);
      if (options.dropEmbeddings) {
        const prior = await loadMeta(writeTarget.metaDir);
        if (prior) {
          const { reclaimAnalysisArtifacts } =
            await import('../storage/analysis-artifact-cleanup.js');
          await reclaimAnalysisArtifacts(writeTarget.metaDir, prior, undefined, log, true);
        }
        // Even an empty or pending vector job must lose its metadata references.
        options = { ...options, force: true };
      }
      const result = await runFullAnalysisInner(
        repoPath,
        options,
        callbacks,
        writeTarget,
        contentRetention,
        parseRun,
        runnerIdentityAtBootstrap,
      );
      if (result.preparedGraph) {
        retainParseStage = true;
        return result;
      }
      if (flatShared) {
        await publishSharedGraph(flatShared, repoPath, writeTarget.currentCommit, log, {
          name: options.registryName,
          allowDuplicateName: options.allowDuplicateName,
        });
      } else if (!writeTarget.sharedStore) {
        // Also for a `--branch` run routed to a local branch sub-slot: the
        // checkout still leaves the store.
        // Leaving a store (`--no-share`, or sharing turned off): the up-to-date
        // path does not re-register, so point the registry at the new storage
        // before the old slot goes away.
        if (slotToLeave) {
          await leaveSharedStore(repoPath, slotToLeave, writeTarget.storagePath, log);
        } else {
          await registerLeftStore(repoPath, writeTarget.storagePath);
        }
      }
      // A clone that left stays out of sibling stores until `--share-with`.
      if (options.noShare) await setShareOptOut(repoPath, true);
      else if (options.shareWith) await setShareOptOut(repoPath, false);
      if (
        options.graphPublication === 'inline' ||
        (options.graphPublication === 'after-exit' && result.alreadyUpToDate)
      ) {
        let published = await loadMeta(writeTarget.metaDir);
        const generate = _deriveEmbeddingMode(
          options,
          published?.stats?.embeddings ?? 0,
        ).shouldGenerateEmbeddings;
        if (published && (generate || published.embeddingJob || published.embeddingCheckpoint)) {
          if (flatShared && !published.graphGeneration) {
            if (!(await ensurePrivateSharedGraph(writeTarget.metaDir, log)))
              throw new Error('The shared graph is unavailable; re-run analyze to rebuild it.');
            published = (await loadMeta(writeTarget.metaDir)) ?? published;
          }
          const { runAnalysisEmbeddingPhase } = await import('./analysis-embedding-phase.js');
          const metadata = await runAnalysisEmbeddingPhase({
            metadataDirectory: writeTarget.metaDir,
            graphPath: resolveGraphPath(writeTarget.metaDir, published),
            resources: options.resources!,
            callbacks,
            nodeLimit: options.embeddingsNodeLimit,
            expectedGeneration: published.graphGeneration?.id,
            signal: callbacks.signal,
          });
          // A matching completed artifact performs no writes. Preserve the
          // graph's no-op result and avoid republishing identical registry and
          // shared-store metadata on every cached embedding invocation.
          const unchangedVectors =
            result.alreadyUpToDate &&
            !published.embeddingJob &&
            !published.embeddingCheckpoint &&
            published.vectorGeneration &&
            metadata.vectorGeneration?.identity === published.vectorGeneration.identity;
          if (!unchangedVectors) {
            await registerRepo(repoPath, metadata, {
              name: options.registryName,
              allowDuplicateName: options.allowDuplicateName,
              branch: writeTarget.placement.branch,
              storagePath: writeTarget.storagePath,
            });
            if (flatShared)
              await publishSharedGraph(flatShared, repoPath, writeTarget.currentCommit, log, {
                name: options.registryName,
                allowDuplicateName: options.allowDuplicateName,
              });
            result.alreadyUpToDate = false;
          }
          result.stats = metadata.stats ?? {};
          callbacks.onProgress('done', 100, 'Done', {
            graphPhase: 'ready',
            embeddingProgress: {
              phase:
                metadata.vectorGeneration?.graphGeneration === metadata.graphGeneration?.id &&
                !metadata.embeddingJob &&
                metadata.vectorGeneration
                  ? 'ready'
                  : metadata.stats?.embeddings
                    ? 'preserved'
                    : 'unverified',
            },
          });
        } else {
          await callbacks.onGraphPublished?.();
        }
      }
      return result;
    } finally {
      // Readers opened after analyze must not inherit its smaller write budget.
      setBufferPoolSizeHint(undefined);
      if (options.graphPublication && !retainParseStage) {
        // A close/publication failure can occur after the durable handoff was
        // written but before an AnalyzeResult is returned. Preserve its cache
        // even when the receipt itself is unreadable.
        retainParseStage = await retainsPreparedGraph(writeTarget.metaDir);
      }
      if (!retainParseStage) await removeColdParseRebuildDir(parseRun.storagePath, true);
      discardScopedEmbeddingSpills();
      lock.release();
    }
  });
}

/** Prove that a previously indexed dirty snapshot still covers the same readable bytes. */
async function matchesIndexedDirtyWorktree(repoPath: string, meta: RepoMeta): Promise<boolean> {
  const { fileHashes, indexCoverage } = meta;
  const indexedDirtyPaths = indexCoverage?.dirtyPaths;
  if (
    !fileHashes ||
    !Array.isArray(indexedDirtyPaths) ||
    indexedDirtyPaths.length === 0 ||
    indexedDirtyPaths.some((rel) => typeof rel !== 'string') ||
    getGraphIncompleteReasons(meta).length > 0 ||
    indexCoverage?.maxFileSizeBytes !== getMaxFileSizeBytes()
  ) {
    return false;
  }

  const liveDirtyPaths = listWorkingTreeDirtyPaths(repoPath);
  const indexedDirtySet = new Set(indexedDirtyPaths);
  if (!liveDirtyPaths?.length || liveDirtyPaths.some((rel) => !indexedDirtySet.has(rel))) {
    return false;
  }

  // Reject ordinary edits before scanning the repo. Include previously dirty
  // paths so reverting one file while another stays dirty cannot look current.
  const dirtyHashes = await computeFileHashes(repoPath, indexedDirtyPaths);
  if (
    indexedDirtyPaths.some(
      (rel) => !dirtyHashes.has(rel) || dirtyHashes.get(rel) !== fileHashes[rel],
    )
  ) {
    return false;
  }

  try {
    const files = await walkRepositoryPaths(repoPath, undefined, {
      quiet: true,
      // Enable the walker's enumeration-error reporting: an unreadable subtree
      // must not be mistaken for an unchanged input set.
      onPathsDiscovered: async () => {},
    });
    const currentPaths = files
      .map((file) => file.path)
      .filter((rel) => !isGitNexusManagedPath(rel));
    const recordedPaths = Object.keys(fileHashes).filter((rel) => !isGitNexusManagedPath(rel));
    if (
      currentPaths.length !== recordedPaths.length ||
      currentPaths.some((rel) => fileHashes[rel] === undefined)
    ) {
      return false;
    }
    // Check all covered files, including changes hidden from Git's status and
    // changes to the scan's coverage through ignore rules outside the worktree.
    const hashes = await computeFileHashes(repoPath, currentPaths);
    return currentPaths.every((rel) => hashes.has(rel) && hashes.get(rel) === fileHashes[rel]);
  } catch {
    return false;
  }
}

async function runFullAnalysisInner(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
  writeTarget: WriteTarget,
  contentRetention: ContentRetention,
  parseRun: ParseIdentityRun,
  runnerIdentityAtBootstrap?: AnalyzerRunnerIdentity,
): Promise<AnalyzeResult> {
  const ftsDisabledReason = resolveFtsDisableReason(options.skipFts);
  const initAnalysisLbug = (dbPath: string, readOnly = false) => {
    if (options.resources) {
      const sizedPool = getEffectiveBufferPoolSize();
      const ceiling = options.resources.parse.graphPoolBytes;
      return initLbug(dbPath, {
        skipFts: readOnly || !!ftsDisabledReason,
        ...(readOnly ? { readOnly: true } : {}),
        bufferPoolBytes: Math.min(sizedPool || ceiling, ceiling),
        threads: options.resources.parse.nativeThreads,
      });
    }
    if (readOnly) return initLbug(dbPath, { readOnly: true, skipFts: true });
    return ftsDisabledReason ? initLbug(dbPath, { skipFts: true }) : initLbug(dbPath);
  };
  const log = (msg: string) => callbacks.onLog?.(stripControlCharacters(msg));
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  // ── rebuild reasons (#3137) ────────────────────────────────────────
  // Every path below that forces a full rebuild adds one reason here instead
  // of setting `options.force` and logging on its own. The rebuild decision is
  // read back from the collector at two checkpoints — before the pipeline
  // (one summary) and after it (at most one follow-up line) — so an upgrade
  // that trips several gates names them all once. Structural full builds (no
  // git, no stored file hashes, an empty file list) are not reasons.
  //
  // The caller's `force` is the user's own `--force`; `--skills` and a parse
  // cache bypass arrive as their own flags and are named for what they are.
  const collector = new RebuildReasonCollector();
  if (options.force === true) {
    collector.add({ key: 'user-force', text: 'a full rebuild was requested (--force).' });
  }
  if (options.skills === true) {
    collector.add({
      key: 'skills',
      text: 'skill generation requested (--skills) — it needs a freshly analyzed graph.',
    });
  }
  if (options.useParseCache === false) {
    collector.add({
      key: 'parse-cache-bypass',
      text: 'parser cache bypass requested — unchanged files will be re-parsed.',
    });
  }
  /**
   * The collected reasons as the crash-recovery marker's optional `reasons`
   * field (#3137 R9): spread into every `incrementalInProgress` writer, and
   * omitted when nothing was collected. Read at write time, so each stamp
   * carries the reasons known by then.
   */
  const storedRebuildReasons = (): Pick<
    NonNullable<RepoMeta['incrementalInProgress']>,
    'reasons'
  > => {
    const reasons = collector.toStored();
    return reasons.length > 0 ? { reasons } : {};
  };
  /** Checkpoint: the collector's verdict becomes the pipeline's `force`. */
  const applyCollectedForce = (): void => {
    options = { ...options, force: collector.forced };
  };
  /** Log reasons added after the summary as the run's single follow-up line. */
  const announceFollowUp = (): void => {
    const line = collector.formatFollowUp();
    if (line !== undefined) log(line);
  };

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
  // Content-addressed caches live once per shared store (#3352), else in the
  // flat slot shared by its branch slots (#2106 KTD7).
  const cacheRoot = writeTarget.sharedStore?.cachesDir ?? storagePath;
  let storageWritable: Promise<void> | undefined;
  const ensureWritableStorage = (): Promise<void> => {
    storageWritable ??= ensureStoragePathWritable(storagePath);
    return storageWritable;
  };
  const ftsProfile = ftsProfileForContentRetention(contentRetention);
  const ftsIndexes = getFtsIndexes(ftsProfile);
  let graphResourcesAdmitted = false;
  const admitGraphResources = async (): Promise<void> => {
    if (graphResourcesAdmitted) return;
    if (options.graphPublication === 'after-exit') await callbacks.onGraphWork?.();
    if (!options.resources) return;
    const { drainEmbeddingSidecarForAnalysis } =
      await import('./embeddings/embedding-sidecar-client.js');
    await drainEmbeddingSidecarForAnalysis();
    await drainAnalysisNativeResources();
    graphResourcesAdmitted = true;
  };

  // Start each analyze with a clean buffer-pool hint: any pre-pipeline DB open
  // (e.g. the embeddings-cache open) falls back to the default until the hint is
  // set from the built graph below, so a prior run's size can't leak in.
  setBufferPoolSizeHint(undefined);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  // Keep gitnexus.json and the legacy meta.json mirror in sync. Use the
  // ownership-validated write target rather than resolving storage again from
  // the registry while holding the index lock. Best-effort: loadMeta has its
  // own legacy fallback, so a reconciliation failure (read-only mount, full
  // disk) must never abort the analyze run.
  try {
    await reconcileMetadataFiles(repoPath, storagePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    log(`Metadata reconciliation failed (non-critical${code ? `, ${code}` : ''}); continuing.`);
  }

  // Shared-store pointer slots (#3352) get a private graph just before the
  // first graph open: here for the paths that open it before the up-to-date
  // check, and below once that check falls through.
  const ensurePrivateGraph = async (copy = true): Promise<void> => {
    await admitGraphResources();
    if (!writeTarget.sharedStore || placement.branch) return;
    if (!(await ensurePrivateSharedGraph(metaDir, log, { copy }))) {
      collector.add({
        key: 'private-graph-unavailable',
        text: 'this checkout could not get a private copy of the shared graph — building a fresh one.',
      });
    }
    // Later dirty-flag writes spread the in-memory metadata; keep them from
    // re-recording the pointer this slot just left.
    if (loadedMeta?.graphPath !== path.basename(lbugPath)) delete loadedMeta?.graphPath;
  };
  const loadedMeta = await loadMeta(metaDir);
  if (loadedMeta?.incrementalInProgress || options.repairFts) await ensurePrivateGraph();
  if (options.preserveExistingPdg && options.pdg === undefined) {
    if (loadedMeta) {
      options = { ...options, pdg: loadedMeta.pdg !== undefined };
    } else {
      try {
        await fs.stat(lbugPath);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          options = { ...options, pdg: false };
        } else {
          throw error;
        }
      }
      if (options.pdg === undefined) {
        throw new Error(
          `Cannot determine whether the existing index at ${lbugPath} contains PDG data; ` +
            'refusing to analyze so the live graph is preserved.',
        );
      }
    }
  }
  const previousFtsDisabledReason = getFtsDisabledReason(loadedMeta?.capabilities?.fts);
  // Flag and env are equivalent disablements. Only a true enable↔disable flip
  // needs a write plan; a discriminator-only change restamps on the
  // already-up-to-date path.
  const ftsModeChanged = Boolean(ftsDisabledReason) !== Boolean(previousFtsDisabledReason);
  // Fold explicit disablement into the in-memory prior meta so every later
  // saveMeta that spreads it (dirty flag, incremental phase stamps) advertises
  // "FTS disabled" instead of leftover available/build-failed while a wipe is
  // in flight. Re-enable leaves the prior stamp untouched.
  const existingMeta = loadedMeta
    ? withExplicitFtsDisablement(loadedMeta, ftsDisabledReason)
    : undefined;
  // KTD6: the dying process writes nothing. Infer skip from the FTS-phase
  // dirty flag (or a persisted native-abort skipReason) BEFORE later
  // saveMeta calls overwrite the on-disk phase.
  const priorFtsNativeAbort = inferNativeAbortSkip(
    existingMeta?.incrementalInProgress,
    existingMeta?.capabilities?.fts?.skipReason,
  );

  // Claim a fresh, ownership-validated slot before the pipeline writes caches.
  // A later registry-name collision or pipeline failure can otherwise leave
  // cache files without metadata, which must be treated as unowned on the next
  // invocation. This marker deliberately has no DB/freshness receipt, so read
  // paths still reject it until a successful analyze writes the final metadata.
  if (!existingMeta && !(await loadMeta(storagePath))) {
    await saveMeta(storagePath, {
      repoPath,
      storagePath,
      lastCommit: '',
      indexedAt: new Date().toISOString(),
    });
  }

  // ── FTS-only repair path ────────────────────────────────────────────
  const requestedRepairFts = Boolean(options.repairFts);
  if (
    options.repairFts &&
    existingMeta &&
    contentRetentionMismatch(existingMeta, contentRetention)
  ) {
    // Same predicate and key as the retention gate below, so the two merge
    // into one entry; that gate's more specific text replaces this one.
    collector.add({
      key: 'content-retention',
      text: 'content retention or FTS profile changed — the database is rebuilt before its search indexes.',
    });
    options = { ...options, repairFts: false };
  }
  if (options.repairFts) {
    if (!existingMeta) {
      throw new Error(
        'Cannot repair FTS indexes because this repository has not been analyzed yet. ' +
          'Run `gitnexus analyze` first to create the initial index, then retry `--repair-fts`.',
      );
    }
    if (shouldRefuseRepairFtsWhileDirty(existingMeta.incrementalInProgress)) {
      // #2409 / tri-review 4669518496 (R6): a non-FTS dirty flag means the
      // previous run died mid-writeback — the graph may be half-written and
      // its WAL possibly poisoned. This branch returns early, so the
      // dirty-recovery sidecar quarantine below would never run: repairing
      // FTS now would open the DB and replay that WAL pre-quarantine, and
      // even a survivable open would certify FTS over a half-written graph.
      // An FTS-phase flag with a successful checkpoint is different (KTD4):
      // the graph-boundary checkpoint already ran, so `--repair-fts` must
      // stay usable (R8). Missing/failed checkpoint is treated like a
      // half-written graph.
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
    await admitGraphResources();
    await ensureWritableStorage();
    // P1 R8: park a poisoned live WAL before opening. Staging never parks —
    // the live index next to an unpublished staging file must replay its WAL.
    const repairDirty = existingMeta.incrementalInProgress;
    if (shouldRefuseFtsCrashWal(repairDirty, existingMeta.capabilities?.fts)) {
      const {
        moved: repairParked,
        removed: repairRemoved,
        failed: repairParkFailed,
      } = await quarantineSidecarsForDirtyRecovery(lbugPath, (message) => log(`   ${message}`));
      if (repairParkFailed.length > 0) {
        throw new Error(ftsCrashParkFailureMessage(repairParkFailed[0]!));
      }
      if (repairParked.length + repairRemoved.length > 0) {
        log('Parked leftover WAL/shadow from the previous in-place FTS abort before --repair-fts.');
      }
    }
    try {
      await initAnalysisLbug(lbugPath);
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
        const inspectPath = extractExtensionPath(rawFtsReason);
        const { kind, remedy } = diagnoseExtensionLoad(
          rawFtsReason,
          'FTS',
          inspectPath,
          resolveFtsVersionPair(inspectPath),
        );
        const remedyTail = usesClassifiedLoadRemedy(kind)
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
      // Restamp before CREATE so a second native abort still has in-place
      // FTS dirty evidence after persist cleared the first stamp.
      try {
        const latestBeforeCreate = (await loadMeta(metaDir)) ?? existingMeta;
        await saveMeta(metaDir, {
          ...latestBeforeCreate,
          incrementalInProgress: buildFtsDirtyStamp({
            prior: latestBeforeCreate.incrementalInProgress,
            writePlan: 'in-place',
            checkpointSucceeded: true,
          }),
        });
      } catch (err) {
        log(
          `FTS dirty restamp write failed (non-critical, continuing with repair${
            err instanceof Error ? `: ${err.message}` : ''
          }).`,
        );
      }
      const repairFailures = await createSearchFTSIndexes({
        indexes: ftsIndexes,
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const catalogDiagnostics: string[] = [];
      let missing: string[] = [];
      let catalogError: string | undefined;
      try {
        missing = await verifySearchFTSIndexes(executeQuery, ftsIndexes, (diagnostic) => {
          catalogDiagnostics.push(diagnostic.message);
        });
      } catch (error) {
        // An unreadable catalog is unknown, not proof of missing indexes.
        // Keep earlier native build errors when this read also fails.
        catalogError = error instanceof Error ? error.message : String(error);
      }
      if (repairFailures.length > 0 || missing.length > 0 || catalogError !== undefined) {
        // A failed DROP may leave a valid old catalog entry. Its presence must
        // not certify that this repair succeeded or clear the recovery marker.
        const reasons = [
          missing.length > 0 ? `missing indexes after rebuild: ${missing.join(', ')}` : '',
          repairFailures.length > 0
            ? summarizeFtsIndexBuildFailures(repairFailures, ftsIndexes)
            : missing.length > 0
              ? 'no build error was returned'
              : '',
          ...catalogDiagnostics,
          catalogError !== undefined ? `catalog verification failed: ${catalogError}` : '',
        ].filter(Boolean);
        throw new Error(
          `FTS repair failed - ${reasons.join('. ')}. ` +
            'Run `gitnexus analyze --force` to perform a full graph+FTS rebuild; ' +
            'if that also fails, verify FTS extension availability via `gitnexus doctor`.',
        );
      }
      await ensureGitNexusIgnored(repoPath, storagePath);
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
          incrementalInProgress: undefined,
          capabilities: {
            graph: latestMeta.capabilities?.graph ?? DEFAULT_GRAPH_CAPABILITY,
            fts: { provider: 'ladybugdb-fts', status: 'available' },
            vectorSearch: latestMeta.capabilities?.vectorSearch ?? DEFAULT_VECTOR_SEARCH_CAPABILITY,
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
          onRename: (previousName, nextName) =>
            log(`Registry name changed: "${previousName}" -> "${nextName}".`),
          allowDuplicateName: options.allowDuplicateName,
          branch: placement.branch,
          storagePath,
        });
      }
      return {
        repoName:
          options.registryName ??
          getInferredRepoName(repoPath) ??
          path.basename(resolveRepoIdentityRoot(repoPath)),
        repoPath,
        storagePath,
        stats: existingMeta.stats ?? {},
        ftsRepairedOnly: true,
        rebuildReasons: collector.keys(),
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
  const parseIdentityResolution = parseRun.resolve();
  const effectiveParseIdentity = parseIdentityResolution.ok
    ? effectiveParseCacheIdentity(parseIdentityResolution.identity, options)
    : undefined;
  if (parseIdentityResolution.ok === false) {
    log(
      `Parse cache disabled: parser identity could not be verified (${parseIdentityResolution.reason}).`,
    );
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
    //
    // A rebuild already forced by a collected reason (--force, --skills, a
    // parse-cache bypass, a failed shared-graph copy, a retention change under
    // --repair-fts) discards the marker, as it did when those set `force`.
    const resumeOptions = { ...options, force: collector.forced };
    let decision = decideEmbeddingResume(checkpoint, undefined, resumeOptions);
    if (decision.action === 'abort') {
      const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
      embeddingIdentityForRun = resolveEmbeddingIdentity();
      decision = decideEmbeddingResume(checkpoint, embeddingIdentityForRun, resumeOptions);
    }
    if (decision.action === 'abort') throw new Error(decision.error);
    log(
      decision.action === 'resume' && checkpoint.recovery
        ? `Previous analyze recorded an embedding checkpoint (${checkpoint.nodesProcessed}/` +
            `${checkpoint.totalNodes} nodes); validating staged vectors before retrying ` +
            `${decision.pendingNodeIds.size} pending node(s).`
        : decision.log,
    );
    if (options.dropEmbeddings) {
      // --drop-embeddings has always implied a rebuild here; the decision only
      // covers the marker.
      collector.add({
        key: 'drop-embeddings',
        text: 'embeddings are being dropped (--drop-embeddings) along with their resume checkpoint.',
      });
    }
    if (decision.action === 'resume') {
      resumeEmbeddingCheckpoint = true;
      pendingEmbeddingNodeIds = new Set(decision.pendingNodeIds);
      resumedEmbeddingCheckpoint = decision.resumedFrom;
    }
  }

  // ── Crash recovery ────────────────────────────────────────────────
  // A non-FTS dirty flag (or an FTS abort that never checkpointed) still
  // forces a wipe + rebuild. An in-place FTS abort AFTER a successful
  // graph-boundary checkpoint (Windows full rebuild, POSIX incremental)
  // parks the live WAL and keeps the graph. A staging FTS abort never
  // parks the live WAL — that index must replay its own delta.
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

    const persistFtsNativeAbortRecovery = async (): Promise<void> => {
      existingMeta.incrementalInProgress = undefined;
      existingMeta.capabilities = {
        ...existingMeta.capabilities,
        graph: existingMeta.capabilities?.graph ?? DEFAULT_GRAPH_CAPABILITY,
        fts: {
          provider: existingMeta.capabilities?.fts?.provider ?? 'ladybugdb-fts',
          status: 'unavailable',
          skipReason: 'native-abort',
          ...(dirty.writePlan ? { writePlan: dirty.writePlan } : {}),
        },
        vectorSearch: existingMeta.capabilities?.vectorSearch ?? DEFAULT_VECTOR_SEARCH_CAPABILITY,
      };
      await saveMeta(metaDir, existingMeta);
    };

    if (allowsFtsCrashWalPark(dirty)) {
      log(
        'Previous analyze run aborted during in-place FTS after a successful graph checkpoint ' +
          `(${dirtyDetails}); parking leftover WAL/shadow so the existing graph can reopen. ` +
          'Search indexes stay skipped until `gitnexus analyze --repair-fts`.',
      );
      await ensureWritableStorage();
      const { failed } = await quarantineSidecarsForDirtyRecovery(lbugPath, (message) =>
        log(`   ${message}`),
      );
      if (failed.length > 0) {
        throw new Error(ftsCrashParkFailureMessage(failed[0]!));
      }
      await persistFtsNativeAbortRecovery();
    } else if (isFtsStagingDirty(dirty)) {
      log(
        'Previous analyze run aborted during FTS after a staging writeback ' +
          `(${dirtyDetails}); leaving the live index WAL in place so the unpublished ` +
          'staging file can still replay. Not forcing a rebuild.',
      );
      await persistFtsNativeAbortRecovery();
    } else {
      // One `interrupted-rebuild` entry carrying the crashed run's stored
      // reasons; a gate below that re-detects one of them merges into it.
      // A legacy boolean marker has no `reasons` and reads as none recorded.
      collector.recordInterruptedRebuild(
        readStoredRebuildReasons(typeof dirty === 'object' ? dirty.reasons : undefined),
        dirtyDetails,
      );
      // Reload meta after clearing the flag in-memory; we still want fileHashes
      // for the post-rebuild meta carry-over, but the collected reason ensures
      // the rebuild path executes.
      //
      // #2409 defect 2: the crashed writeback's WAL can be poisoned — replaying
      // it kills the process natively, and the first DB open of this recovery
      // run (the embedding-cache preservation open below) happens BEFORE the
      // rebuild wipe that would discard it. Park the WAL/shadow sidecars aside
      // now, while nothing is open, so every open in this run is replay-free.
      // The rebuild wipes the DB regardless, so no committed data is at stake.
      await ensureWritableStorage();
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
  }

  // ── rebuild-gate collection (#3137) ────────────────────────────────
  // The nine meta-mismatch gates below used to log individually the moment
  // each fired and set `force: true` nine times over. On an upgrade that
  // trips several gates at once (schema + runner identity + FTS profile is
  // the common triple), the operator got a scattered wall of near-identical
  // warnings. Each gate now adds its reason to the collector, and the one
  // summary before the pipeline prints them together. Every gate is still
  // evaluated (none early-returns), and a rebuild happens iff a forcing
  // reason was collected.
  //
  // #3137: the metadata a crashed FIRST build left behind is the slot claim
  // (`lastCommit: ''`, no fingerprint, no runner identity), not an index. It
  // rebuilds structurally anyway, and measuring it against these gates would
  // announce a schema and runner-identity change that never happened.
  const priorIsFirstBuildClaim =
    existingMeta?.lastCommit === '' &&
    existingMeta.schemaFingerprint === undefined &&
    existingMeta.runnerIdentity === undefined;
  const addGateReason = (reason: RebuildReason): void => {
    if (!priorIsFirstBuildClaim) collector.add(reason);
  };
  if (
    existingMeta &&
    (effectiveParseIdentity === undefined ||
      !isDeepStrictEqual(existingMeta.parseCacheIdentity, effectiveParseIdentity))
  ) {
    addGateReason({
      key: 'parser-identity',
      text:
        effectiveParseIdentity === undefined
          ? 'parser provenance is unverifiable — rebuilding without persistent parser caches.'
          : 'parser artifacts or extraction options changed, or prior provenance is missing — rebuilding the graph.',
    });
  }

  // ── pdg-mode flip forces full writeback (#2099 F1) ─────────────────
  // The incremental writeback persists only changed-file nodes, so a pdg
  // config differing from the one the DB rows were built under cannot be
  // reconciled incrementally: off→on silently drops the freshly built CFG
  // layer ("Incremental: changed=0", zero BasicBlock rows), on→off strands
  // zombie blocks for unchanged files. MUST sit before the alreadyUpToDate
  // fast path below — a clean-tree flip would otherwise early-return without
  // running the pipeline at all. The reason is collected even when another
  // reason already forces the rebuild: a mode change deserves a diagnostic
  // regardless of why a rebuild happens.
  if (existingMeta && pdgModeMismatch(existingMeta.pdg, options)) {
    const pdgOn = options.pdg === true;
    const capsOnly = !!existingMeta.pdg && pdgOn; // both-on can only mismatch via caps
    const was = existingMeta.pdg ? 'with --pdg' : 'without --pdg';
    const now = pdgOn ? 'with --pdg' : 'without --pdg';
    addGateReason({
      key: 'pdg-mode',
      text:
        `pdg mode changed (index built ${was}, this run is ${now}` +
        `${capsOnly ? ', but with different caps' : ''}) — the CFG layer will be ` +
        `${pdgOn ? 'fully persisted' : 'fully removed'}. ` +
        `Tip: set \`pdg: ${pdgOn}\` in .gitnexusrc to pin the mode across runs.`,
    });
  }

  // Retention controls the DB's persisted text and FTS columns. Incremental
  // writeback only touches changed files, so changing it in place would leave
  // old source text and index pages behind. Rebuild the database instead.
  if (existingMeta && contentRetentionMismatch(existingMeta, contentRetention)) {
    const recorded = existingMeta.contentRetention ?? 'full (legacy)';
    addGateReason({
      key: 'content-retention',
      text:
        `content retention changed (index built with ${recorded}, this run uses ${contentRetention}) — ` +
        'stored text and FTS indexes will be recreated.',
    });
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
    addGateReason({
      key: 'schema-fingerprint',
      text:
        `index schema changed (built by ${origin}, this build is ${SCHEMA_FINGERPRINT}) — ` +
        `the database will be recreated from the current schema.${nonGitNote}`,
    });
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
    addGateReason({
      key: 'graph-write-collapse',
      text:
        `previous run persisted ${persisted} of ${expected} expected relationships ` +
        `(recorded as a graph-write collapse) — a full re-analyze is required rather than ` +
        `reporting an index this build already knows is incomplete.`,
    });
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
  if (existingMeta && persistedAnalysisFeatureMismatches.length > 0) {
    addGateReason({
      key: 'analysis-features',
      text:
        `analysis capabilities changed (${persistedAnalysisFeatureMismatches.join(', ')}) — ` +
        `persisted feature evidence will be completed by the rebuild.`,
    });
  }

  // Declared route aliases / handler wrappers change Route evidence without
  // moving the commit or dirtying the tree, so a changed value must rebuild.
  const currentRouteHookConfig = routeHookConfigKey(options.routeHookConfig);
  const persistedRouteHookConfig = existingMeta?.routeHookConfig ?? routeHookConfigKey();
  if (existingMeta && persistedRouteHookConfig !== currentRouteHookConfig) {
    if (currentRouteHookConfig === routeHookConfigKey()) {
      log(
        'Warning: route aliases / handler wrappers used by the previous index are no longer ' +
          'configured (was GITNEXUS_RC unset?) — Routes they produced will be removed.',
      );
    }
    addGateReason({
      key: 'route-hook-config',
      text: 'route aliases or handler wrappers changed — persisted Route evidence will be rebuilt.',
    });
  }

  const currentSpringVendorPrefixes = springVendorPrefixesKey();
  const persistedRouteBindings = existingMeta?.analysisFeatures?.[SPRING_ROUTE_BINDINGS_FEATURE.id];
  if (
    existingMeta &&
    persistedRouteBindings === SPRING_ROUTE_BINDINGS_FEATURE.version &&
    existingMeta.springVendorPrefixes !== currentSpringVendorPrefixes
  ) {
    addGateReason({
      key: 'spring-vendor-prefixes',
      text:
        'Spring vendor mapping prefixes changed — persisted Route evidence will be rebuilt ' +
        'to match the configured aliases.',
    });
  }

  // Analyzer provenance is part of freshness, not merely diagnostics. A
  // same-commit fast path must not preserve metadata produced by an older,
  // malformed, or dependency/native-different runner. Force a real rebuild so
  // the graph and its schema-v4 receipt are finalized atomically together.
  if (existingMeta && !analyzerRunnerIdentitiesEqual(existingMeta.runnerIdentity, runnerIdentity)) {
    const stampedRunnerSchema = (
      existingMeta.runnerIdentity as { schemaVersion?: unknown } | undefined
    )?.schemaVersion;
    addGateReason({
      key: 'runner-identity',
      text:
        `analyzer runner identity changed (stamped schema ${String(stampedRunnerSchema ?? 'missing')}, ` +
        `this build uses schema ${runnerIdentity.schemaVersion}) — index provenance will be ` +
        'rewritten to match the analyzer and dependency/native runtime that produced it.',
    });
  }

  if (
    existingMeta &&
    cjkSegmentationModeMismatch(existingMeta.cjkSegmentation, getSearchFTSCjkSegmentation())
  ) {
    addGateReason({
      key: 'cjk-segmentation',
      text:
        `CJK segmentation mode changed (index built with '${existingMeta.cjkSegmentation ?? 'none'}', ` +
        `this run resolves '${getSearchFTSCjkSegmentation()}') — indexed text and query-time ` +
        `segmentation will be rebuilt in sync.`,
    });
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
  // Published generations keep vectors in their own typed artifact. Changing
  // that artifact's width must not invalidate the independently versioned graph.
  if (
    existingMeta &&
    !(options.graphPublication && existingMeta.graphGeneration) &&
    embeddingDimsMismatch(existingMeta.embeddingDims, EMBEDDING_DIMS)
  ) {
    // Only NAME a recorded width that could be one, for the reason the
    // fingerprint guard gates its stamp on `isSchemaFingerprintShaped`:
    // meta.json is a schema-less JSON.parse of on-disk state, so a value that
    // is not a positive integer is not worth quoting back at the user.
    const recordedDims = existingMeta.embeddingDims;
    const built =
      typeof recordedDims === 'number' && Number.isInteger(recordedDims) && recordedDims > 0
        ? `FLOAT[${recordedDims}]`
        : 'an unrecognized width';
    addGateReason({
      key: 'embedding-dims',
      text:
        `embedding dimensions changed (index built with ${built}, this run embeds at ` +
        `${EMBEDDING_DIMS}) — the vector column will be recreated at the new width. ` +
        `Tip: set GITNEXUS_EMBEDDING_DIMS (or --embedding-dims) to pin it across runs.`,
    });
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
    collector.add({
      key: 'spring-actuator',
      text: 'Spring Actuator runtime enrichment requested — runtime snapshots are re-read on every run.',
    });
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
    collector.add({
      key: 'spring-actuator',
      text: 'Spring Actuator runtime enrichment disabled — runtime evidence will be removed.',
    });
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
    collector.add({
      key: 'asyncapi',
      text: 'AsyncAPI document reading requested — documents are re-read on every run.',
    });
  } else if (asyncApiSpecPreviouslyEnabled) {
    collector.add({
      key: 'asyncapi',
      text: 'AsyncAPI document reading disabled — document-derived evidence will be removed.',
    });
  }

  // Process-detection budget (#3313). Resolve CLI/options then env here so
  // MCP/server jobs honor GITNEXUS_* without a CLI merge. Compare against
  // the persisted stamp BEFORE the already-up-to-date fast path: a clean
  // same-commit raise must re-detect flows rather than return the sampled
  // index. Does NOT set force — incremental empty-diff + skip derived
  // preserve is enough.
  const processDetectionBudget = resolveProcessDetectionBudget(
    {
      maxProcesses: options.maxProcesses,
      maxProcessBranching: options.maxProcessBranching,
      maxProcessTraceDepth: options.maxProcessTraceDepth,
      maxEntryPointCandidates: options.maxEntryPointCandidates,
    },
    process.env,
    (knob, raw) => {
      log(formatInvalidProcessDetectionOverride(knob, raw));
    },
  );
  const processDetectionMismatch = processDetectionBudgetMismatch(
    existingMeta?.processDetection,
    processDetectionBudget,
  );

  // A shared-store slot (#3352) can record HEAD with no graph behind it: a
  // publish interrupted between its renames, or a commit graph reclaimed from
  // under the pointer. Neither the fast path nor an incremental diff (which
  // writes only changed files into a fresh, empty database) would restore it,
  // so rebuild. Scoped to store slots: private `.gitnexus` indexes only lose
  // their graph by hand, and their metadata-only fixtures rely on this path.
  // Checked even when another reason already forces the rebuild, so the
  // summary names every cause.
  if (existingMeta && storeRootOfCheckoutSlot(storagePath)) {
    const graph = placement.branch ? lbugPath : resolveGraphPath(storagePath);
    if (!existsSync(graph)) {
      collector.add({
        key: 'shared-store-missing-graph',
        text: 'shared store: this checkout records a commit but has no graph — building a fresh one.',
      });
    }
  }

  // Checkpoint 1 (pre-pipeline): every reason the fast path must honor is in.
  // `ensurePrivateGraph` below can still add one; the checkpoint re-runs after
  // it, before any reader that plans the rebuild.
  applyCollectedForce();

  // ── Early-return: already up to date ──────────────────────────────
  const includeDotDirsChanged =
    JSON.stringify(existingMeta?.indexCoverage?.includeDotDirs ?? []) !==
    JSON.stringify(getIncludeDotDirs());
  if (
    existingMeta &&
    (!existingMeta.embeddingCheckpoint ||
      (options.graphPublication &&
        resumeEmbeddingCheckpoint &&
        !existingMeta.embeddingCheckpoint.recovery)) &&
    !options.force &&
    existingMeta.lastCommit === currentCommit &&
    !ftsModeChanged &&
    !processDetectionMismatch &&
    !includeDotDirsChanged
  ) {
    // Non-git folders have currentCommit = '' — always rebuild since we can't detect changes
    if (currentCommit !== '') {
      // For git repos, even if HEAD matches lastCommit, the working tree
      // may have uncommitted changes. A dirty checkout can short-circuit only
      // after proving it still matches a successfully indexed dirty snapshot.
      //
      // We exclude paths that GitNexus itself writes during analyze:
      //   .gitnexus/                  — db / parse cache / meta.json
      //   .claude/, .cursor/          — auto-generated agent skill files
      //   AGENTS.md, CLAUDE.md        — auto-updated stats blocks
      // Counting them as dirty would perpetually defeat the up-to-date
      // fast path because the previous analyze just wrote them
      // (regression vs PR #1233 behavior).
      const dirty = isWorkingTreeDirty(repoPath);
      const dirtySnapshotMatches =
        dirty &&
        existsSync(placement.branch ? lbugPath : resolveGraphPath(storagePath)) &&
        (await matchesIndexedDirtyWorktree(repoPath, existingMeta));
      // A clean porcelain status is not enough when the previous index captured
      // uncommitted content at this same HEAD: assume-unchanged and skip-worktree
      // paths are deliberately absent from porcelain. Re-hash only the paths
      // recorded dirty by the previous run. Matching hashes mean the index still
      // describes disk and may take the fast path; a mismatch (including an
      // unreadable/deleted file) must fall through to incremental reconciliation.
      const indexedDirtyPaths = existingMeta.indexCoverage?.dirtyPaths ?? [];
      let indexedContentChanged = indexedDirtyPaths.length > 0;
      let reconciledCleanCoverage = false;
      if (!dirty && existingMeta.fileHashes) {
        // Porcelain also hides newly edited assume-unchanged/skip-worktree
        // paths that were absent from the previous receipt. Include the live
        // hidden-path set in the bounded comparison so those edits cannot take
        // the fast path and publish stale content for HEAD.
        const liveDirtyPaths = listWorkingTreeDirtyPaths(repoPath);
        if (liveDirtyPaths === null) {
          indexedContentChanged = true;
        } else {
          const pathsToCheck = [...new Set([...indexedDirtyPaths, ...liveDirtyPaths])].filter(
            (rel) => existingMeta.fileHashes?.[rel] !== undefined,
          );
          const currentDirtyHashes = await computeFileHashes(repoPath, pathsToCheck);
          indexedContentChanged = pathsToCheck.some(
            (rel) => currentDirtyHashes.get(rel) !== existingMeta.fileHashes?.[rel],
          );
          // A mode-only dirty snapshot can leave a coverage receipt even though
          // restoring the mode makes porcelain clean and content hashes equal.
          // Clear that receipt before taking the fast path; otherwise shared
          // publication remains blocked forever despite a clean checkout.
          reconciledCleanCoverage =
            !indexedContentChanged && indexedDirtyPaths.length > 0 && liveDirtyPaths.length === 0;
        }
      }
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
      if (reconciledCleanCoverage) {
        try {
          existingMeta.indexCoverage = {
            ...existingMeta.indexCoverage,
            dirtyPaths: [],
          };
          await saveMeta(metaDir, existingMeta);
        } catch {
          // If the receipt cannot be persisted, fall through to the normal
          // reconciliation path instead of returning with stale metadata.
          indexedContentChanged = true;
        }
      }
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
      if (((!dirty && !indexedContentChanged) || dirtySnapshotMatches) && !healUnregistered) {
        const processDetectionStamp =
          existingMeta.processDetection ?? toProcessDetectionStamp(processDetectionBudget);
        if (options.registryName) {
          await registerRepo(repoPath, existingMeta, {
            name: options.registryName,
            onRename: (previousName, nextName) =>
              log(`Registry name changed: "${previousName}" -> "${nextName}".`),
            allowDuplicateName: options.allowDuplicateName,
            branch: placement.branch,
            storagePath,
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
            await adoptFlatBranchLabel(repoPath, branchLabel, storagePath);
            await saveMeta(metaDir, {
              ...existingMeta,
              branch: branchLabel,
              processDetection: processDetectionStamp,
            });
          } catch (err) {
            // EACCES/EPERM also arise from ownership problems and transient
            // Windows locks, so keep the real error visible alongside the
            // #1549 read-only hint instead of replacing it.
            log(
              `Warning: could not restamp the workspace branch label (${formatMetaWriteFailureReason(err)}); will retry on the next run.`,
            );
          }
        } else if (ftsDisabledReason && ftsDisabledReason !== previousFtsDisabledReason) {
          // Discriminator-only restamp (flag↔env). `existingMeta` already
          // carries the folded skipReason; persist it without a write plan.
          try {
            await saveMeta(metaDir, {
              ...existingMeta,
              processDetection: processDetectionStamp,
            });
          } catch (err) {
            log(
              `Warning: could not restamp the FTS skip reason (${formatMetaWriteFailureReason(err)}); will retry on the next run.`,
            );
          }
        } else if (!existingMeta.processDetection) {
          try {
            await saveMeta(metaDir, {
              ...existingMeta,
              processDetection: processDetectionStamp,
            });
          } catch (err) {
            log(
              `Warning: could not backfill the process-detection stamp (${formatMetaWriteFailureReason(err)}); will retry on the next run.`,
            );
          }
        }
        await ensureGitNexusIgnored(repoPath, storagePath);
        return {
          // `resolveRepoIdentityRoot` collapses worktree roots to the
          // canonical repo basename (#1259) but leaves arbitrary subdirs
          // and `--skip-git` paths unchanged (#1232/#1233 intent preserved).
          repoName:
            options.registryName ??
            getInferredRepoName(repoPath) ??
            path.basename(resolveRepoIdentityRoot(repoPath)),
          repoPath,
          storagePath,
          stats: existingMeta.stats ?? {},
          alreadyUpToDate: true,
          rebuildReasons: collector.keys(),
          ...(ftsDisabledReason ? { ftsSkipped: true, ftsSkipReason: ftsDisabledReason } : {}),
          ...(!ftsDisabledReason && priorFtsNativeAbort
            ? { ftsSkipped: true, ftsSkipReason: 'native-abort' }
            : {}),
          isPrimaryBranch: !placement.branch,
        };
      }
    }
  }

  await admitGraphResources();
  await ensureWritableStorage();
  // A forced rebuild reads the old graph only to carry embeddings over; with
  // none to carry, copying the shared graph would be thrown away unread.
  const forcedRebuildReadsOldGraph =
    resumeEmbeddingCheckpoint ||
    _deriveEmbeddingMode(options, existingMeta?.stats?.embeddings ?? 0).shouldLoadCache;
  await ensurePrivateGraph(!options.force || forcedRebuildReadsOldGraph);
  if (existingMeta?.graphPath !== path.basename(lbugPath)) delete existingMeta?.graphPath;
  // Checkpoint 1, final read: a graph copy that just failed forces the rebuild
  // before the embedding plan, the parse cache, and the emit mode are decided.
  applyCollectedForce();

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
    (options.graphPublication !== undefined ||
      (options.pdg !== true && process.env.GITNEXUS_ATOMIC_WINDOWS_SWAP === '1'));

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
  let cachedSnapshot: CachedEmbeddingsSnapshot = emptyCachedEmbeddingsSnapshot();
  const adoptCachedEmbeddings = (raw: CachedEmbeddingsSnapshot): void => {
    cachedSnapshot = normalizeCachedEmbeddings(raw);
    assertUniqueEmbeddingKeys(cachedSnapshot.rows, 'Cached embedding');
  };
  const discardCachedEmbeddings = (): void => {
    disposeEmbeddingSpill(cachedSnapshot.spill);
    cachedSnapshot = emptyCachedEmbeddingsSnapshot();
  };
  const discardCachedEmbeddingSpill = (): void => {
    disposeEmbeddingSpill(cachedSnapshot.spill);
    cachedSnapshot = { ...cachedSnapshot, spill: undefined };
  };

  const existingEmbeddingCount = existingMeta?.stats?.embeddings ?? 0;
  const {
    forceRegenerateEmbeddings,
    preserveExistingEmbeddings,
    shouldGenerateEmbeddings: derivedShouldGenerateEmbeddings,
    shouldLoadCache: derivedShouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);
  const shouldGenerateEmbeddings = derivedShouldGenerateEmbeddings || resumeEmbeddingCheckpoint;
  const shouldLoadCache =
    !(options.graphPublication && (existingMeta?.vectorGeneration || existingMeta?.embeddingJob)) &&
    (derivedShouldLoadCache || resumeEmbeddingCheckpoint);

  const stagedRecovery = resolveEmbeddingRecovery(metaDir, existingMeta?.embeddingCheckpoint);
  const stagedCheckpoint = existingMeta?.embeddingCheckpoint;
  const inheritedUnsafeNodeIds = new Set([
    ...pendingEmbeddingNodeIds,
    ...(stagedRecovery?.unsafeNodeIds ?? []),
  ]);

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
  // wipes the DB) — loading unconditionally is insurance against
  // silently dropping embeddings on a mispredicted run. Every fresh graph
  // restores compatible cached rows after the bulk load.
  //
  // This is the FIRST DB open of the run — the one #2409 defect 2 is about.
  // On a dirty-recovery run it happens only after the sidecar quarantine
  // moved (or removed) the crashed run's WAL/shadow; when neither was
  // possible the dirty block above already threw a LbugWipeError, so this
  // open is replay-free by construction (FIX 1 of this shipping review).
  // A supervisor handoff can create placeholder metadata before the first
  // database exists. Skip that empty cache, but still fail closed if missing
  // storage claims paid vectors that must be preserved.
  if (shouldLoadCache && existingMeta && (existingEmbeddingCount > 0 || existsSync(lbugPath))) {
    if (
      options.graphPublication &&
      !options.dropEmbeddings &&
      !existingMeta.graphGeneration &&
      !existingMeta.legacyVectorSource
    ) {
      const { exportLegacyVectorsFromFile } = await import('./lbug/legacy-vector-export.js');
      const historical = existingMeta.embeddingCheckpoint;
      const legacy = await exportLegacyVectorsFromFile(lbugPath, {
        metadataDirectory: metaDir,
        provenance: {
          schemaFingerprint: existingMeta.schemaFingerprint ?? SCHEMA_FINGERPRINT,
          ...(historical
            ? {
                recordedIdentity: {
                  provider: historical.provider,
                  model: historical.model,
                  dimensions: historical.dimensions,
                },
              }
            : {}),
        },
        excluded: inheritedUnsafeNodeIds,
        sourcePoolBytes: options.resources!.embedding.graphPoolBytes,
        bufferPoolBytes: options.resources!.embedding.vectorPoolBytes,
        threads: options.resources!.embedding.nativeThreads,
        signal: callbacks.signal,
      });
      if (legacy) {
        await saveMeta(metaDir, { ...existingMeta, legacyVectorSource: legacy });
        existingMeta.legacyVectorSource = legacy;
      }
    }
    // Preserve/recover sidecars before reading the prior graph. The cache
    // open itself is read-only: failure during staging must leave the
    // published file intact. Preservation failures must stop analysis.
    if (posixSwap || windowsSwapOk) await consolidateLbugForPublication(lbugPath);
    try {
      progress('embeddings', 0, 'Caching embeddings...');
      await initAnalysisLbug(lbugPath, true);
      adoptCachedEmbeddings(await loadCachedEmbeddings());
      await closeLbug();
    } catch (err: any) {
      discardCachedEmbeddings();
      try {
        await closeLbug();
      } catch {
        /* preserve the original cache failure */
      }
      if (err instanceof EmbeddingIntegrityError) throw err;
      // Surface cache-load failures explicitly: silently swallowing here would
      // re-introduce the original silent-data-loss symptom (embeddings end up
      // at 0 in meta.json with no diagnostic) through a different door.
      log(
        `Warning: could not load cached embeddings ` +
          `(${err?.message ?? String(err)}). ` +
          `Embeddings will not be preserved on this run.`,
      );
    }
  }

  // A checkpoint's pending decision and its paid, complete vectors are
  // independent: --force discards the former but can still reuse the latter.
  // Select only the explicitly referenced generation, never an orphan by age.
  if (shouldLoadCache && !options.dropEmbeddings && stagedRecovery && stagedCheckpoint) {
    if (!embeddingIdentityForRun) {
      const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
      embeddingIdentityForRun = resolveEmbeddingIdentity();
    }
    const marker = stagedCheckpoint;
    const matchesIdentity =
      marker.model === embeddingIdentityForRun.model &&
      marker.dimensions === embeddingIdentityForRun.dimensions &&
      marker.provider === embeddingIdentityForRun.provider;
    if (matchesIdentity && stagedRecovery.schemaFingerprint === SCHEMA_FINGERPRINT) {
      // A force-discarded pending decision must not turn a known incomplete
      // inherited group into a reusable cache merely because its hash matches.
      if (inheritedUnsafeNodeIds.size > 0) {
        const rows = cachedSnapshot.rows.filter((row) => !inheritedUnsafeNodeIds.has(row.nodeId));
        cachedSnapshot = {
          ...cachedSnapshot,
          rows,
          embeddingNodeIds: new Set(rows.map((row) => row.nodeId)),
        };
      }
      let recovered: CachedEmbeddingsSnapshot | undefined;
      try {
        const { recoverStagedEmbeddings, mergeRecoveredEmbeddings } =
          await import('./embeddings/staged-embedding-recovery.js');
        recovered = await recoverStagedEmbeddings(stagedRecovery.dbPath, {
          dimensions: embeddingIdentityForRun.dimensions,
          excludedNodeIds: stagedRecovery.unsafeNodeIds,
        });
        const liveCacheDims = snapshotEmbeddingDims(cachedSnapshot);
        if (liveCacheDims !== undefined && liveCacheDims !== embeddingIdentityForRun.dimensions) {
          log(
            `Embedding dimensions changed (${liveCacheDims}d -> ` +
              `${embeddingIdentityForRun.dimensions}d), discarding published cache`,
          );
          discardCachedEmbeddings();
        }
        if (recovered.rows.length > 0) {
          const merged = mergeRecoveredEmbeddings(cachedSnapshot, recovered);
          disposeEmbeddingSpill(cachedSnapshot.spill);
          adoptCachedEmbeddings(merged);
        }
        log(
          `Recovered ${recovered.rows.length} complete staged embedding chunk(s) ` +
            `for ${recovered.embeddingNodeIds.size} node(s); unchanged content can reuse them.`,
        );
      } catch (err) {
        if (err instanceof EmbeddingIntegrityError) throw err;
        log(
          `Warning: could not recover staged embeddings (${(err as Error).message}); ` +
            'the retry will regenerate missing chunks.',
        );
      } finally {
        disposeEmbeddingSpill(recovered?.spill);
      }
    } else {
      log('Staged embedding identity or schema changed; its vectors will not be reused.');
    }
  }

  // ── Load incremental parse cache ──────────────────────────────────
  // Every fresh or repaired shard stays run-owned until final verification.
  // The same directory provides bounded transient ParsedFile streaming when
  // identity is unverifiable, without creating a reusable cache generation.
  parseRun.storagePath = getColdParseRebuildDir(metaDir);
  const coldParseRebuildDir = await createColdParseRebuildDir(metaDir);
  forgetCreatedParseCacheDir(coldParseRebuildDir);
  const parseCache =
    parseIdentityResolution.ok === false
      ? undefined
      : options.useParseCache === false
        ? emptyParseCache(parseIdentityResolution.identity, {
            writeStoragePath: coldParseRebuildDir,
          })
        : await loadParseCache(cacheRoot, parseIdentityResolution.identity, coldParseRebuildDir);

  // Streamed structural emit (#2680). Resolved ONCE, so the pipeline flag and
  // the CSV-dir resolution below cannot disagree — and resolved HERE, not at
  // function entry, because the POSITION is load-bearing: the gate is
  // `options.force`, which only the collector checkpoints above set, from the
  // reasons every freshness guard contributed (embedding-checkpoint drop,
  // dirty-flag recovery, pdg-mode flip, schema-fingerprint change,
  // analysis-feature drift, runner-identity change, CJK-mode change, a failed
  // shared-graph copy). Resolving before them froze the answer at `false` for
  // every rebuild they trigger — including the whole-fleet rebuild an
  // schema-fingerprint change forces on every existing index at once,
  // which is exactly when the #2649 memory relief matters most. So this MUST
  // stay below the last checkpoint that can set `force` and above its first use.
  // (The post-pipeline checkpoint can also set `force`, but the pipeline has
  // already run by then; that run emits non-streamed, precisely as
  // `resolveStreamPdgEmit` — read fresh at the same point — behaves.)
  const streamGraphEmitActive = resolveStreamGraphEmit(options);

  // Retain the pipeline's deferred-derived contract for cached parses, then
  // finish those phases before the fresh graph is persisted below. Streamed
  // builds emit them during the pipeline before their sink is finalized.
  const skipDerivedGraphPhases =
    !streamGraphEmitActive &&
    !options.force &&
    !!existingMeta &&
    !!existingMeta.fileHashes &&
    Object.keys(existingMeta.fileHashes).length > 0 &&
    repoHasGit &&
    !schemaFingerprintMismatch(existingMeta.schemaFingerprint);

  // The one pre-pipeline announcement (#3137): the reason inline, several as a
  // numbered block, nothing for an incremental or structural build.
  const rebuildSummary = collector.formatSummary();
  if (rebuildSummary !== undefined) log(rebuildSummary);

  // ── Phase 1: Full Pipeline (0–60%) ────────────────────────────────
  let pipelineResult;
  let inputFileHashes: Map<string, string> | undefined;
  try {
    if (repoHasGit) {
      // Capture freshness before parsing. Hashing afterward can certify an edit
      // the graph never saw and let the dirty fast path preserve stale results.
      // A concurrent edit now differs from this receipt on the next analysis.
      const inputs = await walkRepositoryPaths(repoPath, undefined, {
        quiet: true,
        onPathsDiscovered: async () => {},
      });
      inputFileHashes = await computeFileHashes(
        repoPath,
        inputs.map((file) => file.path),
      );
    }
    callbacks.signal?.throwIfAborted();
    const { runPipelineFromRepo } = await import('./ingestion/pipeline.js');
    pipelineResult = await runPipelineFromRepo(
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
        signal: callbacks.signal,
        parseCache,
        parsedFileStorePath: coldParseRebuildDir,
        parseWorkerUrl: parseIdentityResolution.ok ? parseIdentityResolution.workerUrl : undefined,
        workerPoolSize: options.workerPoolSize,
        ...(options.resources ? { workerResources: options.resources.parse } : {}),
        maxProcesses: processDetectionBudget.maxProcesses,
        maxProcessBranching: processDetectionBudget.overridden.maxProcessBranching
          ? processDetectionBudget.maxProcessBranching
          : undefined,
        maxProcessTraceDepth: processDetectionBudget.overridden.maxProcessTraceDepth
          ? processDetectionBudget.maxProcessTraceDepth
          : undefined,
        maxEntryPointCandidates: processDetectionBudget.overridden.maxEntryPointCandidates
          ? processDetectionBudget.maxEntryPointCandidates
          : undefined,
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
        // offloaded BasicBlock layer. Non-full retention profiles must keep
        // BasicBlock source text in memory until the retention pass below.
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
        routeHookConfig: options.routeHookConfig,
        skipDerivedGraphPhases,
        springActuatorPath: options.springActuatorPath,
        asyncApiSpecPath: options.asyncApiSpecPath,
        springActuatorScanExclusions,
        // Streaming/chunked PDG emit must remain disabled for non-full content
        // retention profiles because BasicBlock source text is stripped only
        // after all semantic phases have completed.
        streamPdgEmit: contentRetention === 'full' && resolveStreamPdgEmit(options),
      },
    );
  } catch (err) {
    discardCachedEmbeddingSpill();
    await removeColdParseRebuildDir(coldParseRebuildDir, true);
    throw err;
  }

  if (parseCache && options.force && (pipelineResult.parseCacheHitFileCount ?? 0) > 0) {
    log(
      `Rebuilt the graph and FTS while reusing cached parser output for ` +
        `${pipelineResult.parseCacheHitFileCount} file(s) ` +
        `(parser ${parseCache.identity.base.slice(0, 19)}). ` +
        `Parser compatibility is derived automatically from the installed artifacts.`,
    );
  }

  // ── Phase 2: LadybugDB (60–85%) ──────────────────────────────────
  callbacks.signal?.throwIfAborted();
  progress('lbug', 60, 'Loading into LadybugDB...');

  // Parsing and graph construction always see the original source. Apply the
  // retention boundary only after all semantic phases have completed and
  // before any graph rows, FTS values, or embeddings are persisted.
  applyContentRetention(pipelineResult.graph, contentRetention);

  // Restrict the pre-parse hashes to the pipeline's actual File nodes.
  // Used both to drive the incremental DB writeback (when eligible) and to
  // populate meta.json.fileHashes for the next run.
  const allFilePaths: string[] = [];
  pipelineResult.graph.forEachNode((n) => {
    if (n.label === 'File') {
      const fp = n.properties?.filePath as string | undefined;
      if (fp) allFilePaths.push(fp);
    }
  });
  const newFileHashes = inputFileHashes
    ? new Map(
        allFilePaths.flatMap((rel) => {
          const hash = inputFileHashes.get(rel);
          return hash === undefined ? [] : [[rel, hash] as const];
        }),
      )
    : await computeFileHashes(repoPath, allFilePaths);
  const currentAnalysisFeatures = resolveAnalysisFeatureVersions(ANALYSIS_FEATURES, allFilePaths);
  const currentAnalysisFeatureMismatches = existingMeta
    ? findAnalysisFeatureMismatches(existingMeta.analysisFeatures, currentAnalysisFeatures)
    : [];
  if (existingMeta && currentAnalysisFeatureMismatches.length > 0) {
    // Covers a repository gaining or losing its first applicable source file:
    // the persisted file list cannot predict that transition before the
    // pipeline, but an incremental top-up would leave unchanged rows incomplete.
    // Same key as the pre-pipeline gate, so a mismatch that gate already
    // announced merges into its entry and prints no second line.
    addGateReason({
      key: 'analysis-features',
      text:
        `analysis capabilities changed (${currentAnalysisFeatureMismatches.join(', ')}) — ` +
        `persisted feature evidence will be completed by the rebuild.`,
    });
  }
  // Checkpoint 2 (post-pipeline): the capability re-check is the last reason
  // that can force the rebuild. The compact physical write below contributes
  // a non-forcing reason while preserving logical incremental bookkeeping.
  announceFollowUp();

  // Decide incremental vs full at THIS point (post-pipeline, pre-DB).
  // All eligibility conditions are checked here against the actual
  // pipeline output — no separate pre-pipeline prediction to desync from
  // (Bugbot review on PR #1479: a prediction that flipped post-pipeline
  // could skip the embedding cache load and then take the full-rebuild
  // path, silently losing embeddings).
  const incrementalEligible =
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

  // Preserve the checkpoint opt-out contract: these runs report a full
  // rebuild and do not claim incremental verification.
  const isIncremental = incrementalEligible && isManualCheckpointEnabled();
  if (incrementalEligible && !isIncremental) {
    log('Manual WAL checkpoints are disabled; switching to a full DB write before mutation.');
  }

  const hashDiff = isIncremental
    ? diffFileHashes(newFileHashes, existingMeta!.fileHashes)
    : undefined;

  // Parsing and change accounting stay incremental, but populated-table DML
  // rewrites native storage regions even for one changed file (#3852). Every
  // persisting run bulk-loads a fresh database, including its derived layers.
  if (skipDerivedGraphPhases) {
    progress('communities', 58, 'Detecting code communities and flows...');
    await pipelineResult.runDeferredDerivedPhases?.();
  }
  const useAtomicSwap = posixSwap || windowsSwapOk;
  // Preserve/recover the live family before any writable open. A replacement
  // must not conceal orphan WALs or a pre-existing quarantine.
  if (useAtomicSwap) await consolidateLbugForPublication(lbugPath);
  // Set only at the first operation that can mutate the live graph store.
  // Pre-write failures (config, lock, parsing, metadata, importer expansion)
  // remain retryable even when this platform cannot use an atomic swap.
  let liveIndexMutationStarted = false;
  // #2658: a per-run staging name (was the fixed `lbug.new`). Even under the
  // single-writer lock, a unique name means a crashed run's half-built staging
  // file can never be mistaken for — or clobber — a live run's; the lock's
  // orphan sweep (sweepStagingArtifacts) reclaims stragglers on the next
  // acquire. The `.staging.` prefix is what that sweep matches.
  const buildPath = useAtomicSwap ? `${lbugPath}.staging.${randomUUID()}` : lbugPath;
  let inPlaceAttempt: string | undefined;
  let inPlaceVectorCoverage: RepoMeta['vectorGeneration'];
  const saveGraphDirtyState = async (metadata: RepoMeta): Promise<void> => {
    if (!options.graphPublication || buildPath !== lbugPath) {
      await saveMeta(metaDir, metadata);
      return;
    }
    if (!inPlaceAttempt) {
      const dirty = await beginInPlaceAnalysis(metaDir, metadata, (meta) =>
        saveMeta(metaDir, meta),
      );
      inPlaceAttempt = dirty.incrementalInProgress?.attemptId;
      inPlaceVectorCoverage = dirty.vectorGeneration;
      return;
    }
    if (!metadata.incrementalInProgress) throw new Error('Missing in-place write state');
    await saveMeta(metaDir, {
      ...metadata,
      graphGeneration: undefined,
      vectorGeneration: inPlaceVectorCoverage,
      incrementalInProgress: {
        ...metadata.incrementalInProgress,
        attemptId: inPlaceAttempt,
        writePlan: 'in-place',
      },
    });
  };

  let incrementalStats: AnalyzeResult['incrementalStats'];
  const rescueLegacyEmbeddings =
    !!existingMeta &&
    existsSync(lbugPath) &&
    !existingMeta.graphGeneration &&
    !options.dropEmbeddings &&
    cacheRowCount(cachedSnapshot) === 0;
  if ((isIncremental && hashDiff) || rescueLegacyEmbeddings) {
    try {
      await initAnalysisLbug(lbugPath, true);
      if (isIncremental && hashDiff) {
        const MAX_IMPORTER_BFS_DEPTH = 4;
        const writableFiles = new Set<string>(hashDiff.toWrite);
        const directlyChangedCount = writableFiles.size;
        // Resolution groups can change edges between unchanged files without an
        // import or a new-graph edge touching the changed/deleted member. Expand
        // before the importer walk so dependents of these siblings refresh too.
        const { collectResolutionGroupFiles } = await import('./incremental/resolution-groups.js');
        for (const filePath of collectResolutionGroupFiles(
          [...hashDiff.toWrite, ...hashDiff.deleted],
          allFilePaths,
        )) {
          writableFiles.add(filePath);
        }
        const resolutionGroupExpansion = writableFiles.size - directlyChangedCount;
        if (resolutionGroupExpansion > 0) {
          log(`Incremental: +${resolutionGroupExpansion} resolution sibling(s) affected`);
        }
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
          let frontier: string[] = [...writableFiles, ...hashDiff.deleted, ...shadowSeed];
          for (let depth = 0; depth < MAX_IMPORTER_BFS_DEPTH && frontier.length > 0; depth++) {
            const importers = await queryImportersBatch(frontier, {
              onChunkFailure: () => {
                log(
                  'Warning: importer accounting is incomplete; the full graph will still be written.',
                );
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
        const importerExpansion =
          writableFiles.size - directlyChangedCount - resolutionGroupExpansion;
        incrementalStats = {
          changedFiles: hashDiff.changed.length + hashDiff.added.length + hashDiff.deleted.length,
          reparsedFiles: pipelineResult.reparsedFileCount,
          affectedDependents: resolutionGroupExpansion + importerExpansion,
          deletedFiles: hashDiff.deleted.length,
          writeMode: 'full',
        };
        if (importerExpansion > 0) {
          log(
            `Incremental: +${importerExpansion} importer(s) affected (BFS depth ≤ ${MAX_IMPORTER_BFS_DEPTH})`,
          );
        }
        log(
          `Incremental: changed=${hashDiff.changed.length}, added=${hashDiff.added.length}, ` +
            `deleted=${hashDiff.deleted.length}; writing a compact full graph`,
        );
        addGateReason({
          key: 'escalated-full-write',
          forcing: false,
          text: 'switching to a full DB write (fresh bulk COPY) to avoid native row-update storage growth.',
        });
        announceFollowUp();
      }
      // Metadata from an older run can undercount paid legacy vectors. Rescue
      // them before any fresh-file replacement, not only when an extension
      // blocks selective DML. Modern vector generations are separate artifacts.
      if (rescueLegacyEmbeddings) {
        adoptCachedEmbeddings(await loadCachedEmbeddings());
        if (inheritedUnsafeNodeIds.size > 0) {
          const rows = cachedSnapshot.rows.filter((row) => !inheritedUnsafeNodeIds.has(row.nodeId));
          cachedSnapshot = {
            ...cachedSnapshot,
            rows,
            embeddingNodeIds: new Set(rows.map((row) => row.nodeId)),
          };
        }
        if (cacheRowCount(cachedSnapshot) > 0) {
          log(
            `Preserving ${cacheRowCount(cachedSnapshot)} embedding row(s) omitted from index metadata.`,
          );
        }
      }
    } catch (error) {
      discardCachedEmbeddingSpill();
      throw error;
    } finally {
      await closeLbug();
    }
  }

  // A staged failure leaves the published graph and its metadata intact. Only
  // platforms using the in-place full-write fallback need a dirty marker.
  if (existingMeta && !useAtomicSwap) {
    const now = Date.now();
    await saveGraphDirtyState({
      ...existingMeta,
      incrementalInProgress: {
        startedAt: now,
        updatedAt: now,
        phase: 'full-rebuild',
        toWriteCount: 0,
        ...storedRebuildReasons(),
      },
    });
  }
  await closeLbug();
  if (buildPath === lbugPath) liveIndexMutationStarted = true;
  try {
    await wipeLbugDbFiles(buildPath);
  } catch (error) {
    discardCachedEmbeddingSpill();
    if (liveIndexMutationStarted) recordLiveIndexMutationRisk(error);
    throw error;
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

  // The checkpoint counters are process-global (`analyze --watch` reruns analyze in
  // one process), so a failure report counts only this run's from here (#3530).
  const checkpointsAtRunStart = readCheckpointActivity();
  // The platform policy chooses a fresh staging file or an in-place rebuild.
  try {
    await initAnalysisLbug(buildPath);
  } catch (error) {
    // Opening a truncated staging copy or an oversized index fails with the same
    // classified messages a write does, so it carries the same diagnosis (#3530).
    // No checkpoint driver has started yet, so nothing can touch the files mid-stat.
    const stagedBuild = buildPath !== lbugPath;
    const failureMessage = describeThrown(error);
    const diagnosis = await diagnoseClassifiedFailure(
      failureMessage,
      stagedBuildModeOf(stagedBuild),
      { liveIndex: lbugPath, ...(stagedBuild ? { stagingCopy: buildPath } : {}) },
      checkpointsAtRunStart,
    );
    discardCachedEmbeddingSpill();
    const failure = attachFailureDiagnosis(error, failureMessage, diagnosis, log);
    if (liveIndexMutationStarted) recordLiveIndexMutationRisk(failure);
    throw failure;
  }

  // Manual WAL checkpoint driver (#1741): periodically drain the WAL
  // from JS so the un-retriable native auto-checkpoint almost never
  // has work left to do. Failures of the manual CHECKPOINT are absorbed
  // by the driver's bounded retry; the final un-recoverable error still
  // surfaces via the surrounding write that follows the failed flush.
  // Opt-out via `GITNEXUS_WAL_MANUAL_CHECKPOINT=0` (the driver itself
  // returns a no-op handle when disabled). Analyze-only: MCP and serve
  // paths continue to rely on the close-time CHECKPOINT in `safeClose`.
  const walCheckpointDriver: WalCheckpointDriver = startWalCheckpointDriver();
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
    const markIncrementalGraphVerification = async (): Promise<void> => {
      if (buildPath !== lbugPath) return;
      const latest = await loadMeta(metaDir);
      if (!latest?.incrementalInProgress) {
        throw new Error('Cannot certify incremental graph without its dirty metadata marker.');
      }
      // A failed or aborted identity scan is a graph failure. FTS-only repair
      // and FTS crash recovery must not clear it while retaining these rows.
      await saveMeta(metaDir, {
        ...latest,
        incrementalInProgress: {
          ...latest.incrementalInProgress,
          phase: 'graph-reconciliation',
          updatedAt: Date.now(),
          checkpointSucceeded: false,
        },
      });
    };
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
      contentRetention,
    );

    // Drain the fresh graph before building search indexes, and record the
    // checkpoint outcome for the in-place recovery marker.
    const ftsWritePlan = resolveFtsWritePlan(buildPath, lbugPath);
    let boundaryCheckpointSucceeded = false;
    try {
      boundaryCheckpointSucceeded = await checkpointOnce();
    } catch (error) {
      if (isBoundaryCheckpointFatal(ftsWritePlan)) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      log(
        `Boundary WAL checkpoint failed on the in-place FTS path (best-effort): ${detail}. ` +
          'Continuing; recovery will treat the graph-boundary checkpoint as unsuccessful.',
      );
    }
    if (isIncremental) {
      await markIncrementalGraphVerification();
      await reconcileGraphNodeIdentities(
        pipelineResult.graph,
        forEachQueryRow,
        'post-COPY/checkpoint',
      );
    }
    if (shouldStampFtsDirtyPhase(ftsWritePlan)) {
      // Lift the prior-meta precondition: a first-ever in-place run (Windows
      // full rebuild, or any in-place incremental) must stamp too. Staging
      // never stamps — an abort there abandons the unpublished file.
      const latestMeta = (await loadMeta(metaDir)) ?? existingMeta;
      const base: RepoMeta = latestMeta ?? {
        repoPath,
        lastCommit: '',
        indexedAt: new Date().toISOString(),
      };
      // #3322: persist uncertified *before* CREATE_FTS_INDEX. Park keeps this
      // stamp; it must not invent one on every FTS-only crash. Missing stamp +
      // shipped defaults is a match, so a budget-mismatch derived rewrite that
      // dies in FTS would otherwise recertify the rewritten Community/Process
      // rows on a flagless retry.
      await saveGraphDirtyState({
        ...base,
        incrementalInProgress: buildFtsDirtyStamp({
          prior: base.incrementalInProgress,
          writePlan: 'in-place',
          checkpointSucceeded: boundaryCheckpointSucceeded,
        }),
        ...(processDetectionMismatch
          ? {
              processDetection: uncertifyProcessDetectionStamp(base.processDetection),
            }
          : {}),
      });
    }

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    callbacks.signal?.throwIfAborted();
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
    progress(
      'fts',
      85,
      ftsDisabledReason ? 'Skipping search indexes...' : 'Creating search indexes...',
    );
    const ftsAvailable =
      !ftsDisabledReason &&
      (await loadFTSExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      }));
    // Tracks whether search indexes actually ended up usable this run — starts
    // as ftsAvailable (extension loaded) but flips to false below when the
    // build/verify step itself fails, so capabilities.fts.status / ftsSkipped
    // stay honest even though that failure no longer aborts the whole analyze.
    let ftsReady = ftsAvailable;
    // Why FTS ended up skipped (#2658 review L2): an explicit opt-out
    // (`disabled-by-flag` / `disabled-by-env`, #3091) when one was recorded,
    // else tuple-missing when the loader reported no packaged artifact,
    // else extension-unavailable up front, or build-failed in the degrade
    // branch below.
    const tupleMissing =
      !ftsAvailable &&
      !ftsDisabledReason &&
      /no packaged FTS artifact/i.test(getFtsCapability()?.reason ?? '');
    let ftsSkipReason: FtsSkipReason | undefined = ftsAvailable
      ? undefined
      : (ftsDisabledReason ?? (tupleMissing ? 'tuple-missing' : 'extension-unavailable'));
    if (ftsAvailable && priorFtsNativeAbort && !requestedRepairFts) {
      // KTD6 / R11: do not retry CREATE_FTS_INDEX after a native abort —
      // the same content can kill the process again. `--repair-fts` is the
      // explicit retry: its early-return path never reaches this branch,
      // and a retention-mismatch rewrite that started as `--repair-fts`
      // still creates indexes.
      ftsReady = false;
      ftsSkipReason = 'native-abort';
      log(
        'FTS index build skipped — a previous analyze aborted while building search indexes. ' +
          'Graph analysis completed. Run `gitnexus analyze --repair-fts` to retry.',
      );
      progress('fts', 90, 'Search indexes skipped (previous native abort)');
    } else if (ftsAvailable) {
      // Degrade rather than throw: createSearchFTSIndexes re-tokenizes every
      // stored row on every run, so a native tokenizer error on a single
      // pre-existing row (#2544/#2546) must not discard this run's otherwise-
      // successful graph/embeddings work — only keyword search degrades.
      const ftsResult = await buildSearchIndexesOrDegrade(executeQuery, {
        indexes: ftsIndexes,
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      if (isIncremental) await markIncrementalGraphVerification();
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
    } else if (ftsDisabledReason) {
      log(FTS_DISABLED_MESSAGE);
      progress('fts', 90, 'Search indexes skipped (explicitly disabled)');
    } else {
      // For a missing runtime dependency (#2374) the file is present, so the
      // generic "install it with network access" tail in FTS_UNAVAILABLE_MESSAGE
      // contradicts the remedy's own "reinstalling will NOT help" (#2383 F2). Lead
      // with the class-neutral sentence and append only the classified remedy.
      // Same #2383 mock seam as the repair path above — keep the exported
      // `getExtensionCapabilities()` lookup here.
      const ftsReason = getExtensionCapabilities().find((c) => c.name === 'fts')?.reason;
      const inspectPath = extractExtensionPath(ftsReason);
      const { kind, remedy } = diagnoseExtensionLoad(
        ftsReason,
        'FTS',
        inspectPath,
        resolveFtsVersionPair(inspectPath),
      );
      log(
        usesClassifiedLoadRemedy(kind)
          ? `${FTS_UNAVAILABLE_LEAD} ${remedy}`
          : FTS_UNAVAILABLE_MESSAGE,
      );
      progress('fts', 90, 'Search indexes skipped (FTS unavailable)');
    }

    if (isIncremental) {
      // FTS has returned. Later embedding/finalization failures must require
      // graph recovery, since post-FTS node identities are not yet certified.
      await markIncrementalGraphVerification();
    }

    // The graph database is fresh. Restore every compatible cached vector
    // whose owning node still exists; omitted rows cannot leave legacy orphans.
    let restoredEmbeddingCount = 0;
    const restoreFailedNodeIds = new Set<string>();
    if (cacheRowCount(cachedSnapshot) > 0) {
      const cachedDims = snapshotEmbeddingDims(cachedSnapshot);
      const { EMBEDDING_DIMS } = await import('./lbug/schema.js');
      if (cachedDims !== undefined && cachedDims !== EMBEDDING_DIMS) {
        // Dimensions changed (e.g. switched embedding model) — discard cache and re-embed all
        log(
          `Embedding dimensions changed (${cachedDims}d -> ${EMBEDDING_DIMS}d), discarding cache`,
        );
        discardCachedEmbeddings();
      } else {
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        // (1) Live-graph filter — the FULL pipeline graph (always produced),
        // NOT the incremental subgraph, or unchanged files' rows would be
        // dropped from the restore set.
        const liveEmbeddings = cachedSnapshot.rows.filter(
          (e) => pipelineResult.graph.getNode(e.nodeId) !== undefined,
        );
        const rowsToRestore = liveEmbeddings;
        progress('embeddings', 88, `Restoring ${rowsToRestore.length} cached embeddings...`);
        const EMBED_BATCH = 200;
        let spillReader: EmbeddingSpillReader | undefined;
        try {
          for (const batch of chunk(rowsToRestore, EMBED_BATCH)) {
            let materialized;
            try {
              if (!spillReader && cachedSnapshot.spill && cachedSnapshot.embeddings.length === 0) {
                spillReader = new EmbeddingSpillReader(cachedSnapshot.spill);
              }
              materialized = materializeCachedEmbeddings(cachedSnapshot, batch, spillReader);
            } catch (err) {
              if (!shouldGenerateEmbeddings) throw err;
              for (const row of batch) restoreFailedNodeIds.add(row.nodeId);
              log(
                `Warning: could not materialize ${batch.length} cached embedding(s) for restore ` +
                  `(${(err as Error).message}); those nodes will be re-embedded if this run generates embeddings.`,
              );
              continue;
            }
            try {
              await batchInsert(executeWithReusedStatement, materialized);
              restoredEmbeddingCount += batch.length;
            } catch (err) {
              if (err instanceof EmbeddingIntegrityError || !shouldGenerateEmbeddings) throw err;
              for (const row of batch) restoreFailedNodeIds.add(row.nodeId);
              log(
                `Warning: could not restore ${batch.length} cached embedding(s) ` +
                  `(${(err as Error).message}); those nodes will be re-embedded if this run generates embeddings.`,
              );
            }
          }
        } finally {
          spillReader?.close();
        }
      }
    }
    // Vectors are on disk only to survive the wipe/delete. After restore,
    // drop the spill so Phase 4 does not keep a multi-GB temp file open.
    discardCachedEmbeddingSpill();

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
    const collapseVerdict: GraphWriteCollapseVerdict = detectGraphWriteCollapse(
      expectedRelationships,
      persistedRelationships,
    );
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
      if (useAtomicSwap) {
        // A collapsed staging DB can be discarded before it replaces the live
        // index. In-place writes below still need their incomplete stamp.
        throw new Error(
          `Graph write incomplete — the pipeline produced ${expectedRelationships} ` +
            `relationships but only ${persistedRelationships} are readable from the staged index. ` +
            `Analysis aborted before publication; the previous index, if any, is left intact. ` +
            `Review COPY warnings and available memory and disk space. If the native buffer pool ` +
            `was exhausted, set GITNEXUS_LBUG_BUFFER_POOL_SIZE to a larger byte value that fits ` +
            `available memory, then re-run \`gitnexus analyze --force\`.`,
        );
      }
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

    // A fresh graph has no legacy HNSW index. Rebuild it after all restored
    // rows exist when embedding generation did not run (including node-cap
    // skips). Otherwise the embedding pipeline builds it after its inserts.
    // The result records actual availability; an unavailable extension leaves
    // compatible vectors available to the bounded exact-scan fallback.
    if (restoredEmbeddingCount > 0 && embeddingSkipped) {
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

    let stagedCheckpointEmbeddingCount: number | undefined;
    if (!embeddingSkipped && !options.graphPublication) {
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
      const stagedRecoveryEnabled = useAtomicSwap && isManualCheckpointEnabled();
      if (useAtomicSwap && !stagedRecoveryEnabled) {
        log(
          'Manual WAL checkpoints are disabled; new staged work cannot be recovered after interruption. ' +
            'Any previous durable recovery source is retained until publication.',
        );
      }
      const unsafeRecoveryNodeIds = new Set([...inheritedUnsafeNodeIds, ...restoreFailedNodeIds]);
      let activeWindowNodeIds: string[] = [];
      let recoveryGenerationDurable = false;
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedSnapshot.embeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedSnapshot.rows) {
          if (restoreFailedNodeIds.has(e.nodeId)) {
            // Any failed batch for this node: mark stale so Phase 4 DELETEs
            // leftover chunks and re-embeds. Omitting the id would treat the
            // node as new and PK-conflict on rows that already restored.
            existingEmbeddings.set(e.nodeId, STALE_HASH_SENTINEL);
            continue;
          }
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
      // `stats.embeddings` when the caller actually MEASURED the published
      // index (the post-window `onCheckpoint` on an in-place build). A staging
      // build's count is not published until the atomic swap succeeds. The
      // window-start callback passes nothing, preserving the latest count.
      const saveEmbeddingCheckpoint = async (
        checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        },
        pendingNodeIds: string[],
        embeddings?: number,
      ): Promise<void> => {
        if (embeddings !== undefined && buildPath !== lbugPath) {
          stagedCheckpointEmbeddingCount = embeddings;
        }
        const latestMeta = (await loadMeta(metaDir)) ?? existingMeta;
        // An in-place write or manual-checkpoint opt-out cannot create a new
        // recoverable staged generation. Keep the complete previous receipt:
        // updated progress or unsafe nodes would describe different source bytes.
        const preservedRecoveryCheckpoint =
          !stagedRecoveryEnabled &&
          resolveEmbeddingRecovery(metaDir, latestMeta?.embeddingCheckpoint)
            ? latestMeta?.embeddingCheckpoint
            : undefined;
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
        const interrupted = mintInterruptedCheckpoint(
          embeddingIdentity,
          checkpoint,
          pendingNodeIds,
        );
        await saveMeta(metaDir, {
          ...base,
          ...(embeddings === undefined || buildPath !== lbugPath
            ? {}
            : { stats: { ...base.stats, embeddings } }),
          // Written by a run that is still IN FLIGHT — see the `kind` doc in
          // repo-manager.ts.
          embeddingCheckpoint: preservedRecoveryCheckpoint ?? {
            ...interrupted,
            ...(stagedRecoveryEnabled
              ? {
                  recovery: {
                    stagingFile: path.basename(buildPath),
                    schemaFingerprint: SCHEMA_FINGERPRINT,
                    unsafeNodeIds: [...unsafeRecoveryNodeIds],
                  },
                }
              : {}),
          },
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
        cachedSnapshot.embeddingNodeIds.size > 0 ? cachedSnapshot.embeddingNodeIds : undefined,
        existingEmbeddings,
        {
          source: { repoPath, fileHashes: newFileHashes, contentRetention },
          forceReembedNodeIds: pendingEmbeddingNodeIds,
          onCheckpointWindowStart: async ({ nodeIds, ...checkpoint }) => {
            const handoff = stagedRecoveryEnabled && !recoveryGenerationDurable;
            if (handoff) {
              if (!(await checkpointOnce())) {
                throw new Error(
                  'Could not checkpoint restored embeddings before recovery handoff.',
                );
              }
              recoveryGenerationDurable = true;
            }
            activeWindowNodeIds = nodeIds;
            for (const id of nodeIds) unsafeRecoveryNodeIds.add(id);
            await saveEmbeddingCheckpoint(checkpoint, nodeIds);
            // Reclaim the old source only after the new durable generation's
            // reference is saved. Later windows retain this same generation.
            if (handoff) sweepStagingArtifacts(metaDir, log);
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
            const durable = await checkpointOnce();
            if (stagedRecoveryEnabled && !durable) {
              throw new Error('Could not checkpoint the completed embedding window for recovery.');
            }
            for (const id of activeWindowNodeIds) unsafeRecoveryNodeIds.delete(id);
            activeWindowNodeIds = [];
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
    callbacks.signal?.throwIfAborted();
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
    // success. For a staged build, use its last measured count only in the
    // final meta, written after the swap; never publish it at a checkpoint.
    const latestMetaForCount =
      embeddingCount === undefined ? ((await loadMeta(metaDir)) ?? existingMeta) : undefined;
    const persistedEmbeddingCount =
      options.graphPublication && existingMeta?.vectorGeneration && !options.dropEmbeddings
        ? existingMeta.vectorGeneration.chunks
        : resolvePersistedEmbeddingCount(
            measuredEmbeddingCount,
            stagedCheckpointEmbeddingCount ?? latestMetaForCount?.stats?.embeddings,
          );

    const { getRuntimeCapabilities } = await import('./platform/capabilities.js');
    const runtimeCapabilities = getRuntimeCapabilities();
    // Generation/restoration reports the newly built legacy index's mode.
    // With independent vector artifacts, carry their prior observed mode when
    // no legacy index was built in this graph. A zero embedding count below
    // still stamps semantic search unavailable.
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
    // Census of guessed call sites (before edge coalescing), refused candidates
    // and ambiguous `export *` names. The legacy `nameFallbackEdges` metadata
    // key stores site counts, not the final population of heuristic edges.
    const nameFallbackSummary = summarizeNameFallback(
      resolutionOutcomes,
      countCallsByLanguage(pipelineResult.resolvedCalleeNamesByCaller, pipelineResult.graph),
    );
    logNameFallbackSummary(nameFallbackSummary);

    // Annotated so the capabilities stamp below is compile-checked against
    // RepoMeta's status unions (tri-review 4669518496 P1/U3) — an unannotated
    // literal widens the vectorSearch.status ternary to `string` and the
    // honesty contract silently decays to "whatever interpolates".
    let meta: RepoMeta = {
      repoPath,
      storagePath,
      ...(options.graphPublication && !options.dropEmbeddings
        ? {
            graphGeneration: existingMeta?.graphGeneration,
            vectorGeneration: existingMeta?.vectorGeneration,
            embeddingJob: existingMeta?.embeddingJob,
            legacyVectorSource: existingMeta?.legacyVectorSource,
          }
        : {}),
      ...(path.basename(lbugPath) !== LBUG_DIRECTORY ? { graphPath: path.basename(lbugPath) } : {}),
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
      contentRetention,
      contentRetentionSchemaVersion: CONTENT_RETENTION_SCHEMA_VERSION,
      ftsProfile,
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
          // Keep the abort write plan after persist cleared the dirty flag
          // so a leftover live WAL is still refuse-able. Successful FTS
          // drops it with skipReason.
          ...(!ftsReady &&
          ftsSkipReason === 'native-abort' &&
          existingMeta?.capabilities?.fts?.writePlan
            ? { writePlan: existingMeta.capabilities.fts.writePlan }
            : {}),
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
      schemaFingerprint:
        options.graphPublication || hasGitDir(repoPath) ? SCHEMA_FINGERPRINT : undefined,
      unresolvedReceiverMembers: summarizeUnresolvedReceivers(resolutionOutcomes),
      // Resolution runs again on warm parse-cache hits. Replace the receipt,
      // including complete-empty, so corrected/deleted source clears old gaps.
      unresolvedOverloads: summarizeUnresolvedOverloads(
        resolutionOutcomes,
        pipelineResult.resolutionOutcomes !== undefined,
      ),
      nameFallbackEdges: nameFallbackSummary,
      relationshipIntegrity: pipelineResult.relationshipIntegrity,
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
      springVendorPrefixes: currentSpringVendorPrefixes,
      routeHookConfig: currentRouteHookConfig,
      // Always stamped with the live resolved mode (#2331/#2339) — unlike
      // `pdg` below, 'none' is a meaningful value to compare, not an
      // absence, so this is never conditionally omitted.
      cjkSegmentation: getSearchFTSCjkSegmentation(),
      // The FLOAT[N] width this run created the vector column at (#2798).
      // Always stamped, like `cjkSegmentation` and unlike `schemaFingerprint`:
      // the CodeEmbedding table is created for every index, git or not, so
      // absence has exactly one meaning — an index older than the field.
      embeddingDims: EMBEDDING_DIMS,
      // Embedding sync also needs snapshot identity for non-git checkouts.
      // Incremental DB eligibility still independently requires repoHasGit.
      fileHashes: newFileHashesRecord,
      indexCoverage: hasGitDir(repoPath)
        ? {
            maxFileSizeBytes: getMaxFileSizeBytes(),
            // Stamped only when set, so indexes built without the option keep
            // their existing metadata shape.
            ...includeDotDirsCoverage(),
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
      cacheKeys: parseCache ? [...parseCache.usedKeys] : [],
      incrementalInProgress: undefined as RepoMeta['incrementalInProgress'],
      // Cleared on a clean run; otherwise the marker Phase 4/5 minted above
      // (see the `kind` doc in repo-manager.ts).
      embeddingCheckpoint:
        options.graphPublication && !options.dropEmbeddings
          ? resumeEmbeddingCheckpoint
            ? existingMeta?.embeddingCheckpoint
            : undefined
          : pendingEmbeddingCheckpoint,
      // The effective pdg config this run's DB rows were built under
      // (#2099 F1). `undefined` on pdg-off runs — this meta is a fresh
      // literal (no spread of existingMeta), so omission is what CLEARS the
      // stamp after an on→off flip; the next pdgModeMismatch then compares
      // off==off and incremental eligibility is restored.
      pdg: resolvePdgConfig(options),
      processDetection: toProcessDetectionStamp(processDetectionBudget),
    };
    // Re-resolve at the commit boundary. Long analyses can overlap an npm
    // upgrade, rebuilt dist tree, or native dependency replacement; stamping
    // the start-of-run receipt after such a mutation would falsely certify a
    // graph produced by two analyzer identities. Stable-read validation lives
    // inside the resolver, and a mismatch leaves the dirty flag intact so the
    // next run takes the established full-recovery path.
    if (parseIdentityResolution.ok) {
      finalizeParseCacheIdentity(import.meta.url, parseIdentityResolution.identity);
      meta.parseCacheIdentity = effectiveParseIdentity;
    }
    meta.runnerIdentity = finalizeAnalyzerRunnerIdentity(import.meta.url, runnerIdentity);
    // #2614 F1: the freshness stamp (saveMeta) is written AFTER the atomic swap
    // below — never here — so a concurrent MCP reader can't observe
    // meta.indexedAt = T_new while lbugPath still resolves to the pre-swap
    // inode (which latched the reader on the stale index permanently). The meta
    // object is fully computed at this point; only its write is deferred.
    // Parse-cache publish waits until after that swap + saveMeta so a failed
    // registerRepo / close / swap cannot replace live shards (#3153).

    if (isIncremental) {
      // Registry freshness must not advance either. Include FTS, embedding
      // restoration and the final WAL drain in the certified boundary.
      await markIncrementalGraphVerification();
      await walCheckpointDriver.stop();
      if (!(await checkpointOnce())) {
        throw new Error(
          'Graph identity reconciliation failed: final checkpoint could not be verified; run `gitnexus analyze --force`.',
        );
      }
      await reconcileGraphNodeIdentities(
        pipelineResult.graph,
        forEachQueryRow,
        'pre-publish/checkpoint',
      );
    }
    // Keep generated .gitnexus contents ignored without editing the user's root .gitignore.
    await ensureGitNexusIgnored(repoPath, storagePath);

    // ── Close LadybugDB ──────────────────────────────────────────────
    // Stop the manual checkpoint driver before closeLbug so its
    // in-flight CHECKPOINT cannot race the `safeClose` CHECKPOINT.
    await walCheckpointDriver.stop();
    if (
      (useAtomicSwap || options.graphPublication) &&
      !isIncremental &&
      !(await runCheckpointWithRetry()).flushed
    ) {
      // Publication requires durability even when periodic/manual checkpoints
      // are disabled. A best-effort close cannot certify the staged file.
      throw new Error('Cannot publish staged index: final checkpoint could not be verified.');
    }
    let preparedGraph: PreparedAnalysisHandoff | undefined;
    if (options.graphPublication) {
      if (!meta.parseCacheIdentity)
        throw new Error('Graph publication requires verified parser provenance');
      if (!existingMeta?.graphGeneration && !options.dropEmbeddings && !meta.legacyVectorSource) {
        const { exportLegacyVectors } = await import('./lbug/legacy-vector-export.js');
        const historical = existingMeta?.embeddingCheckpoint;
        meta.legacyVectorSource = await exportLegacyVectors({
          metadataDirectory: metaDir,
          query: executeQuery,
          provenance: {
            schemaFingerprint: existingMeta?.schemaFingerprint ?? SCHEMA_FINGERPRINT,
            ...(historical
              ? {
                  recordedIdentity: {
                    provider: historical.provider,
                    model: historical.model,
                    dimensions: historical.dimensions,
                  },
                }
              : {}),
          },
          excluded: new Set([
            ...pendingEmbeddingNodeIds,
            ...inheritedUnsafeNodeIds,
            ...restoreFailedNodeIds,
          ]),
          bufferPoolBytes: options.resources!.embedding.vectorPoolBytes,
          threads: options.resources!.embedding.nativeThreads,
        });
      }
      if (meta.embeddingCheckpoint?.recovery) {
        // The complete staged groups now live in the independent legacy source.
        // Publish the remaining retry decision without the retired staging
        // pointer; the embedding continuation consumes the durable source.
        meta.embeddingCheckpoint = { ...meta.embeddingCheckpoint };
        delete meta.embeddingCheckpoint.recovery;
      }
      const content = createHash('sha256');
      for (const entry of [...newFileHashes].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        content.update(JSON.stringify(entry)).update('\0');
      const receipt = await prepareAnalysisPublication(
        metaDir,
        buildPath,
        meta,
        content.digest('hex'),
        useAtomicSwap
          ? { waitForProcessExit: options.graphPublication === 'after-exit' }
          : {
              mode: 'in-place',
              attemptId: inPlaceAttempt!,
              waitForProcessExit: options.graphPublication === 'after-exit',
            },
      );
      if (parseCache) {
        try {
          await stageAnalysisParseCache(metaDir, receipt.id, parseCache);
        } catch (error) {
          log(`Warning: could not stage parser cache (${(error as Error).message}); continuing.`);
        }
      }
      if (options.graphPublication === 'after-exit') {
        preparedGraph = {
          version: 1,
          publicationId: receipt.id,
          repoPath,
          storagePath,
          metadataDirectory: metaDir,
          repoName: await preparedAnalysisName(repoPath, options),
          commit: currentCommit,
        };
      }
    }
    // CLI callers (about to process.exit) skip the native close to dodge a
    // LadybugDB destructor double-free after --pdg writes — closeLbugBeforeExit
    // CHECKPOINTs for durability then leaves the handles for process exit to
    // reclaim (#2264). Long-lived callers close for real.
    //
    // On Windows a swap must release the build handle before the rename (a
    // same-process open file can't be renamed), so it forces a real close —
    // safe because windowsSwapOk excludes --pdg (the #2264 case). POSIX renames
    // an open file, so it keeps the skip-native-close there.
    const forceRealCloseForSwap =
      useAtomicSwap && process.platform === 'win32' && !options.graphPublication;
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
    if (!options.graphPublication && useAtomicSwap && builtDbExists) {
      await assertLbugPublicationReady(buildPath);
      const releaseInitLock = await acquireInitLock(lbugPath);
      try {
        await assertLbugPublicationReady(lbugPath);
        await retryRename(buildPath, lbugPath);
        liveIndexMutationStarted = true;
      } finally {
        await releaseInitLock();
      }
    }

    // #2614 F1: stamp the freshness metadata now that the index is published.
    // When meta.indexedAt becomes visible, lbugPath already resolves to the new
    // inode, so a reader reiniting on the stamp opens the fresh graph rather
    // than latching on the old one. Leaving the dirty flag set across the swap
    // is a crash-safety improvement: a failed swap leaves the previous index
    // live and the next run recovers via the full-rebuild path.
    if (options.graphPublication === 'inline') {
      const { verifyPublishedAnalysisGraph } = await import('./analysis-graph-verification.js');
      const published = await publishPreparedAnalysis(metaDir, {
        saveMetadata: (metadata) => saveMeta(metaDir, metadata),
        verify: (file, metadata) =>
          verifyPublishedAnalysisGraph(file, metadata, {
            bufferPoolBytes: options.resources!.parse.graphPoolBytes,
            threads: options.resources!.parse.nativeThreads,
          }),
      });
      if (!published) throw new Error('Prepared graph disappeared before publication');
      meta = published;
    } else if (!preparedGraph) {
      await saveMeta(metaDir, meta);
    }
    if (!preparedGraph) sweepStagingArtifacts(metaDir, log);

    // Registry freshness is published only after the graph and its metadata.
    // A failed close, swap, or metadata save must leave the previous registry
    // receipt intact, just as it leaves the cache unpublished.
    // Forward the --name alias and the registry-collision bypass bit.
    // `allowDuplicateName` is its own concern — independent from the
    // pipeline `force` above. The CLI maps it from
    // `--allow-duplicate-name` only; `--force` and `--skills` both
    // trigger pipeline re-run but never bypass the registry guard.
    // The returned name is the one actually written to the registry
    // (after applying the precedence chain in registerRepo) — reuse it
    // so AGENTS.md / skill files reference the same name MCP clients
    // will look up (#979).
    const projectName =
      preparedGraph?.repoName ??
      (await registerRepo(repoPath, meta, {
        name: options.registryName,
        onRename: (previousName, nextName) =>
          log(`Registry name changed: "${previousName}" -> "${nextName}".`),
        allowDuplicateName: options.allowDuplicateName,
        // Non-primary branch runs upsert into the entry's branches[]; the
        // primary/flat run (placement.branch === undefined) refreshes the
        // top-level fields (#2106).
        branch: placement.branch,
        storagePath,
      }));

    // ── #2354: the flat workspace slot has adopted this run's branch ──────
    // Drop a now-shadowed `branches/<slug>/` sub-index for the same label
    // (unreachable once the flat slot serves it) and align the registry's
    // top-level branch label. Best-effort (#2364 review F5): the index is
    // complete and registered, and a failure
    // here leaves only a stale registry label / undeleted shadowed dir —
    // never wrong routing, because the flat meta this run already stamped is
    // what applyBranchScope trusts. Retried by the next content-changing run
    // (same-commit fast-path runs skip it: their guard compares the
    // already-stamped meta label).
    if (!preparedGraph && !placement.branch && branchLabel) {
      try {
        await adoptFlatBranchLabel(repoPath, branchLabel, storagePath);
      } catch (e) {
        log(
          `Warning: could not sync the workspace branch label (${(e as Error).message}); continuing.`,
        );
      }
    }

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

    // Persist the incremental parse cache only after a successful graph
    // publish (#3153). try/catch so a cache-write failure never breaks an
    // otherwise successful indexing run. Prune stale chunk-hash entries first
    // so the cache file size stays bounded across runs (chunks whose
    // composition no longer matches anything in the current scan are dead
    // weight; the parse phase populates `usedKeys` as it processes chunks).
    try {
      if (parseCache && !preparedGraph) {
        await publishAnalysisParseCache(parseCache, {
          storagePath,
          metadataDirectory: metaDir,
          cacheRoot,
          publishedGeneration: meta.graphGeneration?.id,
          sharedStore: writeTarget.sharedStore,
          collectBranchKeys: collectBranchCacheKeys,
          log,
        });
      }
    } catch (e) {
      log(`Warning: could not save parse cache (${(e as Error).message}); continuing.`);
    }

    if (preparedGraph)
      progress('graph-prepared', 98, 'Graph checkpointed; awaiting process release');
    else if (options.graphPublication)
      callbacks.onProgress('graph-ready', 98, 'Graph published', { graphPhase: 'ready' });
    else progress('done', 100, 'Done');

    if (!preparedGraph) await removeColdParseRebuildDir(coldParseRebuildDir, true);

    return {
      repoName: projectName,
      repoPath,
      storagePath,
      stats: meta.stats,
      rebuildReasons: collector.keys(),
      pipelineResult,
      ...(preparedGraph ? { preparedGraph } : {}),
      ...(graphWriteCollapsed ? { graphWriteCollapsed } : {}),
      ftsSkipped: !ftsReady,
      ftsSkipReason: ftsReady ? undefined : ftsSkipReason,
      isPrimaryBranch: !placement.branch,
      incrementalStats,
    };
  } catch (err) {
    const stagedBuild = useAtomicSwap && buildPath !== lbugPath;
    const failureMessage = describeThrown(err);
    // Ensure LadybugDB is closed even on error. Stop the driver first so its retry
    // loop cannot extend an already-failing analyze. `stop()` clears the tick timer
    // before its first `await`, so starting it here keeps any new checkpoint from
    // touching the staging files while the evidence below is measured; a checkpoint
    // already in flight is recorded in that evidence's snapshot (#3530).
    const driverStopped = walCheckpointDriver.stop();
    // Before the database closes — see diagnoseClassifiedFailure.
    const diagnosis = await diagnoseClassifiedFailure(
      failureMessage,
      stagedBuildModeOf(stagedBuild),
      { liveIndex: lbugPath, ...(stagedBuild ? { stagingCopy: buildPath } : {}) },
      checkpointsAtRunStart,
    );
    try {
      await driverStopped;
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
    const retainPrepared = options.graphPublication && (await retainsPreparedGraph(metaDir));
    if (stagedBuild && !retainPrepared) {
      try {
        const recovery = resolveEmbeddingRecovery(
          metaDir,
          (await loadMeta(metaDir))?.embeddingCheckpoint,
        );
        // Both paths belong to this locked slot. The validated generation
        // basename identifies the same file even through a directory alias.
        if (recovery?.stagingFile !== path.basename(buildPath)) await wipeLbugDbFiles(buildPath);
      } catch {
        /* swallow — orphan reclamation must never mask the real failure */
      }
    }
    if (!retainPrepared) await removeColdParseRebuildDir(coldParseRebuildDir, true);
    discardCachedEmbeddingSpill();
    // What the caller sees: `err` itself (identity and prototype preserved, callers
    // tell IndexLockTimeoutError and other domain failures apart with `instanceof`),
    // or a wrapper when `err` is not an Error.
    const failure = attachFailureDiagnosis(err, failureMessage, diagnosis, log);
    if (liveIndexMutationStarted) recordLiveIndexMutationRisk(failure);
    throw failure;
  }
}
