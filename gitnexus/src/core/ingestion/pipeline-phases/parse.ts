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
import type { ExportedTypeMap } from '../call-processor.js';
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
  exportedTypeMap: ExportedTypeMap;
  allFetchCalls: ExtractedFetchCall[];
  allExtractedRoutes: ExtractedRoute[];
  allDecoratorRoutes: ExtractedDecoratorRoute[];
  allToolDefs: ExtractedToolDef[];
  allORMQueries: ExtractedORMQuery[];
  bindingAccumulator: BindingAccumulator;
  /** Resolution context from the parse phase — carries importMap, namedImportMap, etc. */
  resolutionContext: ReturnType<typeof createResolutionContext>;
  /** Pass-through: all file paths for downstream phases. */
  allPaths: string[];
  /** Pass-through: total file count for progress reporting. */
  totalFiles: number;
}

export const parsePhase: PipelinePhase<ParseOutput> = {
  name: 'parse',
  deps: ['structure', 'markdown', 'cobol'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<ParseOutput> {
    const { scannedFiles, allPaths, totalFiles } = getPhaseOutput<StructureOutput>(
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
      totalFiles,
    };
  },
};
