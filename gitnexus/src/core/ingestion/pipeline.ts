import { createKnowledgeGraph } from '../graph/graph.js';
import {
  BindingAccumulator,
  enrichExportedTypeMap,
  type BindingEntry,
} from './binding-accumulator.js';
import { processStructure } from './structure-processor.js';
import { processMarkdown } from './markdown-processor.js';
import { processCobol, isCobolFile, isJclFile } from './cobol-processor.js';
import { processParsing } from './parsing-processor.js';
import {
  processImports,
  processImportsFromExtracted,
  buildImportResolutionContext,
} from './import-processor.js';
import { EMPTY_INDEX } from './import-resolvers/utils.js';
import {
  processCalls,
  processCallsFromExtracted,
  processAssignmentsFromExtracted,
  processRoutesFromExtracted,
  processNextjsFetchRoutes,
  extractFetchCallsFromFiles,
  seedCrossFileReceiverTypes,
  buildImportedReturnTypes,
  buildImportedRawReturnTypes,
  type ExportedTypeMap,
  buildExportedTypeMapFromGraph,
} from './call-processor.js';
import { buildHeritageMap } from './heritage-map.js';
import { nextjsFileToRouteURL, normalizeFetchURL } from './route-extractors/nextjs.js';
import { expoFileToRouteURL } from './route-extractors/expo.js';
import { phpFileToRouteURL } from './route-extractors/php.js';
import {
  extractResponseShapes,
  extractPHPResponseShapes,
} from './route-extractors/response-shapes.js';
import {
  extractMiddlewareChain,
  extractNextjsMiddlewareConfig,
  compileMatcher,
  compiledMatcherMatchesRoute,
} from './route-extractors/middleware.js';
import { generateId } from '../../lib/utils.js';
import type {
  ExtractedAssignment,
  ExtractedCall,
  ExtractedDecoratorRoute,
  ExtractedFetchCall,
  ExtractedHeritage,
  ExtractedORMQuery,
  ExtractedRoute,
  ExtractedToolDef,
  FileConstructorBindings,
} from './workers/parse-worker.js';
import {
  processHeritage,
  processHeritageFromExtracted,
  extractExtractedHeritageFromFiles,
} from './heritage-processor.js';
import { computeMRO } from './mro-processor.js';
import { processCommunities } from './community-processor.js';
import { processProcesses } from './process-processor.js';
import { createResolutionContext } from './resolution-context.js';
import { createASTCache } from './ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { PipelineResult } from '../../types/pipeline.js';
import { walkRepositoryPaths, readFileContents } from './filesystem-walker.js';
import { isLanguageAvailable } from '../tree-sitter/parser-loader.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { providers, getProviderForFile } from './languages/index.js';
import { createWorkerPool, WorkerPool } from './workers/worker-pool.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const isDev = process.env.NODE_ENV === 'development';

const EXPO_NAV_PATTERNS = [
  /router\.(push|replace|navigate)\(\s*['"`]([^'"`]+)['"`]/g,
  /<Link\s+[^>]*href=\s*['"`]([^'"`]+)['"`]/g,
];

/** A group of files with no mutual dependencies, safe to process in parallel. */
type IndependentFileGroup = readonly string[];

/** Kahn's algorithm: returns files grouped by topological level.
 *  Files in the same level have no mutual dependencies — safe to process in parallel.
 *  Files in cycles are returned as a final group (no cross-cycle propagation). */
export function topologicalLevelSort(importMap: ReadonlyMap<string, ReadonlySet<string>>): {
  levels: readonly IndependentFileGroup[];
  cycleCount: number;
} {
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
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(file);
    }
  }

  // BFS from zero-in-degree nodes, grouping by level
  const levels: string[][] = [];
  let currentLevel = [...inDegree.entries()].filter(([, d]) => d === 0).map(([f]) => f);

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
  const cycleFiles = [...inDegree.entries()].filter(([, d]) => d > 0).map(([f]) => f);
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

/** Minimum percentage of files that must benefit from cross-file seeding to justify the re-resolution pass. */
const CROSS_FILE_SKIP_THRESHOLD = 0.03;
/** Hard cap on files re-processed during cross-file propagation. */
const MAX_CROSS_FILE_REPROCESS = 2000;

/** Node labels that represent top-level importable symbols.
 *  Excludes Method, Property, Constructor (accessed via receiver, not directly imported),
 *  and structural labels (File, Folder, Package, Module, Project, etc.). */
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

/** Max synthetic bindings per importing file — prevents memory bloat for
 *  C/C++ files that include many large headers. */
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

/** Check if a language uses wildcard (whole-module) import semantics.
 *  Derived from LanguageProvider.importSemantics — no hardcoded set needed. */
function isWildcardImportLanguage(lang: SupportedLanguages): boolean {
  return WILDCARD_LANGUAGES.has(lang);
}

/** Check if a language needs synthesis before call resolution.
 *  True for wildcard-import languages AND namespace-import languages (Python). */
function needsSynthesis(lang: SupportedLanguages): boolean {
  return SYNTHESIS_LANGUAGES.has(lang);
}

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

  // Build a merged import map: ctx.importMap has file-based imports (Ruby, C/C++),
  // but Go/C# package imports use graph IMPORTS edges + PackageMap instead.
  // Collect graph-level IMPORTS edges for wildcard languages missing from ctx.importMap.
  const FILE_PREFIX = 'File:';
  const graphImports = new Map<string, Set<string>>();
  graph.forEachRelationship((rel) => {
    if (rel.type !== 'IMPORTS') return;
    if (!rel.sourceId.startsWith(FILE_PREFIX) || !rel.targetId.startsWith(FILE_PREFIX)) return;
    const srcFile = rel.sourceId.slice(FILE_PREFIX.length);
    const tgtFile = rel.targetId.slice(FILE_PREFIX.length);
    const lang = getLanguageFromFilename(srcFile);
    if (!lang || !isWildcardImportLanguage(lang)) return;
    // Only add if not already in ctx.importMap (avoid duplicates)
    if (ctx.importMap.get(srcFile)?.has(tgtFile)) return;
    let set = graphImports.get(srcFile);
    if (!set) {
      set = new Set();
      graphImports.set(srcFile, set);
    }
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
    if (!lang || !isWildcardImportLanguage(lang)) continue;
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
    const provider = getProviderForFile(filePath);
    if (!provider || provider.importSemantics !== 'namespace') continue;
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
        if (upstream?.has(binding.exportedName)) {
          filesWithGaps++;
          break;
        }
        const def = ctx.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
        if (def?.returnType) {
          filesWithGaps++;
          break;
        }
      }
      if (filesWithGaps >= gapThreshold) break outer;
    }
  }

  const gapRatio = totalFiles > 0 ? filesWithGaps / totalFiles : 0;
  if (gapRatio < CROSS_FILE_SKIP_THRESHOLD && filesWithGaps < gapThreshold) {
    if (isDev) {
      console.log(
        `⏭️ Cross-file re-resolution skipped (${filesWithGaps}/${totalFiles} files, ${(gapRatio * 100).toFixed(1)}% < ${CROSS_FILE_SKIP_THRESHOLD * 100}% threshold)`,
      );
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
  const astCache = createASTCache(AST_CACHE_CAP);

  for (const level of levels) {
    const levelCandidates: {
      filePath: string;
      seeded: Map<string, string>;
      importedReturns: ReadonlyMap<string, string>;
      importedRawReturns: ReadonlyMap<string, string>;
    }[] = [];
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
      const importedRawReturns = buildImportedRawReturnTypes(
        filePath,
        ctx.namedImportMap,
        ctx.symbols,
      );
      if (seeded.size === 0 && importedReturns.size === 0) continue;
      if (!allPathSet.has(filePath)) continue;

      const lang = getLanguageFromFilename(filePath);
      if (!lang || !isLanguageAvailable(lang)) continue;

      levelCandidates.push({ filePath, seeded, importedReturns, importedRawReturns });
    }

    if (levelCandidates.length === 0) continue;

    const levelPaths = levelCandidates.map((c) => c.filePath);
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

      await processCalls(
        graph,
        reFile,
        astCache,
        ctx,
        undefined,
        exportedTypeMap,
        bindings.size > 0 ? bindings : undefined,
        importedReturnTypesMap.size > 0 ? importedReturnTypesMap : undefined,
        importedRawReturnTypesMap.size > 0 ? importedRawReturnTypesMap : undefined,
      );
      crossFileResolved++;
    }

    if (crossFileResolved >= MAX_CROSS_FILE_REPROCESS) {
      if (isDev)
        console.log(`⚠️ Cross-file re-resolution capped at ${MAX_CROSS_FILE_REPROCESS} files`);
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
  /** Force sequential parsing (no worker pool). Useful for testing the sequential path. */
  skipWorkers?: boolean;
}

// ── Extracted pipeline phases ──────────────────────────────────────────────
// Each function represents a natural phase boundary in the ingestion pipeline.
// Data flow is explicit through parameters and return values.

type ProgressFn = (progress: PipelineProgress) => void;
type ScannedFile = { path: string; size: number };

/**
 * Phase 1+2: Scan repository paths, build file/folder structure, process markdown.
 *
 * @reads  repoPath (filesystem)
 * @writes graph (File, Folder nodes + CONTAINS edges; Markdown sections + cross-links)
 */
async function runScanAndStructure(
  repoPath: string,
  graph: ReturnType<typeof createKnowledgeGraph>,
  onProgress: ProgressFn,
): Promise<{ scannedFiles: ScannedFile[]; allPaths: string[]; totalFiles: number }> {
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

  const allPaths = scannedFiles.map((f) => f.path);
  processStructure(graph, allPaths);

  onProgress({
    phase: 'structure',
    percent: 20,
    message: 'Project structure analyzed',
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  // ── Custom (non-tree-sitter) processors ─────────────────────────────
  // Each custom processor follows the pattern in markdown-processor.ts:
  //   1. Export a process function: (graph, files, allPathSet) => result
  //   2. Export a file detection function: (path) => boolean
  //   3. Filter files by extension, write nodes/edges directly to graph
  // To add a new language: create a new processor file, import it here,
  // and add a filter-read-call-log block following the pattern below.

  // ── Phase 2.5: Markdown processing (headings + cross-links) ────────
  const mdScanned = scannedFiles.filter((f) => f.path.endsWith('.md') || f.path.endsWith('.mdx'));
  if (mdScanned.length > 0) {
    const mdContents = await readFileContents(
      repoPath,
      mdScanned.map((f) => f.path),
    );
    const mdFiles = mdScanned
      .filter((f) => mdContents.has(f.path))
      .map((f) => ({ path: f.path, content: mdContents.get(f.path)! }));
    const allPathSet = new Set(allPaths);
    const mdResult = processMarkdown(graph, mdFiles, allPathSet);
    if (isDev) {
      console.log(
        `  Markdown: ${mdResult.sections} sections, ${mdResult.links} cross-links from ${mdFiles.length} files`,
      );
    }
  }

  // ── Phase 2.6: COBOL processing (regex extraction, no tree-sitter) ──
  const cobolScanned = scannedFiles.filter((f) => isCobolFile(f.path) || isJclFile(f.path));
  if (cobolScanned.length > 0) {
    const cobolContents = await readFileContents(
      repoPath,
      cobolScanned.map((f) => f.path),
    );
    const cobolFiles = cobolScanned
      .filter((f) => cobolContents.has(f.path))
      .map((f) => ({ path: f.path, content: cobolContents.get(f.path)! }));
    const allPathSet = new Set(allPaths);
    const cobolResult = processCobol(graph, cobolFiles, allPathSet);
    if (isDev) {
      console.log(
        `  COBOL: ${cobolResult.programs} programs, ${cobolResult.paragraphs} paragraphs, ${cobolResult.sections} sections from ${cobolFiles.length} files`,
      );
      if (
        cobolResult.execSqlBlocks > 0 ||
        cobolResult.execCicsBlocks > 0 ||
        cobolResult.entryPoints > 0
      ) {
        console.log(
          `  COBOL enriched: ${cobolResult.execSqlBlocks} SQL blocks, ${cobolResult.execCicsBlocks} CICS blocks, ${cobolResult.entryPoints} entry points, ${cobolResult.moves} moves, ${cobolResult.fileDeclarations} file declarations`,
        );
      }
      if (cobolResult.jclJobs > 0) {
        console.log(`  JCL: ${cobolResult.jclJobs} jobs, ${cobolResult.jclSteps} steps`);
      }
    }
  }

  return { scannedFiles, allPaths, totalFiles };
}

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
 *
 * State accumulated across chunks: symbolTable, importMap, namedImportMap,
 * moduleAliasMap (all via ResolutionContext), exportedTypeMap, workerTypeEnvBindings.
 *
 * @reads  graph (structure nodes from Phase 1+2)
 * @reads  allPaths (from scan phase)
 * @writes graph (Symbol nodes, IMPORTS/CALLS/EXTENDS/IMPLEMENTS/ACCESSES edges)
 * @writes ctx.symbolTable, ctx.importMap, ctx.namedImportMap, ctx.moduleAliasMap
 *
 * Follow-up from PR review: MethodExtractor (FieldExtractor parity) and optional
 * METHOD_IMPLEMENTS graph edges to make dispatch queryable without an in-memory map.
 */
async function runChunkedParseAndResolve(
  graph: ReturnType<typeof createKnowledgeGraph>,
  ctx: ReturnType<typeof createResolutionContext>,
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
  const symbolTable = ctx.symbols;

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
  // Reused across all chunks to avoid rebuilding O(files × path_depth) structures.
  const importCtx = buildImportResolutionContext(allPaths);
  const allPathObjects = allPaths.map((p) => ({ path: p }));

  // Worker path: parse + imports + heritage per chunk; buffer extracted calls and
  // run processCallsFromExtracted once after all chunks so interface-dispatch uses a
  // complete implementor map (heritage from every chunk). Costs peak RAM for buffered
  // call rows vs streaming resolution per chunk.
  const sequentialChunkPaths: string[][] = [];
  // Pre-compute which chunks need synthesis — O(1) lookup per chunk.
  const chunkNeedsSynthesis = chunks.map((paths) =>
    paths.some((p) => {
      const lang = getLanguageFromFilename(p);
      return lang != null && needsSynthesis(lang);
    }),
  );
  // Phase 14: Collect exported type bindings for cross-file propagation
  const exportedTypeMap: ExportedTypeMap = new Map();
  // Accumulate file-scope TypeEnv bindings from workers (closes worker/sequential quality gap)
  const bindingAccumulator = new BindingAccumulator();
  // Accumulate fetch() calls from workers for Next.js route matching
  const allFetchCalls: ExtractedFetchCall[] = [];
  // Accumulate framework-extracted routes (Laravel, etc.) for Route node creation
  const allExtractedRoutes: ExtractedRoute[] = [];
  // Accumulate decorator-based routes (@Get, @Post, @app.route, etc.)
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  // Accumulate MCP/RPC tool definitions (@mcp.tool(), @app.tool(), etc.)
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const deferredWorkerCalls: ExtractedCall[] = [];
  const deferredWorkerHeritage: ExtractedHeritage[] = [];
  const deferredConstructorBindings: FileConstructorBindings[] = [];
  const deferredAssignments: ExtractedAssignment[] = [];

  try {
    for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
      const chunkPaths = chunks[chunkIdx];

      // Read content for this chunk only
      const chunkContents = await readFileContents(repoPath, chunkPaths);
      const chunkFiles = chunkPaths
        .filter((p) => chunkContents.has(p))
        .map((p) => ({ path: p, content: chunkContents.get(p)! }));

      // Parse this chunk (workers or sequential fallback)
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
        // Imports
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

        // Heritage + Routes — calls deferred until all chunks have contributed heritage
        // (complete implementor map for interface dispatch).
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
        // Collect file-scope bindings into BindingAccumulator. The worker
        // IPC payload carries only file-scope entries (`scope = ''`
        // hardcoded here). See the FileScopeBindings JSDoc in
        // parse-worker.ts for the rationale and Phase 9 reversion path.
        //
        // Defensive validation at the IPC boundary: silently skip entries
        // with non-string varName/typeName. If a future worker regression
        // (or a Phase 9 reversion mistake that emits 3-tuples into the
        // 2-tuple consumer) produces malformed data, logging is better
        // than silently writing `undefined` into the enrichment map.
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
        // Collect fetch() calls for Next.js route matching
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

      // Clear AST cache between chunks to free memory
      astCache.clear();
      // chunkContents + chunkFiles + chunkWorkerData go out of scope → GC reclaims
    }

    // Build unified HeritageMap (parent lookup + implementor index) after all chunks.
    const fullWorkerHeritageMap =
      deferredWorkerHeritage.length > 0 ? buildHeritageMap(deferredWorkerHeritage, ctx) : undefined;

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
        // Phase 9: pass the accumulator so processCallsFromExtracted can fall back
        // to file-scope TypeEnv bindings when the SymbolTable lacks a return type
        // for a cross-file callee (e.g. var x = getUser() → x: User).
        //
        // Lifecycle ordering: the accumulator is populated but NOT yet finalized
        // at this seam. finalize() is called later (after the sequential-path
        // processCalls which also appends via typeEnv.flush()). Moving finalize()
        // before this call would break sequential-path repos. Pre-finalize reads
        // are safe because finalize() is a write-lock-only operation with no side
        // effects on stored data. All worker-path appendFile calls complete in the
        // chunk loop above, so every worker-contributed binding is available via
        // fileScopeGet().
        bindingAccumulator,
      );
    }

    if (deferredAssignments.length > 0) {
      processAssignmentsFromExtracted(
        graph,
        deferredAssignments,
        ctx,
        deferredConstructorBindings.length > 0 ? deferredConstructorBindings : undefined,
        bindingAccumulator, // Phase 9 fallback parity with processCallsFromExtracted (R3)
      );
    }
  } finally {
    await workerPool?.terminate();
  }

  // Sequential fallback chunks: re-read source for call/heritage resolution
  // Synthesize wildcard import bindings once after ALL imports are processed,
  // before any call resolution — same rationale as the worker-path inline synthesis.
  if (sequentialChunkPaths.length > 0) synthesizeWildcardImportBindings(graph, ctx);
  // Pass 1: Extract heritage from all sequential chunks.
  // Heritage must be fully accumulated BEFORE call resolution so the HeritageMap
  // has the complete ancestor chain and implementor index (same constraint as
  // the worker path).
  //
  // File contents are read once here and cached for Pass 2 to avoid a 2× I/O
  // cost on the sequential path (ASTs are intentionally NOT cached — rebuilding
  // them in Pass 2 keeps peak memory bounded to one chunk at a time).
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
    // Manual loop (not spread) — `push(...arr)` blows the stack on very large
    // arrays, see #650. Pay the explicit iteration cost for safety.
    for (const h of sequentialHeritage) allSequentialHeritage.push(h);
    astCache.clear();
  }
  // Build unified HeritageMap from all sequential heritage (parent lookup + implementor index).
  const sequentialHeritageMap =
    allSequentialHeritage.length > 0 ? buildHeritageMap(allSequentialHeritage, ctx) : undefined;

  // Pass 2: Process calls, heritage edges, fetch calls, and ORM queries per chunk.
  // Reuse the file contents cached in Pass 1 instead of re-reading from disk.
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
    // Extract fetch() calls for Next.js route matching (sequential path)
    const chunkFetchCalls = await extractFetchCallsFromFiles(chunkFiles, astCache);
    if (chunkFetchCalls.length > 0) {
      for (const _item of chunkFetchCalls) allFetchCalls.push(_item);
    }
    // Extract ORM queries (sequential path)
    for (const f of chunkFiles) {
      extractORMQueriesInline(f.path, f.content, allORMQueries);
    }
    astCache.clear();
    // Release cached chunk content as soon as Pass 2 finishes with it so the
    // Pass-1 content map drains incrementally rather than being held for the
    // full duration of Pass 2.
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
    console.log(
      `🔍 Fuzzy Lookups: ${rcStats.fuzzyCallCount} total, ${rcStats.fuzzyCallableCallCount} callable`,
    );
  }

  // ── Finalize the accumulator before the read phase begins. All worker-path
  //    appends (line ~934) and sequential-path flushes (via `processCalls` →
  //    `typeEnv.flush()` earlier in this function) have completed by here,
  //    so the finalize-write-lock is correct at this seam. Making the
  //    lifecycle contract explicit — `append → finalize → consume → dispose`.
  //    Previously `finalize()` was called much later in `runPipelineFromRepo`
  //    after the enrichment loop had already read the mutable accumulator.
  bindingAccumulator.finalize();

  // ── Worker path quality enrichment: merge file-scope bindings into ExportedTypeMap ──
  // Counterpart to `collectExportedBindings()` in call-processor.ts which
  // handles the sequential path (main thread, full SymbolTable access).
  // This call handles the worker path via the accumulator. Both sites
  // populate the same `exportedTypeMap` with subtly different export-check
  // semantics — sequential uses SymbolTable + graph lookup, `enrichExportedTypeMap`
  // uses a three-candidate-ID graph lookup. They must stay in sync until
  // Phase 9 unifies them. If you edit one, check the other.
  //
  // The enrichment loop itself lives in `binding-accumulator.ts` so tests
  // can exercise the real production code instead of reimplementing it.
  const enriched = enrichExportedTypeMap(bindingAccumulator, graph, exportedTypeMap);
  if (isDev && enriched > 0) {
    console.log(
      `🔗 Worker TypeEnv enrichment: ${enriched} fixpoint-inferred exports added to ExportedTypeMap`,
    );
  }

  // ── Final synthesis pass for whole-module-import languages ──
  // Per-chunk synthesis (above) already ran incrementally. This final pass ensures
  // any remaining files whose imports were not covered inline are also synthesized,
  // and that Phase 14 type propagation has complete namedImportMap data.
  const synthesized = synthesizeWildcardImportBindings(graph, ctx);
  if (isDev && synthesized > 0) {
    console.log(
      `🔗 Synthesized ${synthesized} additional wildcard import bindings (Go/Ruby/C++/Swift/Python)`,
    );
  }

  // Free import resolution context — suffix index + resolve cache no longer needed
  // (allPathObjects and importCtx hold ~94MB+ for large repos)
  allPathObjects.length = 0;
  importCtx.resolveCache.clear();
  importCtx.index = EMPTY_INDEX; // Release suffix index memory (~30MB for large repos)
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

/**
 * Post-parse graph analysis: MRO, community detection, process extraction.
 *
 * @reads  graph (all nodes and relationships from parse + resolve phases)
 * @writes graph (Community nodes, Process nodes, MEMBER_OF edges, STEP_IN_PROCESS edges, METHOD_OVERRIDES edges)
 */
async function runGraphAnalysisPhases(
  graph: ReturnType<typeof createKnowledgeGraph>,
  totalFiles: number,
  onProgress: ProgressFn,
  routeRegistry?: Map<string, { filePath: string; source: string }>,
  toolDefs?: { name: string; filePath: string; description: string }[],
): Promise<{
  communityResult: Awaited<ReturnType<typeof processCommunities>>;
  processResult: Awaited<ReturnType<typeof processProcesses>>;
}> {
  // ── Phase 4.5: Method Resolution Order ──────────────────────────────
  onProgress({
    phase: 'parsing',
    percent: 81,
    message: 'Computing method resolution order...',
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  const mroResult = computeMRO(graph);
  if (isDev && mroResult.entries.length > 0) {
    console.log(
      `🔀 MRO: ${mroResult.entries.length} classes analyzed, ${mroResult.ambiguityCount} ambiguities, ${mroResult.overrideEdges} METHOD_OVERRIDES, ${mroResult.methodImplementsEdges} METHOD_IMPLEMENTS`,
    );
  }

  // ── Phase 5: Communities ───────────────────────────────────────────
  onProgress({
    phase: 'communities',
    percent: 82,
    message: 'Detecting code communities...',
    stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
  });

  const communityResult = await processCommunities(graph, (message, progress) => {
    const communityProgress = 82 + progress * 0.1;
    onProgress({
      phase: 'communities',
      percent: Math.round(communityProgress),
      message,
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
    });
  });

  if (isDev) {
    console.log(
      `🏘️ Community detection: ${communityResult.stats.totalCommunities} communities found (modularity: ${communityResult.stats.modularity.toFixed(3)})`,
    );
  }

  communityResult.communities.forEach((comm) => {
    graph.addNode({
      id: comm.id,
      label: 'Community' as const,
      properties: {
        name: comm.label,
        filePath: '',
        heuristicLabel: comm.heuristicLabel,
        cohesion: comm.cohesion,
        symbolCount: comm.symbolCount,
      },
    });
  });

  communityResult.memberships.forEach((membership) => {
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
  graph.forEachNode((n) => {
    if (n.label !== 'File') symbolCount++;
  });
  const dynamicMaxProcesses = Math.max(20, Math.min(300, Math.round(symbolCount / 10)));

  const processResult = await processProcesses(
    graph,
    communityResult.memberships,
    (message, progress) => {
      const processProgress = 94 + progress * 0.05;
      onProgress({
        phase: 'processes',
        percent: Math.round(processProgress),
        message,
        stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: graph.nodeCount },
      });
    },
    { maxProcesses: dynamicMaxProcesses, minSteps: 3 },
  );

  if (isDev) {
    console.log(
      `🔄 Process detection: ${processResult.stats.totalProcesses} processes found (${processResult.stats.crossCommunityCount} cross-community)`,
    );
  }

  processResult.processes.forEach((proc) => {
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
      },
    });
  });

  processResult.steps.forEach((step) => {
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
  if ((routeRegistry?.size ?? 0) > 0 || (toolDefs?.length ?? 0) > 0) {
    // Reverse indexes: file → all route URLs / tool names (handles multi-route files)
    const routesByFile = new Map<string, string[]>();
    if (routeRegistry) {
      for (const [url, entry] of routeRegistry) {
        let list = routesByFile.get(entry.filePath);
        if (!list) {
          list = [];
          routesByFile.set(entry.filePath, list);
        }
        list.push(url);
      }
    }
    const toolsByFile = new Map<string, string[]>();
    if (toolDefs) {
      for (const td of toolDefs) {
        let list = toolsByFile.get(td.filePath);
        if (!list) {
          list = [];
          toolsByFile.set(td.filePath, list);
        }
        list.push(td.name);
      }
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

  return { communityResult, processResult };
}

// ── Pipeline orchestrator ─────────────────────────────────────────────────

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const ctx = createResolutionContext();
  const pipelineStart = Date.now();

  // Hoisted reference for error-path cleanup. The accumulator is normally
  // disposed at the happy-path seam after the dev telemetry log, but if any
  // step between the runChunkedParseAndResolve return and that seam throws
  // (ORM processing, tool node creation, Phase 14, graph analysis), the
  // catch handler disposes it here so the heap footprint does not leak
  // through the rethrow. See binding-accumulator.ts dispose() JSDoc for the
  // lifecycle contract.
  let bindingAccumulatorForCleanup: BindingAccumulator | undefined;

  try {
    // Phase 1+2: Scan paths, build structure, process markdown
    const { scannedFiles, allPaths, totalFiles } = await runScanAndStructure(
      repoPath,
      graph,
      onProgress,
    );

    // Phase 3+4: Chunked parse + resolve (imports, calls, heritage, routes)
    const {
      exportedTypeMap,
      allFetchCalls,
      allExtractedRoutes,
      allDecoratorRoutes,
      allToolDefs,
      allORMQueries,
      bindingAccumulator,
    } = await runChunkedParseAndResolve(
      graph,
      ctx,
      scannedFiles,
      allPaths,
      totalFiles,
      repoPath,
      pipelineStart,
      onProgress,
      options,
    );
    // Track the accumulator for error-path cleanup — the happy-path dispose
    // is still at the post-telemetry seam below, this reference is only
    // consulted by the catch handler if any step between here and there
    // throws.
    bindingAccumulatorForCleanup = bindingAccumulator;

    // ── Phase 3.5: Route Registry (Next.js + PHP + Laravel + decorators) ──
    type RouteEntry = { filePath: string; source: string };
    const routeRegistry = new Map<string, RouteEntry>();

    // Detect Expo Router app/ roots vs Next.js app/ roots (monorepo-safe).
    const expoAppRoots = new Set<string>();
    const nextjsAppRoots = new Set<string>();
    const expoAppPaths = new Set<string>();
    for (const p of allPaths) {
      const norm = p.replace(/\\/g, '/');
      const appIdx = norm.lastIndexOf('app/');
      if (appIdx < 0) continue;
      const root = norm.slice(0, appIdx + 4);
      if (/\/_layout\.(tsx?|jsx?)$/.test(norm)) expoAppRoots.add(root);
      if (/\/page\.(tsx?|jsx?)$/.test(norm)) nextjsAppRoots.add(root);
    }
    for (const root of nextjsAppRoots) expoAppRoots.delete(root);
    if (expoAppRoots.size > 0) {
      for (const p of allPaths) {
        const norm = p.replace(/\\/g, '/');
        const appIdx = norm.lastIndexOf('app/');
        if (appIdx >= 0 && expoAppRoots.has(norm.slice(0, appIdx + 4))) expoAppPaths.add(p);
      }
    }

    for (const p of allPaths) {
      if (expoAppPaths.has(p)) {
        const expoURL = expoFileToRouteURL(p);
        if (expoURL && !routeRegistry.has(expoURL)) {
          routeRegistry.set(expoURL, { filePath: p, source: 'expo-filesystem-route' });
          continue;
        }
      }
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

    const ensureSlash = (path: string) => (path.startsWith('/') ? path : '/' + path);
    let duplicateRoutes = 0;
    const addRoute = (url: string, entry: RouteEntry) => {
      if (routeRegistry.has(url)) {
        duplicateRoutes++;
        return;
      }
      routeRegistry.set(url, entry);
    };
    for (const route of allExtractedRoutes) {
      if (!route.routePath) continue;
      addRoute(ensureSlash(route.routePath), {
        filePath: route.filePath,
        source: 'framework-route',
      });
    }
    for (const dr of allDecoratorRoutes) {
      addRoute(ensureSlash(dr.routePath), {
        filePath: dr.filePath,
        source: `decorator-${dr.decoratorName}`,
      });
    }

    let handlerContents: Map<string, string> | undefined;
    if (routeRegistry.size > 0) {
      const handlerPaths = [...routeRegistry.values()].map((e) => e.filePath);
      handlerContents = await readFileContents(repoPath, handlerPaths);

      for (const [routeURL, entry] of routeRegistry) {
        const { filePath: handlerPath, source: routeSource } = entry;
        const content = handlerContents.get(handlerPath);

        const { responseKeys, errorKeys } = content
          ? handlerPath.endsWith('.php')
            ? extractPHPResponseShapes(content)
            : extractResponseShapes(content)
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
        console.log(
          `🗺️ Route registry: ${routeRegistry.size} routes${duplicateRoutes > 0 ? ` (${duplicateRoutes} duplicate URLs skipped)` : ''}`,
        );
      }
    }

    // ── Phase 3.5b: Link Next.js project-level middleware.ts to routes ──
    if (routeRegistry.size > 0) {
      const middlewareCandidates = allPaths.filter(
        (p) =>
          p === 'middleware.ts' ||
          p === 'middleware.js' ||
          p === 'middleware.tsx' ||
          p === 'middleware.jsx' ||
          p === 'src/middleware.ts' ||
          p === 'src/middleware.js' ||
          p === 'src/middleware.tsx' ||
          p === 'src/middleware.jsx',
      );
      if (middlewareCandidates.length > 0) {
        const mwContents = await readFileContents(repoPath, middlewareCandidates);
        for (const [mwPath, mwContent] of mwContents) {
          const config = extractNextjsMiddlewareConfig(mwContent);
          if (!config) continue;
          const mwLabel =
            config.wrappedFunctions.length > 0 ? config.wrappedFunctions : [config.exportedName];

          // Pre-compile matchers once per middleware file
          const compiled = config.matchers
            .map(compileMatcher)
            .filter((m): m is NonNullable<typeof m> => m !== null);

          let linkedCount = 0;
          for (const [routeURL] of routeRegistry) {
            const matches =
              compiled.length === 0 ||
              compiled.some((cm) => compiledMatcherMatchesRoute(cm, routeURL));
            if (!matches) continue;

            const routeNodeId = generateId('Route', routeURL);
            const existing = graph.getNode(routeNodeId);
            if (!existing) continue;

            const currentMw = (existing.properties.middleware as string[] | undefined) ?? [];
            // Prepend project-level middleware (runs before handler-level wrappers)
            existing.properties.middleware = [
              ...mwLabel,
              ...currentMw.filter((m) => !mwLabel.includes(m)),
            ];
            linkedCount++;
          }
          if (isDev && linkedCount > 0) {
            console.log(
              `🛡️ Linked ${mwPath} middleware [${mwLabel.join(', ')}] to ${linkedCount} routes`,
            );
          }
        }
      }
    }

    // Scan HTML/PHP/template files for <form action="/path"> and AJAX url patterns
    // Scan HTML/template files for <form action="/path"> and AJAX url patterns
    // Skip .php — already parsed by tree-sitter with http_client/fetch queries
    const htmlCandidates = allPaths.filter(
      (p) =>
        p.endsWith('.html') ||
        p.endsWith('.htm') ||
        p.endsWith('.ejs') ||
        p.endsWith('.hbs') ||
        p.endsWith('.blade.php'),
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

    // ── Phase 3.5c: Extract Expo Router navigation patterns ──
    if (expoAppPaths.size > 0 && routeRegistry.size > 0) {
      const unreadExpoPaths = [...expoAppPaths].filter((p) => !handlerContents?.has(p));
      const extraContents =
        unreadExpoPaths.length > 0
          ? await readFileContents(repoPath, unreadExpoPaths)
          : new Map<string, string>();
      const allExpoContents = new Map([...(handlerContents ?? new Map()), ...extraContents]);
      for (const [filePath, content] of allExpoContents) {
        if (!expoAppPaths.has(filePath)) continue;
        for (const pattern of EXPO_NAV_PATTERNS) {
          pattern.lastIndex = 0;
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const url = match[2] ?? match[1];
            if (url && url.startsWith('/')) {
              allFetchCalls.push({ filePath, fetchURL: url, lineNumber: 0 });
            }
          }
        }
      }
    }

    if (routeRegistry.size > 0 && allFetchCalls.length > 0) {
      const routeURLToFile = new Map<string, string>();
      for (const [url, entry] of routeRegistry) routeURLToFile.set(url, entry.filePath);

      // Read consumer file contents so we can extract property access patterns
      const consumerPaths = [...new Set(allFetchCalls.map((c) => c.filePath))];
      const consumerContents = await readFileContents(repoPath, consumerPaths);

      processNextjsFetchRoutes(graph, allFetchCalls, routeURLToFile, consumerContents);
      if (isDev) {
        console.log(
          `🔗 Processed ${allFetchCalls.length} fetch() calls against ${routeRegistry.size} routes`,
        );
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
    const toolCandidatePaths = allPaths.filter(
      (p) =>
        (p.endsWith('.ts') || p.endsWith('.js')) &&
        p.toLowerCase().includes('tool') &&
        !p.includes('node_modules') &&
        !p.includes('test') &&
        !p.includes('__'),
    );
    if (toolCandidatePaths.length > 0) {
      const toolContents = await readFileContents(repoPath, toolCandidatePaths);
      for (const [filePath, content] of toolContents) {
        // Only scan files that contain 'inputSchema' — this is the MCP tool signature
        if (!content.includes('inputSchema')) continue;
        const toolPattern =
          /name:\s*['"](\w+)['"]\s*,\s*\n?\s*description:\s*[`'"]([\s\S]*?)[`'"]/g;
        let match;
        while ((match = toolPattern.exec(content)) !== null) {
          const name = match[1];
          if (seenToolNames.has(name)) continue;
          seenToolNames.add(name);
          toolDefs.push({
            name,
            filePath,
            description: match[2].slice(0, 200).replace(/\n/g, ' ').trim(),
          });
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

    // ── Phase 3.7: ORM Dataflow Detection (Prisma + Supabase) ──────────
    if (allORMQueries.length > 0) {
      processORMQueries(graph, allORMQueries, isDev);
    }

    // `bindingAccumulator.finalize()` was moved inside `runChunkedParseAndResolve`
    // to immediately precede the enrichment loop — see the comment there for
    // the ordering rationale. By the time execution
    // reaches this point, the accumulator has already been finalized, consumed
    // by the enrichment loop, and is ready for dispose() below after the dev
    // telemetry log captures peak state.

    if (isDev) {
      if (bindingAccumulator.totalBindings > 0) {
        const memKB = Math.round(bindingAccumulator.estimateMemoryBytes() / 1024);
        console.log(
          `📦 BindingAccumulator: ${bindingAccumulator.totalBindings} bindings across ${bindingAccumulator.fileCount} files (~${memKB} KB)`,
        );
      } else if (totalFiles > 0) {
        // Zero-binding signal: if the pipeline parsed files but the
        // accumulator is empty, something upstream dropped all bindings.
        // Flag it so operators can spot a regression (e.g. a worker path
        // that accidentally emits empty fileScopeBindings arrays for every
        // file, or a TypeEnv build failure). Dev-mode only.
        console.log(
          `📦 BindingAccumulator: EMPTY — 0 bindings across 0 files despite ${totalFiles} parsed files. If the codebase has typed bindings, this indicates an upstream regression.`,
        );
      }
    }

    // Release the accumulator's heap footprint now. Both consumers of the
    // accumulator have completed:
    //   1. ExportedTypeMap enrichment loop (enrichExportedTypeMap, above).
    //   2. Phase 9: processCallsFromExtracted in runChunkedParseAndResolve,
    //      which uses the accumulator as a BindingAccumulator fallback for
    //      cross-file return types when the SymbolTable has no returnType.
    // Phase 14 (runCrossFileBindingPropagation) and runGraphAnalysisPhases
    // do not read the accumulator — keeping it alive through those long-
    // running phases pins heap for no reason.
    bindingAccumulator.dispose();
    // Happy-path dispose completed — clear the cleanup ref so the catch
    // handler doesn't attempt a second (harmless but noisy) dispose if a
    // later phase throws.
    bindingAccumulatorForCleanup = undefined;

    // ── Phase 14: Cross-file binding propagation (topological level sort) ──
    await runCrossFileBindingPropagation(
      graph,
      ctx,
      exportedTypeMap,
      allPaths,
      totalFiles,
      repoPath,
      pipelineStart,
      onProgress,
    );

    // Post-parse graph analysis (MRO, communities, processes)
    let communityResult: Awaited<ReturnType<typeof processCommunities>> | undefined;
    let processResult: Awaited<ReturnType<typeof processProcesses>> | undefined;

    if (!options?.skipGraphPhases) {
      const graphResults = await runGraphAnalysisPhases(
        graph,
        totalFiles,
        onProgress,
        routeRegistry,
        toolDefs,
      );
      communityResult = graphResults.communityResult;
      processResult = graphResults.processResult;
    }

    onProgress({
      phase: 'complete',
      percent: 100,
      message:
        communityResult && processResult
          ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
          : 'Graph complete! (graph phases skipped)',
      stats: {
        filesProcessed: totalFiles,
        totalFiles,
        nodesCreated: graph.nodeCount,
      },
    });

    return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult };
  } catch (error) {
    // Error-path cleanup: dispose the accumulator if a step after the
    // destructure from runChunkedParseAndResolve but before the happy-path
    // dispose threw. The reference is cleared on the happy path, so this
    // is a no-op when the pipeline completed successfully and then threw
    // from an unrelated post-dispose step (e.g., future cleanup code).
    bindingAccumulatorForCleanup?.dispose();
    ctx.clear();
    throw error;
  }
};

// Inline ORM regex extraction (avoids importing parse-worker which has worker-only code)
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

// ============================================================================
// ORM Query Processing — creates QUERIES edges from callers to model nodes
// ============================================================================

function processORMQueries(
  graph: ReturnType<typeof createKnowledgeGraph>,
  queries: ExtractedORMQuery[],
  isDev: boolean,
): void {
  const modelNodes = new Map<string, string>();
  const seenEdges = new Set<string>();
  let edgesCreated = 0;

  for (const q of queries) {
    const modelKey = `${q.orm}:${q.model}`;
    let modelNodeId = modelNodes.get(modelKey);
    if (!modelNodeId) {
      const candidateIds = [
        generateId('Class', `${q.model}`),
        generateId('Interface', `${q.model}`),
        generateId('CodeElement', `${q.model}`),
      ];
      const existing = candidateIds.find((id) => graph.getNode(id));
      if (existing) {
        modelNodeId = existing;
      } else {
        modelNodeId = generateId('CodeElement', `${q.orm}:${q.model}`);
        graph.addNode({
          id: modelNodeId,
          label: 'CodeElement',
          properties: {
            name: q.model,
            filePath: '',
            description: `${q.orm} model/table: ${q.model}`,
          },
        });
      }
      modelNodes.set(modelKey, modelNodeId);
    }

    const fileId = generateId('File', q.filePath);
    const edgeKey = `${fileId}->${modelNodeId}:${q.method}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);

    graph.addRelationship({
      id: generateId('QUERIES', edgeKey),
      sourceId: fileId,
      targetId: modelNodeId,
      type: 'QUERIES',
      confidence: 0.9,
      reason: `${q.orm}-${q.method}`,
    });
    edgesCreated++;
  }

  if (isDev) {
    console.log(
      `ORM dataflow: ${edgesCreated} QUERIES edges, ${modelNodes.size} models (${queries.length} total calls)`,
    );
  }
}
