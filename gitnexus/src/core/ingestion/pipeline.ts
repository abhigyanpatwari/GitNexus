import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted } from './call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { processMetricsFromGraph, MetricsResult } from './metrics-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDev = process.env.NODE_ENV === 'development';

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

export interface PipelineOptions {
  /** Skip MRO, community detection, and process extraction for faster test runs. */
  skipGraphPhases?: boolean;
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const ctx = createResolutionContext();
  const symbolTable = ctx.symbols;
  let astCache = createASTCache(AST_CACHE_CAP);

  const cleanup = () => {
    astCache.clear();
    ctx.clear();
  };

  try {
    // ── Phase 1: Scan paths only (no content read) ─────────────────────
    onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const scannedFiles = await walkRepositoryPaths(repoPath, (current, total, filePath) => {
      const scanProgress = Math.round((current / total) * 15);
      onProgress({
        phase: 'extracting',
        percent: scanProgress,
        message: 'Scanning repository...',
        detail: filePath,
        stats: { filesProcessed: current, totalFiles: total, nodesCreated: graph.nodeCount },
      });
    });

    const totalFiles = scannedFiles.length;

    onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 2: Structure (paths only — no content needed) ────────────
    onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles, nodesCreated: graph.nodeCount },
    });

    const allPaths = scannedFiles.map(f => f.path);
    processStructure(graph, allPaths);

    onProgress({
      phase: 'structure',
      percent: 20,
      message: 'Project structure analyzed',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    // ── Phase 3+4: Chunked read + parse ────────────────────────────────
    // Group parseable files into byte-budget chunks so only ~20MB of source
    // is in memory at a time. Each chunk is: read → parse → extract → free.

    const parseableScanned = scannedFiles.filter(f => {
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
      console.warn(`Skipping ${count} ${lang} file(s) — ${lang} parser not available (native binding may not have built). Try: npm rebuild tree-sitter-${lang}`);
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
      console.log(`📂 Scan: ${totalFiles} paths, ${totalParseable} parseable (${totalMB.toFixed(0)}MB), ${numChunks} chunks @ ${CHUNK_BYTE_BUDGET / (1024 * 1024)}MB budget`);
    }

    onProgress({
      phase: 'parsing',
      percent: 20,
      message: `Parsing ${totalParseable} files in ${numChunks} chunk${numChunks !== 1 ? 's' : ''}...`,
      stats: { filesProcessed: 0, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
    });

    // Don't spawn workers for tiny repos — overhead exceeds benefit
    const MIN_FILES_FOR_WORKERS = 15;
    const MIN_BYTES_FOR_WORKERS = 512 * 1024;
    const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);

    // Create worker pool once, reuse across chunks
    let workerPool: WorkerPool | undefined;
    if (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS) {
      try {
        let workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
        // When running under vitest, import.meta.url points to src/ where no .js exists.
        // Fall back to the compiled dist/ worker so the pool can spawn real worker threads.
        const thisDir = fileURLToPath(new URL('.', import.meta.url));
        if (!fs.existsSync(fileURLToPath(workerUrl))) {
          const distWorker = path.resolve(thisDir, '..', '..', '..', 'dist', 'core', 'ingestion', 'workers', 'parse-worker.js');
          if (fs.existsSync(distWorker)) {
            workerUrl = pathToFileURL(distWorker) as URL;
          }
        }
        workerPool = createWorkerPool(workerUrl);
      } catch (err) {
        if (isDev) console.warn('Worker pool creation failed, using sequential fallback:', (err as Error).message);
      }
    }

    let filesParsedSoFar = 0;

    // AST cache sized for one chunk (sequential fallback uses it for import/call/heritage)
    const maxChunkFiles = chunks.reduce((max, c) => Math.max(max, c.length), 0);
    astCache = createASTCache(maxChunkFiles);

    // Build import resolution context once — suffix index, file lists, resolve cache.
    // Reused across all chunks to avoid rebuilding O(files × path_depth) structures.
    const importCtx = buildImportResolutionContext(allPaths);
    const allPathObjects = allPaths.map(p => ({ path: p }));

    // Single-pass: parse + resolve imports/calls/heritage per chunk.
    // Calls/heritage use the symbol table built so far (symbols from earlier chunks
    // are already registered). This trades ~5% cross-chunk resolution accuracy for
    // 200-400MB less memory — critical for Linux-kernel-scale repos.
    const sequentialChunkPaths: string[][] = [];

    try {
      for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
        const chunkPaths = chunks[chunkIdx];

        // Read content for this chunk only
        const chunkContents = await readFileContents(repoPath, chunkPaths);
        const chunkFiles = chunkPaths
          .filter(p => chunkContents.has(p))
          .map(p => ({ path: p, content: chunkContents.get(p)! }));

        // Parse this chunk (workers or sequential fallback)
        const chunkWorkerData = await processParsing(
          graph, chunkFiles, symbolTable, astCache,
          (current, _total, filePath) => {
            const globalCurrent = filesParsedSoFar + current;
            const parsingProgress = 20 + ((globalCurrent / totalParseable) * 62);
            onProgress({
              phase: 'parsing',
              percent: Math.round(parsingProgress),
              message: `Parsing chunk ${chunkIdx + 1}/${numChunks}...`,
              detail: filePath,
              stats: { filesProcessed: globalCurrent, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          },
          workerPool,
        );

        const chunkBasePercent = 20 + ((filesParsedSoFar / totalParseable) * 62);

        if (chunkWorkerData) {
          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} files`,
              stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          }, repoPath, importCtx);
          // Calls + Heritage + Routes — resolve in parallel (no shared mutable state between them)
          // This is safe because each writes disjoint relationship types into idempotent id-keyed Maps,
          // and the single-threaded event loop prevents races between synchronous addRelationship calls.
          await Promise.all([
            processCallsFromExtracted(
              graph,
              chunkWorkerData.calls,
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving calls (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} files`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
              chunkWorkerData.constructorBindings,
            ),
            processHeritageFromExtracted(
              graph,
              chunkWorkerData.heritage,
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving heritage (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} records`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
            ),
            processRoutesFromExtracted(
              graph,
              chunkWorkerData.routes ?? [],
              ctx,
              (current, total) => {
                onProgress({
                  phase: 'parsing',
                  percent: Math.round(chunkBasePercent),
                  message: `Resolving routes (chunk ${chunkIdx + 1}/${numChunks})...`,
                  detail: `${current}/${total} routes`,
                  stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
                });
              },
            ),
          ]);
        } else {
          await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths);
          sequentialChunkPaths.push(chunkPaths);
        }

        filesParsedSoFar += chunkFiles.length;

        // Clear AST cache between chunks to free memory
        astCache.clear();
        // chunkContents + chunkFiles + chunkWorkerData go out of scope → GC reclaims
      }
    } finally {
      await workerPool?.terminate();
    }

    // Sequential fallback chunks: re-read source for call/heritage resolution
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, ctx);
      await processHeritage(graph, chunkFiles, astCache, ctx);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      astCache.clear();
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      console.log(`🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`);
    }

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    (importCtx as any).suffixIndex = null;
    (importCtx as any).normalizedFileList = null;

    let communityResult: Awaited<ReturnType<typeof processCommunities>> | undefined;
    let processResult: Awaited<ReturnType<typeof processProcesses>> | undefined;

    if (!options?.skipGraphPhases) {
      // ── Phase 4.5: Method Resolution Order ──────────────────────────────
      onProgress({
        phase: 'parsing',
        percent: 81,
        message: 'Computing method resolution order...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      const mroResult = computeMRO(graph);
      if (isDev && mroResult.entries.length > 0) {
        console.log(`🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities found, ${mroResult.overrideEdges} OVERRIDES edges`);
      }

      // ── Phase 5: Communities ───────────────────────────────────────────
      onProgress({
        phase: 'communities',
        percent: 82,
        message: 'Detecting code communities...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      communityResult = await processCommunities(graph, (message, progress) => {
        const communityProgress = 82 + (progress * 0.10);
        onProgress({
          phase: 'communities',
          percent: Math.round(communityProgress),
          message,
          stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
        });
      });

      if (isDev) {
        console.log(`🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`);
      }

      communityResult.communities.forEach(comm => {
        graph.addNode({
          id: comm.id,
          label: 'Community' as const,
          properties: {
            name: comm.label,
            filePath: '',
            heuristicLabel: comm.heuristicLabel,
            cohesion: comm.cohesion,
            symbolCount: comm.symbolCount,
          }
        });
      });

      communityResult.memberships.forEach(membership => {
        graph.addRelationship({
          id: `${membership.nodeId}_member_of_${membership.communityId}`,
          type: 'MEMBER_OF',
          sourceId: membership.nodeId,
          targetId: membership.communityId,
          confidence: 1.0,
          reason: 'leiden-algorithm',
        });
      });

      // ── Phase 6: Processes ─────────────────────────────────────────────
      onProgress({
        phase: 'processes',
        percent: 94,
        message: 'Detecting execution flows...',
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });

      let symbolCount = 0;
      graph.forEachNode(n => { if (n.label !== 'File') symbolCount++; });
      const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

      processResult = await processProcesses(
        graph,
        communityResult.memberships,
        (message, progress) => {
          const processProgress = 94 + (progress * 0.05);
          onProgress({
            phase: 'processes',
            percent: Math.round(processProgress),
            message,
            stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
          });
        },
        { maxProcesses: dynamicMaxProcesses, minSteps: 3 }
      );

      if (isDev) {
        console.log(`🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`);
      }

      processResult.processes.forEach(proc => {
        graph.addNode({
          id: proc.id,
          label: 'Process' as const,
          properties: {
            name: proc.label,
            filePath: '',
            heuristicLabel: proc.heuristicLabel,
            processType: proc.processType,
            stepCount: proc.stepCount,
            communities: proc.communities,
            entryPointId: proc.entryPointId,
            terminalId: proc.terminalId,
          }
        });
      });

      processResult.steps.forEach(step => {
        graph.addRelationship({
          id: `${step.nodeId}_step_${step.step}_${step.processId}`,
          type: 'STEP_IN_PROCESS',
          sourceId: step.nodeId,
          targetId: step.processId,
          confidence: 1.0,
          reason: 'trace-detection',
          step: step.step,
        });
      });
    }

    // ── Phase 7: Metrics ─────────────────────────────────────────────
    onProgress({
      phase: 'metrics',
      percent: 98,
      message: 'Calculating code metrics...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    const metricsResult = processMetricsFromGraph(graph, (message, progress) => {
      const metricsProgress = 98 + (progress * 0.02);
      onProgress({
        phase: 'metrics',
        percent: Math.round(metricsProgress),
        message,
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });
    });

    if (isDev) {
      console.log(`📊 Metrics: ${metricsResult.stats.totalNodesProcessed} nodes analyzed (avg complexity: ${metricsResult.stats.avgComplexity}, critical: ${metricsResult.stats.criticalCount})`);
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      message: communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes, ${metricsResult.stats.criticalCount} critical hotspots.`
        : 'Graph complete! (graph phases skipped)',
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult, metricsResult };
  } catch (error) {
    cleanup();
    throw error;
  }
};
