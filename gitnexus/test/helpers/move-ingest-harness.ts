/**
 * Harness for driving the moveIngest phase directly (no full pipeline): builds
 * the synthetic structure-phase deps map + PipelineContext the phase expects.
 * Shared by the unit (move-ingest-*) and integration (move-live) Move tests.
 */
import { createMoveIngestPhase, type MoveIngestOutput } from '../../src/core/move/move-ingest.js';
import type { MoveFactsFunction } from '../../src/core/move/compiler-facts.js';
import type { MoveFlowClient } from '../../src/core/move/mcp-client.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import type { PhaseResult } from '../../src/core/ingestion/pipeline-phases/types.js';

export interface MoveFlowClientCallCounts {
  facts: number;
  callGraph: number;
  functionUsage: number;
  capabilities: number;
  packageStatus: number;
}

export const moveFunctionFact = (
  name: string,
  overrides: Partial<MoveFactsFunction> = {},
): MoveFactsFunction => ({
  name,
  visibility: 'internal',
  isEntry: false,
  isInline: false,
  isNative: false,
  isView: false,
  returnTypes: [],
  ...overrides,
});

/**
 * Counting MoveFlowClient stub shared by the Move unit tests: benign defaults,
 * overridable per member. The wrapper counts every call — including calls that
 * reach an override — so tests can assert zero/at-most-once client interaction.
 */
export function makeMoveFlowClientStub(
  overrides: Partial<MoveFlowClient> = {},
): MoveFlowClient & { counts: MoveFlowClientCallCounts } {
  const counts: MoveFlowClientCallCounts = {
    facts: 0,
    callGraph: 0,
    functionUsage: 0,
    capabilities: 0,
    packageStatus: 0,
  };
  const impl: MoveFlowClient = {
    facts: async () => ({}),
    callGraph: async () => ({}),
    functionUsage: async () => ({
      called: [],
      used: [],
    }),
    packageStatus: async () => ({ ok: true, diagnostics: '' }),
    capabilities: async () => ({
      hasFactsQuery: true,
      hasFunctionUsageQuery: true,
      hasStatusTool: true,
    }),
    shutdown: async () => {},
    ...overrides,
  };
  return {
    counts,
    facts: (pkg) => {
      counts.facts += 1;
      return impl.facts(pkg);
    },
    callGraph: (pkg) => {
      counts.callGraph += 1;
      return impl.callGraph(pkg);
    },
    functionUsage: (pkg, fn) => {
      counts.functionUsage += 1;
      return impl.functionUsage(pkg, fn);
    },
    packageStatus: (pkg) => {
      counts.packageStatus += 1;
      return impl.packageStatus(pkg);
    },
    capabilities: () => {
      counts.capabilities += 1;
      return impl.capabilities();
    },
    shutdown: () => impl.shutdown(),
  };
}

/** Run the moveIngest phase over `filePaths` (repo-relative) under `repoPath`. */
export async function runMoveIngestPhase(
  client: MoveFlowClient | null,
  repoPath: string,
  filePaths: readonly string[],
): Promise<MoveIngestOutput> {
  return (await runMoveIngestPhaseWithGraph(client, repoPath, filePaths)).output;
}

export async function runMoveIngestPhaseWithGraph(
  client: MoveFlowClient | null,
  repoPath: string,
  filePaths: readonly string[],
): Promise<{ output: MoveIngestOutput; graph: KnowledgeGraph }> {
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
  const graph = createKnowledgeGraph();
  const output = await createMoveIngestPhase(client).execute(
    {
      repoPath,
      graph,
      onProgress: () => {},
      pipelineStart: Date.now(),
    },
    deps,
  );
  return { output, graph };
}
