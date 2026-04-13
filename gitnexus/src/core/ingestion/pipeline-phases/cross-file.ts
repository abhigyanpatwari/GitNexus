/**
 * Phase: crossFile
 *
 * Cross-file binding propagation: seeds downstream files with resolved
 * type bindings from upstream exports. Files are processed in topological
 * import order so upstream bindings are available when downstream files
 * are re-resolved.
 *
 * @deps    parse, routes, tools, orm (waits for all post-parse phases)
 * @reads   exportedTypeMap, allPaths, totalFiles
 * @writes  graph (refined CALLS edges via re-resolution)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { runCrossFileBindingPropagation } from './cross-file-impl.js';

export interface CrossFileOutput {
  /** Number of files re-processed during cross-file propagation. */
  filesReprocessed: number;
}

export const crossFilePhase: PipelinePhase<CrossFileOutput> = {
  name: 'crossFile',
  deps: ['parse', 'routes', 'tools', 'orm'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<CrossFileOutput> {
    const { exportedTypeMap, allPaths, totalFiles, bindingAccumulator } =
      getPhaseOutput<ParseOutput>(deps, 'parse');

    const isDev = process.env.NODE_ENV === 'development';

    // Log and dispose binding accumulator — all consumers have completed
    if (isDev) {
      if (bindingAccumulator.totalBindings > 0) {
        const memKB = Math.round(bindingAccumulator.estimateMemoryBytes() / 1024);
        console.log(
          `📦 BindingAccumulator: ${bindingAccumulator.totalBindings} bindings across ${bindingAccumulator.fileCount} files (~${memKB} KB)`,
        );
      } else if (totalFiles > 0) {
        console.log(
          `📦 BindingAccumulator: EMPTY — 0 bindings across 0 files despite ${totalFiles} parsed files. If the codebase has typed bindings, this indicates an upstream regression.`,
        );
      }
    }
    bindingAccumulator.dispose();

    const filesReprocessed = await runCrossFileBindingPropagation(
      ctx.graph,
      exportedTypeMap,
      allPaths,
      totalFiles,
      ctx.repoPath,
      ctx.pipelineStart,
      ctx.onProgress,
    );

    return { filesReprocessed };
  },
};
