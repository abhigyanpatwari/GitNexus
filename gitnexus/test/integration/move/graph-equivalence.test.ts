/**
 * Graph-equivalence regression guard for the Move ingestion refactor.
 *
 * This test locks the post-refactor graph structure (sorted node and edge sets)
 * for the coin fixture as a vitest snapshot. Any future change that alters the
 * Move graph shape will cause this test to fail, surfacing unintended regressions
 * before merge.
 *
 * Per-refactor behavioral correctness (Pass-A/Pass-B seam, PendingRef confidence
 * and reason, usedTypes assertions) is covered by the Move unit suite:
 *   test/unit/move/ref-resolver.test.ts
 *   test/unit/move/facts-mapper.test.ts
 *
 * Guard scope: Move-graph structural stability (node labels, edge types, edge
 * reasons). The snapshot is the content — it must not be empty. If move-flow is
 * unavailable in the current environment, the test suite skips (expected locally).
 * CI sets GITNEXUS_REQUIRE_MOVE_FLOW=1 to make unavailability a hard failure.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import { tryResolveMoveFlowClient } from '../../../src/core/move/mcp-client.js';
import { createMoveIngestPhase } from '../../../src/core/move/move-ingest.js';
import { ensureMoveFlowRuntime } from '../../../src/core/move/provision.js';

const requireMoveFlow = process.env.GITNEXUS_REQUIRE_MOVE_FLOW === '1';
const client = requireMoveFlow
  ? (
      await ensureMoveFlowRuntime({
        onLog: (message) => console.info(`[move-graph-equiv] ${message}`),
      })
    )?.client
  : tryResolveMoveFlowClient()?.client;

if (requireMoveFlow && !client) {
  throw new Error('GITNEXUS_REQUIRE_MOVE_FLOW=1 but MoveFlow provisioning failed');
}

const coinFixture = path.resolve(process.cwd(), 'test/fixtures/move/aptos-framework/coin');

describe.skipIf(!client)('Move graph-equivalence regression guard (coin fixture)', () => {
  afterAll(async () => {
    await client?.shutdown();
  });

  it('matches the committed graph snapshot (nodes + edges)', async () => {
    const result = await runPipelineFromRepo(coinFixture, () => {}, {
      standaloneIngestPhase: createMoveIngestPhase(client),
      skipGraphPhases: true,
    });

    const nodes = [...result.graph.iterNodes()].map((n) => `${n.id}\t${n.label}`).sort();

    const edges = [...result.graph.iterRelationships()]
      .map((r) => `${r.sourceId}\t${r.type}\t${r.targetId}\t${r.reason ?? ''}`)
      .sort();

    expect({ nodes, edges }).toMatchSnapshot();
  }, 60000);
});
