/**
 * Pipeline orchestrator — DAG-based ingestion pipeline.
 *
 * The pipeline is composed of named phases with explicit dependencies.
 * Each phase is defined in its own file under `pipeline-phases/`.
 * The DAG runner in `pipeline-phases/runner.ts` executes phases in
 * topological order, passing typed outputs from upstream phases as
 * inputs to downstream phases.
 *
 * To add a new phase:
 * 1. Create a new file in `pipeline-phases/` following the pattern
 * 2. Export it from `pipeline-phases/index.ts`
 * 3. Add it to the `ALL_PHASES` array below
 *
 * See ARCHITECTURE.md for the full phase DAG diagram.
 */

import { createKnowledgeGraph } from '../graph/graph.js';
import { type PipelineProgress } from 'gitnexus-shared';
import { PipelineResult } from '../../types/pipeline.js';
import {
  runPipelineDAG,
  getPhaseOutput,
  scanPhase,
  structurePhase,
  markdownPhase,
  cobolPhase,
  parsePhase,
  routesPhase,
  toolsPhase,
  ormPhase,
  crossFilePhase,
  mroPhase,
  communitiesPhase,
  processesPhase,
  type PipelinePhase,
  type CommunitiesOutput,
  type ProcessesOutput,
} from './pipeline-phases/index.js';

// ── topologicalLevelSort ───────────────────────────────────────────────────
// Retained here for backward compatibility — used by cross-file-impl.ts and
// unit tests that import directly from pipeline.ts.

/** A group of files with no mutual dependencies, safe to process in parallel. */
type IndependentFileGroup = readonly string[];

/** Kahn's algorithm: returns files grouped by topological level.
 *  Files in the same level have no mutual dependencies — safe to process in parallel.
 *  Files in cycles are returned as a final group (no cross-cycle propagation). */
export function topologicalLevelSort(importMap: ReadonlyMap<string, ReadonlySet<string>>): {
  levels: readonly IndependentFileGroup[];
  cycleCount: number;
} {
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const [file, deps] of importMap) {
    if (!inDegree.has(file)) inDegree.set(file, 0);
    for (const dep of deps) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      inDegree.set(file, (inDegree.get(file) ?? 0) + 1);
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(file);
    }
  }

  const levels: string[][] = [];
  let currentLevel = [...inDegree.entries()].filter(([, d]) => d === 0).map(([f]) => f);

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    const nextLevel: string[] = [];
    for (const file of currentLevel) {
      for (const dependent of reverseDeps.get(file) ?? []) {
        const newDeg = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDeg);
        if (newDeg === 0) nextLevel.push(dependent);
      }
    }
    currentLevel = nextLevel;
  }

  const cycleFiles = [...inDegree.entries()].filter(([, d]) => d > 0).map(([f]) => f);
  if (cycleFiles.length > 0) {
    levels.push(cycleFiles);
  }

  return { levels, cycleCount: cycleFiles.length };
}

export interface PipelineOptions {
  /** Skip MRO, community detection, and process extraction for faster test runs. */
  skipGraphPhases?: boolean;
  /** Force sequential parsing (no worker pool). Useful for testing the sequential path. */
  skipWorkers?: boolean;
}

// ── Phase registry ─────────────────────────────────────────────────────────

/**
 * All pipeline phases in the DAG.
 *
 * Phase DAG:
 *
 *   scan → structure → [markdown, cobol] → parse → [routes, tools, orm]
 *     → crossFile → mro → communities → processes
 *
 * To add a new phase: create a file in pipeline-phases/, export the phase
 * object, and add it to the appropriate position in this array.
 */
function buildPhaseList(options?: PipelineOptions): PipelinePhase[] {
  const phases: PipelinePhase[] = [
    scanPhase,
    structurePhase,
    markdownPhase,
    cobolPhase,
    parsePhase,
    routesPhase,
    toolsPhase,
    ormPhase,
    crossFilePhase,
  ];

  if (!options?.skipGraphPhases) {
    phases.push(mroPhase, communitiesPhase, processesPhase);
  }

  return phases;
}

// ── Pipeline orchestrator ─────────────────────────────────────────────────

export const runPipelineFromRepo = async (
  repoPath: string,
  onProgress: (progress: PipelineProgress) => void,
  options?: PipelineOptions,
): Promise<PipelineResult> => {
  const graph = createKnowledgeGraph();
  const pipelineStart = Date.now();

  const phases = buildPhaseList(options);

  const results = await runPipelineDAG(phases, {
    repoPath,
    graph,
    onProgress,
    options,
    pipelineStart,
  });

  // Extract final results for the PipelineResult contract
  const { totalFiles } = getPhaseOutput<{ totalFiles: number }>(results, 'parse');

  let communityResult: CommunitiesOutput['communityResult'] | undefined;
  let processResult: ProcessesOutput['processResult'] | undefined;

  if (!options?.skipGraphPhases) {
    communityResult = getPhaseOutput<CommunitiesOutput>(results, 'communities').communityResult;
    processResult = getPhaseOutput<ProcessesOutput>(results, 'processes').processResult;
  }

  onProgress({
    phase: 'complete',
    percent: 100,
    message:
      communityResult && processResult
        ? `Graph complete! ${communityResult.stats.totalCommunities} communities, ${processResult.stats.totalProcesses} processes detected.`
        : 'Graph complete! (graph phases skipped)',
    stats: {
      filesProcessed: totalFiles,
      totalFiles,
      nodesCreated: graph.nodeCount,
    },
  });

  return { graph, repoPath, totalFileCount: totalFiles, communityResult, processResult };
};
