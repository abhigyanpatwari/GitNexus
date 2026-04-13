/**
 * Cross-file binding propagation — extracted from pipeline.ts.
 *
 * Seeds downstream files with resolved type bindings from upstream exports.
 */

import {
  processCalls,
  buildImportedReturnTypes,
  buildImportedRawReturnTypes,
  type ExportedTypeMap,
  buildExportedTypeMapFromGraph,
} from '../call-processor.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { createASTCache } from '../ast-cache.js';
import { type PipelineProgress, getLanguageFromFilename } from 'gitnexus-shared';
import { readFileContents } from '../filesystem-walker.js';
import { isLanguageAvailable } from '../../tree-sitter/parser-loader.js';
import { topologicalLevelSort } from '../pipeline.js';
import type { KnowledgeGraph } from '../../graph/types.js';

const isDev = process.env.NODE_ENV === 'development';

/** Minimum percentage of files that must benefit from cross-file seeding. */
const CROSS_FILE_SKIP_THRESHOLD = 0.03;
/** Hard cap on files re-processed during cross-file propagation. */
const MAX_CROSS_FILE_REPROCESS = 2000;
/** Max AST trees to keep in LRU cache */
const AST_CACHE_CAP = 50;

/**
 * Cross-file binding propagation.
 * Returns the number of files re-processed.
 */
export async function runCrossFileBindingPropagation(
  graph: KnowledgeGraph,
  ctx: ReturnType<typeof createResolutionContext>,
  exportedTypeMap: ExportedTypeMap,
  allPaths: string[],
  totalFiles: number,
  repoPath: string,
  pipelineStart: number,
  onProgress: (progress: PipelineProgress) => void,
): Promise<number> {
  // For the worker path, buildTypeEnv runs inside workers without SymbolTable,
  // so exported bindings must be collected from graph + SymbolTable in main thread.
  if (exportedTypeMap.size === 0 && graph.nodeCount > 0) {
    const graphExports = buildExportedTypeMapFromGraph(graph, ctx.model.symbols);
    for (const [fp, exports] of graphExports) exportedTypeMap.set(fp, exports);
  }

  if (exportedTypeMap.size === 0 || ctx.namedImportMap.size === 0) return 0;

  const allPathSet = new Set(allPaths);
  const { levels, cycleCount } = topologicalLevelSort(ctx.importMap);

  if (isDev && cycleCount > 0) {
    console.log(`🔄 ${cycleCount} files in import cycles (skipped for cross-file propagation)`);
  }

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
        const def = ctx.model.symbols.lookupExactFull(binding.sourcePath, binding.exportedName);
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
    return 0;
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

      const importedReturns = buildImportedReturnTypes(
        filePath,
        ctx.namedImportMap,
        ctx.model.symbols,
      );
      const importedRawReturns = buildImportedRawReturnTypes(
        filePath,
        ctx.namedImportMap,
        ctx.model.symbols,
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

  return crossFileResolved;
}
