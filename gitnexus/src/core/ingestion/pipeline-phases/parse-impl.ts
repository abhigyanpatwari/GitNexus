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
import { processParsing } from '../parsing-processor.js';
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
import { createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { createWorkerPool } from '../workers/worker-pool.js';
import type { WorkerPool } from '../workers/worker-pool.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
} from '../workers/parse-worker.js';
import type { ExtractedHeritage } from '../model/heritage-map.js';
import type { KnowledgeGraph } from '../../graph/types.js';
import type { PipelineOptions } from '../pipeline.js';
import { extractFetchCallsFromFiles } from '../call-processor.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isDev } from '../utils/env.js';
import { synthesizeWildcardImportBindings, needsSynthesis } from './wildcard-synthesis.js';
import { extractORMQueriesInline } from './orm-extraction.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Max bytes of source content to load per parse chunk. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

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
  allExtractedRoutes: ExtractedRoute[];
  allDecoratorRoutes: ExtractedDecoratorRoute[];
  allToolDefs: ExtractedToolDef[];
  allORMQueries: ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  resolutionContext: ReturnType<typeof createResolutionContext>;
  usedWorkerPool: boolean;
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
    console.warn(
      `Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`,
    );
  }

  const totalParseable = parseableScanned.length;

  if (totalParseable === 0) {
    onProgress({
      phase: 'parsing',
      percent: 82,
      message: 'No parseable files found — skipping parsing phase',
      stats: { filesProcessed: 0, totalFiles: 0, nodesCreated: graph.nodeCount },
    });
  }

  // Build byte-budget chunks
  const chunks: string[][] = [];
  let currentChunk: string[] = [];
  let currentBytes = 0;
  for (const file of parseableScanned) {
    if (currentChunk.length > 0 && currentBytes + file.size > CHUNK_BYTE_BUDGET) {
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
    console.log(
      `📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`,
    );
  }

  onProgress({
    phase: 'parsing',
    percent: 20,
    message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
    stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
  });

  // Don't spawn workers for tiny repos — overhead exceeds benefit.
  // Test suites may lower the thresholds via `options.workerThresholdsForTest`
  // to exercise the worker-pool path with small fixtures; see PipelineOptions.
  const MIN_FILES_FOR_WORKERS = options?.workerThresholdsForTest?.minFiles ?? 15;
  const MIN_BYTES_FOR_WORKERS = options?.workerThresholdsForTest?.minBytes ?? 512 * 1024;
  const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);

  // Create worker pool once, reuse across chunks
  let workerPool: WorkerPool | undefined;
  if (
    !options?.skipWorkers &&
    (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS)
  ) {
    try {
      let workerUrl = new URL('../workers/parse-worker.js', import.meta.url);
      // When running under vitest, import.meta.url points to src/ where no .js exists.
      // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
      const thisDir = fileURLToPath(new URL('.', import.meta.url));
      if (!fs.existsSync(fileURLToPath(workerUrl))) {
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
      workerPool = createWorkerPool(workerUrl);
    } catch (err) {
      console.warn(
        'Worker pool creation failed, using sequential fallback:',
        (err as Error).message,
      );
    }
  }

  let filesParsedSoFar = 0;

  // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
  const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
  let astCache = createASTCache(maxChunkFiles);

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
  const allExtractedRoutes: ExtractedRoute[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const deferredWorkerCalls: ExtractedCall[] = [];
  const deferredWorkerHeritage: ExtractedHeritage[] = [];
  const deferredConstructorBindings: FileConstructorBindings[] = [];
  const deferredAssignments: ExtractedAssignment[] = [];

  try {
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkPaths = chunks[chunkIdx];

      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));

      const chunkWorkerData = await processParsing(
        graph,
        chunkFiles,
        symbolTable,
        astCache,
        (current, _total, filePath) => {
          const globalCurrent = filesParsedSoFar + current;
          const parsingProgress = 20 + (globalCurrent / totalParseable) * 62;
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
        },
        workerPool,
      );

      const chunkBasePercent = 20 + (filesParsedSoFar / totalParseable) * 62;

      if (chunkWorkerData) {
        await processImportsFromExtracted(
          graph,
          allPathObjects,
          chunkWorkerData.imports,
          ctx,
          (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
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
        if (chunkNeedsSynthesis[chunkIdx]) {
          synthesizeWildcardImportBindings(graph, ctx);
          hasSynthesized = true;
        }
        if (exportedTypeMap.size > 0 && ctx.namedImportMap.size > 0) {
          const { enrichedCount } = seedCrossFileReceiverTypes(
            chunkWorkerData.calls,
            ctx.namedImportMap,
            exportedTypeMap,
          );
          if (isDev && enrichedCount > 0) {
            console.log(
              `🔗 E1: Seeded ${enrichedCount} cross-file receiver types (chunk ${chunkIdx + 1})`,
            );
          }
        }
        for (const item of chunkWorkerData.calls) deferredWorkerCalls.push(item);
        for (const item of chunkWorkerData.heritage) deferredWorkerHeritage.push(item);
        for (const item of chunkWorkerData.constructorBindings)
          deferredConstructorBindings.push(item);
        if (chunkWorkerData.assignments?.length) {
          for (const item of chunkWorkerData.assignments) deferredAssignments.push(item);
        }

        await Promise.all([
          processHeritageFromExtracted(graph, chunkWorkerData.heritage, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving heritage (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} records`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          }),
          processRoutesFromExtracted(graph, chunkWorkerData.routes ?? [], ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving routes (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} routes`,
              stats: {
                filesProcessed: filesParsedSoFar,
                totalFiles: totalParseable,
                nodesCreated: graph.nodeCount,
              },
            });
          }),
        ]);

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
    }

    const fullWorkerHeritageMap =
      deferredWorkerHeritage.length > 0
        ? buildHeritageMap(deferredWorkerHeritage, ctx, getHeritageStrategyForLanguage)
        : undefined;

    if (deferredWorkerCalls.length > 0) {
      await processCallsFromExtracted(
        graph,
        deferredWorkerCalls,
        ctx,
        (current, total) => {
          onProgress({
            phase: 'parsing',
            percent: 82,
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
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));
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
      console.log(
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
        console.log(
          `🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`,
        );
      }
    } catch (enrichErr) {
      if (isDev) {
        console.warn(
          'Post-fallback finalize/enrich failed during cleanup:',
          (enrichErr as Error).message,
        );
      }
    }
  }

  if (!hasSynthesized) {
    const synthesized = synthesizeWildcardImportBindings(graph, ctx);
    if (isDev && synthesized > 0) {
      console.log(
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
  };
}
