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
 *
 * **Accumulator ownership / residual risk.** This phase is the sole
 * disposer of the `BindingAccumulator` produced by `parse`. The dispose
 * call lives inside a `finally` block in `execute()` so that a throw
 * inside `runCrossFileBindingPropagation` (or anywhere else in the body)
 * still releases the accumulator's heap. The dependency declaration
 * (`deps: ['parse', 'routes', 'tools', 'orm']`) plus the runner's
 * topological scheduling guarantee that every other consumer of the
 * accumulator has finished before this phase starts, so disposing here
 * is correct.
 *
 * The residual risk is intentional and accepted: if a future phase is
 * inserted between `parse` and `crossFile` that reads the accumulator
 * and throws, `crossFile.execute()` never runs and the accumulator
 * leaks. Any author inserting a new phase between `parse` and
 * `crossFile` MUST either route the new phase's output through
 * `crossFile` (so disposal still happens here) or take ownership of
 * the accumulator's lifetime explicitly (its own try/finally that
 * disposes on the failure path). Do not silently rely on the GC.
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { ParseOutput } from './parse.js';
import { runCrossFileBindingPropagation } from './cross-file-impl.js';
import { isDev } from '../utils/env.js';

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
    const { exportedTypeMap, allPathSet, totalFiles, bindingAccumulator, resolutionContext } =
      getPhaseOutput<ParseOutput>(deps, 'parse');

    try {
      // Telemetry must run BEFORE dispose: totalBindings, fileCount, and
      // estimateMemoryBytes() all return 0 once dispose() clears the
      // internal maps.
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

      const filesReprocessed = await runCrossFileBindingPropagation(
        ctx.graph,
        resolutionContext,
        exportedTypeMap,
        allPathSet,
        totalFiles,
        ctx.repoPath,
        ctx.pipelineStart,
        ctx.onProgress,
      );

      return { filesReprocessed };
    } finally {
      // Single dispose call site for the accumulator — runs on both the
      // happy path and the throw path so the heap is always released
      // before the runner moves on (or surfaces the error).
      bindingAccumulator.dispose();
    }
  },
};
