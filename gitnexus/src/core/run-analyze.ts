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
import {
  initLbug,
  loadGraphToLbug,
  getLbugStats,
  executeQuery,
  executeWithReusedStatement,
  closeLbug,
  loadCachedEmbeddings,
  deleteNodesForFile,
  deleteAllCommunitiesAndProcesses,
  queryImporters,
} from './lbug/lbug-adapter.js';
import { createSearchFTSIndexes } from './search/fts-indexes.js';
import {
  getStoragePaths,
  saveMeta,
  loadMeta,
  ensureGitNexusIgnored,
  registerRepo,
  cleanupOldKuzuFiles,
  INCREMENTAL_SCHEMA_VERSION,
} from '../storage/repo-manager.js';
import { computeFileHashes, diffFileHashes } from '../storage/file-hash.js';
import {
  extractChangedSubgraph,
  computeEffectiveWriteSet,
} from './incremental/subgraph-extract.js';
import { shadowCandidatesFor } from './incremental/shadow-candidates.js';
import { loadParseCache, saveParseCache, pruneCache } from '../storage/parse-cache.js';
import {
  getCurrentCommit,
  getRemoteUrl,
  hasGitDir,
  getInferredRepoName,
  resolveRepoIdentityRoot,
} from '../storage/git.js';
import type { CachedEmbedding } from './embeddings/types.js';
import { generateAIContextFiles } from '../cli/ai-context.js';
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
  /** Skip installing standard GitNexus skill files to .claude/skills/gitnexus/. */
  skipSkills?: boolean;
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
}

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
export async function runFullAnalysis(
  repoPath: string,
  options: AnalyzeOptions,
  callbacks: AnalyzeCallbacks,
): Promise<AnalyzeResult> {
  const log = (msg: string) => callbacks.onLog?.(msg);
  const progress = (phase: string, percent: number, message: string) =>
    callbacks.onProgress(phase, percent, message);

  const { storagePath, lbugPath } = getStoragePaths(repoPath);

  // Clean up stale KuzuDB files from before the LadybugDB migration.
  const kuzuResult = await cleanupOldKuzuFiles(storagePath);
  if (kuzuResult.found && kuzuResult.needsReindex) {
    log('Migrating from KuzuDB to LadybugDB — rebuilding index...');
  }

  const repoHasGit = hasGitDir(repoPath);
  const currentCommit = repoHasGit ? getCurrentCommit(repoPath) : '';
  const existingMeta = await loadMeta(storagePath);

  // ── Crash recovery: dirty flag forces full rebuild ────────────────
  // If the previous incremental run set incrementalInProgress and didn't
  // clear it, the on-disk index may be in a half-state. Cheapest path
  // back to a known-good index is to wipe + rebuild from scratch.
  if (existingMeta?.incrementalInProgress) {
    log(
      'Previous incremental run did not complete cleanly (incrementalInProgress flag set); ' +
        'forcing full rebuild to restore a known-good index.',
    );
    options = { ...options, force: true };
    // Reload meta after clearing the flag in-memory; we still want fileHashes
    // for the post-rebuild meta carry-over, but force=true ensures the
    // rebuild path executes.
  }

  // ── Early-return: already up to date ──────────────────────────────
  if (existingMeta && !options.force && existingMeta.lastCommit === currentCommit) {
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
              encoding: 'utf8',
            },
          );
          return out.trim().length > 0;
        } catch {
          return true; // conservative on git failure
        }
      })();
      if (!dirty) {
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
    shouldGenerateEmbeddings,
    shouldLoadCache,
  } = _deriveEmbeddingMode(options, existingEmbeddingCount);

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
    { parseCache },
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
    // success at the meta-save step.
    await saveMeta(storagePath, {
      ...existingMeta!,
      incrementalInProgress: {
        startedAt: Date.now(),
        toWriteCount: hashDiff.toWrite.length,
      },
    });
  } else {
    // Full rebuild path: wipe DB files first.
    await closeLbug();
    const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
    for (const f of lbugFiles) {
      try {
        await fs.rm(f, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    }
  }

  await initLbug(lbugPath);
  try {
    // All work after initLbug is wrapped in try/finally to ensure closeLbug()
    // is called even if an error occurs — the module-level singleton DB handle
    // must be released to avoid blocking subsequent invocations.

    let lbugMsgCount = 0;
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
      //    `queryImporters` reads `IMPORTS` from the pre-pipeline DB
      //    state, so the result is "files that USED TO import the
      //    target" — exactly the set whose previously-stored edges may
      //    no longer match what cross-file resolution produces this run.
      const MAX_IMPORTER_BFS_DEPTH = 4;
      const writableFiles = new Set<string>(hashDiff.toWrite);
      const directlyChangedCount = writableFiles.size;

      // Shadow-seed: for ADDED files, queryImporters returns 0 (the new
      // file has no IMPORTS rows in the pre-pipeline DB yet). But pre-
      // existing unchanged files may have IMPORTS edges whose module-
      // resolution claim the newcomer can steal under standard JS/TS
      // resolution (Bugbot review on PR #1479). For each added file we
      // derive the shadow candidates and, if the candidate was a known
      // file in the prior meta, seed it into the BFS frontier so its
      // importers — surfaced via queryImporters — get their CALLS edges
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
        let frontier: string[] = [...hashDiff.toWrite, ...hashDiff.deleted, ...shadowSeed];
        for (let depth = 0; depth < MAX_IMPORTER_BFS_DEPTH && frontier.length > 0; depth++) {
          const nextFrontier: string[] = [];
          for (const f of frontier) {
            try {
              const importers = await queryImporters(f);
              for (const i of importers) {
                if (!writableFiles.has(i)) {
                  writableFiles.add(i);
                  nextFrontier.push(i);
                }
              }
            } catch {
              /* per-file importer query failure → skip; correctness degrades on
                 that branch, but DB stays writable. */
            }
          }
          frontier = nextFrontier;
        }
      }
      const importerExpansion = writableFiles.size - directlyChangedCount;
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
      //    The composed set is the input to BOTH deleteNodesForFile
      //    and extractChangedSubgraph — asymmetry between the two would
      //    leave stale rows or PK-conflict at COPY time.
      const effectiveWriteSet = computeEffectiveWriteSet(pipelineResult.graph, writableFiles);
      // Deduped: deleted entries may already appear via importer-BFS
      // expansion (queryImporters can return a now-deleted path), which
      // would otherwise call deleteNodesForFile twice for the same file
      // (Bugbot LOW finding on PR #1479).
      const filesToDelete = [...new Set([...effectiveWriteSet, ...hashDiff.deleted])];
      for (let i = 0; i < filesToDelete.length; i++) {
        const f = filesToDelete[i];
        try {
          await deleteNodesForFile(f);
        } catch {
          /* file may not have rows (e.g. an unparseable file) — fine */
        }
        if (i % 20 === 0) {
          progress('lbug', 62, `Removing rows for changed files (${i}/${filesToDelete.length})...`);
        }
      }
      // 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
      //    from the fresh pipeline output below. Required for the
      //    "Leiden runs on the FULL graph" correctness invariant.
      await deleteAllCommunitiesAndProcesses();

      // 3. Extract the changed subgraph from the FULL ctx.graph and write
      //    only that. Unchanged-file rows in the DB stay untouched. Pass
      //    the SAME effectiveWriteSet so the subgraph and the deletes
      //    cover identical files (asymmetry would silently corrupt).
      const subgraph = extractChangedSubgraph(pipelineResult.graph, effectiveWriteSet);
      await loadGraphToLbug(subgraph, pipelineResult.repoPath, storagePath, (msg) => {
        lbugMsgCount++;
        const pct = Math.min(84, 65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19));
        progress('lbug', pct, msg);
      });
    } else {
      // ── Full rebuild ───────────────────────────────────────────────
      await loadGraphToLbug(pipelineResult.graph, pipelineResult.repoPath, storagePath, (msg) => {
        lbugMsgCount++;
        const pct = Math.min(84, 60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24));
        progress('lbug', pct, msg);
      });
    }

    // ── Phase 3: FTS (85–90%) ─────────────────────────────────────────
    progress('fts', 85, 'Creating search indexes...');
    await createSearchFTSIndexes();
    progress('fts', 90, 'Search indexes ready');

    // ── Phase 3.5: Re-insert cached embeddings ────────────────────────
    // Runs on BOTH the full-rebuild path and the incremental path:
    //   - Full rebuild: DB was wiped, every cached row needs to come back.
    //   - Incremental:  changed-file rows were just deleted by
    //                   deleteNodesForFile (which cascades to their
    //                   embedding rows) — so their cached vectors need
    //                   to come back too. Unchanged-file rows still
    //                   exist; re-inserting their cached vectors would
    //                   PK-conflict, but the per-batch try/catch below
    //                   silently ignores those (matches the existing
    //                   "some may fail if node was removed, that's
    //                   fine" semantics). Bugbot review on PR #1479
    //                   flagged that gating this on `!isIncremental`
    //                   silently lost changed-file embeddings.
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
        progress('embeddings', 88, `Restoring ${cachedEmbeddings.length} cached embeddings...`);
        const { batchInsertEmbeddings: batchInsert } =
          await import('./embeddings/embedding-pipeline.js');
        const EMBED_BATCH = 200;
        for (let i = 0; i < cachedEmbeddings.length; i += EMBED_BATCH) {
          const batch = cachedEmbeddings.slice(i, i + EMBED_BATCH);

          try {
            await batchInsert(executeWithReusedStatement, batch);
          } catch {
            /* some may fail if node was removed, that's fine */
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
        options.embeddingsNodeLimit,
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

    if (!embeddingSkipped) {
      const { isHttpMode } = await import('./embeddings/http-client.js');
      const httpMode = isHttpMode();
      progress(
        'embeddings',
        90,
        httpMode ? 'Connecting to embedding endpoint...' : 'Loading embedding model...',
      );
      const { runEmbeddingPipeline } = await import('./embeddings/embedding-pipeline.js');
      // Build a Map<nodeId, contentHash> from cached embeddings for incremental mode
      let existingEmbeddings: Map<string, string> | undefined;
      if (cachedEmbeddingNodeIds.size > 0) {
        existingEmbeddings = new Map<string, string>();
        for (const e of cachedEmbeddings) {
          existingEmbeddings.set(e.nodeId, e.contentHash ?? STALE_HASH_SENTINEL);
        }
      }

      const { readServerMapping } = await import('./embeddings/server-mapping.js');
      // Mirror the registry's name-resolution chain so the server-mapping
      // lookup key stays aligned with the final registry name (#1259):
      //   --name → remote-derived → canonical-root basename
      // (preserved-alias is intentionally NOT consulted here — server
      // mappings are addressed by the operationally-meaningful name the
      // user configures, not by a sticky registry-only alias they may not
      // know about. The previous canonical-only logic ignored both --name
      // and remote-derived names, silently breaking server-mapping for
      // anyone with a `--name` alias or remote-named repo.)
      const projectName =
        options.registryName ??
        getInferredRepoName(repoPath) ??
        path.basename(resolveRepoIdentityRoot(repoPath));
      const serverName = await readServerMapping(projectName);
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
        { repoName: projectName, serverName },
        existingEmbeddings,
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
    const effectiveSemanticMode =
      semanticMode ??
      (runtimeCapabilities.semanticMode === 'vector-index' ? 'vector-index' : 'exact-scan');

    // Convert the post-run file-hash map to the on-disk Record<string,string>
    // shape consumed by RepoMeta.fileHashes.
    const newFileHashesRecord: Record<string, string> = {};
    for (const [k, v] of newFileHashes) newFileHashesRecord[k] = v;

    const meta = {
      repoPath,
      lastCommit: currentCommit,
      indexedAt: new Date().toISOString(),
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
        fts: { provider: 'ladybugdb-fts', status: runtimeCapabilities.fts },
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
      fileHashes: hasGitDir(repoPath) ? newFileHashesRecord : undefined,
      incrementalInProgress: undefined as { startedAt: number; toWriteCount: number } | undefined,
    };
    await saveMeta(storagePath, meta);

    // Persist the incremental parse cache for the next run. Wraps in
    // try/catch so a cache-write failure never breaks an otherwise
    // successful indexing run. Prune stale chunk-hash entries first so
    // the cache file size stays bounded across runs (chunks whose
    // composition no longer matches anything in the current scan are
    // dead weight; the parse phase populates `usedKeys` as it processes
    // chunks).
    try {
      const pruned = pruneCache(parseCache, parseCache.usedKeys);
      if (pruned > 0) {
        log(`Parse cache: pruned ${pruned} stale chunk entries`);
      }
      await saveParseCache(storagePath, parseCache);
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
    });

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
        },
      );
    } catch {
      // Best-effort — don't fail the entire analysis for context file issues
    }

    // ── Close LadybugDB ──────────────────────────────────────────────
    await closeLbug();

    progress('done', 100, 'Done');

    return {
      repoName: projectName,
      repoPath,
      stats: meta.stats,
      pipelineResult,
    };
  } catch (err) {
    // Ensure LadybugDB is closed even on error
    try {
      await closeLbug();
    } catch {
      /* swallow */
    }
    throw err;
  }
}
