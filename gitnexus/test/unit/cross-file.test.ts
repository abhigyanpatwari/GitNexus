import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BindingAccumulator } from '../../src/core/ingestion/binding-accumulator.js';

// Mock the cross-file-impl module so we can control whether the propagation
// step throws or returns cleanly. The `crossFilePhase` only depends on this
// one external symbol — nothing else in the body has to be stubbed.
vi.mock('../../src/core/ingestion/pipeline-phases/cross-file-impl.js', () => ({
  runCrossFileBindingPropagation: vi.fn(),
}));

import { runCrossFileBindingPropagation } from '../../src/core/ingestion/pipeline-phases/cross-file-impl.js';
import { crossFilePhase } from '../../src/core/ingestion/pipeline-phases/cross-file.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { ParseOutput } from '../../src/core/ingestion/pipeline-phases/parse.js';

const runCrossFileMock = vi.mocked(runCrossFileBindingPropagation);

function makeCtx(): PipelineContext {
  return {
    repoPath: '/tmp/repo',
    // Cast — the body never touches graph methods on the happy/error paths
    // this test exercises (the propagation call is stubbed).
    graph: {} as PipelineContext['graph'],
    onProgress: () => {},
    pipelineStart: 0,
  };
}

function makeParseOutput(acc: BindingAccumulator): ParseOutput {
  return {
    exportedTypeMap: new Map(),
    allFetchCalls: [],
    allExtractedRoutes: [],
    allDecoratorRoutes: [],
    allToolDefs: [],
    allORMQueries: [],
    bindingAccumulator: acc,
    // Cast — the body forwards this to the (mocked) propagation fn but
    // never inspects it.
    resolutionContext: {} as ParseOutput['resolutionContext'],
    allPaths: [],
    totalFiles: 0,
  };
}

function makeDeps(acc: BindingAccumulator): ReadonlyMap<string, PhaseResult<unknown>> {
  return new Map<string, PhaseResult<unknown>>([
    [
      'parse',
      {
        phaseName: 'parse',
        output: makeParseOutput(acc),
        durationMs: 0,
      },
    ],
  ]);
}

describe('crossFilePhase', () => {
  beforeEach(() => {
    runCrossFileMock.mockReset();
  });

  it('disposes the binding accumulator on the happy path', async () => {
    runCrossFileMock.mockResolvedValueOnce(7);

    const acc = new BindingAccumulator();
    acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);
    expect(acc.disposed).toBe(false);

    const result = await crossFilePhase.execute(makeCtx(), makeDeps(acc));

    expect(result.filesReprocessed).toBe(7);
    expect(acc.disposed).toBe(true);
    // Post-dispose contract holds.
    expect(acc.fileCount).toBe(0);
    expect(acc.totalBindings).toBe(0);
  });

  it('disposes the binding accumulator even when propagation throws', async () => {
    // Error-injection: the leak-on-throw gap — without the finally block,
    // the accumulator would stay live (and reachable via the closed-over
    // ParseOutput) until GC. With the finally block, dispose runs on the
    // unwind and the heap is released regardless.
    const boom = new Error('cross-file propagation exploded');
    runCrossFileMock.mockRejectedValueOnce(boom);

    const acc = new BindingAccumulator();
    acc.appendFile('src/a.ts', [{ scope: '', varName: 'x', typeName: 'X' }]);

    await expect(crossFilePhase.execute(makeCtx(), makeDeps(acc))).rejects.toBe(boom);

    expect(acc.disposed).toBe(true);
    expect(acc.fileCount).toBe(0);
    expect(acc.totalBindings).toBe(0);
  });
});
