/**
 * Parse implementation — extracted from pipeline.ts.
 *
 * Contains the chunked parse + resolve loop and its helper functions:
 * - synthesizeWildcardImportBindings
 * - runChunkedParseAndResolve (renamed export)
 * - extractORMQueriesInline
 *
 * This module is consumed by the parse phase (`parse.ts`) and exists
 * to keep the phase file focused on DAG wiring while the heavy implementation
 * lives here.
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
import { SupportedLanguages } from 'gitnexus-shared';
import { providers, getProviderForFile } from '../languages/index.js';
import { createWorkerPool, WorkerPool } from '../workers/worker-pool.js';
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

const isDev = process.env.NODE_ENV === 'development';

// ── Constants ──────────────────────────────────────────────────────────────

/** Max bytes of source content to load per parse chunk. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

/** Node labels that represent top-level importable symbols. */
const IMPORTABLE_SYMBOL_LABELS = new Set([
  'Function',
  'Class',
  'Interface',
  'Struct',
  'Enum',
  'Trait',
  'TypeAlias',
  'Const',
  'Static',
  'Record',
  'Union',
  'Typedef',
  'Macro',
]);

/** Max synthetic bindings per importing file. */
const MAX_SYNTHETIC_BINDINGS_PER_FILE = 1000;

/** Pre-computed language sets derived from providers at module load. */
const WILDCARD_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics === 'wildcard')
    .map((p) => p.id),
);
const SYNTHESIS_LANGUAGES = new Set(
  Object.values(providers)
    .filter((p) => p.importSemantics !== 'named')
    .map((p) => p.id),
);

function isWildcardImportLanguage(lang: SupportedLanguages): boolean {
  return WILDCARD_LANGUAGES.has(lang);
}

function needsSynthesis(lang: SupportedLanguages): boolean {
  return SYNTHESIS_LANGUAGES.has(lang);
}

// ── Wildcard synthesis ─────────────────────────────────────────────────────

/** Synthesize namedImportMap entries for languages with whole-module imports. */
function synthesizeWildcardImportBindings(
  graph: KnowledgeGraph,
  ctx: ReturnType<typeof createResolutionContext>,
): number {
  const exportedSymbolsByFile = new Map<string, { name: string; filePath: string }[]>();
  graph.forEachNode((node) => {
    if (!node.properties?.isExported) return;
    if (!IMPORTABLE_SYMBOL_LABELS.has(node.label)) return;
    const fp = node.properties.filePath;
    const name = node.properties.name;
    if (!fp || !name) return;
    let symbols = exportedSymbolsByFile.get(fp);
    if (!symbols) {
      symbols = [];
      exportedSymbolsByFile.set(fp, symbols);
    }
    symbols.push({ name, filePath: fp });
  });

  if (exportedSymbolsByFile.size === 0) return 0;

  const FILE_PREFIX = 'File:';
  const graphImports = new Map<string, Set<string>>();
  graph.forEachRelationship((rel) => {
    if (rel.type !== 'IMPORTS') return;
    if (!rel.sourceId.startsWith(FILE_PREFIX) || !rel.targetId.startsWith(FILE_PREFIX)) return;
    const srcFile = rel.sourceId.slice(FILE_PREFIX.length);
    const tgtFile = rel.targetId.slice(FILE_PREFIX.length);
    const lang = getLanguageFromFilename(srcFile);
    if (!lang || !isWildcardImportLanguage(lang)) return;
    if (ctx.importMap.get(srcFile)?.has(tgtFile)) return;
    let set = graphImports.get(srcFile);
    if (!set) {
      set = new Set();
      graphImports.set(srcFile, set);
    }
    set.add(tgtFile);
  });

  let totalSynthesized = 0;

  const synthesizeForFile = (filePath: string, importedFiles: Iterable<string>) => {
    let fileBindings = ctx.namedImportMap.get(filePath);
    let fileCount = fileBindings?.size ?? 0;

    for (const importedFile of importedFiles) {
      const exportedSymbols = exportedSymbolsByFile.get(importedFile);
      if (!exportedSymbols) continue;

      for (const sym of exportedSymbols) {
        if (fileCount >= MAX_SYNTHETIC_BINDINGS_PER_FILE) return;
        if (fileBindings?.has(sym.name)) continue;

        if (!fileBindings) {
          fileBindings = new Map();
          ctx.namedImportMap.set(filePath, fileBindings);
        }
        fileBindings.set(sym.name, {
          sourcePath: importedFile,
          exportedName: sym.name,
        });
        fileCount++;
        totalSynthesized++;
      }
    }
  };

  for (const [filePath, importedFiles] of ctx.importMap) {
    const lang = getLanguageFromFilename(filePath);
    if (!lang || !isWildcardImportLanguage(lang)) continue;
    synthesizeForFile(filePath, importedFiles);
  }

  for (const [filePath, importedFiles] of graphImports) {
    synthesizeForFile(filePath, importedFiles);
  }

  const buildPythonModuleAliasForFile = (callerFile: string, importedFiles: Iterable<string>) => {
    let aliasMap = ctx.moduleAliasMap.get(callerFile);
    for (const importedFile of importedFiles) {
      const lastSlash = importedFile.lastIndexOf('/');
      const base = lastSlash >= 0 ? importedFile.slice(lastSlash + 1) : importedFile;
      const dot = base.lastIndexOf('.');
      const stem = dot >= 0 ? base.slice(0, dot) : base;
      if (!stem) continue;
      if (!aliasMap) {
        aliasMap = new Map();
        ctx.moduleAliasMap.set(callerFile, aliasMap);
      }
      aliasMap.set(stem, importedFile);
    }
  };

  for (const [filePath, importedFiles] of ctx.importMap) {
    const provider = getProviderForFile(filePath);
    if (!provider || provider.importSemantics !== 'namespace') continue;
    buildPythonModuleAliasForFile(filePath, importedFiles);
  }

  return totalSynthesized;
}

// ── Inline ORM extraction ──────────────────────────────────────────────────

const PRISMA_QUERY_RE =
  /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;
const SUPABASE_QUERY_RE =
  /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

function extractORMQueriesInline(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  if (!hasPrisma && !hasSupabase) return;

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: content.substring(0, m.index).split('\n').length - 1,
      });
    }
  }
}

// ── Main parse + resolve function ──────────────────────────────────────────

type ScannedFile = { path: string; size: number };
type ProgressFn = (progress: PipelineProgress) => void;

/**
 * Phase 3+4: Chunked parse + resolve loop.
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

  // Don't spawn workers for tiny repos — overhead exceeds benefit
  const MIN_FILES_FOR_WORKERS = 15;
  const MIN_BYTES_FOR_WORKERS = 512 * 1024;
  const totalBytes = parseableScanned.reduce((s, f) => s + f.size, 0);

  // Create worker pool once, reuse across chunks
  let workerPool: WorkerPool | undefined;
  if (
    !options?.skipWorkers &&
    (totalParseable >= MIN_FILES_FOR_WORKERS || totalBytes >= MIN_BYTES_FOR_WORKERS)
  ) {
    try {
      let workerUrl = new URL('./workers/parse-worker.js', import.meta.url);
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
          workerUrl = pathToFileURL(distWorker) as URL;
        }
      }
      workerPool = createWorkerPool(workerUrl);
    } catch (err) {
      if (isDev)
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
        if (chunkNeedsSynthesis[chunkIdx]) synthesizeWildcardImportBindings(graph, ctx);
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
        for (const _item of chunkWorkerData.calls) deferredWorkerCalls.push(_item);
        for (const _item of chunkWorkerData.heritage) deferredWorkerHeritage.push(_item);
        for (const _item of chunkWorkerData.constructorBindings)
          deferredConstructorBindings.push(_item);
        if (chunkWorkerData.assignments?.length) {
          for (const _item of chunkWorkerData.assignments) deferredAssignments.push(_item);
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
          for (const _item of chunkWorkerData.fetchCalls) allFetchCalls.push(_item);
        }
        if (chunkWorkerData.routes?.length) {
          for (const _item of chunkWorkerData.routes) allExtractedRoutes.push(_item);
        }
        if (chunkWorkerData.decoratorRoutes?.length) {
          for (const _item of chunkWorkerData.decoratorRoutes) allDecoratorRoutes.push(_item);
        }
        if (chunkWorkerData.toolDefs?.length) {
          for (const _item of chunkWorkerData.toolDefs) allToolDefs.push(_item);
        }
        if (chunkWorkerData.ormQueries?.length) {
          for (const _item of chunkWorkerData.ormQueries) allORMQueries.push(_item);
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

  // Sequential fallback chunks
  if (sequentialChunkPaths.length > 0) synthesizeWildcardImportBindings(graph, ctx);
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
      for (const _item of chunkFetchCalls) allFetchCalls.push(_item);
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

  bindingAccumulator.finalize();

  const enriched = enrichExportedTypeMap(bindingAccumulator, graph, exportedTypeMap);
  if (isDev && enriched > 0) {
    console.log(
      `🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`,
    );
  }

  const synthesized = synthesizeWildcardImportBindings(graph, ctx);
  if (isDev && synthesized > 0) {
    console.log(
      `🔗 Synthesized ${synthesized} additional wildcard import bindings (Go/Ruby/C++/Swift/Python)`,
    );
  }

  allPathObjects.length = 0;
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
  };
}
