/**
 * processParsing — worker-pool error handling contract.
 *
 * U20 design pivot (PR #1693): there is NO sequential-parser fallback
 * when the worker pool fails. The pool's resilience layers (respawn
 * budget, circuit breaker, quarantine, slot-attribution, cumulative
 * timeout) are the sole contract for handling worker failures. When
 * those exhaust, `processParsing` propagates the error to the caller
 * — `runChunkedParseAndResolve` and the analyze entry point above it.
 *
 * This file replaces the previous sequential-fallback tests (which
 * asserted that processParsing caught WorkerPoolDispatchError and
 * called processParsingSequential on the remaining files). The new
 * contract is "errors propagate, no rescue."
 *
 * Why removing the fallback was the right call:
 *   - The fallback ran the SAME tree-sitter parser the worker just
 *     crashed on, but on the main thread. A native crash (SIGSEGV
 *     from a tree-sitter binding) in the worker would re-trigger the
 *     same SIGSEGV on the main thread, killing the whole analyze
 *     instead of just the worker.
 *   - It hid pool failures behind a degraded-but-completing analyze
 *     run, making them harder to detect and diagnose.
 *   - U2's chunk-cache write suppression keeps cross-run retry
 *     working: a quarantined file's chunk stays uncached, so the
 *     next analyze with a fresh pool gets another chance.
 */
import { describe, expect, it, vi } from 'vitest';
import { createASTCache } from '../../src/core/ingestion/ast-cache.js';
import { processParsing } from '../../src/core/ingestion/parsing-processor.js';
import type { WorkerPool } from '../../src/core/ingestion/workers/worker-pool.js';
import { WorkerPoolDispatchError } from '../../src/core/ingestion/workers/worker-pool.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSymbolTable } from '../../src/core/ingestion/model/symbol-table.js';

describe('processParsing — worker-pool error propagation (U20)', () => {
  it('propagates a raw worker-pool throw to the caller without rescuing', async () => {
    const graph = createKnowledgeGraph();
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new Error('replacement worker failed');
      }),
      terminate: vi.fn(async () => undefined),
    };

    await expect(
      processParsing(
        graph,
        [{ path: 'src/a.ts', content: 'export function a() { return 1; }\n' }],
        createSymbolTable(),
        createASTCache(),
        createASTCache(),
        () => {},
        workerPool,
      ),
    ).rejects.toThrow('replacement worker failed');

    // No sequential fallback ran, so the graph stays empty.
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(false);
  });

  it('propagates WorkerPoolDispatchError with quarantinedPaths intact', async () => {
    const graph = createKnowledgeGraph();
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => {
        throw new WorkerPoolDispatchError(
          'Worker pool circuit breaker tripped: 2 consecutive failures on slot 0',
          ['src/poison.ts'],
        );
      }),
      terminate: vi.fn(async () => undefined),
    };

    const rejection = processParsing(
      graph,
      [
        { path: 'src/poison.ts', content: 'export function poison() { return 0; }\n' },
        { path: 'src/a.ts', content: 'export function a() { return 1; }\n' },
      ],
      createSymbolTable(),
      createASTCache(),
      createASTCache(),
      () => {},
      workerPool,
    );

    await expect(rejection).rejects.toBeInstanceOf(WorkerPoolDispatchError);
    const err = await rejection.catch((e) => e as WorkerPoolDispatchError);
    expect(err.quarantinedPaths).toEqual(['src/poison.ts']);

    // No sequential fallback ran for either file. The caller (analyze
    // entry point) is responsible for surfacing this as a hard
    // failure.
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'a'),
    ).toBe(false);
    expect(
      graph.nodes.some((node) => node.label === 'Function' && node.properties.name === 'poison'),
    ).toBe(false);
  });

  it('worker-path returns successfully when the pool reports a quarantine snapshot without throwing', async () => {
    // Quarantine is a normal session-scoped signal: the pool filters
    // quarantined files out of dispatch, returns the survivors'
    // results, and reports the cumulative set via getQuarantinedPaths.
    // processParsing's worker-path completes successfully on this
    // partial-coverage signal — the quarantined file is missing from
    // the graph, but no error is thrown. The chunk-loop caller uses
    // the quarantine snapshot to decide whether to write the chunk
    // cache (U2 in parse-impl.ts).
    const graph = createKnowledgeGraph();
    const workerPool: WorkerPool = {
      size: 1,
      dispatch: vi.fn(async () => []),
      terminate: vi.fn(async () => undefined),
      getQuarantinedPaths: () => ['src/poison.ts'],
    };

    const progressDetails: string[] = [];
    const result = await processParsing(
      graph,
      [
        { path: 'src/poison.ts', content: 'export function poison() { return 0; }\n' },
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

    // Worker path returned successfully (not null — null was the
    // pre-U20 sentinel for "ran sequential fallback"). The progress
    // log surfaces the quarantine count for operator visibility.
    expect(result).not.toBeNull();
    expect(progressDetails).toContain('1 worker-quarantined file(s) skipped');
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
