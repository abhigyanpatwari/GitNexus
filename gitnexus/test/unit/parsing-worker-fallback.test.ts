import { describe, expect, it, vi } from 'vitest';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import type { WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { WorkerPoolDispatchError } from '../../src/core/ingestion/workers/worker-pool.js';
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

  it('skips worker-timeout singleton files during sequential fallback', async () => {
    const graph = createKnowledgeGraph();
    const progressDetails: string[] = [];
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new WorkerPoolDispatchError('injected worker idle timeout', ['src/stuck.ts']);
      }),
      terminate: vi.fn(async () => undefined),
    };

    const result = await processParsing(
      graph,
      [
        { path: 'src/stuck.ts', content: 'export function stuck() { return 0; }\n' },
        { path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      (_current, _total, detail) => {
        progressDetails.push(detail);
      },
      workerPool,
    );

    expect(result).toBeNull();
    expect(progressDetails).toContain('Skipping 1 worker-excluded file(s) in sequential fallback');
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(true);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'stuck'),
    ).toBe(false);
  });

  it('skips worker-error in-flight file during sequential fallback', async () => {
    const graph = createKnowledgeGraph();
    const progressDetails: string[] = [];
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new WorkerPoolDispatchError('Worker 0 error: native crash', ['src/crashed.ts']);
      }),
      terminate: vi.fn(async () => undefined),
    };

    const result = await processParsing(
      graph,
      [
        { path: 'src/crashed.ts', content: 'export function crashed() { return 0; }\n' },
        { path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      (_current, _total, detail) => {
        progressDetails.push(detail);
      },
      workerPool,
    );

    expect(result).toBeNull();
    expect(progressDetails).toContain('Skipping 1 worker-excluded file(s) in sequential fallback');
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(true);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'crashed'),
    ).toBe(false);
  });

  it('skips worker-exit in-flight file during sequential fallback', async () => {
    const graph = createKnowledgeGraph();
    const progressDetails: string[] = [];
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new WorkerPoolDispatchError(
          'Worker 0 exited with code 134. Likely OOM or native addon failure (in-flight: src/oom.ts).',
          ['src/oom.ts'],
        );
      }),
      terminate: vi.fn(async () => undefined),
    };

    const result = await processParsing(
      graph,
      [
        { path: 'src/oom.ts', content: 'export function oom() { return 0; }\n' },
        { path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      (_current, _total, detail) => {
        progressDetails.push(detail);
      },
      workerPool,
    );

    expect(result).toBeNull();
    expect(progressDetails).toContain('Skipping 1 worker-excluded file(s) in sequential fallback');
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(true);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'oom'),
    ).toBe(false);
  });

  it('runs full sequential fallback when the worker pool throws a non-WorkerPoolDispatchError', async () => {
    const graph = createKnowledgeGraph();
    const progressDetails: string[] = [];
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new Error('replacement worker failed');
      }),
      terminate: vi.fn(async () => undefined),
    };

    const result = await processParsing(
      graph,
      [
        { path: 'src/keep.ts', content: 'export function keep() { return 0; }\n' },
        { path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      (_current, _total, detail) => {
        progressDetails.push(detail);
      },
      workerPool,
    );

    expect(result).toBeNull();
    expect(progressDetails).toContain(
      'Sequential fallback after worker issue: replacement worker failed',
    );
    expect(
      progressDetails.some((d) => d.startsWith('Skipping ') && d.includes('worker-excluded file')),
    ).toBe(false);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(true);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'keep'),
    ).toBe(true);
  });
});
