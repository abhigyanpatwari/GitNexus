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
