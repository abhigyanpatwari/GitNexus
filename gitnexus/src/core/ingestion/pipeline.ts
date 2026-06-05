import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { isConfigFile, processConfigFiles } from './config-indexer.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { processCalls, processCallsFromExtracted, processRoutesFromExtracted, processORMQueriesFromExtracted, processExpoRoutesWithRepoId, processExpoRouterNavigations, processDecoratorRoutesWithRepoId, processPHPRoutesWithRepoId, processNextjsRoutesWithRepoId, processNextjsFetchRoutes, processNextjsMiddleware, processToolDefsFromExtracted } from './call-processor.js';
import type { ExtractedRoute, ExtractedExpoNav, ExtractedORMQuery, ExtractedDecoratorRoute, ExtractedFetchCall, ExtractedToolDef } from './workers/parse-worker.js';
import type { CrossRepoRegistry } from './cross-repo-registry.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { processAngularMetadataFromExtracted } from './angular-metadata-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { extractDependencies } from './dependency-extractor.js';
import { writeManifest } from '../../storage/repo-manifest.js';
import { createResolutionContext, type ResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils/language-detection.js';
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
  /**
   * #50: when provided, unresolved imports whose package maps to an indexed
   * dependency repo create an external File node + CROSS_IMPORTS edge. When
   * omitted (the default), ingestion is single-repo and creates no external nodes.
   */
  crossRepoRegistry?: CrossRepoRegistry;
}

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  let ctx: ResolutionContext;
  let symbolTable;
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

    // ── Phase 2.5: Config Files (application*.properties/yml) ────────────
    // Index config files separately from source code parsing
    const configFileNames = allPaths.filter(isConfigFile);
    if (configFileNames.length > 0) {
      onProgress({
        phase: 'parsing',
        percent: 21,
        message: `Indexing ${configFileNames.length} config file${configFileNames.length !== 1 ? 's' : ''}...`,
        stats: { filesProcessed: 0, totalFiles: configFileNames.length, nodesCreated: graph.nodeCount },
      });

      const configFileContents = await readFileContents(repoPath, configFileNames);
      const configFiles = configFileNames
        .filter(p => configFileContents.has(p))
        .map(p => ({ path: p, content: configFileContents.get(p)! }));

      const propertyCount = processConfigFiles(graph, configFiles);
      
      if (isDev && propertyCount > 0) {
        console.log(`⚙️  Indexed ${propertyCount} properties from ${configFileNames.length} config file${configFileNames.length !== 1 ? 's' : ''}`);
      }
    }

    // ── Phase 2.5: Dependency Extraction ─────────────────────────────
    onProgress({
      phase: 'extracting',
      percent: 20,
      message: 'Extracting dependencies...',
    });

    let extractionRepoId: string | undefined;
    try {
      const extractionResult = await extractDependencies(repoPath);
      extractionRepoId = extractionResult.repoId;
      // Convert ExtractionResult to RepoManifest format
      const manifest: import('../../storage/repo-manifest.js').RepoManifest = {
        repoId: extractionResult.repoId,
        indexedAt: extractionResult.indexedAt,
        dependencies: extractionResult.dependencies.map(d => d.name),
      };
      if (isDev && manifest.dependencies.length > 0) {
        console.log(`📦 Extracted ${manifest.dependencies.length} dependencies from ${extractionResult.ecosystem}`);
      }
      try {
        await writeManifest(repoPath, manifest);
      } catch (manifestErr) {
        console.warn('Failed to write repo manifest:', (manifestErr as Error).message);
      }
    } catch (err) {
      // Non-fatal: dependency extraction failure shouldn't stop indexing
      console.warn('Dependency extraction failed:', (err as Error).message);
    }

    // Always initialize ctx/symbolTable — never leave them undefined
    ctx = createResolutionContext(graph, extractionRepoId);
    symbolTable = ctx.symbols;

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
    const MIN_FILES_FOR_WORKERS = 1000000;
    const MIN_BYTES_FOR_WORKERS = 1024 * 1024 * 1024;  // 512KB threshold
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
    const sequentialChunkRoutes: ExtractedRoute[][] = [];
    // Accumulate expoNavCalls, ormQueries, fetchCalls across chunks for processing after all chunks
    const allExpoNavCalls: ExtractedExpoNav[] = [];
    const allORMQueries: ExtractedORMQuery[] = [];
    const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
    const allFetchCalls: ExtractedFetchCall[] = [];
    const allToolDefs: ExtractedToolDef[] = [];
    const allAngularMetadata: import('./workers/parse-worker.js').ExtractedAngularEdge[] = [];
    // #31: Angular CALLS extracted in the sequential parsing pass (DI/template).
    const allSequentialCalls: import('./workers/parse-worker.js').ExtractedCall[] = [];

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

        if (workerPool && chunkWorkerData) {
          // Worker path: use extracted data for imports, heritage, calls, routes
          // Imports
          await processImportsFromExtracted(graph, allPathObjects, chunkWorkerData.imports, ctx, (current, total) => {
            onProgress({
              phase: 'parsing',
              percent: Math.round(chunkBasePercent),
              message: `Resolving imports (chunk ${chunkIdx + 1}/${numChunks})...`,
              detail: `${current}/${total} files`,
              stats: { filesProcessed: filesParsedSoFar, totalFiles: totalParseable, nodesCreated: graph.nodeCount },
            });
          }, repoPath, importCtx, options?.crossRepoRegistry);
          // Calls + Heritage + Routes — resolve in parallel (no shared mutable state between them)
          // This is safe because each writes disjoint relationship types into idempotent id-keyed Maps,
          // and the single-threaded event loop prevents races between synchronous addRelationship calls.

          // Heritage MUST run before calls: IMPLEMENTS edges (from heritage) are needed
          // for D5 call resolution to work correctly. Call resolution depends on
          // interface/implementation edges being established first.
          await processHeritageFromExtracted(
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
          );

          await processCallsFromExtracted(
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
          );

          await processRoutesFromExtracted(
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
          );
          // Accumulate expoNavCalls and ormQueries for post-processing after all chunks
          if (chunkWorkerData.expoNavCalls) {
            allExpoNavCalls.push(...chunkWorkerData.expoNavCalls);
          }
          if (chunkWorkerData.ormQueries) {
            allORMQueries.push(...chunkWorkerData.ormQueries);
          }
          // Accumulate decoratorRoutes (Express/Hono) for post-processing
          if (chunkWorkerData.decoratorRoutes) {
            allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes);
          }
          // Accumulate angularMetadata (NgModule edges) for post-processing
          if (chunkWorkerData.angularMetadata) {
            allAngularMetadata.push(...chunkWorkerData.angularMetadata);
          }
          // Accumulate fetchCalls for post-processing
          if (chunkWorkerData.fetchCalls) {
            allFetchCalls.push(...chunkWorkerData.fetchCalls);
          }
          // Accumulate toolDefs for post-processing
          if (chunkWorkerData.toolDefs) {
            allToolDefs.push(...chunkWorkerData.toolDefs);
          }
        } else {
          // Sequential path: processImports adds symbols, then heritage/calls are resolved
          // in the sequential fallback loop below (lines 351-365)
          await processImports(graph, chunkFiles, astCache, ctx, undefined, repoPath, allPaths, options?.crossRepoRegistry);
          sequentialChunkPaths.push(chunkPaths);
          sequentialChunkRoutes.push(chunkWorkerData.routes ?? []);
          // Accumulate expoNavCalls and ormQueries for sequential path too
          if (chunkWorkerData.expoNavCalls) {
            allExpoNavCalls.push(...chunkWorkerData.expoNavCalls);
          }
          if (chunkWorkerData.ormQueries) {
            allORMQueries.push(...chunkWorkerData.ormQueries);
          }
          if (chunkWorkerData.decoratorRoutes) {
            allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes);
          }
          if (chunkWorkerData.angularMetadata) {
            allAngularMetadata.push(...chunkWorkerData.angularMetadata);
          }
          // #31: Angular CALLS extracted by the sequential parsing pass. The
          // general call graph is resolved via processCalls re-extraction below;
          // chunkWorkerData.calls carries ONLY the Angular DI/template calls here.
          if (chunkWorkerData.calls && chunkWorkerData.calls.length > 0) {
            allSequentialCalls.push(...chunkWorkerData.calls);
          }
          // Accumulate fetchCalls for sequential path too
          if (chunkWorkerData.fetchCalls) {
            allFetchCalls.push(...chunkWorkerData.fetchCalls);
          }
          // Accumulate toolDefs for sequential path too
          if (chunkWorkerData.toolDefs) {
            allToolDefs.push(...chunkWorkerData.toolDefs);
          }
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
    for (let chunkIdx = 0; chunkIdx < sequentialChunkPaths.length; chunkIdx++) {
      const chunkPaths = sequentialChunkPaths[chunkIdx];
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      await processHeritage(graph, chunkFiles, astCache, ctx);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, ctx);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      const chunkRoutes = sequentialChunkRoutes[chunkIdx];
      if (chunkRoutes.length > 0) {
        await processRoutesFromExtracted(graph, chunkRoutes, ctx);
      }
      astCache.clear();
    }

    // Post-processing: Expo routes and ORM queries (accumulated across all chunks)
    // Process Expo Router routes and navigation
    const expoPaths = allPaths.filter(p => p.includes('app/'));
    if (expoPaths.length > 0) {
      const routeRegistry = processExpoRoutesWithRepoId(graph, expoPaths, ctx.repoId ?? '');
      if (allExpoNavCalls.length > 0) {
        processExpoRouterNavigations(graph, allExpoNavCalls, routeRegistry);
      }
    }

    // Process ORM queries
    if (allORMQueries.length > 0) {
      processORMQueriesFromExtracted(graph, allORMQueries);
    }

    // Process Express/Hono routes (decoratorRoutes extracted from JS/TS files)
    if (allDecoratorRoutes.length > 0) {
      processDecoratorRoutesWithRepoId(graph, allDecoratorRoutes, ctx.repoId ?? '');
    }

    // Process Angular @NgModule metadata edges (#32 — AppModule outgoing edges)
    if (allAngularMetadata.length > 0) {
      await processAngularMetadataFromExtracted(graph, allAngularMetadata, ctx);
    }

    // Process Angular CALLS edges (#31 — DI token -> service, template -> method).
    // Runs after the sequential fallback so component/service symbols exist.
    if (allSequentialCalls.length > 0) {
      await processCallsFromExtracted(graph, allSequentialCalls, ctx);
    }

    // Process MCP tool definitions (@mcp.tool() decorators)
    if (allToolDefs.length > 0) {
      await processToolDefsFromExtracted(graph, allToolDefs, ctx);
    }

    // Process PHP file-based routes (direct file routing in api/ directory)
    const phpApiPaths = allPaths.filter(p => p.endsWith('.php') && (p.startsWith('api/') || p.includes('/api/')));
    if (phpApiPaths.length > 0) {
      const phpContents = await readFileContents(repoPath, phpApiPaths);
      processPHPRoutesWithRepoId(graph, phpApiPaths, phpContents, ctx.repoId ?? '');
    }

    // Process Next.js App Router routes (app/api/**/route.ts files)
    // Match files like: app/api/grants/route.ts, app/api/users/[id]/route.ts
    const nextjsRoutePaths = allPaths.filter(p => /(?:^|\/)app\/api\/.*\/route\.(ts|js|tsx|jsx)$/.test(p));
    let nextjsRouteRegistry: Map<string, string> | undefined;
    if (nextjsRoutePaths.length > 0) {
      const nextjsContents = await readFileContents(repoPath, nextjsRoutePaths);
      nextjsRouteRegistry = processNextjsRoutesWithRepoId(graph, nextjsRoutePaths, nextjsContents, ctx.repoId ?? '');
    }

    // Process Next.js project-level middleware.ts and link to matching routes
    const allFileContents = await readFileContents(repoPath, allPaths);
    processNextjsMiddleware(graph, allPaths, allFileContents);

    // Process fetch() calls to create FETCHES edges to Route nodes
    if (allFetchCalls.length > 0 && nextjsRouteRegistry && nextjsRouteRegistry.size > 0) {
      // Collect consumer file paths and read their contents for key extraction
      const consumerPaths = [...new Set(allFetchCalls.map(c => c.filePath))];
      const consumerContents = await readFileContents(repoPath, consumerPaths);
      processNextjsFetchRoutes(graph, allFetchCalls, nextjsRouteRegistry, consumerContents);
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

    onProgress({
      phase: 'complete',
      percent: 100,
      message: communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
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

/**
 * Topological sort of files by import dependencies.
 * Files with no imports (in-degree 0) go in level 0.
 * Files that only depend on level 0 go in level 1, etc.
 * Files involved in cycles (no entry point) are grouped in a final level
 * and contribute to cycleCount.
 *
 * @param importMap  Map of file path → set of files it imports
 * @returns levels array (each level is an array of file paths) and cycle count
 */
export function topologicalLevelSort(
  importMap: Map<string, Set<string>>
): { levels: string[][]; cycleCount: number } {
  // in-degree = number of unprocessed dependencies this file has
  // A file can be processed when all its dependencies (imports) are processed
  const inDegree = new Map<string, number>();
  // dependents = files that depend on this file (for notification)
  const dependents = new Map<string, Set<string>>();

  // Collect ALL files: both keys (files with imports) and values (imported files)
  const allFiles = new Set<string>(importMap.keys());
  for (const deps of importMap.values()) {
    for (const dep of deps) {
      allFiles.add(dep);
    }
  }

  // Initialize: all files start with in-degree 0
  for (const file of allFiles) {
    inDegree.set(file, 0);
    dependents.set(file, new Set());
  }

  // Compute in-degrees: for each file, count its dependencies (imports)
  // Build reverse graph: for each imported file, track who imports it
  for (const [file, deps] of importMap) {
    // in-degree is the number of dependencies this file has
    inDegree.set(file, deps.size);
    for (const dep of deps) {
      // dep is imported by file, so file depends on dep
      // When dep is processed, file should be notified
      dependents.get(dep)!.add(file);
    }
  }

  const levels: string[][] = [];
  let cycleCount = 0;

  // Kahn's algorithm: process nodes with in-degree 0 (no remaining dependencies)
  let queue: string[] = [];
  for (const [file, degree] of inDegree) {
    if (degree === 0) queue.push(file);
  }

  while (queue.length > 0) {
    // All nodes in current queue are at the same level
    levels.push([...queue]);
    
    // Process all nodes at current level and collect next level
    const nextQueue: string[] = [];
    for (const file of queue) {
      // Notify all dependents that this dependency is processed
      for (const dependent of dependents.get(file) ?? new Set()) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextQueue.push(dependent);
        }
      }
    }
    
    queue = nextQueue;
  }

  // Remaining nodes are in cycles (no entry point found)
  const cycleNodes: string[] = [];
  for (const [file, degree] of inDegree) {
    if (degree > 0) {
      cycleNodes.push(file);
    }
  }

  if (cycleNodes.length > 0) {
    levels.push(cycleNodes);
    cycleCount = cycleNodes.length;
  }

  return { levels, cycleCount };
}
