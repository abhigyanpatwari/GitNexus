import type { NodeLabel } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import type { SymbolTableWriter } from './model/index.js';
import { getLanguageFromFilename } from 'gitnexus-shared';

import { accumulateExportedTypesFromParsedNode, type ExportedTypeMap } from './call-processor.js';

import type { ParsedFile } from 'gitnexus-shared';
import { WorkerPool } from './workers/worker-pool.js';
import type { SkippedPath } from './workers/clone-safety.js';
import type { CfgSkipCounts } from './cfg/collect.js';
import { logger } from '../logger.js';
import type {
  ParseWorkerResult,
  ParseWorkerInput,
  ExtractedRoute,
  ExtractedFetchCall,
  ExtractedDecoratorRoute,
  ExtractedModuleConstants,
  ExtractedToolDef,
  FileScopeBindings,
  ExtractedORMQuery,
  FetchWrapperDef,
} from './workers/parse-worker.js';
import type {
  ExtractedRouterConstructorPrefix,
  ExtractedRouterImport,
  ExtractedRouterInclude,
  ExtractedRouterModuleAlias,
} from './route-extractors/fastapi-router-bindings.js';
import type { SharedSpringType } from './route-extractors/spring-shared.js';

export type FileProgressCallback = (current: number, total: number, filePath: string) => void;

export interface WorkerExtractedData {
  routes: ExtractedRoute[];
  fetchCalls: ExtractedFetchCall[];
  fetchWrapperDefs: FetchWrapperDef[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  routerIncludes: ExtractedRouterInclude[];
  routerImports: ExtractedRouterImport[];
  routerConstructorPrefixes: ExtractedRouterConstructorPrefix[];
  routerModuleAliases: ExtractedRouterModuleAlias[];
  /** Per-file Python module constants for cross-file route-path resolution (#2391). */
  moduleConstants: ExtractedModuleConstants[];
  toolDefs: ExtractedToolDef[];
  ormQueries: ExtractedORMQuery[];
  /** Project-wide Spring class/interface views for the #2288 inheritance pass. */
  springTypes: SharedSpringType[];
  fileScopeBindings: FileScopeBindings[];
  /**
   * Per-file `ParsedFile` artifacts from the new scope-based resolution
   * pipeline (RFC #909 Ring 2). Empty until a provider implements
   * `emitScopeCaptures` — additive to the legacy DAG path. Aggregated
   * from every worker chunk; consumed downstream by #921's
   * finalize-orchestrator.
   */
  parsedFiles: ParsedFile[];
}

type ParsedGraphNode = ParseWorkerResult['nodes'][number];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceLine(node: ParsedGraphNode): number {
  const value = node.properties.startLine;
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareParsedNodeSourceOrder(left: ParsedGraphNode, right: ParsedGraphNode): number {
  const leftPath = typeof left.properties.filePath === 'string' ? left.properties.filePath : '';
  const rightPath = typeof right.properties.filePath === 'string' ? right.properties.filePath : '';
  const fileOrder = compareText(leftPath, rightPath);
  if (fileOrder !== 0) return fileOrder;

  const leftLine = sourceLine(left);
  const rightLine = sourceLine(right);
  if (leftLine !== rightLine) return leftLine < rightLine ? -1 : 1;

  return compareText(left.id, right.id);
}

function nodesInSourceOrder(nodes: readonly ParsedGraphNode[]): readonly ParsedGraphNode[] {
  for (let index = 1; index < nodes.length; index++) {
    if (compareParsedNodeSourceOrder(nodes[index - 1], nodes[index]) > 0) {
      return [...nodes].sort(compareParsedNodeSourceOrder);
    }
  }
  return nodes;
}

// ============================================================================
// Worker-based parallel parsing
// ============================================================================

/**
 * Merge a list of `ParseWorkerResult`s into the running graph + symbol
 * table state and produce the chunk-aggregated `WorkerExtractedData`.
 *
 * Split out from the worker-parse path so the same merge logic can
 * be applied to both freshly-parsed worker output AND cached worker
 * output replayed during incremental analyze. Idempotent on the
 * accumulator fields (push-only); idempotent on graph if the caller
 * starts from a clean graph (otherwise duplicate `addNode` calls are
 * silently no-op'd by `KnowledgeGraph`).
 */
export const mergeChunkResults = (
  graph: KnowledgeGraph,
  symbolTable: SymbolTableWriter,
  chunkResults: readonly ParseWorkerResult[],
  exportedTypeMap?: ExportedTypeMap,
): WorkerExtractedData => {
  const allRoutes: ExtractedRoute[] = [];
  const allFetchCalls: ExtractedFetchCall[] = [];
  const allFetchWrapperDefs: FetchWrapperDef[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allRouterIncludes: ExtractedRouterInclude[] = [];
  const allRouterImports: ExtractedRouterImport[] = [];
  const allRouterConstructorPrefixes: ExtractedRouterConstructorPrefix[] = [];
  const allRouterModuleAliases: ExtractedRouterModuleAlias[] = [];
  const allModuleConstants: ExtractedModuleConstants[] = [];
  const allSpringTypes: SharedSpringType[] = [];
  const allToolDefs: ExtractedToolDef[] = [];
  const allORMQueries: ExtractedORMQuery[] = [];
  const fileScopeBindingsByFile: FileScopeBindings[] = [];
  const allParsedFiles: ParsedFile[] = [];

  for (const result of chunkResults) {
    // Worker jobs and input files are already merged in stable start-index/path
    // order. Canonicalize the final per-result node boundary once so graph
    // insertion, cache replay, and first-wins graph indexes share source order.
    // The common already-ordered path stays allocation-free and linear.
    for (const node of nodesInSourceOrder(result.nodes)) {
      graph.addNode({
        id: node.id,
        label: node.label as NodeLabel,
        properties: node.properties,
      });
    }
    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }
    for (const sym of result.symbols) {
      symbolTable.add(sym.filePath, sym.name, sym.nodeId, sym.type, {
        parameterCount: sym.parameterCount,
        requiredParameterCount: sym.requiredParameterCount,
        parameterTypes: sym.parameterTypes,
        parameterTypeClasses: sym.parameterTypeClasses,
        returnType: sym.returnType,
        declaredType: sym.declaredType,
        templateArguments: sym.templateArguments,
        ownerId: sym.ownerId,
        qualifiedName: sym.qualifiedName,
        isDeleted: sym.isDeleted,
      });
    }
    if (exportedTypeMap) {
      for (const node of result.nodes) {
        accumulateExportedTypesFromParsedNode(exportedTypeMap, node, symbolTable);
      }
    }
    for (const item of result.routes) allRoutes.push(item);
    for (const item of result.fetchCalls) allFetchCalls.push(item);
    for (const item of result.fetchWrapperDefs ?? []) allFetchWrapperDefs.push(item);
    for (const item of result.decoratorRoutes) allDecoratorRoutes.push(item);
    for (const item of result.routerIncludes ?? []) allRouterIncludes.push(item);
    for (const item of result.routerImports ?? []) allRouterImports.push(item);
    for (const item of result.routerConstructorPrefixes ?? []) {
      allRouterConstructorPrefixes.push(item);
    }
    for (const item of result.routerModuleAliases ?? []) allRouterModuleAliases.push(item);
    for (const item of result.moduleConstants ?? []) allModuleConstants.push(item);
    for (const item of result.springTypes ?? []) allSpringTypes.push(item);
    for (const item of result.toolDefs) allToolDefs.push(item);
    if (result.ormQueries) for (const item of result.ormQueries) allORMQueries.push(item);
    if (result.fileScopeBindings)
      for (const item of result.fileScopeBindings) fileScopeBindingsByFile.push(item);
    if (result.parsedFiles) for (const item of result.parsedFiles) allParsedFiles.push(item);
  }

  return {
    routes: allRoutes,
    fetchCalls: allFetchCalls,
    fetchWrapperDefs: allFetchWrapperDefs,
    decoratorRoutes: allDecoratorRoutes,
    routerIncludes: allRouterIncludes,
    routerImports: allRouterImports,
    routerConstructorPrefixes: allRouterConstructorPrefixes,
    routerModuleAliases: allRouterModuleAliases,
    moduleConstants: allModuleConstants,
    toolDefs: allToolDefs,
    ormQueries: allORMQueries,
    springTypes: allSpringTypes,
    fileScopeBindings: fileScopeBindingsByFile,
    parsedFiles: allParsedFiles,
  };
};

/**
 * Dispatch a chunk's files to the worker pool and return the RAW per-worker
 * results, WITHOUT merging them into the graph. Split out from
 * {@link processParsing} so the parse loop can overlap one chunk's
 * merge (main-thread, via {@link mergeChunkResults}) with the NEXT chunk's
 * worker parse — the merge is the only remaining serial main-thread step once
 * ParsedFile serialization moved into the workers (#worker-idle pipelining).
 * Returns `[]` for an all-unparseable chunk (the caller merges `[]` → empty).
 */
export const dispatchChunkParse = async (
  files: { path: string; content: string }[],
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
  /** Populated in-place with the raw results (parse-cache capture). */
  outRawResults?: ParseWorkerResult[],
  /**
   * Content hash of this parse chunk. When set, the workers tag their durable
   * ParsedFile shards with it so a future warm cache hit can restore them
   * (#2038). `undefined` ⇒ no durable write (tests / no-cache path).
   */
  chunkHash?: string,
): Promise<ParseWorkerResult[]> => {
  const parseableFiles: ParseWorkerInput[] = [];
  for (const file of files) {
    const lang = getLanguageFromFilename(file.path);
    if (lang) parseableFiles.push({ path: file.path, content: file.content });
  }
  if (parseableFiles.length === 0) return [];

  const total = files.length;
  const chunkResults = await workerPool.dispatch<ParseWorkerInput, ParseWorkerResult>(
    parseableFiles,
    (filesProcessed) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, 'Parsing...');
    },
    chunkHash,
  );

  // Capture raw results for the incremental parse cache before merging.
  if (outRawResults) {
    for (const r of chunkResults) outRawResults.push(r);
  }

  // Skipped-language telemetry (worker output, independent of the merge).
  const skippedLanguages = new Map<string, number>();
  for (const result of chunkResults) {
    for (const [lang, count] of Object.entries(result.skippedLanguages)) {
      skippedLanguages.set(lang, (skippedLanguages.get(lang) || 0) + count);
    }
  }
  if (skippedLanguages.size > 0) {
    const summary = Array.from(skippedLanguages.entries())
      .map(([lang, count]) => `${lang}: ${count}`)
      .join(', ');
    logger.warn(`  Skipped unsupported languages: ${summary}`);
  }

  // Per-language CFG skip telemetry (#2195): functions skipped during the worker
  // CFG walk, bucketed by reason. Only surfaced for a `--pdg` run (otherwise
  // `cfgSkipped` is empty). Warn ONLY when a robustness-relevant bucket
  // (too-deeply-nested / build-error) is non-zero — a too-many-lines skip is the
  // expected, benign minified/generated-code case and would otherwise be spam.
  const cfgSkipped = new Map<string, CfgSkipCounts>();
  for (const result of chunkResults) {
    for (const [lang, counts] of Object.entries(result.cfgSkipped ?? {})) {
      const prev = cfgSkipped.get(lang) ?? { tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 };
      cfgSkipped.set(lang, {
        tooManyLines: prev.tooManyLines + counts.tooManyLines,
        tooDeeplyNested: prev.tooDeeplyNested + counts.tooDeeplyNested,
        buildError: prev.buildError + counts.buildError,
      });
    }
  }
  for (const [lang, c] of cfgSkipped) {
    if (c.tooDeeplyNested > 0 || c.buildError > 0) {
      logger.warn(
        `  CFG functions skipped (${lang}): ${c.tooDeeplyNested} too-deeply-nested, ` +
          `${c.buildError} build-error(s), ${c.tooManyLines} over line cap`,
      );
    }
  }

  // Clone-safety telemetry (#2112): files whose parse output carried a value
  // the structured-clone algorithm couldn't serialize across the worker
  // boundary. The worker sanitized/dropped the offending value so the run
  // could complete; surface the (rare) data loss so it's visible and the
  // offending extractor can be fixed at source.
  const skippedPaths: SkippedPath[] = [];
  for (const result of chunkResults) {
    for (const entry of result.skippedPaths ?? []) skippedPaths.push(entry);
  }
  if (skippedPaths.length > 0) {
    // Keep the per-file reason ("stripped N value(s) from nodes" /
    // "dropped non-serializable parsedFiles entry") — it distinguishes a
    // recoverable strip from a whole-record drop, which a path-only line loses.
    const shown = skippedPaths
      .slice(0, 10)
      .map((e) => `${e.path} (${e.reason})`)
      .join(', ');
    const more = skippedPaths.length > 10 ? ` …and ${skippedPaths.length - 10} more` : '';
    logger.warn(
      `  Sanitized ${skippedPaths.length} file(s) with non-serializable parse output: ${shown}${more}`,
    );
  }

  onFileProgress?.(total, total, 'done');
  return chunkResults;
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Per-`WorkerPool` log-dedup state for quarantine reporting. Keyed on the
 * pool instance so multiple concurrent pools (test fixtures, future
 * multi-pool callers) each get their own seen-set. WeakMap entries vanish
 * when the pool is garbage-collected.
 */
const loggedQuarantineByPool = new WeakMap<WorkerPool, Set<string>>();

export const processParsing = async (
  graph: KnowledgeGraph,
  files: { path: string; content: string }[],
  symbolTable: SymbolTableWriter,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
  /**
   * Optional out-parameter for the incremental parse cache. When provided,
   * populated with the raw `ParseWorkerResult[]` from the workers (pre-merge).
   * See `gitnexus/src/storage/parse-cache.ts`.
   */
  outRawResults?: ParseWorkerResult[],
  exportedTypeMap?: ExportedTypeMap,
): Promise<WorkerExtractedData> => {
  let lastProgress = 0;
  const reportProgress: FileProgressCallback | undefined = onFileProgress
    ? (current, total, detail) => {
        lastProgress = Math.max(lastProgress, current);
        onFileProgress(lastProgress, total, detail);
      }
    : undefined;

  // U20 design pivot: the worker pool's resilience layers (respawn budget,
  // circuit breaker, quarantine, slot-attribution, cumulative timeout) are the
  // SOLE contract for handling worker failures. There is no sequential parser:
  // a partial quarantine drops the file from this run's graph (surfaced by the
  // per-chunk warn below; the chunk-cache write-guard in parse-impl.ts keeps the
  // chunk uncached so the next analyze retries with a fresh pool), and a full
  // pool failure propagates `WorkerPoolDispatchError` so the run errors out.
  const chunkResults = await dispatchChunkParse(files, workerPool, reportProgress, outRawResults);
  const data = mergeChunkResults(graph, symbolTable, chunkResults, exportedTypeMap);
  // Session-scoped quarantine (worker-pool resilience Layer 3): surface any
  // files this pool has decided are unsafe for workers so the operator can see
  // what was skipped. The pool already filtered them out of dispatch; we only
  // need to log + progress-report. Quarantine is session-scoped per pool
  // instance — a fresh `createWorkerPool` call clears it.
  //
  // Dedup: log the full path list only for entries newly quarantined since the
  // previous dispatch on the same pool. The per-chunk progress message still
  // surfaces the count for UX continuity, but the structured `quarantinedFiles`
  // payload is only emitted when there is new signal — prevents
  // O(quarantine × chunks) log spam.
  const quarantineSnapshot = workerPool.getQuarantinedPaths?.() ?? [];
  const quarantineSet = new Set(quarantineSnapshot);
  if (quarantineSet.size > 0) {
    const quarantinedInChunk = files.filter((file) => quarantineSet.has(file.path));
    if (quarantinedInChunk.length > 0) {
      const seenForPool = loggedQuarantineByPool.get(workerPool) ?? new Set<string>();
      const newlyQuarantined = quarantinedInChunk
        .map((file) => file.path)
        .filter((p) => !seenForPool.has(p));
      for (const p of newlyQuarantined) seenForPool.add(p);
      loggedQuarantineByPool.set(workerPool, seenForPool);
      if (newlyQuarantined.length > 0) {
        logger.warn(
          {
            newlyQuarantined,
            cumulativeQuarantine: quarantineSet.size,
            chunkSkipped: quarantinedInChunk.length,
          },
          `Worker quarantine: ${newlyQuarantined.length} new file(s) skipped this chunk ` +
            `(${quarantinedInChunk.length} skipped total, ${quarantineSet.size} cumulative).`,
        );
      }
      reportProgress?.(
        lastProgress,
        files.length,
        `${quarantinedInChunk.length} worker-quarantined file(s) skipped`,
      );
    }
  }
  return data;
};
