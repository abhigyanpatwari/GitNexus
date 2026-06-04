/**
 * Phase: crossFile
 *
 * Accumulator disposal anchor. The legacy cross-file call re-resolution that
 * this phase used to run (`runCrossFileBindingPropagation`) was owned by the
 * call-resolution DAG and skipped every registry-primary language; RING4-1
 * (#942) deleted the DAG, so the propagation is gone and this phase now only
 * disposes the `BindingAccumulator`. It is kept as a phase (rather than folded
 * into `parse`) so disposal stays sequenced after every accumulator consumer.
 *
 * @deps    parse, routes, tools, orm (waits for all post-parse phases)
 * @reads   totalFiles, bindingAccumulator
 * @writes  nothing (disposal only)
 *
 * **Accumulator ownership / residual risk.** This phase is the sole
 * disposer of the `BindingAccumulator` produced by `parse`. The dispose
 * call lives inside a `finally` block in `execute()` so that a throw
 * anywhere in the body still releases the accumulator's heap. The dependency declaration
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
import { isDev } from '../utils/env.js';

import { logger } from '../../logger.js';
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
    const { totalFiles, bindingAccumulator } = getPhaseOutput<ParseOutput>(deps, 'parse');

    try {
      // Telemetry must run BEFORE dispose: totalBindings, fileCount, and
      // estimateMemoryBytes() all return 0 once dispose() clears the
      // internal maps.
      if (isDev) {
        if (bindingAccumulator.totalBindings > 0) {
          const memKB = Math.round(bindingAccumulator.estimateMemoryBytes() / 1024);
          logger.info(
            `📦 BindingAccumulator: ${bindingAccumulator.totalBindings} bindings across ${bindingAccumulator.fileCount} files (~${memKB} KB)`,
          );
        } else if (totalFiles > 0) {
          logger.info(
            `📦 BindingAccumulator: EMPTY — 0 bindings across 0 files despite ${totalFiles} parsed files. If the codebase has typed bindings, this indicates an upstream regression.`,
          );
        }
      }

      // Legacy cross-file call re-resolution was owned by the call-resolution
      // DAG (registry-primary languages skipped it entirely). With the DAG
      // removed (RING4-1 #942), scope-resolution owns all CALLS edges and no
      // cross-file re-resolution pass runs here. This phase survives solely to
      // dispose the BindingAccumulator on the runner's behalf (see finally).
      return { filesReprocessed: 0 };
    } finally {
      // Single dispose call site for the accumulator — runs on both the
      // happy path and the throw path so the heap is always released
      // before the runner moves on (or surfaces the error).
      bindingAccumulator.dispose();
    }
  },
};
