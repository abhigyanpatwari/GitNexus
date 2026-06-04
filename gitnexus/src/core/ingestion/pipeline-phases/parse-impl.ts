/**
 * Parse implementation — chunked parse + resolve loop.
 *
 * This is the core parsing engine of the ingestion pipeline. It reads
 * source files in byte-budget chunks (~20MB each), parses via worker
 * pool (or sequential fallback), and emits route CALLS edges. Import,
 * call, and inheritance resolution are owned by the scope-resolution
 * phase, not here (RING4-1 #942 removed the legacy call DAG; RING4-2 #943
 * removed the legacy per-file import resolution + wildcard synthesis).
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
  processRoutesFromExtracted,
  buildExportedTypeMapFromGraph,
  type ExportedTypeMap,
} from '../call-processor.js';
import { createSemanticModel, type MutableSemanticModel } from '../model/index.js';
import { ASTCache, createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import {
  createWorkerPool,
  workerPoolDisabledByEnv,
  WorkerPoolInitializationError,
} from '../workers/worker-pool.js';
import type { WorkerPool } from '../workers/worker-pool.js';
import type {
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FetchWrapperDef,
} from '../workers/parse-worker.js';
import type {
  ExtractedRouterImport,
  ExtractedRouterInclude,
  ExtractedRouterModuleAlias,
} from '../route-extractors/fastapi-router-bindings.js';
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
 * Handle a worker-pool startup failure by FAILING FAST with the captured cause
 * (#1741). The pool self-heals *transient* worker crashes on its own — a
 * bounded, jittered startup restart loop (see worker-pool.ts) — so this is
 * reached only when that self-heal is EXHAUSTED, or a deterministic crash-loop
 * was detected, or the pool could not even be constructed. In every such case
 * the workers genuinely cannot start.
 *
 * Rather than silently degrade to the ~10× slower sequential parser — which
 * masked a worker-startup regression as a 2-hour "stuck" run in #1741 (rc99:
 * the failure was a dropped `logger.warn` and an unbounded sequential grind) —
 * GitNexus surfaces the real crash and aborts. An operator who genuinely wants
 * sequential parsing asks for it explicitly with `--workers 0`.
 *
 * The decision is automatic: NO `--allow-sequential-fallback` or pool-sizing
 * flag participates. The pool's own crash classification (`crashClass` on
 * WorkerPoolInitializationError) only sharpens the message.
 *
 * @throws always — an actionable Error carrying the captured worker crash.
 * @internal Exported for unit tests; production callers are the parse loop's
 *           two worker-startup catch sites below.
 */
export function handleWorkerStartupFailure(err: Error): never {
  const isInit = err instanceof WorkerPoolInitializationError;
  const readinessFailures = isInit ? err.readinessFailures : [];
  const crashClass = isInit ? err.crashClass : undefined;
  // Surface the real cause verbatim: readiness failures for an init crash, or
  // the construction error message (e.g. "Worker script not found: …") when the
  // pool never got to spawn workers.
  const failureDetail =
    readinessFailures.length > 0
      ? ` Underlying worker failure(s): ${readinessFailures.join(' | ')}`
      : isInit
        ? ''
        : ` Underlying error: ${err.message}`;

  // Always surface the real crash — never let a startup failure pass silently.
  logger.error(
    { err: err.message, readinessFailures, crashClass },
    'Worker pool failed to start — workers could not start (bounded self-heal exhausted).',
  );

  const cause =
    crashClass === 'deterministic-startup'
      ? `every worker crashed identically during startup (a deterministic ` +
        `crash-loop — retrying cannot help), so the pool has no usable workers.`
      : isInit
        ? `workers exhausted the bounded startup retry budget without reporting ` +
          `ready, so the pool has no usable workers.`
        : `the worker pool could not be constructed.`;

  // Class-aware fix hint: a missing/broken native binding is the likely cause
  // when workers crashed during init, but it is the WRONG guess for a pool that
  // never constructed (commonly a missing build / unresolvable worker path).
  const fixHint = isInit
    ? `Fix the worker startup failure shown above (often a missing/broken native ` +
      `binding or a top-of-script import error in parse-worker).`
    : `Fix the worker pool construction error shown above (commonly a missing ` +
      `build, so dist/ has no parse-worker, or an unresolvable worker path).`;

  throw new Error(
    `Worker pool failed to start: ${cause}${failureDetail}\n\n` +
      `GitNexus will NOT silently fall back to the (much slower) sequential ` +
      `parser and hide this crash — that masked a worker-startup regression as ` +
      `a 2-hour "stuck" run in #1741. Options:\n` +
      `  • ${fixHint}\n` +
      `  • Re-run with --workers 0 to parse sequentially without the worker pool.`,
  );
}

/**
 * Chunked parse + resolve loop.
 *
 * Reads source in byte-budget chunks (~20MB each):
 * 1. Parse each chunk via worker pool (or sequential fallback)
 * 2. After all chunks parse, emit route CALLS edges (deferred so resolution
 *    sees the full repo graph) and collect the exported-type map
 * 3. Collect TypeEnv bindings for cross-file propagation
 *
 * Import, call, and inheritance edges are emitted by the scope-resolution
 * phase, not here (RING4-1 #942 / RING4-2 #943 removed the legacy passes).
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
  /** SemanticModel populated during parse — scope-resolution reads its
   *  TypeRegistry / MethodRegistry / SymbolTable indexes. */
  model: MutableSemanticModel;
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
  const model = createSemanticModel();
  const symbolTable = model.symbols;

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
  // `--workers 0` (workerPoolSize === 0) and `GITNEXUS_WORKER_POOL_SIZE=0` both
  // mean "no pool, parse sequentially". The env channel is consulted ONLY when
  // no explicit `--workers <N>` was given, so an explicit positive size always
  // wins over an ambient env=0 (#1741). Without this, env=0 built a size-0 pool
  // that failed fast with a fabricated "retry budget exhausted" crash.
  const envDisablesWorkers = options?.workerPoolSize === undefined && workerPoolDisabledByEnv();
  const meetsWorkerThreshold =
    totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS;
  // Log only when env=0 actually skips a pool we'd otherwise have used, so the
  // undocumented (possibly accidental) env=0 case is observable instead of a
  // silent degrade — small repos go sequential anyway and need no notice.
  if (envDisablesWorkers && meetsWorkerThreshold) {
    logger.warn(
      'GITNEXUS_WORKER_POOL_SIZE=0 → parsing sequentially; unset it or pass --workers <N> to use the worker pool.',
    );
  }
  const shouldUseWorkers =
    !options?.skipWorkers &&
    options?.workerPoolSize !== 0 &&
    !envDisablesWorkers &&
    meetsWorkerThreshold;
  let workerPool: WorkerPool | undefined;
  const getOrCreateWorkerPool = (): WorkerPool | undefined => {
    if (!shouldUseWorkers) return undefined;
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
      // Pool *construction* failed (e.g. the worker script is missing — a
      // broken install). Fail fast with the cause rather than silently
      // degrading to the slow sequential parser (#1741); `--workers 0` is the
      // explicit opt-out for anyone who genuinely wants sequential parsing.
      handleWorkerStartupFailure(err as Error);
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

  const sequentialChunkPaths: string[][] = [];
  const exportedTypeMap: ExportedTypeMap = new Map();
  const bindingAccumulator = new BindingAccumulator();
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allFetchWrapperDefs: FetchWrapperDef[] = [];
  const allExtractedRoutes: ExtractedRoute[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allRouterIncludes: ExtractedRouterInclude[] = [];
  const allRouterImports: ExtractedRouterImport[] = [];
  const allRouterModuleAliases: ExtractedRouterModuleAlias[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
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
          // Every worker crashed during startup and the pool's bounded
          // self-heal (jittered restart, deterministic crash-loop detection —
          // see worker-pool.ts) was exhausted. Fail fast with the captured
          // cause rather than silently degrading to the ~10× slower sequential
          // parser, which masked this exact regression as a 2-hour "stuck" run
          // in #1741. The failed (zero-worker) pool is torn down by the outer
          // finally. `--workers 0` is the explicit opt-in to sequential.
          rawResults.length = 0;
          handleWorkerStartupFailure(err); // always throws
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

      // Route resolution is moved out of the chunk loop into a single
      // end-of-loop pass below. (Import resolution and wildcard synthesis
      // used to run here too; they were removed in RING4-2 #943 — IMPORTS
      // edges now come from the scope-resolution phase.)
      // Reason: per-chunk extraction blocked the chunk loop on
      // main-thread work between worker dispatches — workers sat idle
      // and total CPU utilization plateaued at 4-5% on multi-core boxes.
      // Deferring keeps workers busy chunk-after-chunk; route resolution
      // sees strictly-more-information (full repo graph) so cross-chunk
      // controller targets resolve at least as well as before.
      if (chunkWorkerData) {
        // Aggregate worker-produced ParsedFile artifacts so scope-
        // resolution can use them as a re-extraction cache (skips its
        // own tree-sitter re-parse on warm runs).
        if (chunkWorkerData.parsedFiles?.length) {
          for (const item of chunkWorkerData.parsedFiles) allParsedFiles.push(item);
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
        if (chunkWorkerData.routerIncludes?.length) {
          for (const item of chunkWorkerData.routerIncludes) allRouterIncludes.push(item);
        }
        if (chunkWorkerData.routerImports?.length) {
          for (const item of chunkWorkerData.routerImports) allRouterImports.push(item);
        }
        if (chunkWorkerData.routerModuleAliases?.length) {
          for (const item of chunkWorkerData.routerModuleAliases) allRouterModuleAliases.push(item);
        }
        if (chunkWorkerData.toolDefs?.length) {
          for (const item of chunkWorkerData.toolDefs) allToolDefs.push(item);
        }
        if (chunkWorkerData.ormQueries?.length) {
          for (const item of chunkWorkerData.ormQueries) allORMQueries.push(item);
        }
      } else {
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
    //   1. route resolution on all chunks' routes
    // Resolution sees the full repo graph instead of just current-and-earlier
    // chunks. Import, call, and inheritance edges are emitted by the
    // scope-resolution phase, not here (RING4-1 #942 removed the legacy call
    // DAG; RING4-2 #943 removed the legacy import-map resolution + wildcard
    // synthesis). Progress band: the route stage gets a slice of the 70-95
    // range; a zero-length input leaves its band as a no-op jump.
    //   routes:   80 -> 85 (5)
    const deferredProfile = isDeferredResolutionProfileEnabled();
    if (deferredProfile) {
      logDeferredProfile(`deferred band start: routes=${allExtractedRoutes.length}`);
    }
    // Populate `exportedTypeMap` from the in-progress graph so the post-parse
    // enrichment pass (enrichExportedTypeMap) sees cross-file export types.
    if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
      const graphExports = buildExportedTypeMapFromGraph(graph, model.symbols);
      for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
    }
    if (allExtractedRoutes.length > 0) {
      const tRoutes = startTimer(deferredProfile);
      await processRoutesFromExtracted(graph, allExtractedRoutes, model, (current, total) => {
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
    // Sequential fallback: calls, inheritance, and imports are emitted by the
    // scope-resolution phase, not here (RING4-1 #942 removed the legacy
    // call/heritage passes; RING4-2 #943 removed the legacy import resolution).
    // This loop still extracts fetch routes + ORM queries, which are
    // language-agnostic edge sources independent of call resolution.
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles: Array<{ path: string; content: string }> = [];
      for (const p of chunkPaths) {
        const content = chunkContents.get(p);
        if (content !== undefined) chunkFiles.push({ path: p, content });
      }
      astCache = createASTCache(chunkFiles.length);
      const chunkFetchCalls = await extractFetchCallsFromFiles(chunkFiles, astCache);
      if (chunkFetchCalls.length > 0) {
        for (const item of chunkFetchCalls) allFetchCalls.push(item);
      }
      for (const f of chunkFiles) {
        extractORMQueriesInline(f.path, f.content, allORMQueries);
      }
      astCache.clear();
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

  // Worker-path enrichment: if exportedTypeMap is empty (e.g. the worker pool
  // built TypeEnv inside workers without access to SymbolTable), reconstruct
  // the map from graph nodes + SymbolTable here in the main thread before
  // handing the (now read-only) map to downstream phases. Doing it here means
  // crossFile receives a fully-populated map and never needs to mutate it for
  // initial-graph enrichment.
  if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
    const graphExports = buildExportedTypeMapFromGraph(graph, model.symbols);
    for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
  }

  // FastAPI router-prefix resolution (cross-file).
  //
  // Workers emit two kinds of records per Python file:
  //   • `routerIncludes` — every `app.include_router(<routerExpr>, prefix='/x')`
  //     site, where `routerExpr` is either `<module>.router` (Shape A) or a
  //     bare local name (Shape B).
  //   • `routerImports`  — every `from <module> import router [as <alias>]`,
  //     mapping a local name to a module key (the basename of the source
  //     module). These let us resolve Shape-B router includes back to the
  //     module that defines the router.
  //
  // We build `module-basename → Set<prefix>` and then walk
  // `allDecoratorRoutes`: any decorator route emitted from a `router.<verb>`
  // decorator inherits its file-basename's prefix. When a router is mounted
  // under multiple prefixes we duplicate the route entry, mirroring FastAPI's
  // runtime behaviour.
  if (allRouterIncludes.length > 0 && allDecoratorRoutes.length > 0) {
    // Group `routerImports` by file so we can resolve Shape-B locals against
    // imports declared in the SAME file as the include_router call. We carry
    // both the short module key (file basename) and, when available, the long
    // key (`<dir>/<basename>`) so cross-package same-name modules don't blur
    // their prefixes together. `routerModuleAliases` lifts the same long-key
    // information for Shape-A includes whose receiving module was imported
    // via `from <pkg> import <module>`.
    interface LocalImport {
      moduleKey: string;
      moduleKeyLong: string | undefined;
    }
    const importsByFile = new Map<string, Map<string, LocalImport>>();
    for (const imp of allRouterImports) {
      let m = importsByFile.get(imp.filePath);
      if (!m) {
        m = new Map();
        importsByFile.set(imp.filePath, m);
      }
      m.set(imp.localName, {
        moduleKey: imp.moduleKey,
        moduleKeyLong: imp.moduleKeyLong,
      });
    }
    // Module-alias map keyed by file: `localName` (the imported module
    // identifier in this file) → long key. Shape-A receivers like
    // `users.router` are matched against this map; the long key, when
    // present, scopes the prefix to the precise source file.
    const moduleAliasesByFile = new Map<string, Map<string, string>>();
    for (const alias of allRouterModuleAliases) {
      let m = moduleAliasesByFile.get(alias.filePath);
      if (!m) {
        m = new Map();
        moduleAliasesByFile.set(alias.filePath, m);
      }
      m.set(alias.localName, alias.moduleKeyLong);
    }

    // Two parallel maps: long-key (precise) and short-key (basename
    // fallback). Long-key entries are preferred when the file's own long
    // key matches; short-key entries match any file with that basename and
    // remain the fallback when no long key is known (e.g. Shape A includes
    // without a corresponding import statement).
    const prefixesByLongKey = new Map<string, Set<string>>();
    const prefixesByShortKey = new Map<string, Set<string>>();

    const recordPrefix = (target: Map<string, Set<string>>, key: string, prefix: string): void => {
      let set = target.get(key);
      if (!set) {
        set = new Set();
        target.set(key, set);
      }
      set.add(prefix);
    };

    for (const inc of allRouterIncludes) {
      // Shape A: `<module>.router`. The worker emits `routerExpr` already
      // including `.router`, so split it back. We only know a short module
      // key here — the call site doesn't carry the dotted package path. If
      // the same file imports `<module>` via `from <pkg> import <module>`
      // (recorded in `allRouterModuleAliases`) we promote to a long key.
      const dotIdx = inc.routerExpr.indexOf('.router');
      if (dotIdx > 0) {
        const moduleShort = inc.routerExpr.slice(0, dotIdx);
        const aliasLong = moduleAliasesByFile.get(inc.filePath)?.get(moduleShort);
        if (aliasLong) {
          recordPrefix(prefixesByLongKey, aliasLong, inc.prefix);
        } else {
          recordPrefix(prefixesByShortKey, moduleShort, inc.prefix);
        }
        continue;
      }

      // Shape B: bare local name. Resolve through this file's imports. The
      // import line gives us a long key whenever the module path was multi-
      // segment, so cross-package collisions are eliminated for Shape B.
      const localImp = importsByFile.get(inc.filePath)?.get(inc.routerExpr);
      if (!localImp) continue;
      if (localImp.moduleKeyLong) {
        recordPrefix(prefixesByLongKey, localImp.moduleKeyLong, inc.prefix);
      } else {
        recordPrefix(prefixesByShortKey, localImp.moduleKey, inc.prefix);
      }
    }

    if (prefixesByLongKey.size > 0 || prefixesByShortKey.size > 0) {
      const fileLongKey = (rel: string): string => {
        // Strip `.py`, then take the last two path segments. `api/users.py`
        // → `api/users`. Files at the repo root return the empty string,
        // which can never match a long-key entry (those always include a
        // parent directory) and so fall through to the short-key lookup.
        const noExt = rel.endsWith('.py') ? rel.slice(0, -3) : rel;
        const lastSlash = noExt.lastIndexOf('/');
        if (lastSlash < 0) return '';
        const beforeLast = noExt.slice(0, lastSlash);
        const stem = noExt.slice(lastSlash + 1);
        const prevSlash = beforeLast.lastIndexOf('/');
        const parent = prevSlash >= 0 ? beforeLast.slice(prevSlash + 1) : beforeLast;
        return `${parent}/${stem}`;
      };

      const fileShortKey = (rel: string): string => {
        const slash = rel.lastIndexOf('/');
        const file = slash >= 0 ? rel.slice(slash + 1) : rel;
        return file.endsWith('.py') ? file.slice(0, -3) : file;
      };

      const expanded: ExtractedDecoratorRoute[] = [];
      for (const dr of allDecoratorRoutes) {
        if (dr.decoratorReceiver !== 'router' || !dr.filePath.endsWith('.py')) {
          expanded.push(dr);
          continue;
        }
        // Long-key lookup first; only fall back to the short key when no
        // long-key prefix targets this file. This avoids prefix leakage
        // between e.g. `api/users.py` and `admin/users.py`.
        const longKey = fileLongKey(dr.filePath);
        const longPrefixes = longKey ? prefixesByLongKey.get(longKey) : undefined;
        const shortPrefixes = longPrefixes
          ? undefined
          : prefixesByShortKey.get(fileShortKey(dr.filePath));
        const prefixes = longPrefixes ?? shortPrefixes;
        if (!prefixes || prefixes.size === 0) {
          expanded.push(dr);
          continue;
        }
        for (const prefix of prefixes) {
          expanded.push({ ...dr, prefix });
        }
      }
      allDecoratorRoutes.length = 0;
      for (const dr of expanded) allDecoratorRoutes.push(dr);
    }
  }

  return {
    exportedTypeMap,
    allFetchCalls,
    allFetchWrapperDefs,
    allExtractedRoutes,
    allDecoratorRoutes,
    allToolDefs,
    allORMQueries,
    bindingAccumulator,
    model,
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
