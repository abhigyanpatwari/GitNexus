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

import path from 'path';
import fs from 'fs/promises';
import { execFileSync } from 'child_process';
import { runPipelineFromRepo } from './ingestion/pipeline.js';
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
  deleteAllCommunitiesAndProcesses,
  deleteAllInterprocTaintPaths,
  deleteAllCallSummaries,
  deleteAllInjects,
  queryImportersBatch,
  loadFTSExtension,
  wipeLbugDbFiles,
  LbugWipeError,
  DELETE_FILES_CHUNK_SIZE,
} from './lbug/lbug-adapter.js';
import { escapeCypherString } from './lbug/cypher-escape.js';
import {
  createSearchFTSIndexes,
  initialiseSearchFTSStemmer,
  verifySearchFTSIndexes,
} from './search/fts-indexes.js';
import {
  cjkSegmentationModeMismatch,
  getSearchFTSCjkSegmentation,
  initialiseSearchFTSCjkSegmentation,
} from './search/cjk-segmentation.js';
import { getExtensionCapabilities, resolveAnalyzeInstallPolicy } from './lbug/extension-loader.js';
import { diagnoseExtensionLoad } from './lbug/extension-load-error.js';
import {
  startWalCheckpointDriver,
  checkpointOnce,
  type WalCheckpointDriver,
} from './lbug/wal-checkpoint-driver.js';
import { quarantineSidecarsForDirtyRecovery } from './lbug/sidecar-recovery.js';
import type { EmbeddingIdentity } from './embeddings/embedding-identity.js';
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
  INCREMENTAL_SCHEMA_VERSION,
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
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import { shouldEscalateIncrementalWrite } from './incremental/escalation-gate.js';
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
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
import { sanitizeDetectedBranch } from '../cli/analyze-config.js';
import { EMBEDDING_TABLE_NAME } from './lbug/schema.js';
import { STALE_HASH_SENTINEL } from './lbug/schema.js';

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
   * The caller will `process.exit()` immediately after this analyze returns (the
   * CLI `analyze` command). When set, the finalize/error close CHECKPOINTs for
   * durability but skips the native `conn.close()`/`db.close()`, which can
   * double-free in LadybugDB's `ClientContext` destructor after large `--pdg`
   * writes (gdb-confirmed) — aborting the process AFTER a fully-written index.
   * Process exit reclaims the handles. Long-lived callers (MCP server, tests)
   * leave this unset so they get a real close. See `closeLbug`. */
  skipNativeCloseOnExit?: boolean;
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
  ftsSkipped?: boolean;
  /**
   * True when the index this run produced/validated is the flat workspace
   * slot (#2106 R2, inverted by #2354 to follow the checked-out branch).
   * `false` for a pinned `--branch` sub-index. Lets the CLI skip repo-root
   * AGENTS.md/CLAUDE.md refreshes (e.g. the base_ref fast-path) for a pinned
   * branch analyze, mirroring the in-pipeline `if (!placement.branch)` gate.
   * (The historical "primary" name is kept — it is public API surface.)
   */
  isPrimaryBranch?: boolean;
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
  // the diagnostic per-language refinement in the impact CONSUMER (see
  // pdg-impact.ts assemblePdgImpactResult), not in this version discriminator.
  for (const key of new Set([...Object.keys(reqRecord), ...Object.keys(recRecord)])) {
    if (reqRecord[key] !== recRecord[key]) return true;
  }
  return false;
};

export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  // Resolve + validate operator-provided FTS config once, before the expensive
  // parse/load phases. A typo fails here in ms; createSearchFTSIndexes reuses
  // the cached value via getSearchFTSStemmer.
  initialiseSearchFTSStemmer();
  initialiseSearchFTSCjkSegmentation();

  // Scope the degraded-parse log throttle to this run. On a reused process
  // (e.g. tests, or any host that calls runFullAnalysis more than once) the
  // module-level counter would otherwise stay saturated and suppress every
  // degraded-parse log after the first run. The per-parse worker holds its own
  // counter in its own module instance and is process-scoped, so no separate
  // worker-side reset is needed (see safe-parse.ts ParseTimeoutError contract).
  resetDegradedParseCounter();

  // `storagePath` is ALWAYS the flat `.gitnexus` — content-addressed caches
  // (parse-cache, parsedfile-store) and the kuzu-migration cleanup live there
  // and are shared across branches (#2106 KTD7).
  const { storagePath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';

  // ── #2106/#2354: resolve which branch slot this run writes to ─────────
  // `branchLabel` is the branch identity recorded in meta.json (incl. the
  // flat workspace slot). `placement.branch` is undefined for the flat slot
  // (the lbug/meta paths stay byte-identical to single-branch behavior) and
  // set for a `branches/<slug>/` sub-directory. Only an explicit `--branch`
  // can route to a sub-directory; a plain analyze ALWAYS targets the flat
  // slot, which follows the checked-out working tree (#2354) — the
  // auto-detected branch (null for detached HEAD / non-git) is recorded as
  // the slot's informational label only.
  // Normalize the auto-detected branch the same way an explicit `--branch` is
  // validated (#2106 R1): a git ref the branch-name rules forbid (backtick,
  // `~ ^ : ? *`, leading `-`, `..`) becomes `null` → the flat slot, matching
  // that a later `--branch <that-ref>` query would also be rejected. A normal
  // ref passes through unchanged so index-time and query-time labels round-trip.
  const checkedOutBranch = repoHasGit
    ? (sanitizeDetectedBranch(getCurrentBranch(repoPath)) ?? null)
    : null;
  // Analyze indexes the working tree, not an arbitrary ref. An explicit
  // `--branch X` while a DIFFERENT branch Y is checked out would write Y's
  // content (and Y's commit) into X's index slot, corrupting X (#2106). Refuse
  // the mismatch. Detached HEAD / non-git (checkedOutBranch === null) still
  // allow an explicit label so CI checkouts can name their snapshot.
  if (options.branch && checkedOutBranch && options.branch !== checkedOutBranch) {
    throw new Error(
      `--branch "${options.branch}" does not match the checked-out branch "${checkedOutBranch}". ` +
        `Check out "${options.branch}" before indexing it, or omit --branch to index the current branch.`,
    );
  }
  const branchLabel = options.branch ?? checkedOutBranch;
  const placement = options.branch ? await resolveBranchPlacement(repoPath, branchLabel) : {};
  const { lbugPath, metaPath } = getStoragePaths(repoPath, placement.branch);
  // metaPath now points to the metadata file (gitnexus.json) in a branch-specific directory.
  // metaDir is the directory containing the metadata file (and branch-specific DBs).
  const metaDir = path.dirname(metaPath);

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
      await createSearchFTSIndexes({
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const missing = await verifySearchFTSIndexes(executeQuery);
      if (missing.length > 0) {
        throw new Error(
          `FTS repair failed - missing indexes after rebuild: ${missing.join(', ')}. ` +
            'Run `gitnexus analyze --force` to perform a full graph+FTS rebuild; ' +
            'if that also fails, verify FTS extension availability via `gitnexus doctor`.',
        );
      }
      await ensureGitNexusIgnored(repoPath);
      progress('fts', 90, 'Search indexes ready');
      progress('done', 100, 'Done');
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

  let resumeEmbeddingCheckpoint = false;
  let pendingEmbeddingNodeIds = new Set<string>();
  let embeddingIdentityForRun: EmbeddingIdentity | undefined;
  if (existingMeta?.embeddingCheckpoint) {
    if (options.dropEmbeddings) {
      log('Discarding the interrupted embedding checkpoint (--drop-embeddings).');
      options = { ...options, force: true };
    } else {
      const { resolveEmbeddingIdentity } = await import('./embeddings/embedding-identity.js');
      embeddingIdentityForRun = resolveEmbeddingIdentity();
      const checkpoint = existingMeta.embeddingCheckpoint;
      if (checkpoint.provider !== embeddingIdentityForRun.provider) {
        throw new Error(
          'Cannot resume embedding checkpoint: the embedding provider configuration differs. ' +
            'Restore the matching endpoint configuration or pass --drop-embeddings to rebuild without it.',
        );
      }
      if (
        checkpoint.model !== embeddingIdentityForRun.model ||
        checkpoint.dimensions !== embeddingIdentityForRun.dimensions
      ) {
        throw new Error(
          `Cannot resume embedding checkpoint: it uses ${checkpoint.model} at ` +
            `${checkpoint.dimensions} dimensions, but this run resolves ` +
            `${embeddingIdentityForRun.model} at ${embeddingIdentityForRun.dimensions}. ` +
            'Restore the matching embedding configuration or pass --drop-embeddings to rebuild without it.',
        );
      }
      resumeEmbeddingCheckpoint = true;
      pendingEmbeddingNodeIds = new Set(checkpoint.pendingNodeIds ?? []);
      log(
        `Previous analyze ended at an embedding checkpoint ` +
          `(${checkpoint.nodesProcessed}/${checkpoint.totalNodes} nodes); resuming from persisted hashes` +
          `${pendingEmbeddingNodeIds.size > 0 ? ` and regenerating ${pendingEmbeddingNodeIds.size} pending node(s)` : ''}.`,
      );
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

  // ── schema-version mismatch forces full rebuild (#2289 P1) ────────
  // Mirrors the pdg-mode block above: a stamp from an older
  // INCREMENTAL_SCHEMA_VERSION (e.g. pre-v5 URL-only Route ids) cannot be
  // reconciled by an incremental top-up — same-commit re-analyze would
  // strand stale rows next to new-schema writes. MUST sit before the
  // alreadyUpToDate fast path below: an unchanged-commit clean tree would
  // otherwise early-return without ever reaching the `isIncremental` gate
  // that consults `schemaVersion`, defeating the bump's whole point.
  //
  // `schemaVersion === undefined` covers two cases that should still trip
  // this guard: a non-git repo (which never stamps the field) and very old
  // meta from before the field existed. Non-git repos take the
  // `currentCommit === ''` rebuild branch below regardless, so the redundant
  // force here is harmless; the friendlier `'pre-versioning'` log avoids a
  // user-visible "stamped vundefined" line in that edge case.
  if (existingMeta && existingMeta.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
    const stampedVersion = existingMeta.schemaVersion ?? 'pre-versioning';
    log(
      `index schema changed (stamped v${stampedVersion}, this build is v${INCREMENTAL_SCHEMA_VERSION}); ` +
        `forcing a full rebuild so persisted rows match the current schema.`,
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
      const dirty = (() => {
        try {
          const out = execFileSync(
            'git',
            [
              'status',
              '--porcelain',
              '--',
              '.',
              ':(exclude).gitnexus',
              ':(exclude).gitnexus/**',
              ':(exclude).claude',
              ':(exclude).claude/**',
              ':(exclude).cursor',
              ':(exclude).cursor/**',
              ':(exclude)AGENTS.md',
              ':(exclude)CLAUDE.md',
            ],
            {
              cwd: repoPath,
              stdio: ['ignore', 'pipe', 'ignore'],
              windowsHide: true,
              encoding: 'utf8',
            },
          );
          return out.trim().length > 0;
        } catch {
          return true; // conservative on git failure
        }
      })();
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
      if (!dirty && !healUnregistered) {
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
      fetchWrappers: options.fetchWrappers,
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

  // Decide incremental vs full at THIS point (post-pipeline, pre-DB).
  // All eligibility conditions are checked here against the actual
  // pipeline output — no separate pre-pipeline prediction to desync from
  // (Bugbot review on PR #1479: a prediction that flipped post-pipeline
  // could skip the embedding cache load and then take the full-rebuild
  // path, silently losing embeddings).
  const isIncremental =
    !options.force &&
    !!existingMeta &&
    existingMeta.schemaVersion === INCREMENTAL_SCHEMA_VERSION &&
    !!existingMeta.fileHashes &&
    Object.keys(existingMeta.fileHashes).length > 0 &&
    repoHasGit &&
    allFilePaths.length > 0;

  const hashDiff = isIncremental
    ? diffFileHashes(newFileHashes, existingMeta!.fileHashes)
    : undefined;

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
    await wipeLbugDbFiles(lbugPath);
  }

  await initLbug(lbugPath);

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
      if (
        shouldEscalateIncrementalWrite(
          filesToDelete.length,
          effectiveWriteSet.size,
          allFilePaths.length,
        )
      ) {
        escalatedFullWrite = true;
        log(
          `Incremental: effective write set covers ${effectiveWriteSet.size}/${allFilePaths.length} ` +
            // Display clamp only (predicate unchanged): BFS-found deleted
            // importers can push the numerator past the CURRENT file list, so
            // the raw fraction can exceed 1 — see the population-mismatch note
            // on shouldEscalateIncrementalWrite (tri-review 4669518496).
            `files (${Math.min(100, Math.round(writeFraction * 100))}%) — switching to a full DB write ` +
            `(wipe + bulk COPY) for this run; file-level incremental bookkeeping is unaffected.`,
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
        await walCheckpointDriver.stop();
        await closeLbug();
        await wipeLbugDbFiles(lbugPath);
        await initLbug(lbugPath);
        walCheckpointDriver = startWalCheckpointDriver();
        await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
          lbugMsgCount++;
          const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
          progress('lbug', pct, msg);
        });
      } else {
        // 1a. Remove the write set's existing rows — batched (#2409): one
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
        });
        // Surgical path: Phase 3.5 restores exactly these files' embedding
        // rows (FIX 3). Sound because deleteNodesForFiles propagates errors
        // — reaching this line means every listed file's rows are gone
        // deterministically — and this process holds the exclusive DB lock,
        // so no concurrent writer can disturb the derivation.
        deletedFilePathsForRestore = new Set(filesToDelete);
        // 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
        //    from the fresh pipeline output below. Required for the
        //    "Leiden runs on the FULL graph" correctness invariant.
        await deleteAllCommunitiesAndProcesses();
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
        // 2b. Drop interprocedural TAINT_PATH edges (#2084 M4 U6) when pdg is on
        //     — their validity is a whole-program property (an A→C flow can be
        //     invalidated by a change to an intermediate function on a third
        //     file), so endpoint-writability extraction can't refresh them.
        //     extractChangedSubgraph re-includes all of them from the fresh
        //     graph (isGraphWideRelType), mirroring Community/Process.
        if (options.pdg === true) {
          await deleteAllInterprocTaintPaths();
          // 2c. Drop CALL_SUMMARY edges (PDG FU-C) on an incremental `--pdg`
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
        const subgraph = extractChangedSubgraph(pipelineResult.graph, effectiveWriteSet);
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
    if (ftsAvailable) {
      await createSearchFTSIndexes({
        onIndexStart: options.verbose
          ? (table, indexName) => log(`FTS: creating ${table}.${indexName}`)
          : undefined,
        onIndexReady: options.verbose
          ? (table, indexName) => log(`FTS: ready ${table}.${indexName}`)
          : undefined,
      });
      const missingIndexNames = await verifySearchFTSIndexes(executeQuery);
      if (missingIndexNames.length > 0) {
        throw new Error(
          `FTS verification failed - missing indexes after analyze: ${missingIndexNames.join(', ')}. ` +
            'Check FTS extension availability, then retry `gitnexus analyze --force` for a full rebuild.',
        );
      }
      progress('fts', 90, 'Search indexes ready');
    } else {
      // For a missing runtime dependency (#2374) the file is present, so the
      // generic "install it with network access" tail in FTS_UNAVAILABLE_MESSAGE
      // contradicts the remedy's own "reinstalling will NOT help" (#2383 F2). Lead
      // with the class-neutral sentence and append only the classified remedy.
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
        for (let i = 0; i < rowsToRestore.length; i += EMBED_BATCH) {
          const batch = rowsToRestore.slice(i, i + EMBED_BATCH);

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
              for (let i = 0; i < orphanRowIds.length; i += DELETE_FILES_CHUNK_SIZE) {
                const chunk = orphanRowIds.slice(i, i + DELETE_FILES_CHUNK_SIZE);
                const listLiteral = `[${chunk
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
    let embeddingSkipped = true;
    let semanticMode: 'vector-index' | 'exact-scan' | undefined;

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
    // reflects the DB's ACTUAL state even when recreation fails (win32 /
    // extension unavailable → 'exact-scan').
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

      const saveEmbeddingCheckpoint = async (
        checkpoint: {
          nodesProcessed: number;
          totalNodes: number;
          chunksProcessed: number;
        },
        pendingNodeIds: string[],
        embeddings: number | undefined,
      ): Promise<void> => {
        const fileHashes: Record<string, string> = {};
        for (const [key, value] of newFileHashes) fileHashes[key] = value;
        await saveMeta(metaDir, {
          ...(existingMeta ?? {}),
          repoPath,
          lastCommit: currentCommit,
          indexedAt: new Date().toISOString(),
          branch: branchLabel ?? existingMeta?.branch,
          remoteUrl: hasGitDir(repoPath) ? getRemoteUrl(repoPath) : undefined,
          stats: {
            files: pipelineResult.totalFileCount,
            nodes: stats.nodes,
            edges: stats.edges,
            communities: pipelineResult.communityResult?.stats.totalCommunities,
            processes: pipelineResult.processResult?.stats.totalProcesses,
            embeddings,
          },
          schemaVersion: hasGitDir(repoPath) ? INCREMENTAL_SCHEMA_VERSION : undefined,
          cjkSegmentation: getSearchFTSCjkSegmentation(),
          fileHashes: hasGitDir(repoPath) ? fileHashes : undefined,
          cacheKeys: [...parseCache.usedKeys],
          incrementalInProgress: undefined,
          embeddingCheckpoint: {
            at: new Date().toISOString(),
            ...checkpoint,
            model: embeddingIdentity.model,
            dimensions: embeddingIdentity.dimensions,
            provider: embeddingIdentity.provider,
            pendingNodeIds,
          },
          pdg: resolvePdgConfig(options),
        });
      };

      const embeddingResult = await runEmbeddingPipeline(
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
            await saveEmbeddingCheckpoint(checkpoint, nodeIds, existingMeta?.stats?.embeddings);
          },
          onCheckpoint: async (checkpoint) => {
            await checkpointOnce();
            const countResult = await executeQuery(
              `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
            );
            const countRow = countResult?.[0];
            const embeddings = Number(countRow?.cnt ?? countRow?.[0] ?? 0);
            await saveEmbeddingCheckpoint(checkpoint, [], embeddings);
          },
        },
      );
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

    // Count embeddings in the index (cached + newly generated)
    let embeddingCount = 0;
    try {
      const embResult = await executeQuery(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN count(e) AS cnt`,
      );
      const row = embResult?.[0];
      embeddingCount = Number(row?.cnt ?? row?.[0] ?? 0);
    } catch {
      /* table may not exist if embeddings never ran */
    }

    if (!embeddingSkipped && stats.nodes > 0 && embeddingCount === 0) {
      throw new Error(
        'Embedding generation completed without persisted embeddings. ' +
          'The index was not registered to avoid silently reporting embeddings: 0.',
      );
    }

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

    // Annotated so the capabilities stamp below is compile-checked against
    // RepoMeta's status unions (tri-review 4669518496 P1/U3) — an unannotated
    // literal widens the vectorSearch.status ternary to `string` and the
    // honesty contract silently decays to "whatever interpolates".
    const meta: RepoMeta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
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
      stats: {
        files: pipelineResult.totalFileCount,
        nodes: stats.nodes,
        edges: stats.edges,
        communities: pipelineResult.communityResult?.stats.totalCommunities,
        processes: pipelineResult.processResult?.stats.totalProcesses,
        embeddings: embeddingCount,
      },
      capabilities: {
        graph: { provider: 'ladybugdb', status: runtimeCapabilities.graph },
        // Reflect what this analyze run actually produced: when the FTS
        // extension was unavailable the indexes were skipped, so record
        // 'unavailable' rather than the static runtime default. Keeps
        // meta.json / `gitnexus doctor` honest about degraded search.
        fts: {
          provider: 'ladybugdb-fts',
          status: ftsAvailable ? runtimeCapabilities.fts : 'unavailable',
        },
        vectorSearch: {
          provider: effectiveSemanticMode === 'vector-index' ? 'ladybugdb-vector' : 'exact-scan',
          status: embeddingCount > 0 ? effectiveSemanticMode : 'unavailable',
          exactScanLimit: runtimeCapabilities.exactScanLimit,
          reason: runtimeCapabilities.reason,
        },
      },
      // Incremental-indexing fields. Populated for git repos so the next
      // analyze run can take the incremental DB-writeback path. Setting
      // incrementalInProgress to undefined explicitly clears any prior
      // dirty flag (full and incremental success paths converge here).
      schemaVersion: hasGitDir(repoPath) ? INCREMENTAL_SCHEMA_VERSION : undefined,
      // Always stamped with the live resolved mode (#2331/#2339) — unlike
      // `pdg` below, 'none' is a meaningful value to compare, not an
      // absence, so this is never conditionally omitted.
      cjkSegmentation: getSearchFTSCjkSegmentation(),
      fileHashes: hasGitDir(repoPath) ? newFileHashesRecord : undefined,
      // This branch's full live chunk-key set (#2106 R6). `usedKeys` is every
      // chunk hash touched in this scan — cache HITS included (see parse-impl
      // usedKeys.add) — so it's complete even on an incremental run. Persisted
      // so a sibling branch's prune can union it and not evict our shards.
      cacheKeys: [...parseCache.usedKeys],
      incrementalInProgress: undefined as RepoMeta['incrementalInProgress'],
      embeddingCheckpoint: undefined,
      // The effective pdg config this run's DB rows were built under
      // (#2099 F1). `undefined` on pdg-off runs — this meta is a fresh
      // literal (no spread of existingMeta), so omission is what CLEARS the
      // stamp after an on→off flip; the next pdgModeMismatch then compares
      // off==off and incremental eligibility is restored.
      pdg: resolvePdgConfig(options),
    };
    await saveMeta(metaDir, meta);

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
            communities: pipelineResult.communityResult?.stats.totalCommunities,
            clusters: aggregatedClusterCount,
            processes: pipelineResult.processResult?.stats.totalProcesses,
          },
          undefined,
          {
            skipAgentsMd: options.skipAgentsMd,
            skipSkills: options.skipSkills,
            noStats: options.noStats,
            defaultBranch: options.defaultBranch,
            hasPdg: options.pdg === true,
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
    await (options.skipNativeCloseOnExit ? closeLbugBeforeExit() : closeLbug());

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
      ftsSkipped: !ftsAvailable,
      isPrimaryBranch: !placement.branch,
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
    throw err;
  }
}
