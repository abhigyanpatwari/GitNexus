/**
 * Harness for driving the moveIngest phase directly (no full pipeline): builds
 * the synthetic structure-phase deps map + PipelineContext the phase expects.
 * Shared by the unit (move-ingest-*) and integration (move-live) Move tests.
 */
import { createMoveIngestPhase, type MoveIngestOutput } from '../../src/core/move/move-ingest.js';
import type { MoveFlowClient } from '../../src/core/move/mcp-client.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { PhaseResult } from '../../src/core/ingestion/pipeline-phases/types.js';

/** Run the moveIngest phase over `filePaths` (repo-relative) under `repoPath`. */
export async function runMoveIngestPhase(
  client: MoveFlowClient | null,
  repoPath: string,
  filePaths: readonly string[],
): Promise<MoveIngestOutput> {
  const deps = new Map<string, PhaseResult<unknown>>([
    [
      'structure',
      {
        phaseName: 'structure',
        output: {
          scannedFiles: filePaths.map((path) => ({ path, size: 0 })),
          allPaths: [],
          allPathSet: new Set<string>(),
          totalFiles: filePaths.length,
        },
        durationMs: 0,
      },
    ],
  ]);
  return createMoveIngestPhase(client).execute(
    {
      repoPath,
      graph: createKnowledgeGraph(),
      onProgress: () => {},
      pipelineStart: Date.now(),
    },
    deps,
  );
}
