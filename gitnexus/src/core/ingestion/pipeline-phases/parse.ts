/**
 * Phase: parse
 *
 * Chunked parse + resolve loop: reads source in byte-budget chunks,
 * parses via worker pool (or sequential fallback), resolves imports,
 * heritage, and calls, synthesizes wildcard bindings.
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
import type {
  ExtractedFetchCall,
  ExtractedRoute,
  ExtractedDecoratorRoute,
  ExtractedToolDef,
  ExtractedORMQuery,
} from '../workers/parse-worker.js';
import type { createResolutionContext } from '../model/resolution-context.js';
import { runChunkedParseAndResolve } from './parse-impl.js';

export interface ParseOutput {
  /**
   * Read-only snapshot of exported type bindings keyed by file path.
   *
   * Fully populated by `parse` (sequential path via `enrichExportedTypeMap`
   * and worker path via `buildExportedTypeMapFromGraph` in the main thread).
   * Downstream phases — including `crossFile` — receive it as a true
   * `ReadonlyMap`; `crossFile` builds its own mutable working copy locally
   * for per-file re-resolution writes, so this snapshot is never mutated
   * after parse returns.
   */
  readonly exportedTypeMap: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly allFetchCalls: readonly ExtractedFetchCall[];
  readonly allExtractedRoutes: readonly ExtractedRoute[];
  readonly allDecoratorRoutes: readonly ExtractedDecoratorRoute[];
  readonly allToolDefs: readonly ExtractedToolDef[];
  readonly allORMQueries: readonly ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  /** Resolution context from the parse phase — carries importMap, namedImportMap, etc. */
  resolutionContext: ReturnType<typeof createResolutionContext>;
  /** Pass-through: all file paths for downstream phases. */
  readonly allPaths: readonly string[];
  /** Pass-through: shared `allPathSet` from structure (built once, not per-phase). */
  readonly allPathSet: ReadonlySet<string>;
  /** Pass-through: total file count for progress reporting. */
  totalFiles: number;
  /**
   * True if the parse phase spawned a live worker pool for this run.
   * False means every chunk ran through the sequential fallback (skipWorkers,
   * thresholds not met, or pool-creation failure). Primarily a test affordance:
   * see `PipelineOptions.workerThresholdsForTest`.
   */
  readonly usedWorkerPool: boolean;
}

export const parsePhase: PipelinePhase<ParseOutput> = {
  name: 'parse',
  deps: ['structure', 'markdown', 'cobol'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ParseOutput> {
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
