/**
 * Phase: parse
 *
 * Chunked parse + resolve loop: reads source in byte-budget chunks,
 * parses via the worker pool (the sole parse path — no sequential fallback),
 * resolves imports, heritage, and calls, synthesizes wildcard bindings.
 *
 * This phase encapsulates the entire `runChunkedParseAndResolve` function
 * from the original pipeline. The chunk loop is a memory optimization
 * internal to this phase, not a phase boundary.
 *
 * @deps    structure, markdown, cobol
 * @reads   scannedFiles, allPaths, totalFiles (from structure)
 * @writes  graph (Symbol nodes, IMPORTS/CALLS/EXTENDS/IMPLEMENTS/ACCESSES edges)
 * @output  exportedTypeMap, allFetchCalls, allExtractedRoutes, allDecoratorRoutes,
 *          allToolDefs, allORMQueries, bindingAccumulator
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import type { BindingAccumulator } from '../binding-accumulator.js';
import type { ParsedFile, SupportedLanguages } from 'gitnexus-shared';
import type {
  ExtractedFetchCall,
  ExtractedRoute,
  ExtractedDecoratorRoute,
  ExtractedToolDef,
  ExtractedORMQuery,
  FetchWrapperDef,
} from '../workers/parse-worker.js';
import { runChunkedParseAndResolve } from './parse-impl.js';
import type { MutableSemanticModel } from '../model/index.js';
import type { ModuleConstants } from '../route-extractors/constant-resolver.js';

export interface ParseOutput {
  /**
   * Read-only snapshot of exported type bindings keyed by file path.
   *
   * Fully populated by `parse` on the main thread after the worker parse:
   * `enrichExportedTypeMap` propagates fixpoint-inferred TypeEnv bindings and
   * `buildExportedTypeMapFromGraph` reconstructs from graph nodes.
   * Downstream phases — including `crossFile` — receive it as a true
   * `ReadonlyMap`; `crossFile` builds its own mutable working copy locally
   * for per-file re-resolution writes, so this snapshot is never mutated
   * after parse returns.
   */
  readonly exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly allFetchCalls: readonly ExtractedFetchCall[];
  readonly allFetchWrapperDefs: readonly FetchWrapperDef[];
  readonly allExtractedRoutes: readonly ExtractedRoute[];
  readonly allDecoratorRoutes: readonly ExtractedDecoratorRoute[];
  readonly allToolDefs: readonly ExtractedToolDef[];
  readonly allORMQueries: readonly ExtractedORMQuery[];
  /** Route URL → resolved handler symbol UID (Part 2, #2138). Consumed by the
   *  routes phase to stamp `handlerSymbolId` on Route nodes. */
  readonly routeHandlerSymbols: ReadonlyMap<string, string>;
  bindingAccumulator: BindingAccumulator;
  /** SemanticModel populated during parse — scope-resolution reads its
   *  TypeRegistry / MethodRegistry / SymbolTable indexes. */
  model: MutableSemanticModel;
  /** Pass-through: all file paths for downstream phases. */
  readonly allPaths: readonly string[];
  /** Pass-through: shared `allPathSet` from structure (built once, not per-phase). */
  readonly allPathSet: ReadonlySet<string>;
  /** Pass-through: total file count for progress reporting. */
  totalFiles: number;
  /**
   * True if the parse phase constructed a worker pool for this run. False
   * means no pool was needed — a warm all-cache-hit run replays cached worker
   * output without spawning workers, or there were no parseable files. There
   * is no sequential parser; the pool is the sole parse path on a cache miss.
   */
  readonly usedWorkerPool: boolean;
  /** Files actually dispatched to parser workers after parse-cache lookup. */
  readonly reparsedFileCount: number;
  /**
   * Per-file `ParsedFile` artifacts produced by workers' calls to
   * `extractParsedFile`. Threaded through to `scopeResolutionPhase`
   * as a re-extraction cache: when a file's ParsedFile is present here,
   * scope-resolution can skip its own `extractParsedFile` (which would
   * otherwise re-parse the file with tree-sitter on the main thread,
   * costing ~58s on a 1000-file repo).
   */
  readonly parsedFiles: readonly ParsedFile[];
  /**
   * Content-derived language decisions for files such as `.h` whose extension
   * is ambiguous. Scope resolution reuses this result rather than rereading
   * source solely to classify it.
   */
  readonly contentLanguageByPath: ReadonlyMap<string, SupportedLanguages | null>;
  /**
   * Repo-wide string constants harvested by the providers that declare
   * `extractModuleConstants`, keyed by file path and already through each
   * provider's `prepareRouteConstants` hook.
   *
   * Exposed so a later phase can fold a constant reference the same way the
   * decorator-route pass does — `springDestinations` resolves a broker address
   * written as `Topics.ORDERS` against this table. It is a snapshot: parse does
   * not mutate it after returning, and consumers must not either, because the
   * preparation that made it foldable has already run.
   *
   * Empty when no provider in this repo harvests constants. A downstream fold
   * against an empty table simply fails to resolve, which is a recorded refusal
   * rather than a wrong answer.
   */
  readonly moduleConstants: ReadonlyMap<string, ModuleConstants>;
  /** Files whose scope extraction failed while legacy parsing continued. */
  readonly scopeExtractionFailures: readonly string[];
  /** Files omitted because their non-standalone language parser was unavailable. */
  readonly unavailableScopeLanguageFiles: number;
}

export const parsePhase: PipelinePhase<ParseOutput> = {
  name: 'parse',
  deps: ['structure', 'markdown', 'cobol'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ParseOutput> {
    // Begin streamed structural emit (#2680), if enabled. Deliberately here and
    // not at graph construction: the pre-parse phases are not all write-only —
    // `mapCobolToGraph` scans CALLS edges and removes the unresolved ones — and
    // nothing before parse produces bulk edge volume anyway.
    ctx.graphEmit?.beginStreaming();

    const { scannedFiles, allPaths, allPathSet, totalFiles } = getPhaseOutput<StructureOutput>(
      deps,
      'structure',
    );

    const result = await runChunkedParseAndResolve(
      ctx.graph,
      scannedFiles,
      allPaths,
      totalFiles,
      ctx.repoPath,
      ctx.pipelineStart,
      ctx.onProgress,
      ctx.options,
    );

    return {
      ...result,
      allPaths,
      allPathSet,
      totalFiles,
    };
  },
};
