import { createKnowledgeGraph } from '../graph/graph.js';
import { processStructure } from './structure-processor.js';
import { processMarkdown } from './markdown-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext
} from './import-processor.js';
import { EMPTY_INDEX } from './resolvers/index.js';
import { processCalls, processCallsFromExtracted, processAssignmentsFromExtracted, processRoutesFromExtracted, processNextjsFetchRoutes, extractFetchCallsFromFiles, seedCrossFileReceiverTypes, buildImportedReturnTypes, buildImportedRawReturnTypes, type ExportedTypeMap, buildExportedTypeMapFromGraph } from './call-processor.js';
import { nextjsFileToRouteURL, normalizeFetchURL } from './route-extractors/nextjs.js';
import { phpFileToRouteURL } from './route-extractors/php.js';
import { extractResponseShapes } from './route-extractors/response-shapes.js';
import { extractMiddlewareChain } from './route-extractors/middleware.js';
import { generateId } from '../../lib/utils.js';
import type { ExtractedFetchCall, ExtractedRoute, ExtractedDecoratorRoute, ExtractedToolDef } from './workers/parse-worker.js';
import { processHeritage, processHeritageFromExtracted } from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { PipelineProgress, PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { getLanguageFromFilename } from './utils.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDev = process.env.NODE_ENV === 'development';

/** A group of files with no mutual dependencies, safe to process in parallel. */
type IndependentFileGroup = readonly string[];

/** Kahn's algorithm: returns files grouped by topological level.
 *  Files in the same level have no mutual dependencies — safe to process in parallel.
 *  Files in cycles are returned as a final group (no cross-cycle propagation). */
export function topologicalLevelSort(
  importMap: ReadonlyMap<string, ReadonlySet<string>>,
): { levels: readonly IndependentFileGroup[]; cycleCount: number } {
  // Build in-degree map and reverse dependency map
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const [file, deps] of importMap) {
    if (!inDegree.has(file)) inDegree.set(file, 0);
    for (const dep of deps) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      // file imports dep, so dep must be processed before file
      // In Kahn's terms: dep → file (dep is a prerequisite of file)
      inDegree.set(file, (inDegree.get(file) ?? 0) + 1);
      let rev = reverseDeps.get(dep);
      if (!rev) { rev = []; reverseDeps.set(dep, rev); }
      rev.push(file);
    }
  }

  // BFS from zero-in-degree nodes, grouping by level
  const levels: string[][] = [];
  let currentLevel = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([f]) => f);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      for (const dependent of reverseDeps.get(file) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextLevel.push(dependent);
      }
    }
    currentLevel = nextLevel;
  }

  // Files still with positive in-degree are in cycles — add as final group
  const cycleFiles = [...inDegree.entries()]
    .filter(([, d]) => d > 0)
    .map(([f]) => f);
  if (cycleFiles.length > 0) {
    levels.push(cycleFiles);
  }

  return { levels, cycleCount: cycleFiles.length };
}

/** Max bytes of source content to load per parse chunk. Each chunk's source +
 *  parsed ASTs + extracted records + worker serialization overhead all live in
 *  memory simultaneously, so this must be conservative. 20MB source ≈ 200-400MB
 *  peak working memory per chunk after parse expansion. */
const CHUNK_BYTE_BUDGET = 20 * 1024 * 1024; // 20MB

/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

// MIDDLEWARE_STOP_KEYWORDS and extractMiddlewareChain moved to ./route-extractors/middleware.ts
// Re-export for backward compatibility
export { extractMiddlewareChain, MIDDLEWARE_STOP_KEYWORDS } from './route-extractors/middleware.js';

// detectStatusCode and extractResponseShapes moved to ./route-extractors/response-shapes.ts
// Re-export for backward compatibility
export { detectStatusCode, extractResponseShapes } from './route-extractors/response-shapes.js';

/** Minimum percentage of files that must benefit from cross-file seeding to justify the re-resolution pass. */
const CROSS_FILE_SKIP_THRESHOLD = 0.03;
/** Hard cap on files re-processed during cross-file propagation. */
const MAX_CROSS_FILE_REPROCESS = 2000;

/** Node labels that represent top-level importable symbols.
 *  Excludes Method, Property, Constructor (accessed via receiver, not directly imported),
 *  and structural labels (File, Folder, Package, Module, Project, etc.). */
const IMPORTABLE_SYMBOL_LABELS = new Set([
  'Function', 'Class', 'Interface', 'Struct', 'Enum', 'Trait',
  'TypeAlias', 'Const', 'Static', 'Record', 'Union', 'Typedef', 'Macro',
]);

/** Max synthetic bindings per importing file — prevents memory bloat for
 *  C/C++ files that include many large headers. */
const MAX_SYNTHETIC_BINDINGS_PER_FILE = 1000;

/** Languages with whole-module import semantics (no per-symbol named imports).
 *  For these languages, namedImportMap entries are synthesized from graph-exported
 *  symbols after parsing, enabling Phase 14 cross-file binding propagation.
 *
 *  Note: Python is intentionally excluded here. `import models` is a namespace import
 *  (not wildcard symbol expansion) — expanding all exported symbols produces ambiguous
 *  bindings when multiple modules export the same name (e.g. models.User vs auth.User).
 *  Python module aliases are built in synthesizeWildcardImportBindings via moduleAliasMap. */
const WILDCARD_IMPORT_LANGUAGES = new Set([
  SupportedLanguages.Go,
  SupportedLanguages.Ruby,
  SupportedLanguages.C,
  SupportedLanguages.CPlusPlus,
  SupportedLanguages.Swift,
]);

/** Languages that require synthesizeWildcardImportBindings to run before call resolution.
 *  Superset of WILDCARD_IMPORT_LANGUAGES — includes Python for moduleAliasMap building. */
const SYNTHESIS_LANGUAGES = new Set([...WILDCARD_IMPORT_LANGUAGES, SupportedLanguages.Python]);

/** Synthesize namedImportMap entries for languages with whole-module imports.
 *  These languages (Go, Ruby, C/C++, Swift, Python) import all exported symbols from a
 *  file, not specific named symbols. After parsing, we know which symbols each file
 *  exports (via graph isExported), so we can expand ImportMap edges into per-symbol
 *  bindings that Phase 14 can use for cross-file type propagation. */
function synthesizeWildcardImportBindings(
  graph: ReturnType<typeof createKnowledgeGraph>,
  ctx: ReturnType<typeof createResolutionContext>,
): number {
  // Pre-compute exported symbols per file from graph (single pass)
  const exportedSymbolsByFile = new Map<string, { name: string; filePath: string }[]>();
  graph.forEachNode(node => {
    if (!node.properties?.isExported) return;
    if (!IMPORTABLE_SYMBOL_LABELS.has(node.label)) return;
    const fp = node.properties.filePath;
    const name = node.properties.name;
    if (!fp || !name) return;
    let symbols = exportedSymbolsByFile.get(fp);
    if (!symbols) { symbols = []; exportedSymbolsByFile.set(fp, symbols); }
    symbols.push({ name, filePath: fp });
  });

  if (exportedSymbolsByFile.size === 0) return 0;

  // Build a merged import map: ctx.importMap has file-based imports (Ruby, C/C++),
  // but Go/C# package imports use graph IMPORTS edges + PackageMap instead.
  // Collect graph-level IMPORTS edges for wildcard languages missing from ctx.importMap.
  const FILE_PREFIX = 'File:';
  const graphImports = new Map<string, Set<string>>();
  graph.forEachRelationship(rel => {
    if (rel.type !== 'IMPORTS') return;
    if (!rel.sourceId.startsWith(FILE_PREFIX) || !rel.targetId.startsWith(FILE_PREFIX)) return;
    const srcFile = rel.sourceId.slice(FILE_PREFIX.length);
    const tgtFile = rel.targetId.slice(FILE_PREFIX.length);
    const lang = getLanguageFromFilename(srcFile);
    if (!lang || !WILDCARD_IMPORT_LANGUAGES.has(lang)) return;
    // Only add if not already in ctx.importMap (avoid duplicates)
    if (ctx.importMap.get(srcFile)?.has(tgtFile)) return;
    let set = graphImports.get(srcFile);
    if (!set) { set = new Set(); graphImports.set(srcFile, set); }
    set.add(tgtFile);
  });

  let totalSynthesized = 0;

  // Helper: synthesize bindings for a file given its imported files
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

  // Process files from ctx.importMap (Ruby, C/C++, Swift file-based imports)
  for (const [filePath, importedFiles] of ctx.importMap) {
    const lang = getLanguageFromFilename(filePath);
    if (!lang || !WILDCARD_IMPORT_LANGUAGES.has(lang)) continue;
    synthesizeForFile(filePath, importedFiles);
  }

  // Process files from graph IMPORTS edges (Go and other wildcard-import languages)
  for (const [filePath, importedFiles] of graphImports) {
    synthesizeForFile(filePath, importedFiles);
  }

  // Build module alias map for Python namespace imports.
  // `import models` in app.py → ctx.moduleAliasMap['app.py']['models'] = 'models.py'
  // Enables `models.User()` to resolve to models.py:User without ambiguous symbol expansion.
  const buildPythonModuleAliasForFile = (callerFile: string, importedFiles: Iterable<string>) => {
    let aliasMap = ctx.moduleAliasMap.get(callerFile);
    for (const importedFile of importedFiles) {
      // Derive the module alias from the imported filename stem (e.g. "models.py" → "models")
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
    if (getLanguageFromFilename(filePath) !== SupportedLanguages.Python) continue;
    buildPythonModuleAliasForFile(filePath, importedFiles);
  }

  return totalSynthesized;
}

/** Phase 14: Cross-file binding propagation.
 *  Seeds downstream files with resolved type bindings from upstream exports.
 *  Files are processed in topological import order so upstream bindings are
 *  available when downstream files are re-resolved. */
async function runCrossFileBindingPropagation(
  graph: ReturnType<typeof createKnowledgeGraph>,
  ctx: ReturnType<typeof createResolutionContext>,
  exportedTypeMap: ExportedTypeMap,
  allPaths: string[],
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: (progress: PipelineProgress) => void,
): Promise<void> {
  // For the worker path, buildTypeEnv runs inside workers without SymbolTable,
  // so exported bindings must be collected from graph + SymbolTable in main thread.
  if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
    const graphExports = buildExportedTypeMapFromGraph(graph, ctx.symbols);
    for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
  }

  if (exportedTypeMap.size === 0 || ctx.namedImportMap.size === 0) return;

  const allPathSet = new Set(allPaths);
  const { levels, cycleCount } = topologicalLevelSort(ctx.importMap);

  // Cycle diagnostic: only log when actual cycles detected (cycleCount from Kahn's BFS)
  if (isDev && cycleCount > 0) {
    console.log(`🔄 ${cycleCount} files in import cycles (skipped for cross-file propagation)`);
  }

  // Quick count of files with cross-file binding gaps (early exit once threshold exceeded)
  let filesWithGaps = 0;
  const gapThreshold = Math.max(1, Math.ceil(totalFiles * CROSS_FILE_SKIP_THRESHOLD));
  outer: for (const level of levels) {
    for (const filePath of level) {
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;
      for (const [, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream?.has(binding.exportedName)) { filesWithGaps++; break; }
        const def = ctx.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
        if (def?.returnType) { filesWithGaps++; break; }
      }
      if (filesWithGaps >= gapThreshold) break outer;
    }
  }

  const gapRatio = totalFiles > 0 ? filesWithGaps / totalFiles : 0;
  if (gapRatio < CROSS_FILE_SKIP_THRESHOLD && filesWithGaps < gapThreshold) {
    if (isDev) {
      console.log(`⏭️ Cross-file re-resolution skipped (${filesWithGaps}/${totalFiles} files, ${(gapRatio * 100).toFixed(1)}% < ${CROSS_FILE_SKIP_THRESHOLD * 100}% threshold)`);
    }
    return;
  }

  onProgress({
    phase: 'parsing',
    percent: 82,
    message: `Cross-file type propagation (${filesWithGaps}+ files)...`,
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  let crossFileResolved = 0;
  const crossFileStart = Date.now();
  let astCache = createASTCache(AST_CACHE_CAP);

  for (const level of levels) {
    const levelCandidates: { filePath: string; seeded: Map<string, string>; importedReturns: ReadonlyMap<string, string>; importedRawReturns: ReadonlyMap<string, string> }[] = [];
    for (const filePath of level) {
      if (crossFileResolved + levelCandidates.length >= MAX_CROSS_FILE_REPROCESS) break;
      const imports = ctx.namedImportMap.get(filePath);
      if (!imports) continue;

      const seeded = new Map<string, string>();
      for (const [localName, binding] of imports) {
        const upstream = exportedTypeMap.get(binding.sourcePath);
        if (upstream) {
          const type = upstream.get(binding.exportedName);
          if (type) seeded.set(localName, type);
        }
      }

      const importedReturns = buildImportedReturnTypes(filePath, ctx.namedImportMap, ctx.symbols);
      const importedRawReturns = buildImportedRawReturnTypes(filePath, ctx.namedImportMap, ctx.symbols);
      if (seeded.size === 0 && importedReturns.size === 0) continue;
      if (!allPathSet.has(filePath)) continue;

      const lang = getLanguageFromFilename(filePath);
      if (!lang || !isLanguageAvailable(lang)) continue;

      levelCandidates.push({ filePath, seeded, importedReturns, importedRawReturns });
    }

    if (levelCandidates.length === 0) continue;

    const levelPaths = levelCandidates.map(c => c.filePath);
    const contentMap = await readFileContents(repoPath, levelPaths);

    for (const { filePath, seeded, importedReturns, importedRawReturns } of levelCandidates) {
      const content = contentMap.get(filePath);
      if (!content) continue;

      const reFile = [{ path: filePath, content }];
      const bindings = new Map<string, ReadonlyMap<string, string>>();
      if (seeded.size > 0) bindings.set(filePath, seeded);

      const importedReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedReturns.size > 0) {
        importedReturnTypesMap.set(filePath, importedReturns);
      }

      const importedRawReturnTypesMap = new Map<string, ReadonlyMap<string, string>>();
      if (importedRawReturns.size > 0) {
        importedRawReturnTypesMap.set(filePath, importedRawReturns);
      }

      await processCalls(graph, reFile, astCache, ctx, undefined, exportedTypeMap, bindings.size > 0 ? bindings : undefined, importedReturnTypesMap.size > 0 ? importedReturnTypesMap : undefined, importedRawReturnTypesMap.size > 0 ? importedRawReturnTypesMap : undefined);
      crossFileResolved++;
    }

    if (crossFileResolved >= MAX_CROSS_FILE_REPROCESS) {
      if (isDev) console.log(`⚠️ Cross-file re-resolution capped at ${MAX_CROSS_FILE_REPROCESS} files`);
      break;
    }
  }

  astCache.clear();

  if (isDev) {
    const elapsed = Date.now() - crossFileStart;
    const totalElapsed = Date.now() - pipelineStart;
    const reResolutionPct = totalElapsed > 0 ? ((elapsed / totalElapsed) * 100).toFixed(1) : '0';
    console.log(
      `🔗 Cross-file re-resolution: ${crossFileResolved} candidates re-processed` +
      ` in ${elapsed}ms (${reResolutionPct}% of total ingestion time so far)`,
    );
  }
}

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
  const pipelineStart = Date.now();

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


    // ── Phase 2.5: Markdown processing (headings + cross-links) ────────
    const mdScanned = scannedFiles.filter(f => f.path.endsWith('.md') || f.path.endsWith('.mdx'));
    if (mdScanned.length > 0) {
      const mdContents = await readFileContents(repoPath, mdScanned.map(f => f.path));
      const mdFiles = mdScanned
        .filter(f => mdContents.has(f.path))
        .map(f => ({ path: f.path, content: mdContents.get(f.path)! }));
      const allPathSet = new Set(allPaths);
      const mdResult = processMarkdown(graph, mdFiles, allPathSet);
      if (isDev) {
        console.log(`  Markdown: ${mdResult.sections} sections, ${mdResult.links} cross-links from ${mdFiles.length} files`);
      }
    }

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
    // Pre-compute which chunks need synthesis — O(1) lookup per chunk.
    const chunkNeedsSynthesis = chunks.map(paths =>
      paths.some(p => { 
        const lang = getLanguageFromFilename(p); 
        return lang != null && SYNTHESIS_LANGUAGES.has(lang); 
      }),
    );
    // Phase 14: Collect exported type bindings for cross-file propagation
    const exportedTypeMap: ExportedTypeMap = new Map();
    // Accumulate file-scope TypeEnv bindings from workers (closes worker/sequential quality gap)
    const workerTypeEnvBindings: { filePath: string; bindings: [string, string][] }[] = [];
    // Accumulate fetch() calls from workers for Next.js route matching
    const allFetchCalls: ExtractedFetchCall[] = [];
    // Accumulate framework-extracted routes (Laravel, etc.) for Route node creation
    const allExtractedRoutes: ExtractedRoute[] = [];
    // Accumulate decorator-based routes (@Get, @Post, @app.route, etc.)
    const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
    // Accumulate MCP/RPC tool definitions (@mcp.tool(), @app.tool(), etc.)
    const allToolDefs: ExtractedToolDef[] = [];

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
          // ── Wildcard-import synthesis (Ruby / C/C++ / Swift / Go) + Python module aliases ─
          // Synthesize namedImportMap entries for wildcard-import languages and build
          // moduleAliasMap for Python namespace imports. Must run after imports are resolved
          // (importMap is populated) but BEFORE call resolution.
          if (chunkNeedsSynthesis[chunkIdx]) synthesizeWildcardImportBindings(graph, ctx);
          // Phase 14 E1: Seed cross-file receiver types from ExportedTypeMap
          // before call resolution — eliminates re-parse for single-hop imported receivers.
          // NOTE: In the worker path, exportedTypeMap is empty during chunk processing
          // (populated later in runCrossFileBindingPropagation). This block is latent —
          // it activates only if incremental export collection is added per-chunk.
          if (exportedTypeMap.size > 0 && ctx.namedImportMap.size > 0) {
            const { enrichedCount } = seedCrossFileReceiverTypes(
              chunkWorkerData.calls, ctx.namedImportMap, exportedTypeMap,
            );
            if (isDev && enrichedCount > 0) {
              console.log(`🔗 E1: Seeded ${enrichedCount} cross-file receiver types (chunk ${chunkIdx + 1})`);
            }
          }
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
          // Process field write assignments (synchronous, runs after calls resolve)
          if (chunkWorkerData.assignments?.length) {
            processAssignmentsFromExtracted(graph, chunkWorkerData.assignments, ctx, chunkWorkerData.constructorBindings);
          }
          // Collect TypeEnv file-scope bindings for exported type enrichment
          if (chunkWorkerData.typeEnvBindings?.length) {
            workerTypeEnvBindings.push(...chunkWorkerData.typeEnvBindings);
          }
          // Collect fetch() calls for Next.js route matching
          if (chunkWorkerData.fetchCalls?.length) {
            allFetchCalls.push(...chunkWorkerData.fetchCalls);
          }
          if (chunkWorkerData.routes?.length) {
            allExtractedRoutes.push(...chunkWorkerData.routes);
          }
          if (chunkWorkerData.decoratorRoutes?.length) {
            allDecoratorRoutes.push(...chunkWorkerData.decoratorRoutes);
          }
          if (chunkWorkerData.toolDefs?.length) {
            allToolDefs.push(...chunkWorkerData.toolDefs);
          }
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
    // Synthesize wildcard import bindings once after ALL imports are processed,
    // before any call resolution — same rationale as the worker-path inline synthesis.
    if (sequentialChunkPaths.length > 0) synthesizeWildcardImportBindings(graph, ctx);
    for (const chunkPaths of sequentialChunkPaths) {
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter(p => chunkContents.has(p))
        .map(p => ({ path: p, content: chunkContents.get(p)! }));
      astCache = createASTCache(chunkFiles.length);
      const rubyHeritage = await processCalls(graph, chunkFiles, astCache, ctx, undefined, exportedTypeMap);
      await processHeritage(graph, chunkFiles, astCache, ctx);
      if (rubyHeritage.length > 0) {
        await processHeritageFromExtracted(graph, rubyHeritage, ctx);
      }
      // Extract fetch() calls for Next.js route matching (sequential path)
      const chunkFetchCalls = await extractFetchCallsFromFiles(chunkFiles, astCache);
      if (chunkFetchCalls.length > 0) {
        allFetchCalls.push(...chunkFetchCalls);
      }
      astCache.clear();
    }

    // ── Phase 3.5: Route Registry (Next.js + PHP + Laravel + decorators) ──
    type RouteEntry = { filePath: string; source: string };
    const routeRegistry = new Map<string, RouteEntry>();
    for (const p of allPaths) {
      const nextjsURL = nextjsFileToRouteURL(p);
      if (nextjsURL && !routeRegistry.has(nextjsURL)) {
        routeRegistry.set(nextjsURL, { filePath: p, source: 'nextjs-filesystem-route' });
        continue;
      }
      if (p.endsWith('.php')) {
        const phpURL = phpFileToRouteURL(p);
        if (phpURL && !routeRegistry.has(phpURL)) {
          routeRegistry.set(phpURL, { filePath: p, source: 'php-file-route' });
        }
      }
    }

    const ensureSlash = (path: string) => path.startsWith('/') ? path : '/' + path;
    let duplicateRoutes = 0;
    const addRoute = (url: string, entry: RouteEntry) => {
      if (routeRegistry.has(url)) { duplicateRoutes++; return; }
      routeRegistry.set(url, entry);
    };
    for (const route of allExtractedRoutes) {
      if (!route.routePath) continue;
      addRoute(ensureSlash(route.routePath), { filePath: route.filePath, source: 'framework-route' });
    }
    for (const dr of allDecoratorRoutes) {
      addRoute(ensureSlash(dr.routePath), { filePath: dr.filePath, source: `decorator-${dr.decoratorName}` });
    }

    if (routeRegistry.size > 0) {
      const handlerPaths = [...routeRegistry.values()].map(e => e.filePath);
      const handlerContents = await readFileContents(repoPath, handlerPaths);

      for (const [routeURL, entry] of routeRegistry) {
        const { filePath: handlerPath, source: routeSource } = entry;
        const content = handlerContents.get(handlerPath);

        const { responseKeys, errorKeys } = content
          ? extractResponseShapes(content)
          : { responseKeys: undefined, errorKeys: undefined };

        const mwResult = content ? extractMiddlewareChain(content) : undefined;
        const middleware = mwResult?.chain;

        const routeNodeId = generateId('Route', routeURL);
        graph.addNode({
          id: routeNodeId,
          label: 'Route',
          properties: {
            name: routeURL,
            filePath: handlerPath,
            ...(responseKeys ? { responseKeys } : {}),
            ...(errorKeys ? { errorKeys } : {}),
            ...(middleware && middleware.length > 0 ? { middleware } : {}),
          },
        });

        const handlerFileId = generateId('File', handlerPath);
        graph.addRelationship({
          id: generateId('HANDLES_ROUTE', `${handlerFileId}->${routeNodeId}`),
          sourceId: handlerFileId,
          targetId: routeNodeId,
          type: 'HANDLES_ROUTE',
          confidence: 1.0,
          reason: routeSource,
        });
      }

      if (isDev) {
        console.log(`🗺️ Route registry: ${routeRegistry.size} routes${duplicateRoutes > 0 ? ` (${duplicateRoutes} duplicate URLs skipped)` : ''}`);
      }
    }

    // Scan HTML/PHP/template files for <form action="/path"> and AJAX url patterns
    // Scan HTML/template files for <form action="/path"> and AJAX url patterns
    // Skip .php — already parsed by tree-sitter with http_client/fetch queries
    const htmlCandidates = allPaths.filter(p =>
      p.endsWith('.html') || p.endsWith('.htm') ||
      p.endsWith('.ejs') || p.endsWith('.hbs') || p.endsWith('.blade.php')
    );
    if (htmlCandidates.length > 0 && routeRegistry.size > 0) {
      const htmlContents = await readFileContents(repoPath, htmlCandidates);
      const htmlPatterns = [/action=["']([^"']+)["']/g, /url:\s*["']([^"']+)["']/g];
      for (const [filePath, content] of htmlContents) {
        for (const pattern of htmlPatterns) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const normalized = normalizeFetchURL(match[1]);
            if (normalized) {
              allFetchCalls.push({ filePath, fetchURL: normalized, lineNumber: 0 });
            }
          }
        }
      }
    }

    if (routeRegistry.size > 0 && allFetchCalls.length > 0) {
      const routeURLToFile = new Map<string, string>();
      for (const [url, entry] of routeRegistry) routeURLToFile.set(url, entry.filePath);

      // Read consumer file contents so we can extract property access patterns
      const consumerPaths = [...new Set(allFetchCalls.map(c => c.filePath))];
      const consumerContents = await readFileContents(repoPath, consumerPaths);

      processNextjsFetchRoutes(graph, allFetchCalls, routeURLToFile, consumerContents);
      if (isDev) {
        console.log(`🔗 Processed ${allFetchCalls.length} fetch() calls against ${routeRegistry.size} routes`);
      }
    }

    // ── Phase 3.6: Tool Detection (MCP/RPC) ──────────────────────────
    const toolDefs: { name: string; filePath: string; description: string }[] = [];
    const seenToolNames = new Set<string>();

    for (const td of allToolDefs) {
      if (seenToolNames.has(td.toolName)) continue;
      seenToolNames.add(td.toolName);
      toolDefs.push({ name: td.toolName, filePath: td.filePath, description: td.description });
    }

    // TS tool definition arrays — require inputSchema nearby to distinguish from config objects
    const toolCandidatePaths = allPaths.filter(p =>
      (p.endsWith('.ts') || p.endsWith('.js')) && p.toLowerCase().includes('tool')
      && !p.includes('node_modules') && !p.includes('test') && !p.includes('__')
    );
    if (toolCandidatePaths.length > 0) {
      const toolContents = await readFileContents(repoPath, toolCandidatePaths);
      for (const [filePath, content] of toolContents) {
        // Only scan files that contain 'inputSchema' — this is the MCP tool signature
        if (!content.includes('inputSchema')) continue;
        const toolPattern = /name:\s*['"](\w+)['"]\s*,\s*\n?\s*description:\s*[`'"]([\s\S]*?)[`'"]/g;
        let match;
        while ((match = toolPattern.exec(content)) !== null) {
          const name = match[1];
          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);
          toolDefs.push({ name, filePath, description: match[2].slice(0, 200).replace(/\n/g, ' ').trim() });
        }
      }
    }

    // Create Tool nodes and HANDLES_TOOL edges
    if (toolDefs.length > 0) {
      for (const td of toolDefs) {
        const toolNodeId = generateId('Tool', td.name);
        graph.addNode({
          id: toolNodeId,
          label: 'Tool',
          properties: { name: td.name, filePath: td.filePath, description: td.description },
        });

        const handlerFileId = generateId('File', td.filePath);
        graph.addRelationship({
          id: generateId('HANDLES_TOOL', `${handlerFileId}->${toolNodeId}`),
          sourceId: handlerFileId,
          targetId: toolNodeId,
          type: 'HANDLES_TOOL',
          confidence: 1.0,
          reason: 'tool-definition',
        });
      }

      if (isDev) {
        console.log(`🔧 Tool registry: ${toolDefs.length} tools detected`);
      }
    }

    // Log resolution cache stats
    if (isDev) {
      const rcStats = ctx.getStats();
      const total = rcStats.cacheHits + rcStats.cacheMisses;
      const hitRate = total > 0 ? ((rcStats.cacheHits / total) * 100).toFixed(1) : '0';
      console.log(`🔍 Resolution cache: ${rcStats.cacheHits} hits, ${rcStats.cacheMisses} misses (${hitRate}% hit rate)`);
    }

    // ── Worker path quality enrichment: merge TypeEnv file-scope bindings into ExportedTypeMap ──
    // Workers return file-scope bindings from their TypeEnv fixpoint (includes inferred types
    // like `const config = getConfig()` → Config). Filter by graph isExported to match
    // the sequential path's collectExportedBindings behavior.
    if (workerTypeEnvBindings.length > 0) {
      let enriched = 0;
      for (const { filePath, bindings } of workerTypeEnvBindings) {
        for (const [name, type] of bindings) {
          // Verify the symbol is exported via graph node
          const nodeId = `Function:${filePath}:${name}`;
          const varNodeId = `Variable:${filePath}:${name}`;
          const constNodeId = `Const:${filePath}:${name}`;
          const node = graph.getNode(nodeId) ?? graph.getNode(varNodeId) ?? graph.getNode(constNodeId);
          if (!node?.properties?.isExported) continue;

          let fileExports = exportedTypeMap.get(filePath);
          if (!fileExports) { fileExports = new Map(); exportedTypeMap.set(filePath, fileExports); }
          // Don't overwrite existing entries (Tier 0 from SymbolTable is authoritative)
          if (!fileExports.has(name)) {
            fileExports.set(name, type);
            enriched++;
          }
        }
      }
      if (isDev && enriched > 0) {
        console.log(`🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`);
      }
    }

    // ── Phase 14 pre-pass: Final synthesis pass for whole-module-import languages ──
    // Per-chunk synthesis (above) already ran incrementally. This final pass ensures
    // any remaining files whose imports were not covered inline are also synthesized,
    // and that Phase 14 type propagation has complete namedImportMap data.
    const synthesized = synthesizeWildcardImportBindings(graph, ctx);
    if (isDev && synthesized > 0) {
      console.log(`🔗 Synthesized ${synthesized} additional wildcard import bindings (Go/Ruby/C++/Swift/Python)`);
    }

    // ── Phase 14: Cross-file binding propagation ──────────────────────
    await runCrossFileBindingPropagation(
      graph, ctx, exportedTypeMap, allPaths, totalFiles, repoPath, pipelineStart, onProgress,
    );

    // Free import resolution context — suffix index + resolve cache no longer needed
    // (allPathObjects and importCtx hold ~94MB+ for large repos)
    allPathObjects.length = 0;
    importCtx.resolveCache.clear();
    importCtx.index = EMPTY_INDEX; // Release suffix index memory (~30MB for large repos)
    importCtx.normalizedFileList = [];

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

      // Link Route and Tool nodes to Processes via reverse index (file → node id)
      if (routeRegistry.size > 0 || toolDefs.length > 0) {
        // Reverse indexes: file → all route URLs / tool names (handles multi-route files)
        const routesByFile = new Map<string, string[]>();
        for (const [url, entry] of routeRegistry) {
          let list = routesByFile.get(entry.filePath);
          if (!list) { list = []; routesByFile.set(entry.filePath, list); }
          list.push(url);
        }
        const toolsByFile = new Map<string, string[]>();
        for (const td of toolDefs) {
          let list = toolsByFile.get(td.filePath);
          if (!list) { list = []; toolsByFile.set(td.filePath, list); }
          list.push(td.name);
        }

        let linked = 0;
        for (const proc of processResult.processes) {
          if (!proc.entryPointId) continue;
          const entryNode = graph.getNode(proc.entryPointId);
          if (!entryNode) continue;
          const entryFile = entryNode.properties.filePath;
          if (!entryFile) continue;

          const routeURLs = routesByFile.get(entryFile);
          if (routeURLs) {
            for (const routeURL of routeURLs) {
              const routeNodeId = generateId('Route', routeURL);
              graph.addRelationship({
                id: generateId('ENTRY_POINT_OF', `${routeNodeId}->${proc.id}`),
                sourceId: routeNodeId,
                targetId: proc.id,
                type: 'ENTRY_POINT_OF',
                confidence: 0.85,
                reason: 'route-handler-entry-point',
              });
              linked++;
            }
          }
          const toolNames = toolsByFile.get(entryFile);
          if (toolNames) {
            for (const toolName of toolNames) {
              const toolNodeId = generateId('Tool', toolName);
              graph.addRelationship({
                id: generateId('ENTRY_POINT_OF', `${toolNodeId}->${proc.id}`),
                sourceId: toolNodeId,
                targetId: proc.id,
                type: 'ENTRY_POINT_OF',
                confidence: 0.85,
                reason: 'tool-handler-entry-point',
              });
              linked++;
            }
          }
        }
        if (isDev && linked > 0) {
          console.log(`🔗 Linked ${linked} Route/Tool nodes to execution flows`);
        }
      }
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
