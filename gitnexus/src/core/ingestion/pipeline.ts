import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processParsing } from './parsing-processor.js';
import { processImports, processImportsFromExtracted, createImportMap, buildImportResolutionContext } from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted } from './call-processor.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createSymbolTable } from './symbol-table.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';

const isDev = process.env.NODE_ENV === 'development';

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const symbolTable = createSymbolTable();
  let astCache = createASTCache(AST_CACHE_CAP);
  const importMap = createImportMap();

  const cleanup = () => {
    astCache.clear();
    symbolTable.clear();
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

    // Create worker pool once, reuse across chunks
    let workerPool: WorkerPool | undefined;
    try {
      const workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
      workerPool = createWorkerPool(workerUrl);
    } catch (err) {
      // Worker pool creation failed — sequential fallback
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

        if (chunkWorkerData) {
          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, importMap, undefined, repoPath, importCtx);
          // Calls — resolve immediately, then free the array
          if (chunkWorkerData.calls.length > 0) {
            await processCallsFromExtracted(graph, chunkWorkerData.calls, symbolTable, importMap);
          }
          // Heritage — resolve immediately, then free
          if (chunkWorkerData.heritage.length > 0) {
            await processHeritageFromExtracted(graph, chunkWorkerData.heritage, symbolTable);
          }
          // Routes — resolve immediately (Laravel route→controller CALLS edges)
          if (chunkWorkerData.routes && chunkWorkerData.routes.length > 0) {
            await processRoutesFromExtracted(graph, chunkWorkerData.routes, symbolTable, importMap);
          }
        } else {
          await processImports(graph, chunkFiles, astCache, importMap, undefined, repoPath, allPaths);
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
      await processCalls(graph, chunkFiles, astCache, symbolTable, importMap);
      await processHeritage(graph, chunkFiles, astCache, symbolTable);
      astCache.clear();
    }

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    (importCtx as any).suffixIndex = null;
    (importCtx as any).normalizedFileList = null;

    if (isDev) {
      let importsCount = 0;
      for (const r of graph.iterRelationships()) {
        if (r.type === 'IMPORTS') importsCount++;
      }
      console.log(`📊 Pipeline: graph has ${importsCount} IMPORTS, ${graph.relationshipCount} total relationships`);
    }

    // ── Phase 5: Communities ───────────────────────────────────────────
    onProgress({
      phase: 'communities',
      percent: 82,
      message: 'Detecting code communities...',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });

    const communityResult = await processCommunities(graph, (message, progress) => {
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

    const processResult = await processProcesses(
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

    onProgress({
      phase: 'complete',
      percent: 100,
      message: `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`,
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount
      },
    });

    astCache.clear();

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult };
  } catch (error) {
    cleanup();
    throw error;
  }
};
