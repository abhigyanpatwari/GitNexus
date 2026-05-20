import { describe, expect, it, vi } from 'vitest';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import type { WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';

describe('processParsing worker fallback', () => {
  it('continues sequentially with visible progress when the worker pool times out', async () => {
    const graph = createKnowledgeGraph();
    const progressCounts: number[] = [];
    const progressDetails: string[] = [];
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async (_items, onProgress?: (filesProcessed: number) => void) => {
        onProgress?.(1);
        throw new Error('injected worker idle timeout');
      }),
      terminate: vi.fn(async () => undefined),
    };

    const result = await processParsing(
      graph,
      [{ path: 'src/a.ts', content: 'export function a() { return 1; }\n' }],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      (current, _total, detail) => {
        progressCounts.push(current);
        progressDetails.push(detail);
      },
      workerPool,
    );

    expect(result).toBeNull();
    expect(progressDetails).toContain(
      'Sequential fallback after worker issue: injected worker idle timeout',
    );
    expect(progressCounts).toEqual([...progressCounts].sort((a, b) => a - b));
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(true);
  });
});

describe('TypeScript object literal method exports', () => {
  it('links exported object literal shorthand methods back to the exported object', async () => {
    const graph = createKnowledgeGraph();

    await processParsing(
      graph,
      [
        {
          path: 'src/foo.ts',
          content: `export const fooService = {
  async getUser(id: string) {
    return findUser(id);
  },
  saveUser(user: User) {
    return persist(user);
  },
};
`,
        },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
    );

    const service = graph.nodes.find(
      (node) => node.label === 'Const' && node.properties.name === 'fooService',
    );
    expect(service, 'exported object literal should be captured as a Const').toBeDefined();

    const methodNames = new Set(
      graph.nodes.filter((node) => node.label === 'Method').map((node) => node.properties.name),
    );
    expect(methodNames).toEqual(new Set(['getUser', 'saveUser']));

    const linkedMethodNames = graph.relationships
      .filter((rel) => rel.type === 'HAS_METHOD' && rel.sourceId === service!.id)
      .map((rel) => graph.getNode(rel.targetId)?.properties.name)
      .sort();

    expect(linkedMethodNames).toEqual(['getUser', 'saveUser']);
  });
});
