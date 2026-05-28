/**
 * Parse implementation — chunked parse + resolve loop.
 *
 * This is the core parsing engine of the ingestion pipeline. It reads
 * source files in byte-budget chunks (~20MB each), parses via worker
 * pool (or sequential fallback), resolves imports/calls/heritage per
 * chunk, and synthesizes wildcard import bindings.
 *
 * Consumed by the parse phase (`parse.ts`) — the phase file handles
 * dependency wiring while the heavy implementation lives here.
 *
 * @module
 */

import {
  BindingAccumulator,
  enrichExportedTypeMap,
  type BindingEntry,
} from '../binding-accumulator.js';
import { processParsing, mergeChunkResults } from '../parsing-processor.js';
import { fileContentHash, computeChunkHash } from '../../../storage/parse-cache.js';
import type { ParseWorkerResult } from '../workers/parse-worker.js';
import type { WorkerExtractedData } from '../parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext,
} from '../import-processor.js';
import { EMPTY_INDEX } from '../import-resolvers/utils.js';
import {
  processCalls,
  processCallsFromExtracted,
  processAssignmentsFromExtracted,
  processRoutesFromExtracted,
  seedCrossFileReceiverTypes,
  buildExportedTypeMapFromGraph,
  type ExportedTypeMap,
} from '../call-processor.js';
import { buildHeritageMap } from '../model/heritage-map.js';
import {
  processHeritage,
  processHeritageFromExtracted,
  extractExtractedHeritageFromFiles,
  getHeritageStrategyForLanguage,
} from '../heritage-processor.js';
import { createResolutionContext } from '../model/resolution-context.js';
import { ASTCache, createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { isRegistryPrimary } from '../registry-primary-flag.js';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPoolInitializationError } from '../workers/worker-pool.js';
import type { WorkerPool } from '../workers/worker-pool.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedImport,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
  FetchWrapperDef,
} from '../workers/parse-worker.js';
import type { ExtractedHeritage } from '../model/heritage-map.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { PipelineOptions } from '../pipeline.js';
import { extractFetchCallsFromFiles } from '../call-processor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isDev } from '../utils/env.js';
import { isVerboseIngestionEnabled } from '../utils/verbose.js';
import {
  endTimer,
  isDeferredResolutionProfileEnabled,
  logDeferredProfile,
  startTimer,
} from '../utils/deferred-resolution-profile.js';
import { synthesizeWildcardImportBindings, needsSynthesis } from './wildcard-synthesis.js';
import { extractORMQueriesInline } from './orm-extraction.js';

import { logger } from '../../logger.js';
// ── Constants ──────────────────────────────────────────────────────────────

/** Max bytes of source content to load per parse chunk.
 *
 * Memory bound for the worker pool dispatch + a granularity knob for
 * the parse cache. A single file change invalidates only its enclosing
 * chunk, so smaller budgets → finer-grained invalidation.
 *
 * Override via GITNEXUS_CHUNK_BYTE_BUDGET (bytes) — the default of 2MB
 * gives a useful invalidation floor (~1/N chunks on a multi-MB repo)
 * while keeping worker dispatch overhead under 5% on cold runs.
 */
/**
 * Built-in chunk byte budget when neither `PipelineOptions.chunkByteBudget`
 * nor `GITNEXUS_CHUNK_BYTE_BUDGET` is set. Tuned to give a useful
 * cache-invalidation floor (~1/N chunks on a multi-MB repo) while keeping
 * worker dispatch overhead under 5% on cold runs. Resolution happens at
 * call time inside `runChunkedParseAndResolve` (U14 from PR #1693 review)
 * — previously this was a module-load IIFE, which froze the env value at
 * import time and meant per-call option threading silently no-op'd.
 */
const DEFAULT_CHUNK_BYTE_BUDGET = 2 * 1024 * 1024;

function resolveChunkByteBudget(options?: PipelineOptions): number {
  const opt = options?.chunkByteBudget;
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return opt;
  const env = Number(process.env.GITNEXUS_CHUNK_BYTE_BUDGET);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_CHUNK_BYTE_BUDGET;
}

// ── Main parse + resolve function ──────────────────────────────────────────

type ScannedFile = { path: string; size: number };
type ProgressFn = (progress: PipelineProgress) => void;

/**
 * Chunked parse + resolve loop.
 *
 * Reads source in byte-budget chunks (~20MB each). For each chunk:
 * 1. Parse via worker pool (or sequential fallback)
 * 2. Resolve imports from extracted data
 * 3. Synthesize wildcard import bindings (Go/Ruby/C++/Swift/Python)
 * 4. Resolve heritage + routes per chunk; defer worker CALLS until all chunks
 *    have contributed heritage so interface-dispatch implementor map is complete
 * 5. Collect TypeEnv bindings for cross-file propagation
 */
export async function runChunkedParseAndResolve(
  graph: KnowledgeGraph,
  scannedFiles: ScannedFile[],
  allPaths: string[],
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: ProgressFn,
  options?: PipelineOptions,
): Promise<{
  exportedTypeMap: ExportedTypeMap;
  allFetchCalls: ExtractedFetchCall[];
  allFetchWrapperDefs: FetchWrapperDef[];
  allExtractedRoutes: ExtractedRoute[];
  allDecoratorRoutes: ExtractedDecoratorRoute[];
  allToolDefs: ExtractedToolDef[];
  allORMQueries: ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  resolutionContext: ReturnType<typeof createResolutionContext>;
  usedWorkerPool: boolean;
  /** Cross-phase tree-sitter Tree cache populated by the sequential
   *  parse path. Distinct from the chunk-local `astCache` used inside
   *  the parse loop (that one is cleared between chunks). Empty when
   *  every chunk ran via the worker pool (workers can't return native
   *  tree-sitter Trees across the MessageChannel). Downstream phases
   *  (scope-resolution) read from this to skip re-parsing the same
   *  source. See plan
   *  docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 4). */
  scopeTreeCache: ASTCache;
  /** Worker-produced ParsedFile artifacts aggregated across chunks.
   *  Threaded into scope-resolution as a re-extract cache so the warm-
   *  cache analyze run can skip the dominant `extractParsedFile` cost
   *  (otherwise ~58s on a 1000-file repo). */
  parsedFiles: import('gitnexus-shared').ParsedFile[];
}> {
  const ctx = createResolutionContext();
  const symbolTable = ctx.model.symbols;

  const parseableScanned = scannedFiles.filter((f) => {
    const lang = getLanguageFromFilename(f.path);
    return lang && isLanguageAvailable(lang);
  });

  // Warn about files skipped due to unavailable parsers
  const skippedByLang = new Map<string, number>();
  for (const f of scannedFiles) {
    const lang = getLanguageFromFilename(f.path);
    if (lang && !isLanguageAvailable(lang)) {
      skippedByLang.set(lang, (skippedByLang.get(lang) || 0) + 1);
    }
  }
  for (const [lang, count] of skippedByLang) {
    logger.warn(
      `Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`,
    );
  }

  // Sort parseableScanned alphabetically for stable chunk membership
  // across runs (Finding 4). Without this, filesystem-scan order can
  // shift between runs (notably on macOS APFS where directory entry
  // order can change after modifications) — different files in the
  // same chunk → different chunk hash → cache miss even when no file
  // content changed. The cache also becomes platform-specific: a
  // Linux-built cache misses on macOS for the same repo.
  parseableScanned.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalParseable = parseableScanned.length;

  if (totalParseable === 0) {
    onProgress({
      phase: 'parsing',
      // Skip directly to the end of the parse-phase progress band (M2 from PR
      // #1693 review). Parse 20-70%, deferred 70-95%; nothing in either runs
      // when there's no parseable file, so jump to 95.
      percent: 95,
      message: 'No parseable files found — skipping parsing phase',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
    });
  }

  // Build byte-budget chunks. The budget is resolved per-call (U14): options
  // first, then env, then the built-in default. Pre-U14 this was a
  // module-load IIFE constant, which froze the env value at import time
  // and made `PipelineOptions.chunkByteBudget` silently no-op on warm test
  // runs. Resolving in the function body restores per-call configurability
  // and matches the pattern used by resolveAutoPoolSize and the U1
  // parseChunkConcurrency resolver.
  const chunkByteBudget = resolveChunkByteBudget(options);
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;
  for (const file of parseableScanned) {
    if (currentChunk.length > 0 && currentBytes + file.size > chunkByteBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(file.path);
    currentBytes += file.size;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  const numChunks = chunks.length;

  if (isDev) {
    const totalMB = parseableScanned.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
    logger.info(
      `📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${chunkByteBudget / (1024 * 1024)}MB budget`,
    );
  }

  // Skip the "Parsing N files..." announcement when there's nothing to parse
  // — the early-return branch above already emitted percent 95 ("skipping
  // parsing phase"), and emitting percent 20 here would regress the
  // progress stream non-monotonically (M2 from PR #1693 review).
  if (totalParseable > 0) {
    onProgress({
      phase: 'parsing',
      percent: 20,
      message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
      stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
    });
  }

  // Don't spawn workers for tiny repos — overhead exceeds benefit.
  // Test suites may lower the thresholds via `options.workerThresholdsForTest`
  // to exercise the worker-pool path with small fixtures; see PipelineOptions.
  const MIN_FILES_FOR_WORKERS = options?.workerThresholdsForTest?.minFiles ?? 15;
  const MIN_BYTES_FOR_WORKERS = options?.workerThresholdsForTest?.minBytes ?? 512 * 1024;
  const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);

  // Create worker pool lazily, reuse across cache-miss chunks.
  //
  // `workerPoolSize === 0` is a programmatic equivalent of `skipWorkers:
  // true` per the `PipelineOptions.workerPoolSize` contract. Short-
  // circuiting here avoids constructing a useless pool. The pool is
  // intentionally NOT created before parse-cache lookup: a warm-cache
  // all-hit run should replay cached worker output without loading
  // parse-worker.js or any tree-sitter/N-API native bindings.
  const shouldUseWorkers =
    !options?.skipWorkers &&
    options?.workerPoolSize !== 0 &&
    (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS);
  let workerPool: WorkerPool | undefined;
  let workerPoolDisabled = false;
  const getOrCreateWorkerPool = (): WorkerPool | undefined => {
    if (!shouldUseWorkers || workerPoolDisabled) return undefined;
    if (workerPool) return workerPool;
    try {
      // U20.U3 test-only injection: integration tests pass a custom
      // worker script URL via `workerUrlForTest` (mirrors the
      // `workerThresholdsForTest` precedent) so they can drive the
      // chunk-loop with deterministically-misbehaving workers without
      // mocking the module import graph. When unset, the normal src/
      // → dist/ resolution runs.
      let workerUrl =
        options?.workerUrlForTest ?? new URL('../workers/parse-worker.js', import.meta.url);
      // When running under vitest, import.meta.url points to src/ where no .js exists.
      // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
      const thisDir = fileURLToPath(new URL('.', import.meta.url));
      if (!options?.workerUrlForTest && !fs.existsSync(fileURLToPath(workerUrl))) {
        const distWorker = path.resolve(
          thisDir,
          '..',
          '..',
          '..',
          '..',
          'dist',
          'core',
          'ingestion',
          'workers',
          'parse-worker.js',
        );
        if (fs.existsSync(distWorker)) {
          workerUrl = pathToFileURL(distWorker);
        }
      }
      workerPool = createWorkerPool(workerUrl, options?.workerPoolSize);
      return workerPool;
    } catch (err) {
      workerPoolDisabled = true;
      logger.warn(
        { err: (err as Error).message },
        'Worker pool creation failed, using sequential fallback:',
      );
      return undefined;
    }
  };

  let filesParsedSoFar = 0;

  // Two caches with different lifetimes:
  //   - `astCache` (chunk-local, cleared between chunks) — call /
  //     heritage / import processors read it during parse to avoid
  //     re-parsing within the same chunk.
  //   - `scopeTreeCache` (total-parseable-sized, never cleared by
  //     parse-impl) — exposed via ParseOutput so scope-resolution can
  //     skip a second tree-sitter parse. Worker-mode parses don't
  //     populate either; consumers fall back to a fresh parse.
  // See plan docs/plans/2026-04-20-002-perf-parse-heritage-mro-plan.md (Unit 4).
  const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
  let astCache = createASTCache(maxChunkFiles);
  const scopeTreeCache = createASTCache(Math.max(parseableScanned.length, 1));

  // Build import resolution context once — suffix index, file lists, resolve cache.
  const importCtx = buildImportResolutionContext(allPaths);
  const allPathObjects = allPaths.map((p) => ({ path: p }));

  const sequentialChunkPaths: string[][] = [];
  const chunkNeedsSynthesis = chunks.map((paths) =>
    paths.some((p) => {
      const lang = getLanguageFromFilename(p);
      return lang != null && needsSynthesis(lang);
    }),
  );
  const exportedTypeMap: ExportedTypeMap = new Map();
  const bindingAccumulator = new BindingAccumulator();
  // Tracks whether per-chunk or fallback wildcard-binding synthesis already
  // ran, so the unconditional final call below can be skipped when redundant.
  // synthesizeWildcardImportBindings is graph-global; once any chunk runs it
  // after parsing wildcard files, later non-wildcard chunks add no work for
  // it, and later wildcard chunks re-run it themselves.
  let hasSynthesized = false;
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allFetchWrapperDefs: FetchWrapperDef[] = [];
  const allExtractedRoutes: ExtractedRoute[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const deferredWorkerCalls: ExtractedCall[] = [];
  const deferredWorkerHeritage: ExtractedHeritage[] = [];
  const deferredConstructorBindings: FileConstructorBindings[] = [];
  const deferredAssignments: ExtractedAssignment[] = [];
  // Imports accumulated across chunks. Previously processed per-chunk
  // via `processImportsFromExtracted` inside the chunk loop, which
  // forced workers to sit idle on the main thread's extraction pass
  // between chunk dispatches (4-5% CPU utilization symptom). Deferring
  // to a single end-of-loop pass lets the worker pool start chunk N+1
  // immediately after chunk N's worker dispatch returns. Resolution is
  // strictly-more-information at end-of-loop because graph now has
  // every chunk's symbols — improves cross-chunk import targets.
  const deferredWorkerImports: ExtractedImport[] = [];
  let anyChunkNeedsWildcardSynth = false;
  // Aggregated per-file ParsedFile artifacts produced by workers' calls
  // to `extractParsedFile`. Threaded through to the scope-resolution
  // phase so it can SKIP its own re-extraction on cache hits — this is
  // the second-half of the parse-cache speedup since scope-resolution's
  // re-parse otherwise dominates the warm-cache wall-clock time.
  const allParsedFiles: import('gitnexus-shared').ParsedFile[] = [];

  // Incremental parse cache (Option B): chunk-level content-addressed.
  // When the chunk's (filePath, content-hash) signature matches a prior
  // run's, replay the cached ParseWorkerResult[] instead of dispatching
  // to workers. See gitnexus/src/storage/parse-cache.ts.
  const parseCache = options?.parseCache;
  let chunkCacheHits = 0;
  let chunkCacheMisses = 0;

  try {
    // U1 — bounded chunk concurrency (B1 from PR #1693 review): pre-fetch
    // chunk file contents up to `parseChunkConcurrency` chunks ahead of the
    // dispatch cursor so file I/O overlaps with worker compute. Worker
    // dispatch itself stays serial because `WorkerPool.dispatch` is not
    // reentrant (concurrent calls would race on the shared per-slot
    // busy/in-flight state). With concurrency=1 behavior is identical to
    // the pure-serial loop. F4: deferred-state aggregation still happens
    // in chunkIdx order (the for-loop below iterates sequentially), so
    // cross-chunk processors see deterministic input regardless of
    // file-read completion order. Honors options.parseChunkConcurrency
    // (threaded from the CLI), then GITNEXUS_PARSE_CHUNK_CONCURRENCY env
    // (default 2 — matches the help text the CLI advertises).
    const parseChunkConcurrency = ((): number => {
      const opt = options?.parseChunkConcurrency;
      if (typeof opt === 'number' && Number.isInteger(opt) && opt >= 1) return opt;
      const env = Number(process.env.GITNEXUS_PARSE_CHUNK_CONCURRENCY);
      if (Number.isInteger(env) && env >= 1) return env;
      return 2;
    })();
    const chunkContentPromises = new Array<Promise<Map<string, string>> | undefined>(numChunks);
    const startChunkPrefetch = (i: number): void => {
      if (i >= numChunks || chunkContentPromises[i] !== undefined) return;
      chunkContentPromises[i] = readFileContents(repoPath, chunks[i]);
    };
    for (let i = 0; i < Math.min(parseChunkConcurrency, numChunks); i++) {
      startChunkPrefetch(i);
    }

    // Hoisted loop-invariant: GITNEXUS_VERBOSE / NODE_ENV are read once
    // (not on every chunk). Previously evaluated at the top of the loop
    // body, which re-read process.env on every iteration even though
    // the env can't change mid-run.
    const verboseThroughputLog = isDev || isVerboseIngestionEnabled();

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkPaths = chunks[chunkIdx];
      // Start wall-clock for the per-chunk throughput log emitted at end
      // of this iteration. The gate is computed once above; here we just
      // sample the clock if the gate is on. Computed when either
      // NODE_ENV=development OR the operator passed `--verbose`
      // (GITNEXUS_VERBOSE) — the previous `isDev`-only gate meant
      // operators running `gitnexus analyze --verbose` in production
      // never saw the log (M3 from PR #1693 review).
      const chunkStartMs: number | null = verboseThroughputLog ? Date.now() : null;

      const chunkContentPromise = chunkContentPromises[chunkIdx];
      if (!chunkContentPromise) {
        throw new Error(`Missing prefetched parse chunk ${chunkIdx + 1}/${numChunks}`);
      }
      const chunkContents = await chunkContentPromise;
      chunkContentPromises[chunkIdx] = undefined; // release the in-memory copy
      startChunkPrefetch(chunkIdx + parseChunkConcurrency);
      const chunkFiles: Array<{ path: string; content: string }> = [];
      for (const p of chunkPaths) {
        const content = chunkContents.get(p);
        if (content !== undefined) chunkFiles.push({ path: p, content });
      }

      // Compute the chunk's content-hash signature (if cache available).
      let chunkHash: string | null = null;
      if (parseCache) {
        const entries = chunkFiles.map((f) => ({
          filePath: f.path,
          contentHash: fileContentHash(f.content),
        }));
        chunkHash = computeChunkHash(entries);
      }

      let chunkWorkerData: WorkerExtractedData | null;
      const cachedRaw = chunkHash && parseCache ? parseCache.entries.get(chunkHash) : undefined;

      // Track every chunk hash we touched so the orchestrator can
      // prune stale entries (chunks whose composition no longer
      // corresponds to a live chunk in the current scan) before saving.
      if (parseCache && chunkHash) parseCache.usedKeys.add(chunkHash);

      if (cachedRaw && cachedRaw.length > 0) {
        // Cache hit: replay the cached worker output through the same
        // merge logic the live worker path uses.
        chunkCacheHits++;
        chunkWorkerData = mergeChunkResults(graph, symbolTable, cachedRaw);
        if (isDev) {
          logger.info(
            `📦 parse-cache HIT: chunk ${chunkIdx + 1}/${numChunks} (${chunkFiles.length} files, ${chunkHash?.slice(0, 8) ?? 'unknown'})`,
          );
        }
        // Progress update so UI advances even on a cache hit.
        const cachedFiles = chunkFiles.length;
        onProgress({
          phase: 'parsing',
          // Parse phase covers 20-70 (50 points). Deferred extraction below
          // takes 70-95 so the UI advances through the (potentially long)
          // resolution stages instead of holding at 82 (M2 from PR #1693
          // review).
          percent: Math.round(20 + ((filesParsedSoFar + cachedFiles) / totalParseable) * 50),
          message: `Parsing chunk ${chunkIdx + 1}/${numChunks} (cache)...`,
          stats: {
            filesProcessed: filesParsedSoFar + cachedFiles,
            totalFiles: totalParseable,
            nodesCreated: graph.nodeCount,
          },
        });
      } else {
        // Cache miss: dispatch to workers, capture the raw results, store
        // them under the chunk hash for the next run.
        chunkCacheMisses++;
        const rawResults: ParseWorkerResult[] = [];
        const progressForChunk = (current: number, _total: number, filePath: string) => {
          const globalCurrent = filesParsedSoFar + current;
          // Parse phase covers 20-70 (M2). Deferred extraction handles 70-95.
          const parsingProgress = 20 + (globalCurrent / totalParseable) * 50;
          onProgress({
            phase: 'parsing',
            percent: Math.round(parsingProgress),
            message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
            detail: filePath,
            stats: {
              filesProcessed: globalCurrent,
              totalFiles: totalParseable,
              nodesCreated: graph.nodeCount,
            },
          });
        };
        const activeWorkerPool = getOrCreateWorkerPool();
        try {
          chunkWorkerData = await processParsing(
            graph,
            chunkFiles,
            symbolTable,
            astCache,
            scopeTreeCache,
            progressForChunk,
            activeWorkerPool,
            // Capture raw results only when we have a cache to write to —
            // otherwise we'd retain extra arrays for nothing.
            parseCache && chunkHash && activeWorkerPool ? rawResults : undefined,
          );
        } catch (err) {
          if (!(err instanceof WorkerPoolInitializationError)) throw err;
          logger.warn(
            {
              err: err.message,
              readinessFailures: err.readinessFailures,
            },
            'Worker pool initialization failed, using sequential fallback:',
          );
          rawResults.length = 0;
          workerPoolDisabled = true;
          const failedPool = workerPool;
          workerPool = undefined;
          await failedPool?.terminate().catch(() => undefined);
          chunkWorkerData = await processParsing(
            graph,
            chunkFiles,
            symbolTable,
            astCache,
            scopeTreeCache,
            progressForChunk,
            undefined,
            undefined,
          );
        }
        // Persist the raw results for this chunk hash. Sequential path
        // doesn't populate rawResults (it writes directly to graph), so
        // small repos without worker pool simply don't cache. That's fine.
        //
        // U20.U2: refuse the write when any chunk file is in the
        // worker pool's cumulative quarantine snapshot. The chunkHash
        // is computed from EVERY file in the chunk, but the pool's
        // Layer 3 quarantine filters quarantined files out of dispatch
        // — so `rawResults` is narrower than the chunkHash key implies.
        // Caching it would silently replay incomplete results on the
        // next run with unchanged content (the corruption class Codex's
        // adversarial review of PR #1693 flagged).
        //
        // Skipping the write means the next analyze gets a cache miss
        // for this chunk and re-dispatches against a fresh worker pool
        // (quarantine is session-scoped — `createQuarantine` is called
        // per-pool at worker-pool.ts), giving the quarantined file
        // another chance. If quarantine fires again, U20.U1's
        // sequential gap-fill still produces a complete graph for this
        // run; the cache just stays empty for this chunk until a fully-
        // clean dispatch lands.
        if (parseCache && chunkHash && rawResults.length > 0) {
          const quarantineSnapshot = workerPool?.getQuarantinedPaths?.() ?? [];
          const quarantineSet = new Set(quarantineSnapshot);
          const chunkHadQuarantine = chunkFiles.some((f) => quarantineSet.has(f.path));
          if (chunkHadQuarantine) {
            if (isDev) {
              const quarantinedInChunk = chunkFiles.filter((f) => quarantineSet.has(f.path)).length;
              logger.info(
                `📦 parse-cache SKIP: chunk ${chunkIdx + 1}/${numChunks} ` +
                  `had ${quarantinedInChunk} worker-quarantined file(s); ` +
                  `next run will rediscover (${chunkHash.slice(0, 8)})`,
              );
            }
          } else {
            parseCache.entries.set(chunkHash, rawResults);
            if (isDev) {
              logger.info(
                `📦 parse-cache MISS+store: chunk ${chunkIdx + 1}/${numChunks} (${chunkFiles.length} files, ${chunkHash.slice(0, 8)})`,
              );
            }
          }
        }
      }

      // Per-chunk extraction passes (processImportsFromExtracted,
      // processHeritageFromExtracted, processRoutesFromExtracted,
      // synthesizeWildcardImportBindings, seedCrossFileReceiverTypes)
      // moved out of the chunk loop into a single end-of-loop pass below.
      // Reason: per-chunk extraction blocked the chunk loop on
      // main-thread work between worker dispatches — workers sat idle
      // and total CPU utilization plateaued at 4-5% on multi-core boxes.
      // Deferring keeps workers busy chunk-after-chunk; resolution sees
      // strictly-more-information (full repo graph) so cross-chunk import
      // and heritage targets resolve at least as well as before.
      if (chunkWorkerData) {
        if (chunkNeedsSynthesis[chunkIdx]) {
          anyChunkNeedsWildcardSynth = true;
        }
        const skipFile = new Set<string>();
        const checkFile = new Set<string>();
        const shouldAccumulate = (filePath: string): boolean => {
          if (checkFile.has(filePath)) return true;
          if (skipFile.has(filePath)) return false;
          const lang = getLanguageFromFilename(filePath);
          if (lang !== null && isRegistryPrimary(lang)) {
            skipFile.add(filePath);
            return false;
          }
          checkFile.add(filePath);
          return true;
        };
        for (const item of chunkWorkerData.imports) {
          if (shouldAccumulate(item.filePath)) deferredWorkerImports.push(item);
        }
        for (const item of chunkWorkerData.calls) {
          if (shouldAccumulate(item.filePath)) deferredWorkerCalls.push(item);
        }
        for (const item of chunkWorkerData.heritage) {
          if (shouldAccumulate(item.filePath)) deferredWorkerHeritage.push(item);
        }
        for (const item of chunkWorkerData.constructorBindings) {
          if (shouldAccumulate(item.filePath)) deferredConstructorBindings.push(item);
        }
        // Aggregate worker-produced ParsedFile artifacts so scope-
        // resolution can use them as a re-extraction cache (skips its
        // own tree-sitter re-parse on warm runs).
        if (chunkWorkerData.parsedFiles?.length) {
          for (const item of chunkWorkerData.parsedFiles) allParsedFiles.push(item);
        }
        if (chunkWorkerData.assignments?.length) {
          for (const item of chunkWorkerData.assignments) {
            if (shouldAccumulate(item.filePath)) deferredAssignments.push(item);
          }
        }

        if (chunkWorkerData.fileScopeBindings?.length) {
          for (const { filePath, bindings } of chunkWorkerData.fileScopeBindings) {
            if (typeof filePath !== 'string' || filePath.length === 0) continue;
            if (!Array.isArray(bindings)) continue;
            const entries: BindingEntry[] = [];
            for (const tuple of bindings) {
              if (!Array.isArray(tuple) || tuple.length !== 2) continue;
              const [varName, typeName] = tuple;
              if (typeof varName !== 'string' || typeof typeName !== 'string') continue;
              entries.push({ scope: '', varName, typeName });
            }
            if (entries.length > 0) {
              bindingAccumulator.appendFile(filePath, entries);
            }
          }
        }
        if (chunkWorkerData.fetchCalls?.length) {
          for (const item of chunkWorkerData.fetchCalls) allFetchCalls.push(item);
        }
        if (chunkWorkerData.fetchWrapperDefs?.length) {
          for (const item of chunkWorkerData.fetchWrapperDefs) allFetchWrapperDefs.push(item);
        }
        if (chunkWorkerData.routes?.length) {
          for (const item of chunkWorkerData.routes) allExtractedRoutes.push(item);
        }
        if (chunkWorkerData.decoratorRoutes?.length) {
          for (const item of chunkWorkerData.decoratorRoutes) allDecoratorRoutes.push(item);
        }
        if (chunkWorkerData.toolDefs?.length) {
          for (const item of chunkWorkerData.toolDefs) allToolDefs.push(item);
        }
        if (chunkWorkerData.ormQueries?.length) {
          for (const item of chunkWorkerData.ormQueries) allORMQueries.push(item);
        }
      } else {
        await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths);
        sequentialChunkPaths.push(chunkPaths);
      }

      filesParsedSoFar += chunkFiles.length;
      astCache.clear();

      // Throughput observability (U3): emit a per-chunk metrics line
      // under verbose ingestion mode so operators can verify CPU
      // utilization moved + tune `--workers` / batch sizes without
      // guessing. Cheap snapshot — just reads pool closure state.
      if (verboseThroughputLog && chunkStartMs !== null) {
        const elapsedMs = Date.now() - chunkStartMs;
        const filesPerSec = elapsedMs > 0 ? (chunkFiles.length * 1000) / elapsedMs : 0;
        const stats = workerPool?.getStats?.();
        const poolFrag = stats
          ? ` pool: ${stats.activeSlots}/${stats.size} active, ` +
            `${stats.quarantined} quarantined${stats.poolBroken ? ', BROKEN' : ''}`
          : ' (sequential)';
        logger.info(
          `📊 chunk ${chunkIdx + 1}/${numChunks}: ${chunkFiles.length} files in ${elapsedMs}ms ` +
            `(${filesPerSec.toFixed(1)} files/s)${poolFrag}`,
        );
      }
    }

    if (isDev && parseCache && (chunkCacheHits > 0 || chunkCacheMisses > 0)) {
      logger.info(
        `📦 parse-cache summary: ${chunkCacheHits} chunk hit(s), ${chunkCacheMisses} miss(es) across ${numChunks} chunk(s)`,
      );
    }

    // Deferred end-of-loop extraction (moved out of the per-chunk block):
    //   1. processImportsFromExtracted on all chunks' imports
    //   2. synthesizeWildcardImportBindings (if any chunk had wildcards)
    //   3. seedCrossFileReceiverTypes on deferred calls (depends on
    //      namedImportMap populated by step 1)
    //   4. processHeritageFromExtracted on all chunks' heritage
    //   5. processRoutesFromExtracted on all chunks' routes
    // Same logic as the prior per-chunk passes, just batched — resolution
    // sees the full repo graph instead of just current-and-earlier chunks.
    // Deferred extraction band (M2 from PR #1693 review): the 4 stages below
    // each get their own 5-10 point slice of the 70-95 range so percent
    // advances monotonically through the (potentially long) resolution work
    // instead of holding flat at 82. Stages that are skipped (zero-length
    // input) leave their band as a no-op jump — the next stage still starts
    // at its own band, preserving monotonicity.
    //   imports:  70 -> 75 (5)
    //   heritage: 75 -> 80 (5)
    //   routes:   80 -> 85 (5)
    //   calls:    85 -> 95 (10)
    const deferredProfile = isDeferredResolutionProfileEnabled();
    if (deferredProfile) {
      logDeferredProfile(
        `deferred band start: imports=${deferredWorkerImports.length} heritage=${deferredWorkerHeritage.length} ` +
          `calls=${deferredWorkerCalls.length} routes=${allExtractedRoutes.length}`,
      );
    }
    if (deferredWorkerImports.length > 0) {
      const tImports = startTimer(deferredProfile);
      await processImportsFromExtracted(
        graph,
        allPathObjects,
        deferredWorkerImports,
        ctx,
        (current, total) => {
          const ratio = total > 0 ? current / total : 1;
          onProgress({
            phase: 'parsing',
            percent: 70 + Math.round(ratio * 5),
            message: 'Resolving imports (all chunks)...',
            detail: `${current}/${total} files`,
            stats: {
              filesProcessed: filesParsedSoFar,
              totalFiles: totalParseable,
              nodesCreated: graph.nodeCount,
            },
          });
        },
        repoPath,
        importCtx,
      );
      endTimer(
        tImports,
        (ms) =>
          `processImportsFromExtracted: ${ms.toFixed(0)}ms (${deferredWorkerImports.length} import batches before drain)`,
      );
      // U15 (lightweight M1): processImportsFromExtracted is the sole
      // consumer of `deferredWorkerImports`. Free the array now so the
      // GC can reclaim the per-file ExtractedImport records before the
      // heavier downstream stages run (heritage, routes, calls). Peak
      // accumulator memory drops from O(repo) to O(repo - imports) for
      // the remainder of the deferred phase. The future per-chunk
      // streaming upgrade can rewrite this with the same correctness
      // contract once profile data shows it's warranted.
      deferredWorkerImports.length = 0;
    }
    if (anyChunkNeedsWildcardSynth) {
      const tWildcard = startTimer(deferredProfile);
      synthesizeWildcardImportBindings(graph, ctx);
      hasSynthesized = true;
      endTimer(tWildcard, (ms) => `synthesizeWildcardImportBindings: ${ms.toFixed(0)}ms`);
    }
    // L5 from PR #1693 review: populate `exportedTypeMap` from the in-progress
    // graph BEFORE `seedCrossFileReceiverTypes` runs. Previously the seeding
    // branch below was reached with `exportedTypeMap.size === 0` in the
    // worker path (the map was only built at the post-parse block far below,
    // AFTER the seeding branch), so the seed dead-coded itself silently and
    // call resolution never got the cross-file receiver-type enrichment.
    // The post-parse builder still runs as a defensive fallback on the
    // sequential path; its `size === 0` guard means we don't pay the cost
    // twice on the worker path.
    if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
      const graphExports = buildExportedTypeMapFromGraph(graph, ctx.model.symbols);
      for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
    }
    if (exportedTypeMap.size > 0 && ctx.namedImportMap.size > 0 && deferredWorkerCalls.length > 0) {
      const { enrichedCount } = seedCrossFileReceiverTypes(
        deferredWorkerCalls,
        ctx.namedImportMap,
        exportedTypeMap,
      );
      if (enrichedCount > 0) {
        // Two independent gates, not else-if: when both isDev AND
        // deferredProfile are active, BOTH lines fire — log scrapers keyed
        // on the original "🔗 E1" emoji marker keep matching, AND operators
        // grepping the [deferred-profile] prefix see no gap between the
        // wildcard-synth and heritage timings.
        if (isDev) {
          logger.info(`🔗 E1: Seeded ${enrichedCount} cross-file receiver types (all chunks)`);
        }
        if (deferredProfile) {
          logDeferredProfile(`E1: seeded ${enrichedCount} cross-file receiver types (all chunks)`);
        }
      }
    }
    if (deferredWorkerHeritage.length > 0) {
      const tHeritage = startTimer(deferredProfile);
      await processHeritageFromExtracted(graph, deferredWorkerHeritage, ctx, (current, total) => {
        const ratio = total > 0 ? current / total : 1;
        onProgress({
          phase: 'parsing',
          percent: 75 + Math.round(ratio * 5),
          message: 'Resolving heritage (all chunks)...',
          detail: `${current}/${total} records`,
          stats: {
            filesProcessed: filesParsedSoFar,
            totalFiles: totalParseable,
            nodesCreated: graph.nodeCount,
          },
        });
      });
      endTimer(
        tHeritage,
        (ms) =>
          `processHeritageFromExtracted: ${ms.toFixed(0)}ms (${deferredWorkerHeritage.length} records)`,
      );
    }
    if (allExtractedRoutes.length > 0) {
      const tRoutes = startTimer(deferredProfile);
      await processRoutesFromExtracted(graph, allExtractedRoutes, ctx, (current, total) => {
        const ratio = total > 0 ? current / total : 1;
        onProgress({
          phase: 'parsing',
          percent: 80 + Math.round(ratio * 5),
          message: 'Resolving routes (all chunks)...',
          detail: `${current}/${total} routes`,
          stats: {
            filesProcessed: filesParsedSoFar,
            totalFiles: totalParseable,
            nodesCreated: graph.nodeCount,
          },
        });
      });
      endTimer(
        tRoutes,
        (ms) =>
          `processRoutesFromExtracted: ${ms.toFixed(0)}ms (${allExtractedRoutes.length} routes)`,
      );
    }

    let fullWorkerHeritageMap: ReturnType<typeof buildHeritageMap> | undefined;
    if (deferredWorkerHeritage.length > 0) {
      const tBuildHeritage = startTimer(deferredProfile);
      fullWorkerHeritageMap = buildHeritageMap(
        deferredWorkerHeritage,
        ctx,
        getHeritageStrategyForLanguage,
      );
      endTimer(tBuildHeritage, (ms) => `buildHeritageMap wall: ${ms.toFixed(0)}ms`);
    } else if (deferredProfile) {
      logDeferredProfile('buildHeritageMap: skipped (no heritage records)');
    }
    // U15 (lightweight M1): buildHeritageMap is the LAST consumer of the
    // raw `deferredWorkerHeritage` records — processCallsFromExtracted
    // below reads from the derived `fullWorkerHeritageMap` instead. Free
    // the raw heritage array now so the GC can reclaim it before the
    // (potentially long) call-resolution stage. processHeritageFromExtracted
    // earlier was a read-only consumer (pushed to graph, didn't drain).
    deferredWorkerHeritage.length = 0;

    if (deferredWorkerCalls.length > 0) {
      if (deferredProfile) {
        logDeferredProfile(
          `processCallsFromExtracted: starting (${deferredWorkerCalls.length} call sites, heritageMap=${fullWorkerHeritageMap !== undefined})`,
        );
      }
      const tCalls = startTimer(deferredProfile);
      await processCallsFromExtracted(
        graph,
        deferredWorkerCalls,
        ctx,
        (current, total) => {
          const ratio = total > 0 ? current / total : 1;
          onProgress({
            phase: 'parsing',
            // Calls is the longest deferred stage on real repos — give it the
            // 10-point tail 85-95 so the progress bar visibly advances during
            // call resolution instead of holding at 82 (M2).
            percent: 85 + Math.round(ratio * 10),
            message: 'Resolving calls (all chunks)...',
            detail: `${current}/${total} files`,
            stats: {
              filesProcessed: filesParsedSoFar,
              totalFiles: totalParseable,
              nodesCreated: graph.nodeCount,
            },
          });
        },
        deferredConstructorBindings.length > 0 ? deferredConstructorBindings : undefined,
        fullWorkerHeritageMap,
        bindingAccumulator,
      );
      endTimer(tCalls, (ms) => `processCallsFromExtracted: ${ms.toFixed(0)}ms total`);
    }

    if (deferredAssignments.length > 0) {
      processAssignmentsFromExtracted(
        graph,
        deferredAssignments,
        ctx,
        deferredConstructorBindings.length > 0 ? deferredConstructorBindings : undefined,
        bindingAccumulator,
      );
    }
    // U15 (lightweight M1): all three arrays have had their last consumer
    // by the time we reach this point — processCallsFromExtracted drained
    // `deferredWorkerCalls` and read `deferredConstructorBindings`;
    // processAssignmentsFromExtracted drained `deferredAssignments` and
    // also read `deferredConstructorBindings`. Free them now so the
    // function-scope references die before downstream graph-build /
    // scope-resolution starts using its own working memory. Note: arrays
    // returned in the function result object (allFetchCalls,
    // allExtractedRoutes, allDecoratorRoutes, allToolDefs, allORMQueries,
    // allParsedFiles) intentionally stay live — downstream consumers
    // need them.
    deferredWorkerCalls.length = 0;
    deferredConstructorBindings.length = 0;
    deferredAssignments.length = 0;
  } finally {
    await workerPool?.terminate();
  }

  // Sequential fallback chunks.
  //
  // U6: wrap the fallback loop and the finalize/enrich steps in a try/finally
  // so cleanup still runs on a mid-fallback throw. The `finally` guarantees:
  //   1. `astCache.clear()` releases any tree-sitter trees held by the most
  //      recently allocated per-chunk cache, mirroring the per-chunk
  //      `astCache.clear()` calls on the happy path.
  //   2. `bindingAccumulator.finalize()` runs before `crossFile` disposes the
  //      accumulator downstream — callers that inspect partial TypeEnv state
  //      (or consume it via `enrichExportedTypeMap` on a partial recovery)
  //      still see a finalized accumulator.
  //   3. `enrichExportedTypeMap` runs so any bindings already accumulated
  //      are propagated into `exportedTypeMap` even if the fallback aborted.
  //
  // Disposal of the accumulator remains with `crossFile` (owned by U2). We do
  // NOT call `bindingAccumulator.dispose()` here.
  try {
    if (sequentialChunkPaths.length > 0) {
      synthesizeWildcardImportBindings(graph, ctx);
      hasSynthesized = true;
    }
    const allSequentialHeritage: ExtractedHeritage[] = [];
    const cachedSequentialChunkFiles: Array<Array<{ path: string; content: string }>> = [];
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles: Array<{ path: string; content: string }> = [];
      for (const p of chunkPaths) {
        const content = chunkContents.get(p);
        if (content !== undefined) chunkFiles.push({ path: p, content });
      }
      cachedSequentialChunkFiles.push(chunkFiles);
      astCache = createASTCache(chunkFiles.length);
      const sequentialHeritage = await extractExtractedHeritageFromFiles(chunkFiles, astCache);
      for (const h of sequentialHeritage) allSequentialHeritage.push(h);
      astCache.clear();
    }
    const sequentialHeritageMap =
      allSequentialHeritage.length > 0
        ? buildHeritageMap(allSequentialHeritage, ctx, getHeritageStrategyForLanguage)
        : undefined;

    for (let chunkIdx = 0; chunkIdx < sequentialChunkPaths.length; chunkIdx++) {
      const chunkFiles = cachedSequentialChunkFiles[chunkIdx];
      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(
        graph,
        chunkFiles,
        astCache,
        ctx,
        undefined,
        exportedTypeMap,
        undefined,
        undefined,
        undefined,
        sequentialHeritageMap,
        bindingAccumulator,
      );
      await processHeritage(graph, chunkFiles, astCache, ctx);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      const chunkFetchCalls = await extractFetchCallsFromFiles(chunkFiles, astCache);
      if (chunkFetchCalls.length > 0) {
        for (const item of chunkFetchCalls) allFetchCalls.push(item);
      }
      for (const f of chunkFiles) {
        extractORMQueriesInline(f.path, f.content, allORMQueries);
      }
      astCache.clear();
      cachedSequentialChunkFiles[chunkIdx] = [];
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      logger.info(
        `🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`,
      );
    }
  } finally {
    // Clearing an already-empty cache is a no-op, so this is idempotent-safe
    // on the happy path where every per-chunk block already cleared astCache.
    astCache.clear();

    // Run finalize + enrichment inside try/catch so a cleanup failure never
    // masks the original fallback error. finalize must precede crossFile's
    // dispose (U2) and enrichExportedTypeMap depends on finalized bindings.
    try {
      bindingAccumulator.finalize();
      const enriched = enrichExportedTypeMap(bindingAccumulator, graph, exportedTypeMap);
      if (isDev && enriched > 0) {
        logger.info(
          `🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`,
        );
      }
    } catch (enrichErr) {
      if (isDev) {
        logger.warn(
          { err: (enrichErr as Error).message },
          'Post-fallback finalize/enrich failed during cleanup:',
        );
      }
    }
  }

  if (!hasSynthesized) {
    const synthesized = synthesizeWildcardImportBindings(graph, ctx);
    if (isDev && synthesized > 0) {
      logger.info(
        `🔗 Synthesized ${synthesized} additional wildcard import bindings (Go/Ruby/C++/Swift/Python)`,
      );
    }
  }

  // Worker-path enrichment: if exportedTypeMap is empty (e.g. the worker pool
  // built TypeEnv inside workers without access to SymbolTable), reconstruct
  // the map from graph nodes + SymbolTable here in the main thread before
  // handing the (now read-only) map to downstream phases. Doing it here means
  // crossFile receives a fully-populated map and never needs to mutate it for
  // initial-graph enrichment.
  if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
    const graphExports = buildExportedTypeMapFromGraph(graph, ctx.model.symbols);
    for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
  }

  allPathObjects.length = 0;
  // Safe to reset importCtx caches here: `importCtx` (ImportResolutionContext)
  // is a scratch workspace used only during import path resolution. The
  // `resolutionContext` (`ctx`) returned below is a distinct object — it owns
  // the fully-populated, post-parse `importMap` / `namedImportMap` /
  // `packageMap` / `moduleAliasMap` / `model`, and never references
  // `importCtx`. Cross-file re-resolution in cross-file-impl.ts consumes only
  // `ctx` (via `processCalls`), so clearing the suffix index / resolveCache /
  // normalizedFileList here cannot lose import matches downstream.
  importCtx.resolveCache.clear();
  importCtx.index = EMPTY_INDEX;
  importCtx.normalizedFileList = [];

  return {
    exportedTypeMap,
    allFetchCalls,
    allFetchWrapperDefs,
    allExtractedRoutes,
    allDecoratorRoutes,
    allToolDefs,
    allORMQueries,
    bindingAccumulator,
    resolutionContext: ctx,
    // Whether a worker pool was actually live for this run. False means the
    // sequential fallback handled every chunk (either due to `skipWorkers`,
    // the file-count/byte thresholds, or a pool-creation failure).
    usedWorkerPool: workerPool !== undefined,
    // Surface the persistent scope cache so downstream phases
    // (scope-resolution) can skip re-parsing files that the
    // sequential path already parsed. Survives chunk boundaries; the
    // chunk-local `astCache` above is intentionally NOT exposed
    // because parse-impl clears it between chunks.
    scopeTreeCache,
    // Per-file ParsedFile artifacts produced by workers' calls to
    // `extractParsedFile`. Empty when only the sequential path ran
    // (sequential doesn't go through the worker, and extracts ParsedFile
    // inline rather than emitting it). Consumed by scope-resolution as
    // a re-extraction cache: when the file's ParsedFile is here,
    // scope-resolution skips its own `extractParsedFile` call.
    parsedFiles: allParsedFiles,
  };
}
