import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MoveFactsMap } from '../../../src/core/move/compiler-facts.js';
import {
  makeMoveFlowClientStub,
  moveFunctionFact,
  runMoveIngestPhaseWithGraph,
} from '../../helpers/move-ingest-harness.js';

describe('Move entry points', () => {
  it('emits roots for entry and view functions, but not init_module', async () => {
    const repoRoot = path.resolve('/repo');
    const facts: MoveFactsMap = {
      '0xa::roots': {
        file: path.join(repoRoot, 'pkg/sources/roots.move'),
        functions: [
          moveFunctionFact('entry_api', { isEntry: true }),
          moveFunctionFact('view_api', { isView: true }),
          moveFunctionFact('init_module'),
        ],
      },
    };
    const client = makeMoveFlowClientStub({
      facts: async () => facts,
      callGraph: async () => ({}),
      capabilities: async () => ({
        hasFactsQuery: true,
        hasFunctionUsageQuery: false,
        hasStatusTool: false,
      }),
    });

    const { graph } = await runMoveIngestPhaseWithGraph(client, repoRoot, [
      'pkg/Move.toml',
      'pkg/sources/roots.move',
    ]);
    const roots = [...graph.iterRelationshipsByType('ENTRY_POINT_OF')].map((edge) => edge.reason);

    expect(roots).toEqual(expect.arrayContaining(['move-entry-function', 'move-view-function']));
    expect(roots).toHaveLength(2);
  });
});
