/**
 * Parse implementation — chunked parse + resolve loop.
 *
 * This is the core parsing engine of the ingestion pipeline. It reads
 * source files in byte-budget chunks (~20MB each), parses via the worker
 * pool (the sole parse path — there is no sequential fallback), and emits
 * route CALLS edges. Import,
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
import { mergeChunkResults, dispatchChunkParse } from '../parsing-processor.js';
import {
  fileContentHash,
  computeChunkHash,
  loadParseCacheChunk,
  persistParseCacheChunk,
  PARSE_CACHE_VERSION,
} from '../../../storage/parse-cache.js';
import {
  clearParsedFileStore,
  persistParsedFileChunk,
  getDurableParsedFileDir,
  loadDurableParsedFileIndex,
  restoreDurableParsedFileShard,
} from '../../../storage/parsedfile-store.js';
import type { ParseWorkerResult } from '../workers/parse-worker.js';
import { DEFAULT_PDG_MAX_FUNCTION_LINES } from '../cfg/collect.js';
import type { WorkerExtractedData } from '../parsing-processor.js';
import {
  processRoutesFromExtracted,
  resolveRouteHandlerSymbols,
  buildExportedTypeMapFromGraph,
  type ExportedTypeMap,
} from '../call-processor.js';
import { createSemanticModel, type MutableSemanticModel } from '../model/index.js';
import {
  type PipelineProgress,
  getLanguageFromFilename,
  SupportedLanguages,
} from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import {
  isLanguageAvailable,
  isGrammarRuntimeSkipped,
  createParserForLanguage,
} from '../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { getProvider, providers } from '../languages/index.js';
import type Parser from 'tree-sitter';
import {
  createWorkerPool,
  workerPoolDisabledByEnv,
  resolveAutoPoolSize,
  WorkerPoolInitializationError,
  WorkerPoolDisabledError,
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
import {
  resolveInheritedSpringRoutes,
  type SharedSpringType,
} from '../route-extractors/spring-shared.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { PipelineOptions } from '../pipeline.js';
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
import { isDebugHeapEnabled, logHeapProbe } from '../utils/heap-probe.js';

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

/**
 * Per-worker share of a chunk's byte budget when auto-scaling (#worker-idle).
 *
 * A chunk is a single `WorkerPool.dispatch` unit; the pool fans a chunk's files
 * into sub-batch jobs and assigns them to idle workers (`wakeIdleSlots`). When
 * the chunk budget (2 MB) was far below the 8 MB sub-batch cap, every chunk
 * produced exactly ONE job → ONE busy worker while the other N-1 sat idle. To
 * keep all workers fed, the auto chunk budget now scales as
 * `poolSize × CHUNK_BYTES_PER_WORKER`, so each dispatch carries enough work to
 * fan across the whole pool. Sequential / explicit-budget runs are unaffected.
 */
const CHUNK_BYTES_PER_WORKER = 2 * 1024 * 1024;

/**
 * Target jobs-per-worker per dispatch. More jobs than workers gives the pool's
 * idle-slot assignment room to load-balance (a slow job doesn't strand a worker
 * while the rest finish early). Drives the derived `subBatchMaxBytes`.
 */
const TARGET_JOBS_PER_WORKER = 3;

/** Floor for a derived sub-batch so jobs don't shrink to per-file IPC churn. */
const MIN_SUB_BATCH_BYTES = 256 * 1024;

function resolveChunkByteBudget(options?: PipelineOptions, effectivePoolSize = 1): number {
  const opt = options?.chunkByteBudget;
  if (typeof opt === 'number' && Number.isFinite(opt) && opt > 0) return opt;
  const env = Number(process.env.GITNEXUS_CHUNK_BYTE_BUDGET);
  if (Number.isFinite(env) && env > 0) return env;
  // Auto: size each chunk so a dispatch can fan across the whole pool. A
  // single-worker (tiny-repo) run keeps the original 2 MB invalidation floor.
  return Math.max(DEFAULT_CHUNK_BYTE_BUDGET, effectivePoolSize * CHUNK_BYTES_PER_WORKER);
}

// ── Main parse + resolve function ──────────────────────────────────────────

type ScannedFile = { path: string; size: number };
type ProgressFn = (progress: PipelineProgress) => void;

/**
 * Whole-repo, cross-file route extraction (main thread).
 *
 * Some frameworks define their route table from a single root file that pulls
 * in other files across the repo — e.g. Django follows
 * `manage.py → DJANGO_SETTINGS_MODULE → ROOT_URLCONF → root urls.py`, then walks
 * `include()` chains across many files. Unlike single-file route files (Laravel
 * `routes/*.php`), which the parse worker extracts in isolation, these need a
 * whole-repo view and on-demand cross-file reads — neither of which the
 * filesystem-free worker can provide, and which a per-chunk worker view gets
 * wrong whenever the root file and its includes land in different chunks.
 *
 * So it runs here, once, after every file is scanned — mirroring the FastAPI
 * router-include join further below. The pass is language-agnostic: any
 * {@link LanguageProvider} exposing both `discoverRootRouteFile` and
 * `extractRoutes` participates (today only Python/Django). For repos without
 * such a framework the cost is a path scan plus one `manage.py`-style miss.
 */
export async function extractCrossFileRoutes(
  allPaths: string[],
  repoPath: string,
): Promise<ExtractedRoute[]> {
  const out: ExtractedRoute[] = [];

  // Languages whose provider implements the cross-file route hooks. Route
  // results are intentionally NOT persisted across analyze runs, so a repo
  // using such a framework (e.g. Django) re-derives its routes on every run;
  // a repo without one does effectively nothing here. Cross-run route caching
  // is a deliberate follow-up — see #1836.
  const routeCapableLangs = new Set<SupportedLanguages>();
  for (const provider of Object.values(providers)) {
    if (provider.discoverRootRouteFiles && provider.extractRoutes) {
      routeCapableLangs.add(provider.id);
    }
  }
  if (routeCapableLangs.size === 0) return out;

  // Bucket only the paths whose language can contribute routes, so a non-
  // framework repo never pays to bucket the languages it doesn't use here.
  const pathsByLang = new Map<SupportedLanguages, string[]>();
  for (const p of allPaths) {
    const lang = getLanguageFromFilename(p);
    if (!lang || !routeCapableLangs.has(lang)) continue;
    let bucket = pathsByLang.get(lang);
    if (!bucket) {
      bucket = [];
      pathsByLang.set(lang, bucket);
    }
    bucket.push(p);
  }

  for (const [lang, langPaths] of pathsByLang) {
    if (!isLanguageAvailable(lang)) continue;
    const provider = getProvider(lang);
    if (!provider.discoverRootRouteFiles || !provider.extractRoutes) continue;

    // Disk-backed reader keyed on repo-relative paths. Discovery and the
    // include() walk read through this; nothing is pre-loaded, so a repo that
    // lacks the framework pays only the reads its own discovery probes trigger.
    const readCache = new Map<string, string | null>();
    const reader = (relativePath: string): string | null => {
      const cached = readCache.get(relativePath);
      if (cached !== undefined) return cached;
      let content: string | null = null;
      try {
        content = fs.readFileSync(path.join(repoPath, relativePath), 'utf-8');
      } catch {
        content = null;
      }
      readCache.set(relativePath, content);
      return content;
    };

    // One root route file per discoverable project (a monorepo can have several).
    const rootPaths = provider.discoverRootRouteFiles(
      langPaths.map((p) => ({ path: p })),
      undefined,
      reader,
    );
    if (rootPaths.length === 0) continue;

    // One parser per language — the grammar is language-scoped, so it is reused
    // for every project root and every include() re-parse.
    let parser: Parser;
    try {
      parser = await createParserForLanguage(lang, rootPaths[0]);
    } catch {
      continue; // grammar unavailable — skip the language, mirrors worker safety net
    }

    for (const rootPath of rootPaths) {
      const rootContent = reader(rootPath);
      if (rootContent === null) continue; // skip this root only, not the language

      let rootTree: Parser.Tree;
      try {
        rootTree = parseSourceSafe(parser, rootContent);
      } catch {
        logger.warn(`Skipping unparseable root route file: ${rootPath}`);
        continue; // skip this root only
      }

      // Isolate a misbehaving provider: a throw here must not abort the whole
      // analyze (mirrors the worker's per-file isolation). Skip this root, warn.
      try {
        const routes = provider.extractRoutes(rootTree, rootPath, reader, parser);
        for (const r of routes) out.push(r);
      } catch (err) {
        logger.warn({ err }, `Cross-file route extraction failed for ${rootPath}`);
      }
    }
  }

  return out;
}

/**
 * Handle a worker-pool startup failure by FAILING FAST with the captured cause
 * (#1741). The pool self-heals *transient* worker crashes on its own — a
 * bounded, jittered startup restart loop (see worker-pool.ts) — so this is
 * reached only when that self-heal is EXHAUSTED, or a deterministic crash-loop
 * was detected, or the pool could not even be constructed. In every such case
 * the workers genuinely cannot start.
 *
 * There is no sequential parser to silently degrade to — that fallback was
 * removed (and it had masked a worker-startup regression as a 2-hour "stuck"
 * run in #1741, rc99: a dropped `logger.warn` plus an unbounded sequential
 * grind). GitNexus surfaces the real crash and aborts so the operator fixes the
 * worker startup (commonly a missing build). The pool's own crash
 * classification (`crashClass` on WorkerPoolInitializationError) sharpens the
 * message.
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
      `The worker pool is GitNexus's only parse path — there is no sequential ` +
      `fallback to hide this crash behind (silently degrading masked a ` +
      `worker-startup regression as a 2-hour "stuck" run in #1741). Fix:\n` +
      `  • ${fixHint}`,
  );
}

/**
 * Chunked parse + resolve loop.
 *
 * Reads source in byte-budget chunks (~20MB each):
 * 1. Parse each chunk via the worker pool (the sole parse path)
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
  /** Route URL → resolved handler symbol UID (Part 2, #2138). Lets the routes
   *  phase stamp `handlerSymbolId` on Route nodes so contract extraction can
   *  read the handler from the graph instead of re-parsing source. */
  routeHandlerSymbols: ReadonlyMap<string, string>;
  /** SemanticModel populated during parse — scope-resolution reads its
   *  TypeRegistry / MethodRegistry / SymbolTable indexes. */
  model: MutableSemanticModel;
  /** Whether a worker pool was actually constructed for this run. False
   *  means no pool was needed: a warm all-cache-hit run replays cached
   *  worker output without spawning workers, or there were no parseable
   *  files. There is no sequential parser — the pool is the sole parse path
   *  whenever a chunk misses the cache. */
  usedWorkerPool: boolean;
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
    // Distinguish a deliberate runtime opt-out from a genuinely-missing binding
    // so we don't tell a user who set GITNEXUS_SKIP_OPTIONAL_GRAMMARS to
    // `npm rebuild` a grammar that built fine (#2091/#2093 review).
    if (isGrammarRuntimeSkipped(lang as SupportedLanguages)) {
      logger.warn(
        `Skipping ${count} ${lang} file(s) — ${lang} parsing disabled via GITNEXUS_SKIP_OPTIONAL_GRAMMARS.`,
      );
    } else {
      logger.warn(
        `Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`,
      );
    }
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
  const totalBytes = parseableScanned.reduce((sum, f) => sum + f.size, 0);

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

  // Sequential parsing has been removed: the worker pool (quarantine +
  // respawn/recycle + circuit breaker) is the sole parse path. The three
  // channels that used to select an in-process parser are now hard errors, so
  // an operator who set one gets an actionable message instead of a silently
  // slower (now nonexistent) fallback. Validated before any chunk work; a
  // zero-parseable-file repo is exempt (nothing to parse).
  if (totalParseable > 0) {
    const requestedPoolSize = options?.workerPoolSize;
    const disabledByEnv = requestedPoolSize === undefined && workerPoolDisabledByEnv();
    if (options?.skipWorkers || requestedPoolSize === 0 || disabledByEnv) {
      const reason = options?.skipWorkers
        ? '`skipWorkers: true` was passed'
        : requestedPoolSize === 0
          ? '`--workers 0` (workerPoolSize=0) was requested'
          : '`GITNEXUS_WORKER_POOL_SIZE=0` is set';
      throw new WorkerPoolDisabledError(
        `Worker-pool parsing cannot be disabled (${reason}). GitNexus no longer ` +
          `has a sequential parser — the worker pool self-heals via quarantine + ` +
          `respawn, so there is no slower path to fall back to. Pass ` +
          `\`--workers <N>\` with N>=1, or omit it for an auto-sized pool.`,
      );
    }
  }

  // Build byte-budget chunks. The budget is resolved per-call (U14): options
  // first, then env, then the built-in default. Pre-U14 this was a
  // module-load IIFE constant, which froze the env value at import time
  // and made `PipelineOptions.chunkByteBudget` silently no-op on warm test
  // runs. Resolving in the function body restores per-call configurability
  // and matches the pattern used by resolveAutoPoolSize and the U1
  // parseChunkConcurrency resolver.
  // Effective worker count, computed up-front so the chunk budget can scale to
  // keep the whole pool busy (#worker-idle). The pool is ALWAYS used (sequential
  // parsing was removed; the disabled channels threw above). Size it to the
  // work: an explicit `--workers <N>` pins the size; otherwise the cores-based
  // auto size is capped by the repo's worth of work (~one worker per
  // CHUNK_BYTES_PER_WORKER of source) so a tiny repo spawns ~1 worker instead of
  // a full pool, replacing the job the deleted small-repo threshold used to do.
  // KTD-3 of the remove-sequential plan; the cap formula is intentionally coarse
  // (tuning deferred).
  const explicitPoolSize = options?.workerPoolSize;
  const workProportionalCap = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES_PER_WORKER));
  const effectivePoolSize =
    explicitPoolSize && explicitPoolSize > 0
      ? explicitPoolSize
      : Math.min(resolveAutoPoolSize(), workProportionalCap);
  const chunkByteBudget = resolveChunkByteBudget(options, effectivePoolSize);
  // Sub-batch size so each chunk fans into ~`TARGET_JOBS_PER_WORKER` jobs per
  // worker, giving the pool's idle-slot assignment room to load-balance. An
  // explicit `GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES` operator override wins.
  const subBatchEnv = Number(process.env.GITNEXUS_WORKER_SUB_BATCH_MAX_BYTES);
  const dispatchSubBatchMaxBytes =
    Number.isFinite(subBatchEnv) && subBatchEnv > 0
      ? subBatchEnv
      : Math.max(
          MIN_SUB_BATCH_BYTES,
          Math.ceil(chunkByteBudget / (effectivePoolSize * TARGET_JOBS_PER_WORKER)),
        );
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

  // Create the worker pool lazily, reusing it across cache-miss chunks.
  //
  // KTD-8 — the pool is intentionally NOT created before the parse-cache
  // lookup: a warm-cache all-hit run must replay cached worker output without
  // loading parse-worker.js or any tree-sitter/N-API native bindings. So
  // `getOrCreateWorkerPool` is called only from inside the chunk loop, on the
  // first cache MISS. There is no longer a "should we use workers?" gate:
  // sequential parsing was removed and the disabled channels (`--workers 0` /
  // env=0 / `skipWorkers`) threw above, so for any repo with parseable files
  // the pool is always the parse path.
  let workerPool: WorkerPool | undefined;
  const getOrCreateWorkerPool = (): WorkerPool => {
    if (workerPool) return workerPool;
    try {
      // Test-only injection: integration tests pass a custom worker script URL
      // via `workerUrlForTest` so they can drive the chunk-loop with
      // deterministically-misbehaving workers without mocking the module import
      // graph. When unset, the normal src/ → dist/ resolution runs.
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
      // Thread the ParsedFile store path into the pool so workers write their
      // own shards (#1983 parallel serialization). `parsedFileStorePath` is
      // declared below but this closure only runs from inside the chunk loop,
      // after it is initialized; `undefined` drives the worker no-store
      // fallback (return ParsedFiles in the result).
      workerPool = createWorkerPool(workerUrl, effectivePoolSize, {
        parsedFileStoreStoragePath: parsedFileStorePath,
        // Durable, content-addressed shard dir for warm-cache reuse (#2038).
        // Initialized below before the chunk loop (same deferred-init pattern
        // as `parsedFileStorePath`); this closure only runs from the loop.
        durableParsedFileStoragePath: durableParsedFileDir,
        // CFG/PDG opt-in (#2081 M1) — baked into each worker's workerData so the
        // worker builds + attaches cfgSideChannel. Off by default.
        pdg: options?.pdg === true,
        pdgMaxFunctionLines: options?.pdgMaxFunctionLines,
        // Fan each chunk across the whole pool (#worker-idle): without this a
        // chunk smaller than the 8 MB sub-batch cap became a single job on a
        // single worker. Honors an explicit `subBatchMaxBytes` / env override.
        subBatchMaxBytes: dispatchSubBatchMaxBytes,
      });
      return workerPool;
    } catch (err) {
      // Pool *construction* failed (e.g. the worker script is missing — a
      // broken install). Fail fast with the cause (#1741). There is no
      // sequential parser to fall back to; the operator must fix the worker
      // startup (commonly a missing build so dist/ has no parse-worker).
      handleWorkerStartupFailure(err as Error);
    }
  };

  let filesParsedSoFar = 0;

  const exportedTypeMap: ExportedTypeMap = new Map();
  const bindingAccumulator = new BindingAccumulator();
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allFetchWrapperDefs: FetchWrapperDef[] = [];
  const allExtractedRoutes: ExtractedRoute[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allRouterIncludes: ExtractedRouterInclude[] = [];
  const allRouterImports: ExtractedRouterImport[] = [];
  const allRouterModuleAliases: ExtractedRouterModuleAlias[] = [];
  const allSpringTypes: SharedSpringType[] = [];
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
  // Disk-backed ParsedFile store (#1983): when a storage path is available we
  // flush worker-produced ParsedFiles to disk per chunk (instead of retaining
  // them in `allParsedFiles`) and scope-resolution streams them back per
  // language — avoiding both the ~1× semantic-model RAM cost of holding them
  // and, critically, the unbounded native tree-sitter re-parse leak that
  // scope-resolution's main-thread re-extraction otherwise accumulates. When
  // there is no storage path (tests / direct pipeline calls), we fall back to
  // retaining them in `allParsedFiles` (small-repo path, preserves prior
  // behavior). Cleared up-front so a prior run's shards never leak in.
  const parsedFileStorePath = parseCache?.storagePath;
  if (parsedFileStorePath) await clearParsedFileStore(parsedFileStorePath);
  // Durable, content-addressed ParsedFile store (#2038 warm-cache coverage) —
  // a sibling of the run-scoped store, NOT cleared per run. Workers write a
  // shard per chunk hash; on a warm parse-cache hit we restore the chunk's
  // shards into the run-scoped store so scope-resolution streams them without
  // re-parsing. `durableHitKeys` is the prior run's index, version-gated by
  // PARSE_CACHE_VERSION (a mismatch ⇒ empty ⇒ every chunk re-dispatches, which
  // repopulates the durable store — never the main-thread extract fallback).
  const durableParsedFileDir =
    parsedFileStorePath !== undefined ? getDurableParsedFileDir(parsedFileStorePath) : undefined;
  const durableHitKeys =
    durableParsedFileDir !== undefined
      ? await loadDurableParsedFileIndex(durableParsedFileDir, PARSE_CACHE_VERSION)
      : new Set<string>();
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
    const heapProbeEveryN = isDebugHeapEnabled() ? 25 : 0;

    // ── Merge pipelining (#worker-idle) ──────────────────────────────────────
    // Merging a chunk's worker results into the graph is the only remaining
    // serial main-thread step (ParsedFile serialization now runs in workers).
    // To stop the whole pool idling during that merge, we OVERLAP it with the
    // NEXT chunk's worker parse: a freshly-dispatched worker chunk is parked in
    // `pendingWorkerChunk`, and we merge+finalize it only AFTER starting the
    // following chunk's dispatch — so the workers parse chunk N+1 while the
    // main thread merges chunk N. Chunk ORDER is preserved (N finalized before
    // N+1), which keeps the deferred aggregation deterministic. Cache-hit
    // chunks drain any pending chunk first, then finalize inline (no worker
    // dispatch to overlap).
    interface PendingWorkerChunk {
      readonly rawResults: ParseWorkerResult[];
      readonly chunkIdx: number;
      readonly chunkHash: string | null;
      readonly chunkFiles: Array<{ path: string; content: string }>;
      readonly chunkStartMs: number | null;
    }
    let pendingWorkerChunk: PendingWorkerChunk | null = null;

    // Apply one chunk's merged worker data: per-chunk aggregation into the
    // run-level accumulators + the throughput log. Shared by the cache-hit
    // (inline) and worker (deferred) paths. The `| null` guard is defensive —
    // every live caller passes real worker data now that sequential parsing
    // (which was the only path that passed null) is gone.
    const applyChunkResults = async (
      chunkWorkerData: WorkerExtractedData | null,
      chunkIdx: number,
      chunkFiles: Array<{ path: string; content: string }>,
      chunkStartMs: number | null,
    ): Promise<void> => {
      if (chunkWorkerData) {
        if (chunkWorkerData.parsedFiles?.length) {
          if (parsedFileStorePath) {
            await persistParsedFileChunk(
              parsedFileStorePath,
              `chunk-${chunkIdx}`,
              chunkWorkerData.parsedFiles,
            );
          } else {
            for (const item of chunkWorkerData.parsedFiles) allParsedFiles.push(item);
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
        if (chunkWorkerData.routerIncludes?.length) {
          for (const item of chunkWorkerData.routerIncludes) allRouterIncludes.push(item);
        }
        if (chunkWorkerData.routerImports?.length) {
          for (const item of chunkWorkerData.routerImports) allRouterImports.push(item);
        }
        if (chunkWorkerData.routerModuleAliases?.length) {
          for (const item of chunkWorkerData.routerModuleAliases) allRouterModuleAliases.push(item);
        }
        if (chunkWorkerData.springTypes?.length) {
          for (const item of chunkWorkerData.springTypes) allSpringTypes.push(item);
        }
        if (chunkWorkerData.toolDefs?.length) {
          for (const item of chunkWorkerData.toolDefs) allToolDefs.push(item);
        }
        if (chunkWorkerData.ormQueries?.length) {
          for (const item of chunkWorkerData.ormQueries) allORMQueries.push(item);
        }
      }

      filesParsedSoFar += chunkFiles.length;

      if (verboseThroughputLog && chunkStartMs !== null) {
        const elapsedMs = Date.now() - chunkStartMs;
        const filesPerSec = elapsedMs > 0 ? (chunkFiles.length * 1000) / elapsedMs : 0;
        const stats = workerPool?.getStats?.();
        const poolFrag = stats
          ? ` pool: ${stats.activeSlots}/${stats.size} active, ` +
            `${stats.quarantined} quarantined${stats.poolBroken ? ', BROKEN' : ''}`
          : ' (cache replay)';
        logger.info(
          `📊 chunk ${chunkIdx + 1}/${numChunks}: ${chunkFiles.length} files in ${elapsedMs}ms ` +
            `(${filesPerSec.toFixed(1)} files/s)${poolFrag}`,
        );
      }
    };

    // Merge + finalize a parked worker chunk: graph merge (the overlapped
    // main-thread step) → parse-cache write-guard → run-level aggregation.
    const finalizeWorkerChunk = async (p: PendingWorkerChunk): Promise<void> => {
      const chunkWorkerData = mergeChunkResults(graph, symbolTable, p.rawResults, exportedTypeMap);
      // Persist raw results for this chunk hash (skipping when any chunk file
      // was worker-quarantined, so the narrower rawResults isn't cached under
      // the full-chunk key — see the original inline note / U20.U2).
      if (parseCache && p.chunkHash && p.rawResults.length > 0) {
        const quarantineSet = new Set(workerPool?.getQuarantinedPaths?.() ?? []);
        const chunkHadQuarantine = p.chunkFiles.some((f) => quarantineSet.has(f.path));
        if (chunkHadQuarantine) {
          if (isDev) {
            const quarantinedInChunk = p.chunkFiles.filter((f) => quarantineSet.has(f.path)).length;
            logger.info(
              `📦 parse-cache SKIP: chunk ${p.chunkIdx + 1}/${numChunks} ` +
                `had ${quarantinedInChunk} worker-quarantined file(s); ` +
                `next run will rediscover (${p.chunkHash.slice(0, 8)})`,
            );
          }
        } else {
          await persistParseCacheChunk(parseCache, p.chunkHash, p.rawResults);
          if (isDev) {
            logger.info(
              `📦 parse-cache MISS+store: chunk ${p.chunkIdx + 1}/${numChunks} (${p.chunkFiles.length} files, ${p.chunkHash.slice(0, 8)})`,
            );
          }
        }
      }
      await applyChunkResults(chunkWorkerData, p.chunkIdx, p.chunkFiles, p.chunkStartMs);
    };

    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      if (heapProbeEveryN > 0 && chunkIdx > 0 && chunkIdx % heapProbeEveryN === 0) {
        logHeapProbe(
          `parse-chunk-${chunkIdx}`,
          `nodes=${graph.nodeCount} parsedFiles=${allParsedFiles.length}`,
        );
      }
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
        chunkHash = computeChunkHash(
          entries,
          // Only worker-visible pdg config participates in the key —
          // pdgMaxEdgesPerFunction is emit-time-only and deliberately
          // excluded (see PdgCacheKey in parse-cache.ts; #2099 F3). The line
          // cap is RESOLVED to the worker's default before folding so an
          // explicit-default run shares the default run's keys (the worker
          // output is byte-identical either way).
          options?.pdg === true
            ? {
                pdg: true,
                maxFunctionLines: options?.pdgMaxFunctionLines ?? DEFAULT_PDG_MAX_FUNCTION_LINES,
              }
            : false,
        );
      }

      const cachedRaw =
        chunkHash && parseCache ? await loadParseCacheChunk(parseCache, chunkHash) : undefined;

      // Track every chunk hash we touched so the orchestrator can
      // prune stale entries (chunks whose composition no longer
      // corresponds to a live chunk in the current scan) before saving.
      if (parseCache && chunkHash) parseCache.usedKeys.add(chunkHash);

      // A parse-cache hit may skip the workers ONLY if the chunk's ParsedFiles
      // are recoverable without a main-thread re-parse: restored from a durable
      // shard (store path) or carried in the cached result (no-store path). If a
      // cached chunk's durable shards are missing — first run after the durable
      // store was introduced, or a pruned/version-stale shard — fall through to
      // a worker re-dispatch to repopulate them. NEVER let scope-resolution
      // re-extract on the main thread (the #1983 OOM the durable store closes).
      const durableHit =
        chunkHash !== null && durableParsedFileDir !== undefined && durableHitKeys.has(chunkHash);

      if (cachedRaw && cachedRaw.length > 0 && (durableHit || parsedFileStorePath === undefined)) {
        // Cache hit: replay cached worker output. Finalize any parked worker
        // chunk FIRST so deferred aggregation stays in chunk order, then merge
        // + apply this hit inline (no worker dispatch to overlap).
        if (pendingWorkerChunk) {
          await finalizeWorkerChunk(pendingWorkerChunk);
          pendingWorkerChunk = null;
        }
        chunkCacheHits++;
        const chunkWorkerData = mergeChunkResults(graph, symbolTable, cachedRaw, exportedTypeMap);
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
        // Restore the chunk's durable ParsedFile shards into the run-scoped
        // store so scope-resolution finds full coverage with ZERO main-thread
        // re-parse. A verbatim byte copy — byte-identical to a cold run.
        if (durableHit && durableParsedFileDir && parsedFileStorePath && chunkHash) {
          const restored = await restoreDurableParsedFileShard(
            durableParsedFileDir,
            parsedFileStorePath,
            chunkHash,
          );
          if (restored === 0) {
            logger.warn(
              `parsedfile-cache: durable shards missing for cached chunk ` +
                `${chunkHash.slice(0, 8)} — scope-resolution will re-extract these files`,
            );
          }
        }
        await applyChunkResults(chunkWorkerData, chunkIdx, chunkFiles, chunkStartMs);
      } else {
        // Cache miss: dispatch to workers, capture the raw results, store
        // them under the chunk hash for the next run.
        chunkCacheMisses++;
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
        // Worker path — PIPELINE: kick off this chunk's dispatch, merge the
        // PREVIOUS chunk while these workers parse, then park this chunk for
        // the next iteration to merge (overlapping its parse). The deferred
        // merge + parse-cache write-guard + aggregation all run in
        // `finalizeWorkerChunk`, in chunk order. The pool is the sole parse
        // path — `getOrCreateWorkerPool` returns a pool or throws.
        const dispatchPromise = dispatchChunkParse(
          chunkFiles,
          activeWorkerPool,
          progressForChunk,
          undefined,
          chunkHash ?? undefined,
        );
        // Mark handled so a rejection during the overlap drain below isn't
        // flagged as unhandled; the `await` re-throws it for real handling.
        dispatchPromise.catch(() => {});
        if (pendingWorkerChunk) {
          await finalizeWorkerChunk(pendingWorkerChunk);
          pendingWorkerChunk = null;
        }
        let chunkResults: ParseWorkerResult[];
        try {
          chunkResults = await dispatchPromise;
        } catch (err) {
          if (!(err instanceof WorkerPoolInitializationError)) throw err;
          // Every worker crashed during startup and the pool's bounded
          // self-heal was exhausted. Fail fast (#1741) — there is no sequential
          // parser to degrade to. `handleWorkerStartupFailure` always throws, so
          // `chunkResults` stays definitely assigned for the parked chunk below.
          handleWorkerStartupFailure(err);
        }
        pendingWorkerChunk = {
          rawResults: chunkResults,
          chunkIdx,
          chunkHash,
          chunkFiles,
          chunkStartMs,
        };
      }

      // (Per-chunk aggregation + parse-cache write + throughput log now run in
      // `applyChunkResults` / `finalizeWorkerChunk` — see the merge-pipelining
      // block above. Route/import/inheritance edges are emitted later: route
      // resolution in the single end-of-loop pass below, the rest by the
      // scope-resolution phase, RING4-2 #943.)
    }

    // Drain the final parked worker chunk — the last pipelined chunk has no
    // successor to overlap its merge with, so merge + finalize it here.
    if (pendingWorkerChunk) {
      await finalizeWorkerChunk(pendingWorkerChunk);
      pendingWorkerChunk = null;
    }

    if (isDev && parseCache && (chunkCacheHits > 0 || chunkCacheMisses > 0)) {
      logger.info(
        `📦 parse-cache summary: ${chunkCacheHits} chunk hit(s), ${chunkCacheMisses} miss(es) across ${numChunks} chunk(s)`,
      );
    }

    logHeapProbe(
      'post-parse-chunks',
      `routes=${allExtractedRoutes.length} nodes=${graph.nodeCount} parsedFiles=${allParsedFiles.length}`,
    );

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
      logHeapProbe('pre-buildExportedTypeMapFromGraph');
      const graphExports = buildExportedTypeMapFromGraph(graph, model.symbols);
      for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
      logHeapProbe('post-buildExportedTypeMapFromGraph');
    }
    // Whole-repo, cross-file route extraction (e.g. Django) runs on the main
    // thread — the worker has no filesystem access and can't follow `include()`
    // chains across files. Merge its routes in before `processRoutesFromExtracted`
    // and the routes phase consume `allExtractedRoutes`.
    const crossFileRoutes = await extractCrossFileRoutes(allPaths, repoPath);
    if (crossFileRoutes.length > 0) {
      for (const r of crossFileRoutes) allExtractedRoutes.push(r);
      if (deferredProfile) {
        logDeferredProfile(`cross-file routes: +${crossFileRoutes.length}`);
      }
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

  // Fetch calls + ORM queries were already extracted inside each worker
  // (returned in ParseWorkerResult, aggregated per chunk in applyChunkResults).
  // With sequential parsing removed there is no post-loop drain to run — only
  // the TypeEnv finalize + enrichment that the drain's `finally` used to host.
  // Finalize the accumulator and propagate any fixpoint-inferred exports before
  // `crossFile` disposes it downstream. Wrapped in try/catch so a cleanup
  // failure never masks a real parse error; disposal stays with `crossFile`.
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
        'Post-parse finalize/enrich failed during cleanup:',
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

  // Cross-file Spring interface-inheritance pass (#2288): a concrete
  // `@RestController` inherits the `@*Mapping`s declared on the interfaces it
  // implements. The per-file `SharedSpringType` views collected by the Java
  // provider's `extractRouteInheritanceTypes` hook are resolved here, project-
  // wide, into decorator routes attributed to the implementing controller (the
  // interface's own per-file routes were suppressed at extraction). Mirrors the
  // group layer via the shared `resolveInheritedSpringRoutes` so both agree.
  if (allSpringTypes.length > 0) {
    for (const inherited of resolveInheritedSpringRoutes(allSpringTypes)) {
      allDecoratorRoutes.push({
        filePath: inherited.filePath,
        routePath: inherited.path,
        httpMethod: inherited.method,
        decoratorName: 'inherited-mapping',
        lineNumber: 0,
        handlerName: inherited.methodName,
      });
    }
  }

  logHeapProbe(
    'parse-impl-return',
    `exportedTypeMap=${exportedTypeMap.size} parsedFiles=${allParsedFiles.length} nodes=${graph.nodeCount}`,
  );
  // Part 2 (#2138): resolve each route's handler to a real symbol UID now that
  // the model is fully populated and decorator-route prefixes are finalized.
  const routeHandlerSymbols = resolveRouteHandlerSymbols(
    model,
    allExtractedRoutes,
    allDecoratorRoutes,
  );
  return {
    exportedTypeMap,
    allFetchCalls,
    allFetchWrapperDefs,
    allExtractedRoutes,
    allDecoratorRoutes,
    allToolDefs,
    allORMQueries,
    bindingAccumulator,
    routeHandlerSymbols,
    model,
    // Whether a worker pool was actually constructed for this run. False means
    // no pool was needed: a warm all-cache-hit run replays cached worker output
    // without spawning workers, or there were no parseable files.
    usedWorkerPool: workerPool !== undefined,
    // Per-file ParsedFile artifacts produced by workers' calls to
    // `extractParsedFile`. Consumed by scope-resolution as a re-extraction
    // cache: when the file's ParsedFile is here, scope-resolution skips its own
    // `extractParsedFile` call.
    parsedFiles: allParsedFiles,
  };
}
