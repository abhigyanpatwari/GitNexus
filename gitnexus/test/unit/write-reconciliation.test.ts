import { describe, expect, it, vi } from 'vitest';
import { reconcileGraphNodeIdentities } from '../../src/core/incremental/write-reconciliation.js';
import { buildTestGraph } from '../helpers/test-graph.js';

const graph = () =>
  buildTestGraph(
    [
      {
        id: 'Function:src/lock.ts:acquire',
        label: 'Function',
        name: 'acquire',
        filePath: 'src/lock.ts',
        startLine: 504,
        endLine: 719,
      },
      {
        id: 'Function:bench/measure.mjs:retainedHeapBytes',
        label: 'Function',
        name: 'retainedHeapBytes',
        filePath: 'bench/measure.mjs',
        startLine: 437,
        endLine: 453,
      },
    ],
    [],
  );
const rows = () => [
  {
    id: 'Function:src/lock.ts:acquire',
    name: 'acquire',
    filePath: 'src/lock.ts',
    startLine: 504,
    endLine: 719,
  },
  {
    id: 'Function:bench/measure.mjs:retainedHeapBytes',
    name: 'retainedHeapBytes',
    filePath: 'bench/measure.mjs',
    startLine: 437,
    endLine: 453,
  },
];
const queryFor = (functions: ReturnType<typeof rows>) =>
  vi.fn(async (query: string) => (query.includes('(n:`Function`)') ? functions : []));

describe('incremental identity reconciliation', () => {
  it('certifies every identity using one unfiltered query per label', async () => {
    const query = queryFor(rows());
    const receipt = await reconcileGraphNodeIdentities(graph(), query, 'post-COPY');
    expect(receipt.nodes).toBe(2);
    expect(query).toHaveBeenCalledTimes(receipt.tables);
    for (const [cypher] of query.mock.calls) {
      expect(cypher).toMatch(/^MATCH \(n:`\w+`\) RETURN/);
      expect(cypher).not.toMatch(/WHERE|content/);
    }
  });

  it('rejects a missing unchanged symbol', async () => {
    await expect(
      reconcileGraphNodeIdentities(graph(), queryFor(rows().slice(1)), 'post-COPY'),
    ).rejects.toThrow(/1 missing ID.*src\/lock.ts:acquire/);
  });

  it.each(['name', 'filePath', 'startLine', 'endLine'] as const)(
    'rejects column/row inconsistency in %s despite identical ID counts',
    async (field) => {
      const persisted = rows();
      const swapped = persisted.map((row, index) => ({
        ...row,
        [field]: persisted[1 - index][field],
      }));
      await expect(
        reconcileGraphNodeIdentities(graph(), queryFor(swapped), 'pre-publish'),
      ).rejects.toThrow(field);
    },
  );

  it('rejects a duplicated row that would hide a missing ID in a count check', async () => {
    await expect(
      reconcileGraphNodeIdentities(graph(), queryFor([rows()[0], rows()[0]]), 'post-COPY'),
    ).rejects.toThrow(/duplicate ID/);
  });

  it('surfaces a failed scan rather than certifying an unreadable graph', async () => {
    const query = vi.fn().mockRejectedValue(new Error('Invalid UTF-8'));
    await expect(reconcileGraphNodeIdentities(graph(), query, 'pre-publish')).rejects.toThrow(
      /could not read identity fields.*Invalid UTF-8/,
    );
  });
});
