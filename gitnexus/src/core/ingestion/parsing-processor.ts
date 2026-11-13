import type { FetchWrapperCall, FetchWrapperReexport } from './route-extractors/fetch-wrapper.js';
import type { NodeLabel } from 'gitnexus-shared';
import { KnowledgeGraph } from '../graph/types.js';
import type { SymbolTableWriter } from './model/index.js';
import { getLanguageForFileContent } from './languages/index.js';

import { accumulateExportedTypesFromParsedNode, type ExportedTypeMap } from './call-processor.js';

import type { ParsedFile } from 'gitnexus-shared';
import { WorkerPool } from './workers/worker-pool.js';
import type { DispatchGroup } from './workers/worker-pool.js';
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
  fetchWrapperCalls: FetchWrapperCall[];
  fetchWrapperReexports: FetchWrapperReexport[];
  decoratorRoutes: ExtractedDecoratorRoute[];
  routeFacts?: { filePath: string; facts: unknown; routePosition: number }[];
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
  /** Scope-extraction omissions represented by this worker/cache result. */
  scopeExtractionFailures: string[];
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

function nodeFilePath(node: ParsedGraphNode): string {
  return typeof node.properties.filePath === 'string' ? node.properties.filePath : '';
}

/**
 * Stable path order: files in ordinal path order, each file's items in the
 * order its parse produced them. Input already in order is returned as is (one
 * linear check, no copy). Otherwise a sorted copy is returned, so an array the
 * parse cache may still hold is never reordered in place.
 */
function inPathOrder<T>(items: T[], pathOf: (item: T) => string): T[] {
  for (let index = 1; index < items.length; index++) {
    if (compareText(pathOf(items[index - 1]), pathOf(items[index])) > 0) {
      return [...items].sort((left, right) => compareText(pathOf(left), pathOf(right)));
    }
  }
  return items;
}

/** {@link inPathOrder} for per-file items, which carry their file's path. */
function byFilePath<T extends { readonly filePath: string }>(items: T[]): T[] {
  return inPathOrder(items, (item) => item.filePath);
}

/**
 * Index of the first item whose file path does not sort before `filePath`, in
 * an array already in file-path order: where that file's items begin, or would
 * begin if it has none.
 */
function filePathStart(items: readonly { readonly filePath: string }[], filePath: string): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareText(items[middle].filePath, filePath) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Every result's items as one list; a single result's own array is not copied. */
function chunkItems<T>(
  results: readonly ParseWorkerResult[],
  itemsOf: (r: ParseWorkerResult) => T[] | undefined,
): T[] {
  if (results.length === 1) return itemsOf(results[0]) ?? [];
  const items: T[] = [];
  for (const result of results) for (const item of itemsOf(result) ?? []) items.push(item);
  return items;
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
  const allFetchWrapperCalls: FetchWrapperCall[] = [];
  const allFetchWrapperReexports: FetchWrapperReexport[] = [];
  const allDecoratorRoutes: ExtractedDecoratorRoute[] = [];
  const allRouteFacts: { filePath: string; facts: unknown; routePosition: number }[] = [];
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
  const scopeExtractionFailures: string[] = [];

  // A chunk arrives either as a few batched worker results (files grouped by
  // language inside each) or as one result per file (the per-file reuse
  // store), and how files are batched depends on the worker count. Graph
  // nodes, the symbol table and the route registry are all first-wins, so the
  // chunk is merged in one canonical order however it arrived: nodes in source
  // order (path, line, id) across the whole chunk, and symbols and every
  // per-file list stably by file path. A batched result can hold many files
  // out of path order, so no result count skips the check; input already in
  // order costs one linear pass and no copy.
  const chunkNodes = chunkItems(chunkResults, (result) => result.nodes);
  for (const node of nodesInSourceOrder(chunkNodes)) {
    graph.addNode({
      id: node.id,
      label: node.label as NodeLabel,
      properties: node.properties,
    });
  }
  for (const result of chunkResults) {
    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }
  }
  for (const sym of byFilePath(chunkItems(chunkResults, (result) => result.symbols))) {
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
    // Each file's nodes in the order its parse produced them (a later export
    // of the same name wins within a file); files in path order.
    for (const node of inPathOrder(chunkNodes, nodeFilePath)) {
      accumulateExportedTypesFromParsedNode(exportedTypeMap, node, symbolTable);
    }
  }

  for (const result of chunkResults) {
    for (const item of result.routes) allRoutes.push(item);
    for (const item of result.fetchCalls) allFetchCalls.push(item);
    for (const item of result.fetchWrapperDefs ?? []) allFetchWrapperDefs.push(item);
    for (const item of result.fetchWrapperCalls ?? []) allFetchWrapperCalls.push(item);
    for (const item of result.fetchWrapperReexports ?? []) allFetchWrapperReexports.push(item);
    for (const item of result.routeFacts ?? []) allRouteFacts.push(item);
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
    for (const filePath of result.scopeExtractionFailures ?? []) {
      scopeExtractionFailures.push(filePath);
    }
  }

  // A file's route facts resolve into routes inserted at `routePosition`, the
  // index in this chunk's decorator routes where that file's own decorator
  // routes begin (the worker records it before extracting them). Reordering the
  // decorator routes moves those starts, so each position is recomputed against
  // the final order: the start of the file's routes, or where they would start
  // when the file has none. That depends only on the paths, never on arrival.
  const decoratorRoutes = byFilePath(allDecoratorRoutes);
  const routeFacts = byFilePath(allRouteFacts).map((item) => ({
    ...item,
    routePosition: filePathStart(decoratorRoutes, item.filePath),
  }));

  return {
    routes: byFilePath(allRoutes),
    fetchCalls: byFilePath(allFetchCalls),
    fetchWrapperDefs: byFilePath(allFetchWrapperDefs),
    fetchWrapperCalls: byFilePath(allFetchWrapperCalls),
    fetchWrapperReexports: byFilePath(allFetchWrapperReexports),
    decoratorRoutes,
    routeFacts,
    routerIncludes: byFilePath(allRouterIncludes),
    routerImports: byFilePath(allRouterImports),
    routerConstructorPrefixes: byFilePath(allRouterConstructorPrefixes),
    routerModuleAliases: byFilePath(allRouterModuleAliases),
    moduleConstants: byFilePath(allModuleConstants),
    toolDefs: byFilePath(allToolDefs),
    ormQueries: byFilePath(allORMQueries),
    springTypes: byFilePath(allSpringTypes),
    fileScopeBindings: byFilePath(fileScopeBindingsByFile),
    parsedFiles: byFilePath(allParsedFiles),
    scopeExtractionFailures: inPathOrder(scopeExtractionFailures, (filePath) => filePath),
  };
};

/**
 * Dispatch ONE chunk's files to the worker pool and return the RAW per-worker
 * results, WITHOUT merging them into the graph. A thin single-group wrapper
 * over {@link dispatchChunkParseRound}, used by {@link processParsing}'s
 * one-shot path. The chunk-to-chunk overlap this once described now lives in
 * `parse-impl.ts` at ROUND granularity (`startRound` / `drainRound` /
 * `closeRound`), which batches several chunks into one dispatch.
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
  const [chunkResults = []] = await dispatchChunkParseRound(
    [{ items: files, chunkHash }],
    workerPool,
    onFileProgress,
  );

  // Capture raw results for the incremental parse cache before merging.
  if (outRawResults) {
    for (const r of chunkResults) outRawResults.push(r);
  }
  return chunkResults;
};

/**
 * Dispatch SEVERAL parse-cache chunks as one pool round and return their raw
 * results, one array per input group in input order.
 *
 * `WorkerPool.dispatch` is a barrier, so one round-trip per chunk leaves most
 * slots idle whenever a chunk is smaller than the pool — which stable
 * `(language, hash(path) % 128)` packs usually are. Batching chunks into one
 * `dispatchGroups` call removes those barriers; jobs are still cut at chunk
 * boundaries, so every result stays attributable to the chunk whose cache key
 * owns it.
 */
export const dispatchChunkParseRound = async (
  groups: ReadonlyArray<DispatchGroup<ParseWorkerInput>>,
  workerPool: WorkerPool,
  onFileProgress?: FileProgressCallback,
): Promise<ParseWorkerResult[][]> => {
  const dispatchGroups: DispatchGroup<ParseWorkerInput>[] = groups.map((group) => {
    const items: ParseWorkerInput[] = [];
    for (const file of group.items) {
      const lang = getLanguageForFileContent(file.path, file.content);
      if (lang)
        items.push({
          path: file.path,
          content: file.content,
          ...(file.cacheKey === undefined ? {} : { cacheKey: file.cacheKey }),
        });
    }
    return { items, chunkHash: group.chunkHash };
  });
  const total = groups.reduce((sum, group) => sum + group.items.length, 0);
  if (dispatchGroups.every((group) => group.items.length === 0)) return groups.map(() => []);

  const perGroup = await workerPool.dispatchGroups<ParseWorkerInput, ParseWorkerResult>(
    dispatchGroups,
    (filesProcessed) => {
      onFileProgress?.(Math.min(filesProcessed, total), total, 'Parsing...');
    },
  );
  const chunkResults = perGroup.flat();

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
  return perGroup;
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
