/**
 * Repo metadata primitives — the bottom layer of `storage/`.
 *
 * Holds the on-disk shape of a GitNexus index's metadata file
 * (`.gitnexus/gitnexus.json`, plus its legacy `meta.json` mirror) and the
 * read-side helpers that locate and parse it. Nothing here writes, and nothing
 * here knows about the global registry.
 *
 * Why it is its own module: `repo-manager.ts` owns the registry and the write
 * side, and `branch-index.ts` (#2106) owns the multi-branch slug/placement
 * logic — but `resolveBranchPlacement` has to READ the flat slot's metadata to
 * decide who owns it. That made `branch-index` import values back out of
 * `repo-manager`, which imports values out of `branch-index`: a genuine
 * two-way runtime cycle that was only ESM-safe because neither side touched the
 * other at module-evaluation time. Rather than keep relying on that timing,
 * the shared read primitives moved DOWN here, where both layers can import them
 * and neither imports the other back.
 *
 * `repo-manager.ts` re-exports the public names (`RepoMeta`,
 * `AnalyzerRunnerIdentity`, `getStoragePath`, `loadMeta`, `INDEX_METADATA_FILE`,
 * `isMissingFilesystemError`) so every existing import site keeps working
 * unchanged.
 *
 * Imports `node:fs`/`node:path` and a few type-only summary shapes. Keep it that way: a
 * value import here would land in every consumer of `storage/`.
 */

import fs from 'fs/promises';
import path from 'path';
import type { UnresolvedReceiverSummary } from '../core/ingestion/scope-resolution/unresolved-receivers.js';
import type { UndecidedSatisfactionSummary } from '../core/ingestion/scope-resolution/undecided-satisfaction.js';
import type { ScopeExtractionFailureSummary } from '../core/ingestion/scope-resolution/scope-extraction-failures.js';

/** The `.gitnexus` directory name, relative to a repo root. */
export const GITNEXUS_DIR = '.gitnexus';
export const INDEX_METADATA_FILE = 'gitnexus.json';
// Dual-written mirror of INDEX_METADATA_FILE, kept for backward compatibility
// with consumers that only know the pre-rename filename (see MIGRATION.md).
export const LEGACY_METADATA_FILE = 'meta.json';

/**
 * Versioned receipt for the analyzer process that produced an index.
 *
 * Paths identify the resolved runtime and invoked GitNexus entry artifact on
 * this machine. The entry artifact is diagnostic (CLI and server-worker entry
 * files differ); semantic freshness compares the runtime/build/dependency
 * fields. SHA-256 digests make the receipt independently reproducible:
 * `invokedArtifact.digest` covers the entry file, `build.digest` covers the
 * complete source or distribution tree, and `dependencyRuntime.digest` covers
 * the applicable lockfile, resolved runtime package metadata, and every
 * content-addressed package payload (including JS/JSON/native/Wasm inputs)
 * using the canonicalizations defined in `core/analyzer-identity.ts`.
 */
export interface AnalyzerRunnerIdentity {
  schemaVersion: 4;
  runtime: {
    executablePath: string;
    version: string;
    platform: string;
    architecture: string;
    modulesAbi: string;
    libc: string;
  };
  cliVersion: string;
  invokedArtifact: {
    path: string;
    digest: string;
  };
  build: {
    kind: 'source' | 'distribution';
    rootPath: string;
    canonicalization: 'gitnexus-analyzer-build-v2';
    digest: string;
  };
  dependencyRuntime: {
    manifestPath: string;
    lockfilePath: string | null;
    canonicalization: 'gitnexus-analyzer-dependency-runtime-v4';
    packageCount: number;
    artifactCount: number;
    digest: string;
  };
}

export interface RepoMeta {
  repoPath: string;
  lastCommit: string;
  indexedAt: string;
  /**
   * Analyzer/runtime receipt for the successful run represented by this
   * metadata. Optional so indexes written by older GitNexus releases remain
   * readable; a missing value means provenance is unknown, never that it
   * matches the currently invoked analyzer.
   */
  runnerIdentity?: AnalyzerRunnerIdentity;
  /**
   * Canonical `origin` remote URL captured at index time. Used to
   * fingerprint the same logical repo across multiple on-disk clones
   * (worktrees, agent workspaces, "clean clone for indexing"). When
   * absent (no remote configured, git unavailable, etc.) the repo is
   * treated as path-only and sibling-clone detection is skipped.
   */
  remoteUrl?: string;
  stats?: {
    files?: number;
    nodes?: number;
    edges?: number;
    communities?: number;
    processes?: number;
    embeddings?: number;
  };
  /**
   * Capability stamps for what THIS analyze run actually produced (mirrors
   * the meta literal in run-analyze.ts — typed here so the stamp site is
   * compile-checked; tri-review 4669518496 P1/U3: `vectorSearch.status`
   * must never claim 'vector-index' unless the run verified or recreated
   * the HNSW index). `fts.status` gained its first programmatic reader in
   * #2767: `LocalBackend.ensureInitialized()` compares it against the
   * warm connection pool's last-observed value as the dedicated signal
   * that `--repair-fts` changed FTS availability (`doctor` still prints
   * platform-derived capabilities separately; `graph`/`vectorSearch` remain
   * forensic-only). The status unions mirror `CapabilityStatus` /
   * `SemanticSearchMode` in core/platform/capabilities.ts; inlined so storage/
   * takes no core/ import for a pair of string unions, at the cost of keeping
   * the two in sync by hand.
   */
  capabilities?: {
    graph: { provider: string; status: 'available' | 'degraded' | 'unavailable' };
    fts: {
      provider: string;
      status: 'available' | 'degraded' | 'unavailable';
      /**
       * Why THIS run ended up without search indexes, when `status` is
       * `'unavailable'` (#2841). Mirrors `AnalysisResult.ftsSkipReason` in
       * core/run-analyze.ts — the same discriminator that surface already
       * reports to the CLI, persisted rather than re-derived because the two
       * causes need OPPOSITE handling on the next run:
       *
       *  - `extension-unavailable` — the FTS extension could not load. Healable
       *    from outside the repo (install it), so the up-to-date fast path
       *    probes whether it loads now and re-analyzes when it does.
       *  - `build-failed` — the extension loaded fine and the index BUILD
       *    failed (e.g. one un-tokenizable pre-existing row, #2544/#2546).
       *    Deterministic: the same probe would "heal" it into a full
       *    re-analysis that degrades identically and restamps, forever. Only
       *    `--repair-fts` or a content change addresses it.
       *
       * Collapsing both into `status: 'unavailable'` is exactly what made that
       * loop reachable. ABSENT on indexes written before #2841 and on the
       * `--repair-fts` stamp (which writes `status: 'available'`); `undefined`
       * therefore reads as "cause unknown" and keeps the pre-#2841 behaviour.
       */
      skipReason?: 'extension-unavailable' | 'build-failed';
    };
    vectorSearch: {
      provider: string;
      status: 'vector-index' | 'exact-scan' | 'unavailable';
      exactScanLimit: number;
      reason?: string;
    };
  };
  /**
   * Digest of the graph DDL this index's tables were actually created from
   * (`SCHEMA_FINGERPRINT`, core/lbug/schema.ts). On mismatch, runFullAnalysis
   * warns and forces a full rebuild, which wipes and recreates the database so
   * the tables are built from the current DDL (#2798).
   *
   * This REPLACED `schemaVersion`, a hand-incremented integer that had to
   * predict the same fact and could not: it collided with `main` eight times,
   * twice exactly, and an exact clash passed the `===` gate silently. The
   * digest is derived, so it cannot collide by accident at this scale (48
   * bits; see SCHEMA_FINGERPRINT) — two builds agree exactly when their DDL
   * agrees.
   *
   * ABSENT ≡ mismatch, deliberately. That is the backward-compatibility path:
   * every index built by an older GitNexus carries no fingerprint, gets the
   * warning, and is rebuilt once against the current schema. Grandfathering
   * absence would instead stamp a fresh fingerprint onto a database whose DDL
   * was never verified.
   *
   * Stamped only for git repos — non-git repos never take the incremental path.
   * Declared as a plain string rather than importing the constant: that would
   * be a RUNTIME value import of core/lbug/schema.ts, pulling the whole DDL and
   * its `gitnexus-shared` module graph into every storage/ consumer.
   */
  schemaFingerprint?: string;
  /**
   * Exact versions of independently-gated analysis capabilities produced by
   * the successful run. Unlike schemaFingerprint, these may apply only to repos
   * containing relevant source files.
   */
  analysisFeatures?: Record<string, number>;
  /**
   * The resolved GITNEXUS_FTS_CJK_SEGMENTATION mode ('none' | 'bigram') the
   * existing index's content/description columns were last written under
   * (#2331/#2339). On mismatch with the live process's resolved mode,
   * runFullAnalysis forces a full rebuild so indexed text and query-time
   * segmentation never diverge. Always stamped (never omitted), unlike
   * `pdg` below — the default 'none' is itself a meaningful value to
   * compare, not an absence.
   */
  cjkSegmentation?: string;
  /**
   * The `FLOAT[N]` width this index's `CodeEmbedding` vector column was
   * actually created at — `EMBEDDING_DIMS` (core/lbug/schema.ts), resolved from
   * `GITNEXUS_EMBEDDING_DIMS` at module load (#2798). On mismatch with the live
   * process's width, runFullAnalysis forces a full rebuild, which wipes the
   * database and recreates the table at the new width; an incremental run never
   * revisits a column's type, so nothing else can.
   *
   * Sits beside `schemaFingerprint` rather than inside it on purpose: the
   * fingerprint is a digest of CODE, and this width comes from the
   * ENVIRONMENT, so folding it in would make the same build disagree with
   * itself across two runs and thrash rebuilds.
   *
   * ABSENT means an index written before this field existed — NOT a mismatch,
   * unlike `schemaFingerprint` above. Absence says nothing about the width
   * (that run used whatever its env resolved, almost always the 384 default,
   * and the table it wrote agreed with it), and every such index also predates
   * `schemaFingerprint`, so the guard above already rebuilds it once and this
   * stamp lands then. See `embeddingDimsMismatch` for the full argument.
   *
   * Always stamped, like `cjkSegmentation` and unlike `schemaFingerprint`: the
   * column is created for every index, git or not, so there is no case where
   * omitting it is correct — which keeps absence meaning exactly one thing.
   * A plain number rather than an import of the constant, for the same reason
   * `schemaFingerprint` is a plain string: storage/ takes no runtime import of
   * core/lbug/schema.ts.
   */
  embeddingDims?: number;
  /**
   * Member names whose call sites were DROPPED because the receiver's type
   * could not be established (#2744, the second half of #2708). Read by
   * `impact()` / `context()` to report a result as `epistemic: 'lower-bound'`
   * instead of `'exact'` when the queried symbol's name appears here.
   *
   * Keyed by member name, not by target symbol, on purpose: a dropped site's
   * callee is unknown by definition, so the drop cannot be attributed to any
   * target. Absent when a run dropped nothing, which is the common case and
   * keeps `epistemic` exact for cleanly-resolving repos.
   *
   * The persisted shape IS `UnresolvedReceiverSummary` — referenced, not
   * re-declared. The writer stores the whole summary, so a structural mirror
   * here silently drops any field added on the producing side (a reader then
   * sees `undefined` for keys that are present on disk). Type-only import, so
   * this adds no runtime dependency from storage/ on core/.
   */
  unresolvedReceiverMembers?: UnresolvedReceiverSummary;
  /**
   * Files omitted from scope-resolution because their provider capture or
   * extraction step threw. The rest of each file may still be present in the
   * graph, so this is an index-completeness signal rather than a parse failure.
   * Absent means the successful run recorded no such omission; older indexes
   * also read as absent until re-analyzed.
   */
  scopeExtractionFailures?: ScopeExtractionFailureSummary;
  /**
   * Completeness receipt for scope extraction in the successful run represented
   * by this metadata. A missing or different value means completeness is
   * unknown (legacy, malformed, or unreadable metadata), not that zero files
   * were omitted.
   */
  scopeExtractionReceipt?: 1;
  /**
   * Interfaces whose structural-satisfaction check this run could not COMPLETE
   * (#2873) — not interfaces found to have no implementors.
   *
   * Read by `impact()` to report `epistemic: 'lower-bound'` instead of
   * `'exact'` when a walk crosses one of these interfaces. Without it, an
   * interface whose implementors were never decided is byte-identical to one
   * that genuinely has none: both are zero IMPLEMENTS edges, and only the
   * second is an answer.
   *
   * Absent when a run decided everything it looked at, which is the common case
   * and keeps `epistemic` exact for cleanly-resolving repos. Absence is NOT the
   * same as a zeroed record — an index written before this field existed also
   * reads as absent, and both correctly mean "no hedge available from here".
   */
  undecidedInterfaceSatisfaction?: UndecidedSatisfactionSummary;
  /**
   * SHA-256 of every file's content at the time of the last successful
   * indexing run. The next run computes current hashes and diffs against
   * this map to determine which files' DB rows must be replaced.
   * Map keys are repo-relative paths.
   */
  fileHashes?: Record<string, string>;
  /**
   * Set when a run finished but the persisted edge count came back far short
   * of what the pipeline produced — the B2 "refresh reports SUCCESS while the
   * index is unusable" failure (observed as edges collapsing 23009 -> 2170,
   * and as a missing `CodeRelation` table, which reads here as a persisted
   * count of zero).
   *
   * Recorded rather than thrown because the metadata IS written and the DB
   * does hold rows; what is false is the claim that the index is complete.
   * `getIndexIncompleteReasons` turns this into `graph-write-collapsed` so
   * `status` and the MCP resources report the index as incomplete instead of
   * fresh. Absent on a healthy run.
   */
  /**
   * Fields whose property reads could not be linked because every definition of
   * the name lives in ANOTHER language (R3-1).
   *
   * Persisted because the graph cannot answer this at query time: the unlinked
   * reads mint no edge and no node, so the only record that they existed is the
   * analyze pass that declined them. Without it, `context()` on such a field
   * shows an empty incoming list that is byte-identical to a genuinely unread
   * field — and the two demand opposite actions.
   *
   * Capped at analyze time; a long tail is not more actionable than a short one.
   */
  crossLanguageProperties?: readonly { name: string; languages: string[] }[];
  graphWriteCollapsed?: {
    /** Relationships the pipeline produced in memory. */
    expected: number;
    /** Relationships readable from the DB after the write. */
    persisted: number;
  };
  /**
   * Crash-recovery dirty flag — a generic marker written to the metadata
   * file (gitnexus.json + its meta.json mirror) BEFORE any destructive DB
   * mutation by BOTH writeback branches (incremental since its introduction;
   * full rebuilds over an existing meta since #2099 F1); cleared on success
   * by overwriting the metadata file. If a run crashes between, the next
   * run sees the flag and forces a full rebuild — the cheapest path back
   * to a known-good index.
   */
  incrementalInProgress?: {
    /** When the run started (epoch ms). */
    startedAt: number;
    /** Last dirty-flag refresh (epoch ms). */
    updatedAt?: number;
    /** Number of files in the writable set, for diagnostic logs.
     *  `0` on the full-rebuild path (no incremental write set exists). */
    toWriteCount: number;
    /** Last completed writeback phase before the process stopped. */
    phase?: string;
    /** Directly changed/added files before importer expansion. */
    directWriteCount?: number;
    /** Extra files pulled into the writable set by importer BFS. */
    importerExpansion?: number;
    /** Files in the effective write set after graph-boundary expansion. */
    effectiveWriteCount?: number;
    /** Files whose persisted rows were scheduled for deletion. */
    deleteCount?: number;
    /** Added-file shadow seeds included in importer BFS. */
    shadowSeedCount?: number;
    /** Importer-BFS chunks dropped by failed IMPORTS queries (#2410 +
     *  tri-review 4669518496 P2-5). Stamped only when > 0: a dropped chunk
     *  means the importer expansion silently shrank, so a crash's
     *  diagnostics must show whether the write set was already
     *  under-expanded when the run died. */
    droppedImporterChunks?: number;
  };
  /**
   * Durable embedding-resume marker, written in two distinct situations that
   * `kind` tells apart — see below. A matching runtime resumes from persisted
   * hashes and regenerates the pending nodes.
   *
   * Cleared by a clean run. NOT cleared by a run that completed while dropping
   * nodes to endpoint failures (#2790): retaining it is what makes those nodes
   * come back, because a plain `analyze` derives `shouldGenerateEmbeddings:
   * false` once any embeddings exist, so nothing would ever call the pipeline
   * again.
   */
  embeddingCheckpoint?: {
    at: string;
    nodesProcessed: number;
    totalNodes: number;
    chunksProcessed: number;
    model: string;
    dimensions: number;
    /** `local` or a secret-free SHA-256 fingerprint of the HTTP endpoint identity. */
    provider: string;
    /**
     * Which situation wrote this marker. Absent ≡ `'interrupted'`, so markers
     * written by older versions keep the stricter behavior.
     *
     * - `'interrupted'` — written BEFORE a bounded write window. Its
     *   `pendingNodeIds` may be half-persisted if the process died mid-window,
     *   so resume must delete and regenerate them even when a persisted row
     *   carries the current content hash, and an identity mismatch must fail
     *   closed: resuming under a foreign model would mix vector spaces.
     * - `'partial'` — written AFTER a run that completed but dropped nodes to
     *   endpoint failures. The pipeline already deleted every row of those
     *   nodes, so they provably hold ZERO rows. Nothing is at risk from a
     *   different embedding identity, so an identity mismatch may drop the
     *   pending set with a warning instead of aborting the run.
     * - `'unverified-count'` — written after a run whose embedding count could
     *   not be measured. `pendingNodeIds` is EMPTY: nothing was dropped and
     *   nothing needs re-embedding. It exists only to defeat the same-commit
     *   fast return so the next run re-derives a count, because clearing it
     *   while `stats.embeddings` still reads a stale zero is what arms a later
     *   `--force` to wipe live embeddings.
     */
    kind?: 'interrupted' | 'partial' | 'unverified-count';
    /**
     * Consecutive resume attempts that have failed to clear `pendingNodeIds`
     * (`'partial'` only). Bounds the retry so a node the endpoint rejects
     * deterministically — an oversized chunk, content it refuses — cannot keep
     * a repo permanently incomplete. See EMBEDDING_RESUME_MAX_ATTEMPTS.
     */
    attempts?: number;
    /**
     * Nodes to regenerate on resume. For `'interrupted'` these may hold a
     * subset of their chunks; for `'partial'` they hold none.
     */
    pendingNodeIds?: string[];
  };
  /**
   * Name of the git branch this index represents (#2106). Absent for the
   * default/legacy single-branch case so the flat metadata file stays
   * byte-identical to pre-multi-branch output. When present in the FLAT
   * metadata file, it records which branch "owns" the flat slot (the first
   * branch indexed); per-branch indexes under `branches/<slug>/` always carry
   * their own `branch`.
   */
  branch?: string;
  /**
   * The parse-cache chunk keys this branch's index needs (#2106 R6). The
   * parse-cache and durable parsedfile store live ONCE at the repo root and are
   * shared across branches; recording each branch's live chunk keys lets the
   * prune step union them so re-analyzing one branch doesn't evict another
   * branch's still-live shards. Additive/optional; absent in legacy metas.
   */
  cacheKeys?: string[];
  /**
   * The effective `--pdg` configuration this index's DB rows were built
   * under (#2099 F1). Presence ≡ the BasicBlock/CFG layer exists in the DB;
   * ABSENT ≡ pdg-off — which covers every legacy meta, since `--pdg`
   * shipped opt-in. Caps are recorded RESOLVED (defaults applied) so an
   * explicit-default run compares equal to a default run. run-analyze
   * compares this against the requested options and forces a full
   * writeback on any mismatch — the incremental path only persists
   * changed-file nodes and would otherwise silently drop (or strand) the
   * CFG layer on a mode flip. Additive/optional: it is metadata, not DDL, so
   * it does not move `schemaFingerprint` and costs no rebuild for anyone whose
   * pdg mode is unchanged. NOTE the removal mechanism is load-bearing:
   * the end-of-run meta is a fresh object literal, NOT a spread of the
   * prior meta, so omitting this field on a pdg-off run is what clears
   * the stamp after an on→off flip.
   */
  pdg?: {
    /** Worker-side per-function source-line cap, resolved (0 = unlimited). */
    maxFunctionLines: number;
    /** Emit-side per-function CFG edge cap, resolved (0 = unlimited). */
    maxEdgesPerFunction: number;
    /**
     * Emit-side per-function REACHING_DEF edge cap, resolved (0 = unlimited;
     * #2082 M2). ABSENT on an M1-era stamp — which is exactly what makes
     * `pdgModeMismatch` trip on the first M2 run over an M1 index and force
     * the full writeback that populates REACHING_DEF rows. Optional in the
     * type for that reason; resolved (always present) on every M2+ write.
     */
    maxReachingDefEdgesPerFunction?: number;
    /**
     * Emit-side per-function CDG (control-dependence) edge cap, resolved
     * (0 = unlimited; #2085 M5). ABSENT on any pre-M5 stamp — that absence is
     * what trips `pdgModeMismatch` on the first CDG-aware run and forces the
     * full writeback that materialises CDG edges. Optional for that upgrade
     * reason; resolved (always present) on every M5+ write.
     */
    maxCdgEdgesPerFunction?: number;
    /**
     * Per-function taint findings cap, resolved (0 = unlimited; #2083 M3).
     * ABSENT on an M1/M2-era stamp — like `maxReachingDefEdgesPerFunction`,
     * that absence is what trips `pdgModeMismatch` on the first M3 run and
     * forces the full writeback that populates TAINTED/SANITIZES rows.
     */
    maxTaintFindingsPerFunction?: number;
    /** Per-finding taint hop cap, resolved (0 = unlimited; #2083 M3 KTD6 —
     *  bounds the persisted hop-encoded `reason`). Optional for the same
     *  M2-era-stamp upgrade reason as the findings cap. */
    maxTaintHops?: number;
    /**
     * Per-run cross-function caps, resolved (0 = unlimited; #2084 M4 review
     * P1-3). ABSENT on an M3-era stamp — that absence trips `pdgModeMismatch`
     * on the first run that adds them and forces the full writeback that
     * re-materialises TAINT_PATH within bounds. Optional for that upgrade
     * reason; resolved (always present) on every post-fix write.
     */
    maxInterprocFindings?: number;
    maxInterprocHops?: number;
    maxInterprocEdges?: number;
    /**
     * Digest of the built-in taint model the persisted findings were
     * produced under (#2083 M3 KTD7/R7). Any model-content change ships a
     * new digest → mismatch → full writeback repopulates taint edges
     * without `--force`. Optional: absent on pre-M3 stamps.
     */
    taintModelVersion?: string;
    /**
     * Identity of the reaching-definitions solver the persisted REACHING_DEF
     * rows were produced under (#2201 review R3). The SSA-sparse rewrite computes
     * FULL facts for deep-loop functions the old dense worklist truncated to
     * empty (the blocks×64 ceiling no longer fires) — but an existing `--pdg`
     * index built under the old solver carries those truncated rows. ABSENT on
     * any pre-#2201 stamp, so that absence trips `pdgModeMismatch` on the first
     * upgraded run and forces the full writeback that recomputes the now-fuller
     * REACHING_DEF coverage without `--force`. Bump the tag on any future change
     * that alters which facts the solver emits. Optional for that upgrade reason;
     * resolved (always present) on every post-#2201 write.
     */
    reachingDefSolver?: string;
    /**
     * Whether this `--pdg` index recorded the FU-C `CALL_SUMMARY` return-value
     * ascent layer (per-callee param→return summary edges). `true` on every
     * FU-C+ (v4) write. ABSENT on any pre-FU-C (v3) `--pdg` stamp — that absence
     * is what tells `impact`'s PDG mode the index predates CALL_SUMMARY, so it
     * surfaces a "no return-value ascent (re-index for CALL_SUMMARY)" note while
     * STILL serving the intra slice. CALL_SUMMARY is deliberately NOT a required
     * sub-layer for `pdgLayerStatus` to report `'ready'`: a v3 index stays fully
     * usable for the intra-procedural statement slice; only the ascent upgrade is
     * unavailable. Optional for that back-compat reason.
     */
    hasCallSummary?: boolean;
  };
}

/**
 * Get the .gitnexus storage path for a repository.
 * Used for local metadata and caches that are not committed.
 */
export const getStoragePath = (repoPath: string): string => {
  return path.join(path.resolve(repoPath), GITNEXUS_DIR);
};

/**
 * True for errors that prove a path is absent (ENOENT/ENOTDIR) — as opposed
 * to transient/permission failures (EIO/EACCES/EBUSY…) where the file may
 * well still exist. Exported for consumers that need the same "provably
 * missing vs not provably absent" distinction (e.g. collectBranchCacheKeys).
 */
export function isMissingFilesystemError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Best-effort read of one specific metadata filename — no fallback, null on
 * any failure (absent, unreadable, or unparseable).
 */
export const tryReadMetaFile = async (dir: string, filename: string): Promise<RepoMeta | null> => {
  try {
    const raw = await fs.readFile(path.join(dir, filename), 'utf-8');
    return JSON.parse(raw) as RepoMeta;
  } catch {
    return null;
  }
};

/**
 * Load metadata from the legacy `meta.json` mirror in the given directory.
 * Returns null when the file is absent, unreadable, or unparseable — a
 * corrupt legacy file is treated the same as a missing one (safe rebuild).
 */
const loadMetaLegacy = async (metaDir: string): Promise<RepoMeta | null> =>
  tryReadMetaFile(metaDir, LEGACY_METADATA_FILE);

/**
 * Load metadata from a directory containing the metadata file (gitnexus.json).
 * For primary/flat: metaDir = <repo>/.gitnexus
 * For feature branches: metaDir = <repo>/.gitnexus/branches/<slug>
 *
 * Falls back to the legacy `meta.json` mirror ONLY when `gitnexus.json` is
 * provably absent (ENOENT/ENOTDIR). Any other failure — a parse error, EACCES,
 * EIO — returns null instead of silently resurrecting possibly-stale legacy
 * content: a corrupt primary file must trigger the same safe full-rebuild path
 * a missing index would (the fail-safe `saveMeta`'s docstring relies on), not
 * an incremental run over a stale legacy baseline.
 */
export const loadMeta = async (metaDir: string): Promise<RepoMeta | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(metaDir, INDEX_METADATA_FILE), 'utf-8');
  } catch (err) {
    // Provably absent → the legacy mirror is the source of truth (pre-rename
    // repo, or a mirror-only state). Anything else → fail safe with null.
    return isMissingFilesystemError(err) ? loadMetaLegacy(metaDir) : null;
  }
  try {
    return JSON.parse(raw) as RepoMeta;
  } catch {
    // Corrupt primary file — do NOT mask it with legacy content.
    return null;
  }
};
