/**
 * Phase: structure
 *
 * Builds File and Folder nodes in the graph from scanned paths.
 *
 * @deps    scan
 * @reads   allPaths (from scan phase)
 * @writes  graph (File, Folder nodes + CONTAINS edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { processStructure } from '../structure-processor.js';
import type { ScanOutput } from './scan.js';

/** Structure phase produces no additional data — it writes directly to the graph. */
export interface StructureOutput {
  /** Pass-through from scan for downstream phases. */
  scannedFiles: { path: string; size: number }[];
  allPaths: string[];
  /**
   * Materialized once here and shared across all downstream consumers
   * (cobol, markdown, cross-file propagation). Avoids the previous
   * per-phase `new Set(allPaths)` allocations on multi-thousand-file repos.
   */
  allPathSet: ReadonlySet<string>;
  totalFiles: number;
}

export const structurePhase: PipelinePhase<StructureOutput> = {
  name: 'structure',
  deps: ['scan'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<StructureOutput> {
    const { scannedFiles, allPaths, totalFiles } = getPhaseOutput<ScanOutput>(deps, 'scan');

    ctx.onProgress({
      phase: 'structure',
      percent: 15,
      message: 'Analyzing project structure...',
      stats: { filesProcessed: 0, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    processStructure(ctx.graph, allPaths);

    ctx.onProgress({
      phase: 'structure',
      percent: 20,
      message: 'Project structure analyzed',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    // Build the set once here so cobol, markdown, and cross-file propagation
    // can all reuse it instead of re-materializing `new Set(allPaths)` each.
    const allPathSet: ReadonlySet<string> = new Set(allPaths);

    return { scannedFiles, allPaths, allPathSet, totalFiles };
  },
};
